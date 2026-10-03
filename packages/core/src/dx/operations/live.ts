// @effect-diagnostics-next-line nodeBuiltinImport:off -- Administration targets must be canonical local paths at the live-engine boundary.
import path from "node:path";

import { Effect, Result, Schema } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../contracts/agent-store.js";
import type { LiveEngine } from "../live/engine.js";
import { configPath } from "../live/home.js";
import type { LiveActionError } from "../live/home.js";
import type {
  AdministrationResources,
  LiveAdministrationPreview,
  LiveAdministrationRequest,
  LiveAdministrationResult,
  RetainedAdministrationReview,
} from "../live/store-admin.js";
import { AgentRefSchema } from "../model/agent-common.js";
import type {
  AgentRef,
  AgentScope,
  StoreIdentity,
} from "../model/agent-common.js";
import { OPERATION_SCHEMA_VERSION } from "../model/agent-operation.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
  OperationPrecondition,
  OperationReceipt,
} from "../model/agent-operation.js";
import { contextForRepo } from "../registry/runtime.js";
import { sameOperationRefs } from "./digest.js";
import { operationStep } from "./ports.js";
import type {
  OperationAdapter,
  OperationEffectResult,
  OperationPlanInput,
  OperationPreparation,
  OperationProbe,
  OperationWorkContext,
} from "./ports.js";
import { operationError } from "./service.js";

const ADMINISTRATION_VERSION = "dx.live-administration.v1";

type AdministrationKind = LiveAdministrationRequest["kind"];

export type LiveAdministrationBackend = Pick<
  LiveEngine,
  | "home"
  | "previewAdministration"
  | "applyReviewedAdministration"
  | "probeReviewedAdministration"
>;

export interface LiveAdministrationTarget {
  readonly path: string;
  readonly repoId: string;
  readonly worktreeId: string;
}

export type LiveAdministrationTargetResolver = (
  scope: AgentScope
) => Effect.Effect<LiveAdministrationTarget, AgentStoreFailure>;

const ConfigureSettingsSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["add-repo", "remove-repo"]),
    target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    action: Schema.Literal("cursor-usage"),
    enabled: Schema.Literals(["true", "false"]),
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });

const RetainedRequestSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("delete"), target: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("reset") }),
  Schema.Struct({ backupId: Schema.String, kind: Schema.Literal("restore") }),
  Schema.Struct({
    action: Schema.Literals(["add-repo", "remove-repo"]),
    kind: Schema.Literal("configure"),
    target: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("cursor-usage"),
    enabled: Schema.Boolean,
    kind: Schema.Literal("configure"),
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });

const RefListSchema = Schema.fromJsonString(Schema.Array(Schema.String));

const mapLiveError = (error: LiveActionError) => {
  const message = error.message.slice(0, 4096);

  if (error.reason === "stale-plan") {
    return operationError("plan-stale", message);
  }

  if (error.reason === "confirmation") {
    return operationError("authorization-required", message);
  }

  if (error.reason === "outside-home") {
    return operationError("scope-denied", message);
  }

  return operationError(
    /budget|bound|limit exceeded/u.test(message)
      ? "budget-exhausted"
      : "source-unavailable",
    message
  );
};

