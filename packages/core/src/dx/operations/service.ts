// @effect-diagnostics-next-line nodeBuiltinImport:off -- Durable operation IDs use cryptographic random UUIDs.
import { randomUUID } from "node:crypto";

import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schema,
  Scope,
  Semaphore,
} from "effect";

import { AgentStore } from "../contracts/agent-store.js";
import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import type { AgentHandle, AgentRef } from "../model/agent-common.js";
import {
  OPERATION_SCHEMA_VERSION,
  OperationInputSchema,
  OperationPlanSchema,
  OperationStepSchema,
} from "../model/agent-operation.js";
import type {
  OperationDescriptor,
  OperationInput,
  OperationKind,
  OperationOutput,
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import { createOperationWorkBudget } from "./budget.js";
import type { OperationWorkBudget } from "./budget.js";
import {
  digestOperationPlan,
  operationDigest,
  operationScopeDigest,
} from "./digest.js";
import { OperationExecution, runOperationMachine } from "./machine.js";
import type { OperationPhaseOutcome } from "./machine.js";
import type {
  OperationAdapter,
  OperationApplyInput,
  OperationEffectResult,
  OperationPlanInput,
} from "./ports.js";

export const operationError = (
  code: AgentError["code"],
  message: string
): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: {
      action:
        code === "plan-stale" || code === "plan-expired" ? "replan" : "none",
      ref: null,
    },
    ref: null,
    retryable: code === "store-busy" || code === "revision-conflict",
  });

export interface OperationServiceApi {
  readonly descriptors: readonly OperationDescriptor[];
  readonly run: (
    input: OperationInput
  ) => Effect.Effect<OperationOutput, AgentStoreFailure>;
}

interface ExecutionJob {
  readonly plan: OperationPlan;
  readonly input: OperationApplyInput;
  readonly receipt: OperationReceipt;
  readonly adapter: OperationAdapter;
  readonly attemptedAt: string;
  readonly budget: OperationWorkBudget;
}

interface SharedAcquisition {
  readonly done: Deferred.Deferred<OperationEffectResult, AgentStoreFailure>;
  readonly operation: AgentHandle;
}

interface ExecutionProgress {
  receipt: OperationReceipt;
  selected: readonly OperationStep[];
  position: number;
  pending: OperationStep | null;
  result: OperationEffectResult | null;
  resultRecovered: boolean;
  attemptStartedAt: string;
}

const emptyEffects: OperationReceipt["effects"] = {
  backupArtifacts: [],
  backupIds: [],
  configDigest: null,
  evidenceIds: [],
  exportArtifacts: [],
  exports: [],
  filesChanged: [],
  remainingStoreGeneration: 0,
  removalReason: "This effect does not remove stored observations.",
  removedCount: null,
  removedRefs: [],
};

const emptyResources: OperationReceipt["resources"] = {
  bytesRead: null,
  elapsedMs: null,
  recordsDecoded: null,
  requests: null,
  retries: null,
};

const zeroResources: OperationReceipt["resources"] = {
  bytesRead: 0,
  elapsedMs: 0,
  recordsDecoded: 0,
  requests: 0,
  retries: 0,
};

const initialResources = (
  adapter: OperationAdapter
): OperationReceipt["resources"] => {
  const measured = { ...zeroResources };

  for (const resource of adapter.unmeasuredValidationResources ?? []) {
    measured[resource] = null;
  }

  return measured;
};

const executionResult = (
  result: OperationEffectResult,
  retry: boolean
): OperationEffectResult => {
  if (!retry) {
    return result;
  }

  const retried = {
    ...result,
    step: { ...result.step, retries: result.step.retries + 1 },
  };

  if (result.resources === undefined) {
    return retried;
  }

  return {
    ...retried,
    resources: {
      ...result.resources,
      retries:
        result.resources.retries === null ? null : result.resources.retries + 1,
    },
  };
};

const kinds: readonly OperationKind[] = [
  "collect",
  "derive-usage",
  "refresh-prices",
  "configure",
  "export",
  "delete",
  "reset",
  "restore",
  "live-start",
  "live-stop",
];

const disabledDescriptor = (kind: OperationKind): OperationDescriptor => ({
  authorization: "none",
  cancellation: "before-start-only",
  effects: {
    destructive: kind === "delete" || kind === "reset" || kind === "restore",
    networkDestinations: [],
    reads: [],
    writes: [],
  },
  enabled: false,
  idempotency: "disabled",
  kind,
  reason: "No installed effect adapter supports this operation.",
  requiredInputs: [],
  version: OPERATION_SCHEMA_VERSION,
});

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const terminal = (receipt: OperationReceipt): boolean =>
  !["planned", "running", "interrupted", "partial"].includes(
    receipt.executionState
  );

const finishedStep = (step: OperationStep): boolean =>
  [
    "committed",
    "unchanged",
    "already-applied",
    "unavailable",
    "rejected",
    "cancelled",
    "failed",
  ].includes(step.state);

const uniquePayloads = <Value>(values: readonly Value[]): Value[] => {
  const observed = new Set<string>();

  return values.filter((value) => {
    const key = JSON.stringify(value);

    if (observed.has(key)) {
      return false;
    }

    observed.add(key);

    return true;
  });
};