const meteredAdministration = Effect.fn(
  "liveAdministration.meteredAdministration"
)(function* meteredAdministration<
  A extends { readonly resources: AdministrationResources },
>(
  context: OperationWorkContext,
  run: (limits: OperationBounds) => Effect.Effect<A, LiveActionError>,
  retainAccountingFailure?: (result: A, error: AgentStoreFailure) => A
): Effect.fn.Return<A, AgentStoreFailure> {
  const remaining = yield* context.budget.remaining;

  const outcome = yield* Effect.result(run(remaining));

  if (Result.isFailure(outcome)) {
    const { resources } = outcome.failure;

    const usage =
      resources === undefined
        ? {
            byteUnits: remaining.maxBytes,
            bytesRead: null,
            filesRead: remaining.maxFiles,
            recordUnits: remaining.maxRecords,
            recordsDecoded: null,
            requests: 0,
            retries: 0,
          }
        : {
            bytesRead: resources.bytesRead,
            filesRead: resources.filesRead,
            recordsDecoded: resources.recordsDecoded,
            requests: 0,
            retries: 0,
          };

    yield* context.budget.charge(usage);

    return yield* mapLiveError(outcome.failure);
  }

  const { resources } = outcome.success;

  const charged = yield* Effect.result(
    context.budget.charge({
      bytesRead: resources.bytesRead,
      filesRead: resources.filesRead,
      recordsDecoded: resources.recordsDecoded,
      requests: 0,
      retries: 0,
    })
  );

  if (Result.isFailure(charged)) {
    return retainAccountingFailure === undefined
      ? yield* charged.failure
      : retainAccountingFailure(outcome.success, charged.failure);
  }

  return outcome.success;
});

const precondition = (
  kind: OperationPrecondition["kind"],
  target: string,
  expected: string
): OperationPrecondition => ({ allowAppend: false, expected, kind, target });

const expectedValue = (
  plan: OperationPlan,
  kind: OperationPrecondition["kind"],
  target: string
): string | undefined =>
  plan.preconditions.find(
    (entry) => entry.kind === kind && entry.target === target
  )?.expected;

const unrestrictedSelection = (scope: AgentScope): boolean =>
  scope.branchSelection.kind === "all" &&
  scope.branchSelection.branches.length === 0 &&
  scope.flightId === null &&
  scope.sources.length === 0 &&
  scope.tools.length === 0;

const wholeStoreScope = (scope: AgentScope): boolean =>
  scope.repoId === null &&
  scope.worktreeId === null &&
  unrestrictedSelection(scope);

const targetMatchesScope = (
  target: LiveAdministrationTarget,
  scope: AgentScope
): boolean =>
  scope.repoId !== null &&
  scope.worktreeId !== null &&
  target.repoId === scope.repoId &&
  target.worktreeId === scope.worktreeId &&
  path.isAbsolute(target.path) &&
  target.path === path.resolve(target.path);

const canonicalTarget: LiveAdministrationTargetResolver = Effect.fn(
  "liveAdministration.canonicalTarget"
)(function* canonicalTarget(scope) {
  if (
    scope.repoId === null ||
    scope.worktreeId === null ||
    !path.isAbsolute(scope.repoId) ||
    !path.isAbsolute(scope.worktreeId) ||
    scope.repoId !== path.resolve(scope.repoId) ||
    scope.worktreeId !== path.resolve(scope.worktreeId)
  ) {
    return yield* operationError(
      "scope-denied",
      "Select explicit canonical repository and worktree paths or provide an identity resolver."
    );
  }

  const actual = contextForRepo(scope.worktreeId);

  if (
    actual.repoCommonDir !== scope.repoId ||
    actual.worktreePath !== scope.worktreeId
  ) {
    return yield* operationError(
      "scope-denied",
      "The current Git repository and worktree identities do not match the selected scope."
    );
  }

  return {
    path: scope.worktreeId,
    repoId: scope.repoId,
    worktreeId: scope.worktreeId,
  };
});

const selectedRef = (id: string, identity: StoreIdentity): AgentRef => ({
  basisId: null,
  id,
  kind: "evidence",
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  version: ADMINISTRATION_VERSION,
});

const retainedRefs = (
  refs: readonly string[]
): readonly OperationPrecondition[] => {
  const chunks: string[][] = [];
  let chunk: string[] = [];

  for (const ref of refs) {
    if (JSON.stringify([...chunk, ref]).length > 4096 && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
    }

    chunk.push(ref);
  }

  chunks.push(chunk);

  return chunks.map((values, index) =>
    precondition(
      "selected-content",
      `administration.refs.${String(index)}`,
      JSON.stringify(values)
    )
  );
};

const requestFor = Effect.fn("liveAdministration.requestFor")(
  function* requestFor(
    engine: LiveAdministrationBackend,
    input: Pick<OperationPlanInput, "arguments" | "scope">,
    resolveTarget: LiveAdministrationTargetResolver
  ): Effect.fn.Return<LiveAdministrationRequest, AgentStoreFailure> {
    const args = input.arguments;

    if (args.kind === "configure") {
      if (args.path !== configPath(engine.home)) {
        return yield* operationError(
          "scope-denied",
          "Configuration edits must select the live engine's exact config path."
        );
      }

      const settings = yield* Schema.decodeUnknownEffect(
        ConfigureSettingsSchema
      )(args.settings).pipe(
        Effect.mapError(() =>
          operationError(
            "invalid-selector",
            "Select an exact supported configuration action and its target or enabled value."
          )
        )
      );

      if (settings.action === "cursor-usage") {
        if (!wholeStoreScope(input.scope)) {
          return yield* operationError(
            "scope-denied",
            "Cursor account acquisition settings require an explicit whole-store scope."
          );
        }

        return {
          action: settings.action,
          enabled: settings.enabled === "true",
          kind: "configure",
        };
      }

      const target = yield* resolveTarget(input.scope);

      if (
        !targetMatchesScope(target, input.scope) ||
        target.path !== settings.target ||
        !unrestrictedSelection(input.scope)
      ) {
        return yield* operationError(
          "scope-denied",
          "The configuration target must match the selected repository and worktree identity exactly."
        );
      }

      return {
        action: settings.action,
        kind: "configure",
        target: target.path,
      };
    }

    if (args.kind === "delete") {
      if (!args.backupRequired || !unrestrictedSelection(input.scope)) {
        return yield* operationError(
          "scope-denied",
          "Repository deletion requires its entire unfiltered repository scope and a backup."
        );
      }

      const target = yield* resolveTarget(input.scope);

      if (!targetMatchesScope(target, input.scope)) {
        return yield* operationError(
          "scope-denied",
          "The deletion target must resolve the exact selected repository and worktree identity."
        );
      }

      return { kind: "delete", target: target.path };
    }

    if (args.kind !== "reset" && args.kind !== "restore") {
      return yield* operationError(
        "invalid-selector",
        "Select a live administration operation."
      );
    }

    if (
      !wholeStoreScope(input.scope) ||
      (args.kind === "reset" && !args.backupRequired)
    ) {
      return yield* operationError(
        "scope-denied",
        "Reset and restore require an explicit unfiltered whole-store scope and safety backup."
      );
    }

    return args.kind === "reset"
      ? { kind: "reset" }
      : { backupId: args.backupId, kind: "restore" };
  }
);

const confirmationFor = (preview: LiveAdministrationPreview): string => {
  const { request } = preview;

  if (preview.confirmText !== null) {
    return preview.confirmText;
  }

  if (request.kind === "restore") {
    return `restore ${request.backupId}`;
  }

  if (request.kind !== "configure") {
    return "";
  }

  return request.action === "cursor-usage"
    ? `configure cursor-usage ${String(request.enabled)}`
    : `configure ${request.action} ${request.target}`;
};

const currentlyAuthorized = (preview: LiveAdministrationPreview): boolean => {
  const { request, configuration } = preview;

  if (request.kind !== "configure") {
    return false;
  }

  if (request.action === "cursor-usage") {
    return !request.enabled || configuration.cursorUsageImport;
  }

  return (
    request.action === "remove-repo" ||
    configuration.repos.some((entry) => path.resolve(entry) === request.target)
  );
};