const removalCount = (
  before: number | null,
  after: number | null,
  recovered?: boolean
): number | null => {
  if (after === null) {
    return before;
  }

  return recovered === true
    ? Math.max(before ?? 0, after)
    : (before ?? 0) + after;
};

const mergeEffects = (
  before: OperationReceipt["effects"],
  after: OperationReceipt["effects"] = emptyEffects,
  recovered?: boolean
): OperationReceipt["effects"] => ({
  backupArtifacts: uniquePayloads([
    ...before.backupArtifacts,
    ...after.backupArtifacts,
  ]),
  backupIds: [...new Set([...before.backupIds, ...after.backupIds])],
  configDigest: after.configDigest ?? before.configDigest,
  evidenceIds: [...new Set([...before.evidenceIds, ...after.evidenceIds])],
  exportArtifacts: uniquePayloads([
    ...before.exportArtifacts,
    ...after.exportArtifacts,
  ]),
  exports: [...new Set([...before.exports, ...after.exports])],
  filesChanged: [...new Set([...before.filesChanged, ...after.filesChanged])],
  remainingStoreGeneration: Math.max(
    before.remainingStoreGeneration,
    after.remainingStoreGeneration
  ),
  removalReason:
    after.removedCount === null ? before.removalReason : after.removalReason,
  removedCount: removalCount(
    before.removedCount,
    after.removedCount,
    recovered
  ),
  removedRefs: uniquePayloads([...before.removedRefs, ...after.removedRefs]),
});

const sumKnown = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a + b;

const measuredProgress = (
  before: number | null,
  after: number | null,
  recovered?: boolean
): number | null =>
  recovered === true && before !== null && after !== null
    ? Math.max(before, after)
    : sumKnown(before, after);

const mergeResources = (
  before: OperationReceipt["resources"],
  after: OperationReceipt["resources"] = emptyResources,
  recovered?: boolean
): OperationReceipt["resources"] => ({
  bytesRead: measuredProgress(before.bytesRead, after.bytesRead, recovered),
  elapsedMs: measuredProgress(before.elapsedMs, after.elapsedMs, recovered),
  recordsDecoded: measuredProgress(
    before.recordsDecoded,
    after.recordsDecoded,
    recovered
  ),
  requests: measuredProgress(before.requests, after.requests, recovered),
  retries: measuredProgress(before.retries, after.retries, recovered),
});

interface OperationCompletion {
  executionState: OperationReceipt["executionState"];
  recovery: OperationReceipt["recovery"];
  verificationState: OperationReceipt["verificationState"];
}

const mergeRejected = (
  before: OperationStep["rejected"],
  after: OperationStep["rejected"],
  recovered?: boolean
): OperationStep["rejected"] => {
  if (before === null || after === null) {
    return null;
  }

  return recovered === true ? Math.max(before, after) : before + after;
};

const completedState = (
  receipt: OperationReceipt,
  replay: OperationAdapter["replay"]
): Pick<
  OperationReceipt,
  "executionState" | "verificationState" | "recovery"
> => {
  const result: OperationCompletion = {
    executionState: "succeeded",
    recovery: "none",
    verificationState: "verified",
  };

  if (receipt.steps.some((step) => step.state === "unavailable")) {
    result.verificationState = "unavailable";
  }

  if (
    receipt.steps.some((step) =>
      ["spooled", "partial", "failed", "rejected"].includes(step.state)
    )
  ) {
    result.executionState = "partial";
    result.verificationState = "partial";
    result.recovery =
      replay === "safe" ? "safe-resume" : "verify-indeterminate";
  }

  if (receipt.steps.some((step) => step.state === "rejected")) {
    result.recovery = "replan";
  }

  if (
    receipt.steps.some(
      (step) => step.state === "indeterminate" || step.state === "running"
    )
  ) {
    result.executionState = "partial";
    result.verificationState = "indeterminate";
    result.recovery = "verify-indeterminate";
  }

  if (
    receipt.cancellationRequested ||
    receipt.steps.some((step) => step.state === "cancelled")
  ) {
    result.executionState = "cancelled";
    result.recovery = "none";

    if (receipt.steps.some((step) => step.state === "cancelled")) {
      result.verificationState = "partial";
    }
  }

  return result;
};

const failedEffect = (
  pending: OperationStep,
  message: string,
  replay: OperationAdapter["replay"],
  timedOut: boolean
): OperationEffectResult => ({
  step: {
    ...pending,
    gaps: [message],
    remainingWork:
      "Verify existing progress or create a new bounded plan after resolving this gap.",
    state:
      timedOut || replay === "probe-required" ? "indeterminate" : "unavailable",
  },
});

const failedAgentEffect = (
  pending: OperationStep,
  error: AgentError,
  replay: OperationAdapter["replay"]
): OperationEffectResult => {
  if (error.code === "budget-exhausted" && error.recovery.action === "replan") {
    return {
      step: {
        ...pending,
        gaps: [error.message],
        remainingWork:
          "Create a new bounded plan using the retained work measurements.",
        state: "rejected",
      },
    };
  }

  return failedEffect(
    pending,
    error.message,
    replay,
    error.code === "budget-exhausted"
  );
};