const retainReview = Effect.fn("liveAdministration.retainReview")(
  function* retainReview(
    plan: OperationPlan
  ): Effect.fn.Return<RetainedAdministrationReview, AgentStoreFailure> {
    const encoded = expectedValue(
      plan,
      "source-identity",
      "administration.request"
    );

    const fingerprint = expectedValue(
      plan,
      "selected-content",
      "administration.fingerprint"
    );

    const configDigest = expectedValue(
      plan,
      "config-digest",
      "administration.current-config"
    );

    if (
      encoded === undefined ||
      fingerprint === undefined ||
      configDigest === undefined
    ) {
      return yield* operationError(
        "plan-stale",
        "The retained administration review is incomplete."
      );
    }

    const request = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(RetainedRequestSchema)
    )(encoded).pipe(
      Effect.mapError(() =>
        operationError(
          "plan-stale",
          "The retained administration request is invalid."
        )
      )
    );

    const lists = plan.preconditions.filter(
      (entry) =>
        entry.kind === "selected-content" &&
        entry.target.startsWith("administration.refs.")
    );

    if (request.kind !== plan.kind || lists.length === 0) {
      return yield* operationError(
        "plan-stale",
        "The retained request kind or reviewed selection is missing."
      );
    }

    const selectedRefs: string[] = [];

    for (const entry of lists) {
      const decoded = yield* Schema.decodeUnknownEffect(RefListSchema)(
        entry.expected
      ).pipe(
        Effect.mapError(() =>
          operationError(
            "plan-stale",
            "The retained selected references are invalid."
          )
        )
      );

      selectedRefs.push(...decoded);
    }

    const resultConfigDigest = expectedValue(
      plan,
      "config-digest",
      "administration.result-config"
    );

    const retained: RetainedAdministrationReview = {
      configDigest,
      fingerprint,
      request,
      selectedRefs,
    };

    return resultConfigDigest === undefined
      ? retained
      : { ...retained, resultConfigDigest };
  }
);

const effectsFor = (
  engine: LiveAdministrationBackend,
  kind: AdministrationKind
): OperationPlan["effects"] => ({
  destructive: kind === "delete" || kind === "reset" || kind === "restore",
  networkDestinations: [],
  reads:
    kind === "configure"
      ? [configPath(engine.home)]
      : [engine.home.storePath, engine.home.dftHome],
  writes:
    kind === "configure"
      ? [configPath(engine.home)]
      : [engine.home.storePath, engine.home.dftHome],
});

const resultEffects = (
  result: LiveAdministrationResult,
  before: StoreIdentity,
  after: StoreIdentity
): OperationReceipt["effects"] => ({
  backupArtifacts: result.backupArtifacts.map((artifact) => ({
    ...artifact,
    restorationVersion: String(artifact.restorationVersion),
    storeGeneration: before.storeGeneration,
    storeId: before.storeId,
  })),
  backupIds: result.backupIds,
  configDigest: result.configDigest,
  evidenceIds: [],
  exportArtifacts: [],
  exports: [],
  filesChanged: result.filesChanged.slice(0, 256),
  remainingStoreGeneration: after.storeGeneration,
  removalReason: result.removalReason,
  removedCount: result.removedCount,
  removedRefs: result.removedRefs
    .slice(0, 500)
    .map((ref) => selectedRef(ref, before)),
});

const exactDeleteSelection = (
  args: Extract<OperationArguments, { kind: "delete" }>,
  refs: readonly string[],
  identity: StoreIdentity
): boolean =>
  sameOperationRefs(
    args.selectedRefs.map((ref) => ref.id),
    refs
  ) &&
  args.selectedRefs.every(
    (ref) =>
      ref.storeId === identity.storeId &&
      ref.storeGeneration === identity.storeGeneration &&
      ref.version === ADMINISTRATION_VERSION &&
      ref.kind === "evidence" &&
      ref.basisId === null
  );

const executionState = (
  result: LiveAdministrationResult
): OperationReceipt["steps"][number]["state"] => {
  if (
    result.partialErrors.length > 0 ||
    result.verificationUnavailable.length > 0 ||
    result.filesChanged.length > 256 ||
    result.removedRefs.length > 500
  ) {
    return "partial";
  }

  return result.kind === "configure" && result.filesChanged.length === 0
    ? "unchanged"
    : "committed";
};

const requiredInputs = (kind: AdministrationKind): readonly string[] => {
  if (kind === "configure") {
    return ["path", "expectedContentDigest", "settings"];
  }

  if (kind === "restore") {
    return ["backupId", "expectedContentDigest", "confirmation"];
  }

  return ["backupRequired", "confirmation"];
};

const assertReviewedInput = Effect.fn("liveAdministration.assertReviewedInput")(
  function* assertReviewedInput(
    input: OperationPlanInput,
    preview: LiveAdministrationPreview,
    resolveTarget: LiveAdministrationTargetResolver
  ) {
    if (
      preview.request.kind === "delete" &&
      (preview.plan === null ||
        !("repo" in preview.plan) ||
        (resolveTarget === canonicalTarget &&
          preview.plan.repo.commonDir !== input.scope.repoId))
    ) {
      return yield* operationError(
        "scope-denied",
        "The preview repository identity differs from the selected deletion scope."
      );
    }

    if (
      input.arguments.kind === "configure" &&
      input.arguments.expectedContentDigest !== preview.configDigest
    ) {
      return yield* operationError(
        "plan-stale",
        "The exact expected configuration content digest does not match."
      );
    }

    if (
      input.arguments.kind === "restore" &&
      input.arguments.expectedContentDigest !== preview.backupContentDigest
    ) {
      return yield* operationError(
        "plan-stale",
        "The selected backup content digest does not match."
      );
    }

    return true;
  }
);