export const makeOperationService = Effect.fn("makeOperationService")(
  function* makeOperationService(
    store: AgentStoreService,
    adapters: readonly OperationAdapter[]
  ) {
    const scope = yield* Scope.Scope;
    const semaphore = yield* Semaphore.make(1);

    const active = new Map<
      string,
      Deferred.Deferred<OperationReceipt, AgentStoreFailure>
    >();

    const jobs = new Map<string, ExecutionJob>();
    const owned = new Set<string>();
    const acquisitions = new Map<string, SharedAcquisition>();
    const budgets = new Map<string, OperationWorkBudget>();

    const byKind: Partial<Record<OperationKind, OperationAdapter>> = {};

    for (const adapter of adapters) {
      byKind[adapter.descriptor.kind] = adapter;
    }

    const current = (handle: AgentHandle) =>
      store.identity.pipe(
        Effect.flatMap((identity) =>
          store.getOperation({
            ...handle,
            storeGeneration: identity.storeGeneration,
            storeId: identity.storeId,
          })
        )
      );

    const save = (
      receipt: OperationReceipt,
      patch: Partial<OperationReceipt>
    ) => store.updateOperation({ ...receipt, ...patch }, receipt.revision);

    const acquire = Effect.fn("OperationService.acquire")(function* acquire(
      plan: OperationPlan,
      step: OperationStep,
      operation: AgentHandle,
      work: Effect.Effect<OperationEffectResult, AgentStoreFailure>
    ) {
      const key = `${operationScopeDigest(plan)}|${JSON.stringify(plan.preconditions)}|${step.id}`;
      const existing = acquisitions.get(key);

      if (existing !== undefined) {
        const sharedRef: AgentRef = {
          ...existing.operation,
          basisId: null,
          kind: "operation",
          version: OPERATION_SCHEMA_VERSION,
        };

        const waitingReceipt = yield* current(operation);
        yield* save(waitingReceipt, {
          verificationRefs: uniquePayloads([
            ...waitingReceipt.verificationRefs,
            sharedRef,
          ]),
        });
        const result = yield* Deferred.await(existing.done);

        return {
          ...result,
          step: {
            ...result.step,
            gaps: [
              ...result.step.gaps,
              "This caller reused compatible acquisition work within the same scope and bounds.",
            ].slice(0, 64),
          },
          verificationRefs: [
            ...(result.verificationRefs ?? []),
            {
              ...existing.operation,
              basisId: null,
              kind: "operation",
              version: OPERATION_SCHEMA_VERSION,
            },
          ],
        } satisfies OperationEffectResult;
      }

      const done = yield* Deferred.make<
        OperationEffectResult,
        AgentStoreFailure
      >();

      const shared = { done, operation };
      acquisitions.set(key, shared);

      const cleanup = Effect.sync(() => {
        if (acquisitions.get(key) === shared) {
          acquisitions.delete(key);
        }
      });

      yield* Effect.forkIn(
        work.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            cleanup.pipe(Effect.andThen(Deferred.done(done, exit)))
          ),
          Effect.ensuring(cleanup)
        ),
        scope
      );

      return yield* Deferred.await(done);
    });

    const recordResult = Effect.fn("OperationService.recordResult")(
      function* recordResult(
        receipt: OperationReceipt,
        result: OperationEffectResult,
        recovered: boolean,
        job: ExecutionJob
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(OperationStepSchema)(
          result.step
        ).pipe(
          Effect.mapError(() =>
            operationError(
              "invalid-transition",
              "The effect adapter returned an invalid step receipt."
            )
          )
        );

        const latest = yield* current(receipt);
        const previous = latest.steps.find((step) => step.id === decoded.id);

        const progress =
          previous === undefined
            ? decoded
            : {
                ...decoded,
                committedThrough:
                  decoded.committedThrough ?? previous.committedThrough,
                duplicates: recovered
                  ? Math.max(previous.duplicates, decoded.duplicates)
                  : previous.duplicates + decoded.duplicates,
                inserted: recovered
                  ? Math.max(previous.inserted, decoded.inserted)
                  : previous.inserted + decoded.inserted,
                rejected: mergeRejected(
                  previous.rejected,
                  decoded.rejected,
                  recovered
                ),
                retries: recovered
                  ? Math.max(previous.retries, decoded.retries)
                  : previous.retries + decoded.retries,
                safeCursor: decoded.safeCursor ?? previous.safeCursor,
                spooledRefs: [
                  ...new Set([...previous.spooledRefs, ...decoded.spooledRefs]),
                ],
              };

        const withStep = yield* store.appendOperationStep(
          latest,
          progress,
          latest.revision
        );

        return yield* save(withStep, {
          effects: mergeEffects(withStep.effects, result.effects, recovered),
          resources:
            job.adapter.meteredWork === true
              ? yield* job.budget.measurements
              : mergeResources(withStep.resources, result.resources, recovered),
          resultingBasisId:
            result.resultingBasisId ?? withStep.resultingBasisId,
          verificationRefs: uniquePayloads([
            ...withStep.verificationRefs,
            ...(result.verificationRefs ?? []),
          ]),
        });
      }
    );

    const prepare = Effect.fn("OperationService.prepare")(function* prepare(
      job: ExecutionJob,
      progress: ExecutionProgress
    ): Effect.fn.Return<OperationPhaseOutcome, AgentStoreFailure> {
      const { adapter, plan } = job;
      let receipt = yield* current(progress.receipt);

      if (
        receipt.executionState === "running" &&
        job.receipt.executionState !== "running"
      ) {
        return { phase: "done", receipt };
      }

      const changed =
        receipt.executionState === "planned"
          ? yield* adapter.validate(plan, { budget: job.budget })
          : [];

      if (changed.length > 0) {
        receipt = yield* save(receipt, {
          completedAt: yield* nowIso,
          executionState: "rejected",
          recovery: "replan",
          steps: [
            {
              committedThrough: null,
              duplicates: 0,
              gaps: changed.slice(0, 64),
              id: "preconditions",
              inserted: 0,
              rejected: 0,
              remainingWork: "Create a new plan for the changed scope.",
              retries: 0,
              safeCursor: null,
              source: null,
              spooledRefs: [],
              state: "rejected",
            },
          ],
          verificationState: "not-attempted",
        });

        return { phase: "done", receipt };
      }

      if (receipt.cancellationRequested) {
        receipt = yield* save(receipt, {
          completedAt: yield* nowIso,
          executionState: "cancelled",
          recovery: "none",
        });

        return { phase: "done", receipt };
      }

      progress.selected = adapter.steps(plan);

      if (progress.selected.length > 256) {
        return yield* operationError(
          "budget-exhausted",
          "The operation exceeds the 256-step journal limit."
        );
      }

      let resources =
        receipt.executionState === "planned"
          ? initialResources(adapter)
          : receipt.resources;

      if (adapter.meteredWork === true) {
        resources = yield* job.budget.measurements;
      }

      progress.receipt = yield* save(receipt, {
        completedAt: null,
        executionState: "running",
        resources,
        startedAt: receipt.startedAt ?? progress.attemptStartedAt,
      });
      owned.add(receipt.id);

      return { phase: "next", receipt: null };
    });

    const next = Effect.fn("OperationService.next")(function* next(
      _job: ExecutionJob,
      progress: ExecutionProgress
    ): Effect.fn.Return<OperationPhaseOutcome, AgentStoreFailure> {
      progress.receipt = yield* current(progress.receipt);
      const pending = progress.selected[progress.position];

      if (pending === undefined) {
        return { phase: "finalize", receipt: null };
      }

      progress.pending = pending;

      const recorded = progress.receipt.steps.find(
        (step) => step.id === pending.id
      );

      if (recorded !== undefined && finishedStep(recorded)) {
        progress.position += 1;

        return { phase: "next", receipt: null };
      }

      if (progress.receipt.cancellationRequested) {
        return { phase: "cancel", receipt: null };
      }

      return {
        phase:
          recorded !== undefined &&
          ["running", "indeterminate", "partial", "spooled"].includes(
            recorded.state
          )
            ? "recover"
            : "execute",
        receipt: null,
      };
    });

    const recover = Effect.fn("OperationService.recover")(function* recover(
      job: ExecutionJob,
      progress: ExecutionProgress
    ): Effect.fn.Return<OperationPhaseOutcome, AgentStoreFailure> {
      const { pending } = progress;

      if (pending === null) {
        return yield* operationError(
          "invalid-transition",
          "Recovery requires a selected step."
        );
      }

      progress.receipt = yield* current(progress.receipt);

      const recorded = progress.receipt.steps.find(
        (step) => step.id === pending.id
      );

      if (recorded === undefined) {
        return { phase: "execute", receipt: null };
      }

      const probe = yield* job.adapter.probe(
        job.plan,
        recorded,
        progress.receipt,
        { budget: job.budget }
      );

      if (probe.state === "complete") {
        progress.receipt = yield* recordResult(
          progress.receipt,
          probe.result,
          true,
          job
        );
        progress.position += 1;

        return { phase: "next", receipt: null };
      }

      if (probe.state === "indeterminate") {
        progress.receipt = yield* recordResult(
          progress.receipt,
          {
            step: {
              ...recorded,
              gaps: [...recorded.gaps, probe.reason].slice(0, 64),
              remainingWork: "Verify the existing effect before retrying.",
              state: "indeterminate",
            },
          },
          true,
          job
        );
        progress.position += 1;

        return { phase: "next", receipt: null };
      }

      const changed = yield* job.adapter.validate(job.plan, {
        budget: job.budget,
      });

      if (changed.length > 0) {
        progress.receipt = yield* recordResult(
          progress.receipt,
          {
            step: {
              ...recorded,
              gaps: [...recorded.gaps, ...changed].slice(0, 64),
              remainingWork:
                "Create a new plan for the changed source or configuration.",
              state: "rejected",
            },
          },
          true,
          job
        );
        progress.position += 1;

        return { phase: "next", receipt: null };
      }

      return { phase: "execute", receipt: null };
    });

    const execute = Effect.fn("OperationService.execute")(function* execute(
      job: ExecutionJob,
      progress: ExecutionProgress
    ): Effect.fn.Return<OperationPhaseOutcome, AgentStoreFailure> {
      const { adapter, input, plan } = job;
      const { pending } = progress;

      if (pending === null) {
        return yield* operationError(
          "invalid-transition",
          "Execution requires a selected step."
        );
      }

      let receipt = yield* current(progress.receipt);
      const recorded = receipt.steps.find((step) => step.id === pending.id);
      const now = yield* DateTime.now;

      const elapsed =
        DateTime.toEpochMillis(now) -
        DateTime.toEpochMillis(
          DateTime.makeUnsafe(receipt.startedAt ?? plan.createdAt)
        );

      const remaining = plan.bounds.maxElapsedMs - elapsed;

      const retry =
        recorded !== undefined &&
        ["running", "indeterminate", "partial", "spooled"].includes(
          recorded.state
        );

      const retryBudgetExhausted =
        retry && recorded.retries >= plan.bounds.maxRetries;

      if (
        remaining <= 0 ||
        plan.expiresAt <= DateTime.formatIso(now) ||
        retryBudgetExhausted
      ) {
        progress.resultRecovered = true;
        progress.result = {
          step: {
            ...(recorded ?? pending),
            gaps: [
              retryBudgetExhausted
                ? "The reviewed retry budget is exhausted."
                : "The reviewed elapsed-time budget or plan validity is exhausted.",
            ],
            remainingWork:
              "Create a new bounded plan using the retained progress.",
            state: "rejected",
          },
        };

        return { phase: "commit", receipt: null };
      }

      receipt = yield* store.appendOperationStep(
        receipt,
        { ...(recorded ?? pending), state: "running" },
        receipt.revision
      );
      progress.receipt = receipt;

      if (adapter.meteredWork === true) {
        yield* job.budget.remaining;

        if (retry) {
          yield* job.budget.charge({
            bytesRead: 0,
            filesRead: 0,
            recordsDecoded: 0,
            requests: 0,
            retries: 1,
          });
        }
      }

      const effect = adapter.execute(plan, pending, {
        budget: job.budget,
        confirmation: input.confirmation ?? null,
        operation: receipt,
      });

      const boundedEffect =
        adapter.descriptor.cancellation === "before-start-only"
          ? effect
          : effect.pipe(
              Effect.timeout(remaining),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  operationError(
                    "budget-exhausted",
                    "The acquisition exceeded its reviewed elapsed-time budget."
                  )
                )
              )
            );

      const acquisition =
        plan.kind === "collect" && adapter.replay === "safe"
          ? acquire(plan, pending, receipt, boundedEffect)
          : boundedEffect;

      const callerBounded =
        plan.kind === "collect"
          ? acquisition.pipe(
              Effect.timeout(remaining),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  operationError(
                    "budget-exhausted",
                    "This caller exhausted its reviewed acquisition time budget."
                  )
                )
              )
            )
          : acquisition;

      const result = yield* callerBounded.pipe(
        Effect.catchTag("AgentError", (error) =>
          Effect.succeed(failedAgentEffect(pending, error, adapter.replay))
        ),
        Effect.catch((error) =>
          Effect.succeed(
            failedEffect(pending, error.message, adapter.replay, false)
          )
        )
      );

      progress.resultRecovered = false;
      progress.result = executionResult(result, retry);

      return { phase: "commit", receipt: null };
    });

    const commit = Effect.fn("OperationService.commit")(function* commit(
      job: ExecutionJob,
      progress: ExecutionProgress
    ): Effect.fn.Return<OperationPhaseOutcome, AgentStoreFailure> {
      if (progress.result === null) {
        return yield* operationError(
          "invalid-transition",
          "Commit requires a measured effect result."
        );
      }

      progress.receipt = yield* recordResult(
        progress.receipt,
        progress.result,
        progress.resultRecovered,
        job
      );
      progress.result = null;
      progress.position += 1;

      return { phase: "next", receipt: null };
    });

    const cancel = Effect.fn("OperationService.cancel")(function* cancel(
      _job: ExecutionJob,
      progress: ExecutionProgress
    ): Effect.fn.Return<OperationPhaseOutcome, AgentStoreFailure> {
      const { pending } = progress;

      if (pending === null) {
        return yield* operationError(
          "invalid-transition",
          "Cancellation requires a selected step."
        );
      }

      const receipt = yield* current(progress.receipt);
      const recorded = receipt.steps.find((step) => step.id === pending.id);
      progress.receipt = yield* store.appendOperationStep(
        receipt,
        {
          ...(recorded ?? pending),
          remainingWork:
            "Further work was cancelled; committed and staged progress remains stored.",
          state: "cancelled",
        },
        receipt.revision
      );
      progress.position += 1;

      return { phase: "next", receipt: null };
    });

    const finalize = Effect.fn("OperationService.finalize")(function* finalize(
      job: ExecutionJob,
      progress: ExecutionProgress
    ): Effect.fn.Return<OperationPhaseOutcome, AgentStoreFailure> {
      const receipt = yield* current(progress.receipt);
      const identity = yield* store.identity;
      const now = yield* DateTime.now;

      const elapsedMs = Math.max(
        0,
        DateTime.toEpochMillis(now) -
          DateTime.toEpochMillis(
            DateTime.makeUnsafe(receipt.startedAt ?? progress.attemptStartedAt)
          )
      );

      const resources =
        job.adapter.meteredWork === true
          ? yield* job.budget.measurements
          : { ...receipt.resources, elapsedMs };

      progress.receipt = yield* save(receipt, {
        afterRevision: identity.revision,
        completedAt: yield* nowIso,
        effects: {
          ...receipt.effects,
          remainingStoreGeneration: identity.storeGeneration,
        },
        resources,
        ...completedState(receipt, job.adapter.replay),
      });

      return { phase: "done", receipt: progress.receipt };
    });

    const markInterrupted = (job: ExecutionJob) =>
      owned.has(job.receipt.id)
        ? current(job.receipt).pipe(
            Effect.flatMap((receipt) =>
              terminal(receipt)
                ? Effect.void
                : save(receipt, {
                    completedAt: null,
                    executionState: "interrupted",
                    recovery:
                      job.adapter.replay === "safe"
                        ? "safe-resume"
                        : "verify-indeterminate",
                    verificationState: "indeterminate",
                  }).pipe(Effect.asVoid)
            ),
            Effect.ignore
          )
        : Effect.void;

    const progressById = new Map<string, ExecutionProgress>();

    const recordBudget = Effect.fn("OperationService.recordBudget")(
      function* recordBudget(job: ExecutionJob) {
        if (job.adapter.meteredWork !== true) {
          return;
        }

        const receipt = yield* current(job.receipt);
        yield* save(receipt, { resources: yield* job.budget.measurements });
      }
    );

    const phase =
      (
        handler: (
          job: ExecutionJob,
          progress: ExecutionProgress
        ) => Effect.Effect<OperationPhaseOutcome, AgentStoreFailure>,
        boundedValidation = false
      ) =>
      (id: string) => {
        const job = jobs.get(id);
        const progress = progressById.get(id);

        return job === undefined || progress === undefined
          ? Effect.fail(
              operationError(
                "operation-not-found",
                "The operation execution context is unavailable."
              )
            )
          : (boundedValidation
              ? Effect.gen(function* validationWithinBudget() {
                  const now = yield* DateTime.now;

                  const remaining =
                    job.plan.bounds.maxElapsedMs -
                    (DateTime.toEpochMillis(now) -
                      DateTime.toEpochMillis(
                        DateTime.makeUnsafe(progress.attemptStartedAt)
                      ));

                  if (remaining <= 0) {
                    return yield* operationError(
                      "budget-exhausted",
                      "The reviewed validation time budget is exhausted."
                    );
                  }

                  return yield* handler(job, progress).pipe(
                    Effect.timeout(remaining),
                    Effect.catchTag("TimeoutError", () =>
                      Effect.fail(
                        operationError(
                          "budget-exhausted",
                          "The reviewed validation or recovery time budget is exhausted."
                        )
                      )
                    )
                  );
                })
              : handler(job, progress)
            ).pipe(
              Effect.onExit((exit) =>
                Effect.uninterruptible(
                  recordBudget(job).pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Exit.isFailure(exit) ? markInterrupted(job) : Effect.void
                    )
                  )
                )
              )
            );
      };

    const execution = OperationExecution.of({
      cancel: phase(cancel),
      commit: phase(commit),
      execute: phase(execute),
      finalize: phase(finalize),
      next: phase(next),
      prepare: phase(prepare, true),
      recover: phase(recover, true),
    });

    const start = Effect.fn("OperationService.start")(function* start(
      job: ExecutionJob
    ) {
      const waiting = active.get(job.receipt.id);

      if (waiting !== undefined) {
        return waiting;
      }

      const done = yield* Deferred.make<OperationReceipt, AgentStoreFailure>();
      active.set(job.receipt.id, done);
      jobs.set(job.receipt.id, job);
      progressById.set(job.receipt.id, {
        attemptStartedAt: job.attemptedAt,
        pending: null,
        position: 0,
        receipt: job.receipt,
        result: null,
        resultRecovered: false,
        selected: [],
      });

      const run = Effect.scoped(
        Effect.gen(function* runMachine() {
          const output = yield* runOperationMachine(job.receipt.id);

          if (output?.error !== undefined) {
            if (
              Schema.is(AgentError)(output.error) &&
              output.error.code === "revision-conflict"
            ) {
              return yield* current(job.receipt);
            }

            return yield* Effect.fail(output.error);
          }

          if (output?.receipt === undefined) {
            yield* markInterrupted(job);
          }

          const receipt = yield* current(output?.receipt ?? job.receipt);
          const progress = progressById.get(job.receipt.id);

          if (progress !== undefined) {
            progress.receipt = receipt;
          }

          return receipt;
        })
      ).pipe(Effect.provideService(OperationExecution, execution));

      const cleanup = Effect.sync(() => {
        if (active.get(job.receipt.id) === done) {
          active.delete(job.receipt.id);
          const progress = progressById.get(job.receipt.id);

          if (
            progress !== undefined &&
            (terminal(progress.receipt) ||
              (progress.receipt.executionState === "partial" &&
                progress.receipt.recovery !== "safe-resume"))
          ) {
            budgets.delete(job.receipt.id);
          }

          jobs.delete(job.receipt.id);
          progressById.delete(job.receipt.id);
          owned.delete(job.receipt.id);
        }
      });

      yield* Effect.forkIn(
        run.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.uninterruptible(markInterrupted(job))
              : Effect.void
          ),
          Effect.exit,
          Effect.flatMap((exit) =>
            cleanup.pipe(Effect.andThen(Deferred.done(done, exit)))
          ),
          Effect.ensuring(cleanup)
        ),
        scope
      );

      return done;
    });

    const planOperation = Effect.fn("OperationService.plan")(
      function* planOperation(input: OperationPlanInput) {
        const identity = yield* store.identity;

        if (
          identity.storeId !== input.target.storeId ||
          identity.storeGeneration !== input.target.storeGeneration
        ) {
          return yield* operationError(
            "stale-generation",
            "The selected store identity or generation changed. Resolve the current store before planning."
          );
        }

        const adapter = byKind[input.arguments.kind];

        if (adapter === undefined || !adapter.descriptor.enabled) {
          return yield* operationError(
            "source-unavailable",
            adapter?.descriptor.reason ??
              "No installed effect adapter supports this operation."
          );
        }

        const planningNow = yield* DateTime.now;

        const planningBudget = yield* createOperationWorkBudget(
          input.bounds,
          DateTime.toEpochMillis(planningNow)
        );

        const prepared = yield* adapter.prepare(input, {
          budget: planningBudget,
        });

        if (prepared.arguments.kind !== input.arguments.kind) {
          return yield* operationError(
            "invalid-transition",
            "An adapter cannot change the reviewed operation kind."
          );
        }

        if (
          (prepared.forecast.bytes ?? 0) > input.bounds.maxBytes ||
          (prepared.forecast.requests ?? 0) > input.bounds.maxRequests
        ) {
          return yield* operationError(
            "budget-exhausted",
            "The selected effect exceeds the reviewed byte or request limit."
          );
        }

        const created = yield* DateTime.now;

        const candidate: OperationPlan = {
          ...prepared,
          bounds: input.bounds,
          consent: {
            ...prepared.consent,
            scopeDigest: operationDigest({
              arguments: prepared.arguments,
              bounds: input.bounds,
              effects: prepared.effects,
              scope: input.scope,
              storeGeneration: identity.storeGeneration,
              storeId: identity.storeId,
            }),
          },
          createdAt: DateTime.formatIso(created),
          expiresAt: DateTime.formatIso(DateTime.add(created, { minutes: 15 })),
          id: randomUUID(),
          kind: prepared.arguments.kind,
          planDigest: "pending",
          preconditions: [
            {
              allowAppend: false,
              expected: String(identity.storeGeneration),
              kind: "store-generation",
              target: identity.storeId,
            },
            ...prepared.preconditions,
          ],
          purpose: input.purpose,
          schemaVersion: OPERATION_SCHEMA_VERSION,
          scope: input.scope,
          storeGeneration: identity.storeGeneration,
          storeId: identity.storeId,
          validity: "valid",
        };

        const normalized = yield* Schema.decodeUnknownEffect(
          OperationPlanSchema
        )(candidate).pipe(
          Effect.mapError(() =>
            operationError(
              "invalid-selector",
              "The normalized operation plan exceeds its schema bounds."
            )
          )
        );

        const plan = {
          ...normalized,
          planDigest: digestOperationPlan(normalized),
        };

        yield* store.putOperationPlan(plan);

        return plan;
      }
    );

    const budgetForReceipt = Effect.fn("OperationService.budgetForReceipt")(
      function* budgetForReceipt(
        plan: OperationPlan,
        receipt: OperationReceipt,
        attemptedAt: string
      ) {
        const existing = budgets.get(receipt.id);

        if (existing !== undefined) {
          return existing;
        }

        const budget = yield* createOperationWorkBudget(
          plan.bounds,
          DateTime.toEpochMillis(DateTime.makeUnsafe(attemptedAt)),
          receipt.startedAt === null ? undefined : receipt.resources
        );

        if (budgets.size >= 256) {
          const oldest = budgets.keys().next().value;

          if (oldest !== undefined) {
            budgets.delete(oldest);
          }
        }

        budgets.set(receipt.id, budget);

        return budget;
      }
    );

    const applyOperation = Effect.fn("OperationService.apply")(
      function* applyOperation(input: OperationApplyInput) {
        const attemptedAt = yield* nowIso;

        const claimed = yield* semaphore.withPermit(
          Effect.gen(function* claim() {
            const reserved = yield* store.reserveOperation(
              input.plan,
              input.expectedDigest,
              input.idempotencyKey
            );

            if (
              reserved.receipt.storeGeneration !== input.plan.storeGeneration ||
              reserved.receipt.storeId !== input.plan.storeId
            ) {
              return { done: null, receipt: reserved.receipt, reused: true };
            }

            if (
              terminal(reserved.receipt) ||
              (reserved.receipt.executionState === "partial" &&
                reserved.receipt.recovery !== "safe-resume")
            ) {
              return {
                done: null,
                receipt: reserved.receipt,
                reused: reserved.reused,
              };
            }

            const prior = active.get(reserved.receipt.id);

            if (prior !== undefined) {
              return { done: prior, receipt: reserved.receipt, reused: true };
            }

            if (reserved.receipt.executionState === "running") {
              return { done: null, receipt: reserved.receipt, reused: true };
            }

            const plan = yield* store.getOperationPlan(input.plan);

            if (
              plan.planDigest !== input.expectedDigest ||
              digestOperationPlan(plan) !== input.expectedDigest
            ) {
              return yield* operationError(
                "idempotency-conflict",
                "The expected digest does not identify this reviewed plan."
              );
            }

            const adapter = byKind[plan.kind];

            if (adapter === undefined || !adapter.descriptor.enabled) {
              return yield* operationError(
                "source-unavailable",
                "The reviewed effect adapter is unavailable in this build."
              );
            }

            const budget = yield* budgetForReceipt(
              plan,
              reserved.receipt,
              attemptedAt
            );

            const nowForAuthorization = yield* DateTime.now;

            const authorizationRemaining =
              plan.bounds.maxElapsedMs -
              (DateTime.toEpochMillis(nowForAuthorization) -
                DateTime.toEpochMillis(DateTime.makeUnsafe(attemptedAt)));

            if (authorizationRemaining <= 0) {
              return yield* operationError(
                "budget-exhausted",
                "The reviewed authorization time budget is exhausted."
              );
            }

            const authorized = yield* adapter
              .authorize(plan, input, { budget })
              .pipe(
                Effect.timeout(authorizationRemaining),
                Effect.catchTag("TimeoutError", () =>
                  Effect.fail(
                    operationError(
                      "budget-exhausted",
                      "The reviewed authorization time budget is exhausted."
                    )
                  )
                )
              );

            const authorizedReceipt =
              adapter.meteredWork === true
                ? yield* save(yield* current(reserved.receipt), {
                    resources: yield* budget.measurements,
                    startedAt: reserved.receipt.startedAt ?? attemptedAt,
                  })
                : reserved.receipt;

            if (!authorized) {
              return yield* operationError(
                "authorization-required",
                "Authorization must cover this exact reviewed scope; arbitrary receipt IDs do not grant access."
              );
            }

            const now = yield* nowIso;

            if (plan.validity !== "valid" || plan.expiresAt <= now) {
              const receipt = yield* save(authorizedReceipt, {
                completedAt: now,
                executionState: "expired",
                recovery: "replan",
              });

              return { done: null, receipt, reused: reserved.reused };
            }

            const done = yield* start({
              adapter,
              attemptedAt,
              budget,
              input,
              plan,
              receipt: authorizedReceipt,
            });

            return { done, receipt: reserved.receipt, reused: reserved.reused };
          })
        );

        return {
          action: "apply",
          receipt:
            claimed.done === null
              ? claimed.receipt
              : yield* Deferred.await(claimed.done),
          reused: claimed.reused,
        } satisfies OperationOutput;
      }
    );

    const run = Effect.fn("OperationService.run")(function* run(
      input: OperationInput
    ) {
      const decoded = yield* Schema.decodeUnknownEffect(OperationInputSchema)(
        input
      ).pipe(
        Effect.mapError(() =>
          operationError(
            "invalid-selector",
            "The operation request is invalid or exceeds its bounds."
          )
        )
      );

      switch (decoded.action) {
        case "plan": {
          return {
            action: "plan",
            plan: yield* planOperation(decoded),
          } satisfies OperationOutput;
        }

        case "apply": {
          return yield* applyOperation(decoded);
        }

        case "get": {
          const receipt = yield* store.getOperation(decoded.operation);

          const retainedPlan = yield* store.getOperationPlanForReceipt(
            decoded.operation
          );

          const reviewedPlan =
            retainedPlan !== null &&
            retainedPlan.id === receipt.planId &&
            retainedPlan.planDigest === receipt.planDigest &&
            digestOperationPlan(retainedPlan) === receipt.planDigest
              ? retainedPlan
              : null;

          return {
            action: "get",
            receipt,
            reviewedPlan,
            reviewedPlanUnavailableReason:
              reviewedPlan === null
                ? "The immutable reviewed plan is unavailable; a new operation requires a separately reviewed scope."
                : null,
          } satisfies OperationOutput;
        }

        case "cancel": {
          return {
            action: "cancel",
            receipt: yield* store.requestOperationCancellation(
              decoded.operation,
              decoded.expectedRevision
            ),
          } satisfies OperationOutput;
        }

        default: {
          return yield* operationError(
            "invalid-selector",
            "The operation action is unsupported."
          );
        }
      }
    });

    const descriptors: OperationDescriptor[] = [];

    for (const kind of kinds) {
      descriptors[descriptors.length] =
        byKind[kind]?.descriptor ?? disabledDescriptor(kind);
    }

    return { descriptors, run } satisfies OperationServiceApi;
  }
);

export class OperationService extends Context.Service<
  OperationService,
  OperationServiceApi
>()("@rat-stack/core/dx/OperationService") {
  static readonly layer = (adapters: readonly OperationAdapter[]) =>
    Layer.effect(
      this,
      AgentStore.pipe(
        Effect.flatMap((store) => makeOperationService(store, adapters))
      )
    );
}

export const runOperation = (
  input: OperationInput
): Effect.Effect<OperationOutput, AgentStoreFailure, OperationService> =>
  OperationService.use((service) => service.run(input));