export const makeLiveAdministrationAdapters = (
  engine: LiveAdministrationBackend,
  store: AgentStoreService,
  resolveTarget: LiveAdministrationTargetResolver = canonicalTarget
): readonly OperationAdapter[] => {
  const prepare = Effect.fn("liveAdministration.prepare")(function* prepare(
    input: OperationPlanInput,
    context: OperationWorkContext
  ): Effect.fn.Return<OperationPreparation, AgentStoreFailure> {
    const request = yield* requestFor(engine, input, resolveTarget);

    const preview = yield* meteredAdministration(context, (limits) =>
      engine.previewAdministration(request, limits)
    );

    const identity = yield* store.identity;

    yield* assertReviewedInput(input, preview, resolveTarget);

    const refs: AgentRef[] = [];

    for (const refId of preview.selectedRefs) {
      const ref = yield* Schema.decodeUnknownEffect(AgentRefSchema)(
        selectedRef(refId, identity)
      ).pipe(
        Effect.mapError(() =>
          operationError(
            "invalid-selector",
            "The administration selection cannot be represented by bounded references."
          )
        )
      );

      refs.push(ref);
    }

    if (
      input.arguments.kind === "delete" &&
      input.arguments.selectedRefs.length > 0 &&
      !exactDeleteSelection(input.arguments, preview.selectedRefs, identity)
    ) {
      return yield* operationError(
        "scope-denied",
        "A nonempty deletion selection must match the full reviewed scope exactly."
      );
    }

    const args: OperationArguments =
      input.arguments.kind === "delete"
        ? { ...input.arguments, selectedRefs: refs }
        : input.arguments;

    const authorized = currentlyAuthorized(preview);

    const preconditions = [
      precondition(
        "source-identity",
        "administration.request",
        JSON.stringify(preview.request)
      ),
      precondition(
        "selected-content",
        "administration.fingerprint",
        preview.fingerprint
      ),
      precondition(
        "config-digest",
        "administration.current-config",
        preview.configDigest
      ),
      precondition(
        "config-digest",
        configPath(engine.home),
        preview.configDigest
      ),
      precondition("backup-policy", "confirmation", confirmationFor(preview)),
      ...retainedRefs(preview.selectedRefs),
    ];

    if (preview.resultConfigDigest !== undefined) {
      preconditions.push(
        precondition(
          "config-digest",
          "administration.result-config",
          preview.resultConfigDigest
        )
      );
    }

    if (
      request.kind === "delete" ||
      request.kind === "reset" ||
      request.kind === "restore"
    ) {
      preconditions.push(
        precondition("backup-policy", "backup-required", "true")
      );
    }

    if (request.kind === "restore") {
      preconditions.push(
        precondition(
          "source-content",
          request.backupId,
          input.arguments.kind === "restore"
            ? input.arguments.expectedContentDigest
            : ""
        )
      );
    }

    return {
      arguments: args,
      consent: {
        reason: authorized
          ? "Current enrollment authorizes this configuration change."
          : "Supply the exact reviewed confirmation text.",
        receiptIds: [],
        scopeDigest: preview.fingerprint,
        state: authorized ? "authorized" : "required",
      },
      effects: effectsFor(engine, request.kind),
      expectedEvidenceImprovement:
        "Apply the reviewed tracker administration scope and preserve available recovery evidence.",
      forecast: { bytes: null, cost: null, elapsedMs: null, requests: 0 },
      preconditions,
      resumeBoundary: "atomic-step",
      stopCondition:
        "Stop after one reviewed administration effect or retain partial progress for explicit verification.",
    };
  });

  const validate = Effect.fn("liveAdministration.validate")(
    function* validate(plan: OperationPlan, context: OperationWorkContext) {
      const retained = yield* retainReview(plan);
      const request = yield* requestFor(engine, plan, resolveTarget);

      if (JSON.stringify(request) !== JSON.stringify(retained.request)) {
        return [
          "The administration request no longer matches its selected identity.",
        ];
      }

      const preview = yield* meteredAdministration(context, (limits) =>
        engine.previewAdministration(request, limits)
      );

      return preview.fingerprint !== retained.fingerprint ||
        preview.configDigest !== retained.configDigest ||
        !sameOperationRefs(preview.selectedRefs, retained.selectedRefs) ||
        (plan.arguments.kind === "restore" &&
          preview.backupContentDigest !== plan.arguments.expectedContentDigest)
        ? ["The reviewed administration contents or configuration changed."]
        : [];
    },
    Effect.match({
      onFailure: (error) => [error.message],
      onSuccess: (result) => result,
    })
  );

  const authorize: OperationAdapter["authorize"] = Effect.fn(
    "liveAdministration.authorize"
  )(function* authorize(plan, input, context) {
    const retained = yield* retainReview(plan);

    const request = yield* requestFor(engine, plan, resolveTarget);

    if (JSON.stringify(request) !== JSON.stringify(retained.request)) {
      return false;
    }

    const confirmation = expectedValue(plan, "backup-policy", "confirmation");

    if (
      confirmation !== undefined &&
      confirmation.length > 0 &&
      input.confirmation === confirmation
    ) {
      return true;
    }

    if (request.kind !== "configure") {
      return false;
    }

    const preview = yield* meteredAdministration(context, (limits) =>
      engine.previewAdministration(request, limits)
    );

    return currentlyAuthorized(preview);
  });

  const execute: OperationAdapter["execute"] = Effect.fn(
    "liveAdministration.execute"
  )(function* execute(plan, step, context): Effect.fn.Return<
    OperationEffectResult,
    AgentStoreFailure
  > {
    const retained = yield* retainReview(plan);

    if (step.id !== `administration.${retained.request.kind}`) {
      return yield* operationError(
        "scope-denied",
        "The administration step is outside the reviewed operation."
      );
    }

    const before = yield* store.identity;

    const result = yield* meteredAdministration(
      context,
      (limits) =>
        engine.applyReviewedAdministration(
          retained.request,
          retained.fingerprint,
          context.confirmation ?? "",
          context.operation.id,
          limits
        ),
      (completed, error) => ({
        ...completed,
        partialErrors: [...completed.partialErrors, error.message],
      })
    );

    const after = yield* store.identity;

    const gaps = [...result.partialErrors, ...result.verificationUnavailable];

    if (result.filesChanged.length > 256) {
      gaps.push(
        `${String(result.filesChanged.length - 256)} additional changed file references do not fit in this bounded receipt.`
      );
    }

    if (result.removedRefs.length > 500) {
      gaps.push(
        `${String(result.removedRefs.length - 500)} additional removed references do not fit in this bounded receipt.`
      );
    }

    return {
      effects: resultEffects(result, before, after),
      resources: {
        bytesRead: result.resources.bytesRead,
        elapsedMs: Math.ceil(result.resources.elapsedMs),
        recordsDecoded: result.resources.recordsDecoded,
        requests: 0,
        retries: 0,
      },
      step: {
        ...step,
        gaps: gaps.slice(0, 64).map((message) => message.slice(0, 4096)),
        remainingWork:
          gaps.length > 0
            ? "Verify retained backups and the partial effect before retrying."
            : null,
        state: executionState(result),
      },
    };
  });

  const probe: OperationAdapter["probe"] = Effect.fn(
    "liveAdministration.probe"
  )(
    function* probe(
      plan,
      step,
      receipt,
      context
    ): Effect.fn.Return<OperationProbe, AgentStoreFailure> {
      const retained = yield* retainReview(plan);

      const identity = yield* store.identity;

      if (
        retained.request.kind === "restore" ||
        identity.storeGeneration !== plan.storeGeneration ||
        identity.storeId !== plan.storeId
      ) {
        return {
          reason:
            "The restore outcome or changed store generation needs explicit verification before retrying.",
          state: "indeterminate",
        };
      }

      const checked = yield* meteredAdministration(context, (limits) =>
        engine.probeReviewedAdministration(
          retained,
          receipt.effects.backupIds,
          limits
        )
      );

      if (checked.state !== "complete") {
        return checked.state === "absent"
          ? { state: "absent" }
          : { reason: checked.reason, state: "indeterminate" };
      }

      return {
        result: {
          effects: {
            backupArtifacts: [],
            backupIds: checked.backupIds,
            configDigest: checked.configDigest,
            evidenceIds: [],
            exportArtifacts: [],
            exports: [],
            filesChanged: checked.filesChanged,
            remainingStoreGeneration: identity.storeGeneration,
            removalReason:
              "Configuration verification does not establish any removed observations.",
            removedCount: null,
            removedRefs: [],
          },
          resources: {
            bytesRead: checked.resources.bytesRead,
            elapsedMs: Math.ceil(checked.resources.elapsedMs),
            recordsDecoded: checked.resources.recordsDecoded,
            requests: 0,
            retries: 0,
          },
          step: {
            ...step,
            gaps: [],
            remainingWork: null,
            state: "already-applied",
          },
        },
        state: "complete",
      };
    },
    Effect.match({
      onFailure: (error): OperationProbe => ({
        reason: error.message.slice(0, 4096),
        state: "indeterminate",
      }),
      onSuccess: (result) => result,
    })
  );

  const kinds: readonly AdministrationKind[] = [
    "configure",
    "delete",
    "reset",
    "restore",
  ];

  return kinds.map((kind): OperationAdapter => ({
    authorize,
    descriptor: {
      authorization: "explicit-confirmation",
      cancellation: "before-start-only",
      effects: effectsFor(engine, kind),
      enabled: true,
      idempotency: "durable-key",
      kind,
      reason: null,
      requiredInputs: requiredInputs(kind),
      version: OPERATION_SCHEMA_VERSION,
    },
    execute,
    meteredWork: true,
    prepare,
    probe,
    replay: "probe-required",
    steps: () => [
      operationStep(`administration.${kind}`, "live-administration"),
    ],
    validate,
  }));
};
