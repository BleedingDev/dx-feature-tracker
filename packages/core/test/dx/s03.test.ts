import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Each test releases only the scratch directory it created.
} from "node:fs";
import os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture SQLite paths are confined to their owned scratch directory.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";

import { runImportSpool } from "../../src/dx/cli/commands/collect.js";
import { sanitizeHookPayload } from "../../src/dx/collectors/cursor-hooks/sanitize.js";
import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../src/dx/contracts/agent-store.js";
import { StoreBusy } from "../../src/dx/contracts/error-store-busy.js";
import type { Harness, SessionRef } from "../../src/dx/harness/contract.js";
import { fileCursorOf } from "../../src/dx/harness/contract.js";
import {
  HarnessRegistry,
  harnessCatalog,
} from "../../src/dx/harness/registry.js";
import { writeLiveConfig } from "../../src/dx/live/config.js";
import { backupsDir, configPath, liveHome } from "../../src/dx/live/home.js";
import {
  applyReviewedAdministration,
  previewAdministration,
  probeReviewedAdministration,
  resetStore,
} from "../../src/dx/live/store-admin.js";
import type { LiveAdministrationRequest } from "../../src/dx/live/store-admin.js";
import type { AgentScope } from "../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
  OperationReceipt,
} from "../../src/dx/model/agent-operation.js";
import type { CollectCursor } from "../../src/dx/model/coverage.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type { EventBatch, FlightContext } from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import {
  ACCOUNT_OPERATION_BOUNDS,
  accountOperationArguments,
  accountOperationScope,
  makeBoundedAccountOperationAdapter,
  makeBoundedAccountPageTransport,
} from "../../src/dx/operations/account.js";
import { makeOperationWorkBudget } from "../../src/dx/operations/budget.js";
import {
  makeExplicitSelectedSourceCatalog,
  makePlannedSourceOperationAdapter,
} from "../../src/dx/operations/collector.js";
import {
  makeBoundedCursorHookIdentityProbe,
  makeBoundedCursorHookOperationAdapter,
} from "../../src/dx/operations/cursor-hooks.js";
import { makeBoundedCursorOperationAdapter } from "../../src/dx/operations/cursor.js";
import {
  boundedCompressedSnapshotHarness,
  decompressOperationSnapshot,
} from "../../src/dx/operations/decompression.js";
import { makeBoundedGitOperationAdapter } from "../../src/dx/operations/git.js";
import {
  boundedHookSnapshotHarness,
  decodeBoundedHookSnapshot,
} from "../../src/dx/operations/hooks.js";
import {
  makeLiveOperationAcquisitionExecutor,
  makeLiveSelectedSourceCatalog,
} from "../../src/dx/operations/live-acquisition.js";
import { makeLiveAdministrationAdapters } from "../../src/dx/operations/live.js";
import type { LiveAdministrationBackend } from "../../src/dx/operations/live.js";
import { makeBoundedOpencodeOperationAdapter } from "../../src/dx/operations/opencode.js";
import { operationStep } from "../../src/dx/operations/ports.js";
import type {
  OperationAdapter,
  OperationApplyInput,
  OperationEffectResult,
  OperationPlanInput,
} from "../../src/dx/operations/ports.js";
import { makeOperationService } from "../../src/dx/operations/service.js";
import type { OperationServiceApi } from "../../src/dx/operations/service.js";
import { runPlannedStep } from "../../src/dx/registry/sync.js";
import type { PlannedSource } from "../../src/dx/registry/sync.js";
import { HarnessCursors } from "../../src/dx/storage/harness-cursors.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import type { OpenedEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import { registerAccountOperationTests } from "./fixtures/s03/account-suite.js";
import { registerCursorHookOperationTests } from "./fixtures/s03/cursor-hooks-suite.js";
import { registerCursorOperationTests } from "./fixtures/s03/cursor-suite.js";
import { registerDecompressionTests } from "./fixtures/s03/decompression-suite.js";
import { makeGitOperationFixture } from "./fixtures/s03/git-operation-fixture.js";
import { registerGitOperationTests } from "./fixtures/s03/git-suite.js";
import { registerHookOperationTests } from "./fixtures/s03/hooks-suite.js";
import { registerLiveAcquisitionTests } from "./fixtures/s03/live-acquisition-suite.js";
import { registerOpencodeOperationTests } from "./fixtures/s03/opencode-suite.js";

const fixtureScope: AgentScope = {
  branchSelection: { branches: ["fixture-main"], kind: "selected" },
  flightId: null,
  repoId: "fixture:s03:repo",
  resolution: "Synthetic S03 operation fixture; no live evidence",
  sources: ["fixture.s03"],
  tools: [],
  worktreeId: "fixture:s03:worktree",
};

const collectionArguments: OperationArguments = {
  allowSourceGrowth: true,
  cursor: null,
  inputRefs: [],
  kind: "collect",
  parserVersion: "fixture.s03.v1",
  selectedRoots: ["fixture:s03:source"],
  source: "fixture.s03",
};

const fixtureBatch = (
  id: string,
  context: FlightContext = emptyFlightContext
): EventBatch => ({
  coverage: {
    adapterId: "harness.pi",
    expectedItems: 1,
    gaps: [],
    observedItems: 1,
    state: "complete",
    watermark: "fixture-s03-watermark",
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events: [
    {
      acquisition: "file-import",
      adapterId: "harness.pi",
      adapterVersion: "fixture.s03.v1",
      ai: null,
      context,
      eventId: EventIdSchema.make(id),
      evidence: { bounded: true, hash: null, ref: `fixture:s03:${id}` },
      fieldSemantics: [],
      identity: emptyEventIdentity,
      kind: "other",
      observedAt: "2026-01-01T00:00:00.000Z",
      occurredAt: null,
      occurredAtPrecision: "unknown",
      origin: "fixture",
      payload: { fixture: "S03 synthetic record" },
      schemaVersion: "dx.event.v2",
      sourceVersion: "fixture.s03.v1",
      upstreamKey: `fixture:s03:${id}`,
      usage: null,
    },
  ],
});

const fixtureAdapter = (
  overrides: Partial<OperationAdapter> = {}
): OperationAdapter => ({
  authorize: (plan, input) =>
    Effect.succeed(
      plan.consent.state === "authorized" ||
        input.confirmation === plan.consent.scopeDigest
    ),
  descriptor: {
    authorization: "existing-enrollment",
    cancellation: "between-steps",
    effects: {
      destructive: false,
      networkDestinations: [],
      reads: ["fixture:s03:source"],
      writes: ["fixture:s03:store"],
    },
    enabled: true,
    idempotency: "durable-key",
    kind: "collect",
    reason: null,
    requiredInputs: [],
    version: "fixture.s03.v1",
  },
  execute: (_plan, step) =>
    Effect.succeed({ step: { ...step, inserted: 1, state: "committed" } }),
  prepare: (input) =>
    Effect.succeed({
      arguments: input.arguments,
      consent: {
        reason: "Synthetic enrolled fixture only",
        receiptIds: [],
        scopeDigest: "assigned-by-coordinator",
        state: "authorized",
      },
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: ["fixture:s03:source"],
        writes: ["fixture:s03:store"],
      },
      expectedEvidenceImprovement: "Exercise fixture operation receipts",
      forecast: { bytes: null, cost: null, elapsedMs: null, requests: 0 },
      preconditions: [],
      resumeBoundary: "atomic-step",
      stopCondition: "Finish the labelled fixture step",
    }),
  probe: () => Effect.succeed({ state: "absent" }),
  replay: "safe",
  steps: () => [operationStep("fixture-step", "fixture.s03")],
  validate: () => Effect.succeed([]),
  ...overrides,
});

const recordingAgentStore = (
  store: AgentStoreService,
  failures: AgentStoreFailure[]
): AgentStoreService => ({
  ...store,
  appendOperationStep: (handle, step, revision) =>
    store.appendOperationStep(handle, step, revision).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() => {
          failures.push(failure);
        })
      )
    ),
  updateOperation: (receipt, revision) =>
    store.updateOperation(receipt, revision).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() => {
          failures.push(failure);
        })
      )
    ),
});

const withFixtureStore = <A, E>(
  use: (
    opened: OpenedEventStore,
    root: string
  ) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(
    Effect.gen(function* fixtureStore() {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), "dft-s03-"))),
        (owned) =>
          Effect.sync(() => {
            rmSync(owned, { force: true, recursive: true });
          })
      );

      const opened = yield* Effect.acquireRelease(
        openSqliteEventStore({
          kind: "live",
          path: path.join(root, "fixture.sqlite"),
        }),
        (store) =>
          Effect.sync(() => {
            store.close();
          })
      );

      return yield* use(opened, root);
    })
  );

const createPlan = Effect.fn("S03.createPlan")(function* createPlan(
  service: OperationServiceApi,
  opened: OpenedEventStore,
  args: OperationArguments = collectionArguments,
  scope: AgentScope = fixtureScope,
  limits: Partial<OperationBounds> = {}
) {
  const input: OperationPlanInput = {
    action: "plan",
    arguments: args,
    bounds: {
      maxBytes: 4096,
      maxElapsedMs: 60_000,
      maxFiles: 2,
      maxRecords: 16,
      maxRequests: 0,
      maxRetries: 1,
      ...limits,
    },
    purpose: "Verify isolated synthetic operation behavior",
    scope,
    target: yield* opened.agentService.identity,
  };

  const result = yield* service.run(input);

  if (result.action !== "plan") {
    return yield* Effect.die(new Error("Expected a plan response"));
  }

  return result.plan;
});

const applyInput = (
  plan: OperationPlan,
  key = "fixture.s03.key"
): OperationApplyInput => ({
  action: "apply",
  consentReceiptIds: [],
  expectedDigest: plan.planDigest,
  idempotencyKey: key,
  plan,
});

const applyReceipt = Effect.fn("S03.applyReceipt")(function* applyReceipt(
  service: OperationServiceApi,
  input: OperationApplyInput
) {
  const output = yield* service.run(input);

  if (output.action !== "apply") {
    return yield* Effect.die(new Error("Expected an apply response"));
  }

  return output;
});

registerLiveAcquisitionTests({
  applyInput,
  createPlan,
  fixtureBatch,
  fixtureScope,
  makeBoundedCursorHookIdentityProbe,
  makeBoundedCursorHookOperationAdapter,
  makeExplicitSelectedSourceCatalog,
  makeLiveOperationAcquisitionExecutor,
  makeLiveSelectedSourceCatalog,
  makeOperationService,
  makePlannedSourceOperationAdapter,
  sanitizeHookPayload,
  withFixtureStore,
});

registerGitOperationTests({
  applyInput,
  applyReceipt,
  createPlan,
  fixtureBatch,
  fixtureScope,
  makeBoundedGitOperationAdapter,
  makeGitOperationFixture,
  makeOperationService,
  withFixtureStore,
});

registerAccountOperationTests({
  accountBounds: ACCOUNT_OPERATION_BOUNDS,
  accountOperationArguments,
  accountOperationScope,
  applyInput,
  createPlan,
  fixtureBatch,
  fixtureScope,
  makeAccountAdapter: makeBoundedAccountOperationAdapter,
  makeAccountTransport: makeBoundedAccountPageTransport,
  makeOperationService,
  withFixtureStore,
});

registerHookOperationTests({
  applyInput,
  boundedHookSnapshotHarness,
  createPlan,
  decodeBoundedHookSnapshot,
  fixtureScope,
  harnessCatalog,
  makeOperationService,
  makePlannedSourceOperationAdapter,
  withFixtureStore,
});

registerOpencodeOperationTests({
  applyInput,
  createPlan,
  fixtureBatch,
  fixtureScope,
  makeBoundedOpencodeOperationAdapter,
  makeOperationService,
  withFixtureStore,
});

registerDecompressionTests({
  applyInput,
  applyReceipt,
  boundedCompressedSnapshotHarness,
  createPlan,
  decompressOperationSnapshot,
  fixtureScope,
  makeOperationService,
  makeOperationWorkBudget,
  makePlannedSourceOperationAdapter,
  memoryCursors: Effect.service(HarnessCursors).pipe(
    Effect.provide(HarnessCursors.memory)
  ),
  withFixtureStore,
});

registerCursorOperationTests({
  applyInput,
  applyReceipt,
  createPlan,
  fixtureBatch,
  fixtureScope,
  makeBoundedCursorOperationAdapter,
  makeOperationService,
  withFixtureStore,
});

registerCursorHookOperationTests({
  applyInput,
  createPlan,
  fixtureScope,
  makeBoundedCursorHookOperationAdapter,
  makeOperationService,
  sanitizeHookPayload,
  withFixtureStore,
});

describe("S03 durable operation coordination", () => {
  it.effect("a receipt with unavailable review retains its known effects", () =>
    withFixtureStore((opened) =>
      Effect.gen(function* unavailableReview() {
        let writes = 0;

        const adapter = fixtureAdapter({
          execute: (_plan, step) =>
            Effect.sync(() => {
              writes += 1;

              return {
                step: { ...step, inserted: 1, state: "committed" },
              } satisfies OperationEffectResult;
            }),
        });

        const service = yield* makeOperationService(opened.agentService, [
          adapter,
        ]);

        const plan = yield* createPlan(service, opened);
        const applied = yield* applyReceipt(service, applyInput(plan));

        const missingReviewStore: AgentStoreService = {
          ...opened.agentService,
          getOperationPlanForReceipt: () => Effect.succeed(null),
        };

        const restarted = yield* makeOperationService(missingReviewStore, [
          adapter,
        ]);

        const result = yield* restarted.run({
          action: "get",
          operation: {
            id: applied.receipt.id,
            storeGeneration: applied.receipt.storeGeneration,
            storeId: applied.receipt.storeId,
          },
        });

        const recovered = yield* Effect.fromNullishOr(
          result.action === "get" ? result : null
        );

        expect(recovered.receipt).toEqual(applied.receipt);
        expect(recovered.reviewedPlan).toBeNull();
        expect(recovered.reviewedPlanUnavailableReason).toContain(
          "unavailable"
        );
        expect(recovered.reviewedPlanUnavailableReason).toContain(
          "reviewed scope"
        );
        expect(writes).toBe(1);
      })
    )
  );

  it.effect(
    "concurrent duplicate applies execute once and retain one durable receipt",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* duplicateApply() {
          const entered = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();
          const duplicateReserved = yield* Deferred.make<boolean>();
          let writes = 0;
          let reservations = 0;

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.gen(function* applyOnce() {
                writes += 1;
                yield* Deferred.succeed(entered, true);
                yield* Deferred.await(release);

                return {
                  step: { ...step, inserted: 1, state: "committed" },
                } satisfies OperationEffectResult;
              }),
          });

          const coordinatedStore: AgentStoreService = {
            ...opened.agentService,
            reserveOperation: (handle, digest, key) =>
              opened.agentService.reserveOperation(handle, digest, key).pipe(
                Effect.tap(() =>
                  Effect.gen(function* observeReservation() {
                    reservations += 1;

                    if (reservations === 2) {
                      yield* Deferred.succeed(duplicateReserved, true);
                    }
                  })
                )
              ),
          };

          const service = yield* makeOperationService(coordinatedStore, [
            adapter,
          ]);

          const plan = yield* createPlan(service, opened);

          const first = yield* Effect.forkChild(
            applyReceipt(service, applyInput(plan))
          );

          yield* Deferred.await(entered);

          const second = yield* Effect.forkChild(
            applyReceipt(service, applyInput(plan))
          );

          yield* Deferred.await(duplicateReserved);
          yield* Deferred.succeed(release, true);

          const outputs = yield* Effect.all([
            Fiber.join(first),
            Fiber.join(second),
          ]);

          expect(writes).toBe(1);
          expect(outputs[0].receipt.id).toBe(outputs[1].receipt.id);
          expect(outputs.map((output) => output.reused)).toEqual([false, true]);
          expect(outputs[0].receipt.executionState).toBe("succeeded");
          expect(outputs[0].receipt.steps).toMatchObject([
            { inserted: 1, state: "committed" },
          ]);
          expect(
            yield* opened.agentService.getOperation(outputs[0].receipt)
          ).toEqual(outputs[0].receipt);
          const retried = yield* applyReceipt(service, applyInput(plan));
          expect(retried.reused).toBe(true);
          expect(retried.receipt).toEqual(outputs[0].receipt);
          expect(writes).toBe(1);
        })
      )
  );

  it.effect(
    "rejects a different plan digest under an already consumed key",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* digestConflict() {
          let writes = 0;

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.sync(() => {
                writes += 1;

                return {
                  step: { ...step, inserted: 1, state: "committed" },
                } satisfies OperationEffectResult;
              }),
          });

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const first = yield* createPlan(service, opened);
          yield* applyReceipt(service, applyInput(first));

          const other = yield* createPlan(service, opened, {
            ...collectionArguments,
            selectedRoots: ["fixture:s03:different-source"],
          });

          expect(other.planDigest).not.toBe(first.planDigest);
          const conflict = yield* Effect.flip(service.run(applyInput(other)));
          expect(conflict).toMatchObject({ code: "idempotency-conflict" });
          expect(writes).toBe(1);
        })
      )
  );

  it.effect(
    "arbitrary consent references cannot authorize a scope requiring confirmation",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* untrustedConsent() {
          let writes = 0;
          const base = fixtureAdapter();

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.sync(() => {
                writes += 1;

                return { step: { ...step, state: "committed" } };
              }),
            prepare: (input, context) =>
              base.prepare(input, context).pipe(
                Effect.map((prepared) => ({
                  ...prepared,
                  consent: { ...prepared.consent, state: "required" },
                }))
              ),
          });

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const plan = yield* createPlan(service, opened);

          const denied = yield* Effect.flip(
            service.run({
              ...applyInput(plan),
              consentReceiptIds: ["fixture:invented-enrollment-receipt"],
            })
          );

          expect(denied).toMatchObject({ code: "authorization-required" });
          expect(writes).toBe(0);

          const accepted = yield* applyReceipt(service, {
            ...applyInput(plan),
            confirmation: plan.consent.scopeDigest,
          });

          expect(accepted.receipt.executionState).toBe("succeeded");
          expect(writes).toBe(1);
        })
      )
  );

  it.effect(
    "cancellation between steps preserves the committed first effect",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* cancelBetweenSteps() {
          const entered = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();
          const writes: string[] = [];

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.gen(function* pauseFirstStep() {
                writes.push(step.id);
                yield* Deferred.succeed(entered, true);
                yield* Deferred.await(release);

                return {
                  resources: {
                    bytesRead: 128,
                    elapsedMs: 0,
                    recordsDecoded: 1,
                    requests: 0,
                    retries: 0,
                  },
                  step: { ...step, inserted: 1, state: "committed" },
                };
              }),
            steps: () => [
              operationStep("fixture-first"),
              operationStep("fixture-second"),
            ],
          });

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const plan = yield* createPlan(service, opened);

          const running = yield* Effect.forkChild(
            applyReceipt(service, applyInput(plan))
          );

          yield* Deferred.await(entered);

          const reserved = yield* opened.agentService.reserveOperation(
            plan,
            plan.planDigest,
            "fixture.s03.key"
          );

          const current = yield* opened.agentService.getOperation(
            reserved.receipt
          );

          yield* service.run({
            action: "cancel",
            expectedRevision: current.revision,
            operation: current,
          });
          yield* Deferred.succeed(release, true);
          const output = yield* Fiber.join(running);
          expect(writes).toEqual(["fixture-first"]);
          expect(output.receipt.executionState).toBe("cancelled");
          expect(output.receipt.resources).toEqual({
            bytesRead: 128,
            elapsedMs: 0,
            recordsDecoded: 1,
            requests: 0,
            retries: 0,
          });
          expect(output.receipt.steps).toMatchObject([
            { id: "fixture-first", inserted: 1, state: "committed" },
            { id: "fixture-second", inserted: 0, state: "cancelled" },
          ]);
        })
      )
  );

  it.effect(
    "interruption retains uncertainty and a completion probe prevents repeated effects",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* interruptionProbe() {
          const entered = yield* Deferred.make<boolean>();
          let writes = 0;
          let probes = 0;
          let completed: OperationEffectResult | null = null;

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.gen(function* interruptedWrite() {
                writes += 1;
                completed = {
                  step: { ...step, inserted: 1, state: "committed" },
                };
                yield* Deferred.succeed(entered, true);

                return yield* Effect.never;
              }),
            probe: () =>
              Effect.sync(() => {
                probes += 1;

                return completed === null
                  ? { state: "absent" }
                  : { result: completed, state: "complete" };
              }),
            replay: "probe-required",
          });

          const executionScope = yield* Scope.make();
          yield* Effect.addFinalizer(() =>
            Scope.close(executionScope, Exit.void)
          );

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]).pipe(Effect.provideService(Scope.Scope, executionScope));

          const plan = yield* createPlan(service, opened);

          const running = yield* Effect.forkChild(
            applyReceipt(service, applyInput(plan))
          );

          yield* Deferred.await(entered);

          const reserved = yield* opened.agentService.reserveOperation(
            plan,
            plan.planDigest,
            "fixture.s03.key"
          );

          yield* Scope.close(executionScope, Exit.void);
          yield* Fiber.interrupt(running);

          const interrupted = yield* opened.agentService.getOperation(
            reserved.receipt
          );

          expect(interrupted.executionState).toBe("interrupted");
          expect(interrupted.verificationState).toBe("indeterminate");
          expect(interrupted.steps[0]?.state).toBe("running");
          expect(interrupted.steps[0]?.inserted).toBe(0);

          const restarted = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const resumed = yield* applyReceipt(restarted, applyInput(plan));
          expect(resumed.reused).toBe(true);
          expect(resumed.receipt.executionState).toBe("succeeded");
          expect(resumed.receipt.steps[0]).toMatchObject({
            inserted: 1,
            state: "committed",
          });
          expect(writes).toBe(1);
          expect(probes).toBe(1);
        })
      )
  );

  it.effect(
    "spooled evidence remains partial until a safe replay commits it",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* resumeSpooledStep() {
          let attempts = 0;
          let commits = 0;
          let probes = 0;

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.sync(() => {
                attempts += 1;

                if (attempts === 1) {
                  return {
                    step: {
                      ...step,
                      remainingWork: "Replay the fixture spool",
                      spooledRefs: ["fixture:s03:spool"],
                      state: "spooled",
                    },
                  };
                }

                commits += 1;

                return {
                  step: {
                    ...step,
                    committedThrough: "fixture-record-1",
                    inserted: 1,
                    safeCursor: "fixture-cursor-1",
                    spooledRefs: ["fixture:s03:spool"],
                    state: "committed",
                  },
                };
              }),
            probe: () =>
              Effect.sync(() => {
                probes += 1;

                return { state: "absent" };
              }),
          });

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const plan = yield* createPlan(service, opened);
          const partial = yield* applyReceipt(service, applyInput(plan));
          expect(partial.receipt.executionState).toBe("partial");
          expect(partial.receipt.verificationState).toBe("partial");
          expect(partial.receipt.recovery).toBe("safe-resume");
          expect(partial.receipt.steps[0]).toMatchObject({
            committedThrough: null,
            inserted: 0,
            safeCursor: null,
            state: "spooled",
          });
          expect(commits).toBe(0);
          const resumed = yield* applyReceipt(service, applyInput(plan));
          expect(resumed.reused).toBe(true);
          expect({
            attempts,
            probes,
            step: resumed.receipt.steps[0],
          }).toMatchObject({
            attempts: 2,
            probes: 1,
            step: { state: "committed" },
          });
          expect(resumed.receipt.executionState).toBe("succeeded");
          expect(resumed.receipt.steps[0]).toMatchObject({
            committedThrough: "fixture-record-1",
            inserted: 1,
            safeCursor: "fixture-cursor-1",
            state: "committed",
          });
          expect(commits).toBe(1);
          expect(probes).toBe(1);
        })
      )
  );
});

describe("S03 retry budgets", () => {
  it.effect(
    "a zero retry budget retains a spool without replaying effects",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* exhaustedSpoolRetry() {
          let executions = 0;

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.sync(() => {
                executions += 1;

                return {
                  step: {
                    ...step,
                    remainingWork: "Replay the synthetic fixture spool",
                    spooledRefs: ["fixture:s03:retry-budget-spool"],
                    state: "spooled",
                  },
                };
              }),
          });

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const plan = yield* createPlan(
            service,
            opened,
            collectionArguments,
            fixtureScope,
            { maxRetries: 0 }
          );

          const first = yield* applyReceipt(service, applyInput(plan));
          expect(first.receipt.executionState).toBe("partial");
          expect(first.receipt.steps[0]?.spooledRefs).toEqual([
            "fixture:s03:retry-budget-spool",
          ]);

          const retry = yield* applyReceipt(service, applyInput(plan));
          expect(retry.reused).toBe(true);
          expect(executions).toBe(1);
          expect(retry.receipt.steps[0]).toMatchObject({
            inserted: 0,
            spooledRefs: ["fixture:s03:retry-budget-spool"],
          });
          expect(retry.receipt.recovery).toBe("replan");
        })
      )
  );
});

describe("S03 compatible acquisition sharing", () => {
  it.effect(
    "distinct authorized plans share one acquisition and cancelling one preserves the other",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* sharedCallers() {
          const entered = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();
          const joined = yield* Deferred.make<OperationReceipt>();
          let executions = 0;
          let authorizations = 0;

          const adapter = fixtureAdapter({
            authorize: () =>
              Effect.sync(() => {
                authorizations += 1;

                return true;
              }),
            execute: (_plan, step) =>
              Effect.gen(function* sharedWork() {
                executions += 1;
                yield* Deferred.succeed(entered, true);
                yield* Deferred.await(release);

                return { step: { ...step, inserted: 1, state: "committed" } };
              }),
          });

          const store: AgentStoreService = {
            ...opened.agentService,
            updateOperation: (receipt, revision) =>
              opened.agentService.updateOperation(receipt, revision).pipe(
                Effect.tap((stored) =>
                  Effect.gen(function* observeSharedStep() {
                    if (
                      stored.verificationRefs.some(
                        (ref) => ref.kind === "operation"
                      )
                    ) {
                      yield* Deferred.succeed(joined, stored);
                    }
                  })
                )
              ),
          };

          const service = yield* makeOperationService(store, [adapter]);
          const firstPlan = yield* createPlan(service, opened);
          const secondPlan = yield* createPlan(service, opened);
          expect(firstPlan.id).not.toBe(secondPlan.id);

          const first = yield* Effect.forkChild(
            applyReceipt(service, applyInput(firstPlan, "fixture-shared-first"))
          );

          yield* Deferred.await(entered);

          const second = yield* Effect.forkChild(
            applyReceipt(
              service,
              applyInput(secondPlan, "fixture-shared-second")
            )
          );

          const secondRunning = yield* Deferred.await(joined);
          yield* service.run({
            action: "cancel",
            expectedRevision: secondRunning.revision,
            operation: secondRunning,
          });
          yield* Deferred.succeed(release, true);

          const outputs = yield* Effect.all([
            Fiber.join(first),
            Fiber.join(second),
          ]);

          expect(authorizations).toBe(2);
          expect(executions).toBe(1);
          expect(outputs[0].receipt.id).not.toBe(outputs[1].receipt.id);
          expect(outputs[0].receipt.executionState).toBe("succeeded");
          expect(outputs[1].receipt.executionState).toBe("cancelled");
          expect(outputs[1].receipt.verificationRefs).toContainEqual(
            expect.objectContaining({
              basisId: null,
              id: outputs[0].receipt.id,
              kind: "operation",
              storeGeneration: outputs[0].receipt.storeGeneration,
              storeId: outputs[0].receipt.storeId,
              version: "dx.operation.v1",
            })
          );
        })
      )
  );

  it.effect(
    "different approved bounds require independent acquisition work",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* incompatibleBounds() {
          const bothEntered = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();
          let executions = 0;

          const adapter = fixtureAdapter({
            execute: (_plan, step) =>
              Effect.gen(function* boundedWork() {
                executions += 1;

                if (executions === 2) {
                  yield* Deferred.succeed(bothEntered, true);
                }

                yield* Deferred.await(release);

                return { step: { ...step, inserted: 1, state: "committed" } };
              }),
          });

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const firstPlan = yield* createPlan(service, opened);

          const secondPlan = yield* createPlan(
            service,
            opened,
            collectionArguments,
            fixtureScope,
            { maxBytes: 2048 }
          );

          const calls = yield* Effect.forkChild(
            Effect.all(
              [
                applyReceipt(
                  service,
                  applyInput(firstPlan, "fixture-bounds-first")
                ),
                applyReceipt(
                  service,
                  applyInput(secondPlan, "fixture-bounds-second")
                ),
              ],
              { concurrency: 2 }
            )
          );

          yield* Deferred.await(bothEntered);
          yield* Deferred.succeed(release, true);
          const outputs = yield* Fiber.join(calls);
          expect(executions).toBe(2);
          expect(
            outputs.every(
              (output) => output.receipt.executionState === "succeeded"
            )
          ).toBe(true);
          expect(
            outputs.every(
              (output) => output.receipt.verificationRefs.length === 0
            )
          ).toBe(true);
        })
      )
  );

  it.effect("a denied caller cannot join an authorized acquisition", () =>
    withFixtureStore((opened) =>
      Effect.gen(function* deniedSharedCaller() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        let executions = 0;
        let authorizations = 0;

        const adapter = fixtureAdapter({
          authorize: (_plan, input) =>
            Effect.sync(() => {
              authorizations += 1;

              return input.consentReceiptIds.length === 0;
            }),
          execute: (_plan, step) =>
            Effect.gen(function* authorizedWork() {
              executions += 1;
              yield* Deferred.succeed(entered, true);
              yield* Deferred.await(release);

              return { step: { ...step, inserted: 1, state: "committed" } };
            }),
        });

        const service = yield* makeOperationService(opened.agentService, [
          adapter,
        ]);

        const firstPlan = yield* createPlan(service, opened);
        const secondPlan = yield* createPlan(service, opened);

        const first = yield* Effect.forkChild(
          applyReceipt(
            service,
            applyInput(firstPlan, "fixture-authorized-caller")
          )
        );

        yield* Deferred.await(entered);

        const denied = yield* Effect.flip(
          service.run({
            ...applyInput(secondPlan, "fixture-denied-caller"),
            consentReceiptIds: ["fixture-untrusted-receipt"],
          })
        );

        expect(denied).toMatchObject({ code: "authorization-required" });
        yield* Deferred.succeed(release, true);
        expect((yield* Fiber.join(first)).receipt.executionState).toBe(
          "succeeded"
        );
        expect(authorizations).toBe(2);
        expect(executions).toBe(1);
      })
    )
  );
});

const selectedSourceFixture = Effect.fn("S03.selectedSourceFixture")(
  function* selectedSourceFixture(
    opened: OpenedEventStore,
    root: string,
    input: { readonly text?: string; readonly batch?: EventBatch } = {}
  ) {
    const sourceRoot = realpathSync(root);
    const file = path.join(sourceRoot, "synthetic-source.jsonl");
    writeFileSync(file, input.text ?? "fixture\n");

    const batch =
      input.batch ?? fixtureBatch("evt_fixture_s03_selected_source");

    const info = statSync(file);
    const identity = yield* opened.agentService.identity;

    const inputRef = {
      basisId: null,
      id: "fixture.s03.source-selection",
      kind: "evidence",
      storeGeneration: identity.storeGeneration,
      storeId: identity.storeId,
      version: "fixture.s03.source.v1",
    } as const;

    const ref: SessionRef = {
      channel: "session-file",
      harness: "pi",
      id: "fixture.s03.session",
      mtimeMs: info.mtimeMs,
      path: file,
      sessionId: "fixture-s03-session",
      size: info.size,
      source: "harness.pi",
      worktree: null,
    };

    const planned: PlannedSource = {
      context: emptyFlightContext,
      harness: "pi",
      input: file,
      ref,
      source: "harness.pi",
      unavailable: null,
    };

    const reads: string[] = [];
    let busy = false;

    const harness: Harness = {
      capabilities: {
        branchSources: [],
        liveHooks: false,
        storedFigure: null,
        subagents: false,
      },
      channels: ["session-file"],
      discover: Effect.succeed({
        harness: "pi",
        present: true,
        reason: "Synthetic S03 source",
        roots: [sourceRoot],
        sessions: 1,
        version: "fixture.s03.source.v1",
      }),
      displayName: "Synthetic S03 source",
      id: "pi",
      locate: () => Effect.succeed([ref]),
      read: () => Effect.succeed(batch),
    };

    const adapter = makePlannedSourceOperationAdapter({
      enrollment: (request) =>
        Effect.succeed(
          request.receiptIds.some((id) => id !== "fixture.s03.known-enrollment")
            ? {
                reason: "Unknown fixture enrollment receipt",
                receiptIds: [],
                state: "denied",
              }
            : {
                reason: "Exact isolated fixture enrollment",
                receiptIds: ["fixture.s03.known-enrollment"],
                state: "authorized",
              }
        ),
      env: {
        store: {
          ...opened.service,
          append: (events) =>
            busy
              ? Effect.fail(new StoreBusy({ message: "Fixture writer lock" }))
              : opened.service.append(events),
        },
        storePath: path.join(root, "fixture.sqlite"),
      },
      parserVersion: "fixture.s03.source.v1",
      registry: harnessCatalog([harness]),
      selected: [{ inputRef, planned, root: sourceRoot }],
      snapshotHarness: (snapshot) =>
        Effect.succeed({
          ...harness,
          read: () =>
            Effect.sync(() => {
              reads.push(new TextDecoder().decode(snapshot.bytes));

              return batch;
            }),
        }),
    });

    const args: OperationArguments = {
      allowSourceGrowth: true,
      cursor: null,
      inputRefs: [inputRef],
      kind: "collect",
      parserVersion: "fixture.s03.source.v1",
      selectedRoots: [sourceRoot],
      source: "harness.pi",
    };

    return {
      adapter,
      args,
      file,
      reads,
      scope: { ...fixtureScope, sources: ["harness.pi"] },
      setBusy: (value: boolean) => {
        busy = value;
      },
    };
  }
);

describe("S03 selected source preconditions", () => {
  it.effect(
    "a large JSONL record uses its line allowance within the byte cap",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* largeBoundedRecord() {
          const text = `${JSON.stringify({
            fixture: "S03 synthetic large JSONL record",
            padding: "x".repeat(131_072),
          })}\n`;

          const fixture = yield* selectedSourceFixture(opened, root, { text });

          const service = yield* makeOperationService(opened.agentService, [
            fixture.adapter,
          ]);

          const plan = yield* createPlan(
            service,
            opened,
            fixture.args,
            fixture.scope,
            { maxBytes: 262_144, maxRecords: 4 }
          );

          const output = yield* applyReceipt(service, applyInput(plan));

          expect(text.length).toBeGreaterThan(100_000);
          expect(fixture.reads).toHaveLength(1);
          expect(output.receipt.executionState).toBe("succeeded");
          expect(output.receipt.resources.bytesRead).toBe(
            new TextEncoder().encode(text).byteLength
          );
          expect(output.receipt.steps[0]?.inserted).toBe(1);
        })
      )
  );

  it.effect(
    "expanded events exceed the remaining record allowance before append",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* expandedRecordLimit() {
          const base = fixtureBatch("evt_fixture_s03_expansion");
          const baseEvent = yield* Effect.fromNullishOr(base.events[0]);

          const expanded: EventBatch = {
            ...base,
            coverage: {
              ...base.coverage,
              expectedItems: 16,
              observedItems: 16,
            },
            events: Array.from({ length: 16 }, (_, index) => ({
              ...baseEvent,
              eventId: EventIdSchema.make(`evt_fixture_s03_expansion_${index}`),
              upstreamKey: `fixture:s03:expanded:${index}`,
            })),
          };

          const fixture = yield* selectedSourceFixture(opened, root, {
            batch: expanded,
            text: `${JSON.stringify({ fixture: "S03 one record expands" })}\n`,
          });

          const service = yield* makeOperationService(opened.agentService, [
            fixture.adapter,
          ]);

          const plan = yield* createPlan(
            service,
            opened,
            fixture.args,
            fixture.scope,
            { maxRecords: 16 }
          );

          const output = yield* applyReceipt(service, applyInput(plan));

          expect(fixture.reads).toHaveLength(1);
          expect(output.receipt.steps[0]?.inserted).toBe(0);
          expect(
            output.receipt.executionState,
            JSON.stringify(output.receipt)
          ).toBe("partial");
          expect(
            (yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            })).events
          ).toHaveLength(0);
        })
      )
  );

  it.effect(
    "the reviewed byte limit rejects a source before parsing or acquisition",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* selectedByteLimit() {
          const fixture = yield* selectedSourceFixture(opened, root);

          const service = yield* makeOperationService(opened.agentService, [
            fixture.adapter,
          ]);

          const rejected = yield* Effect.flip(
            createPlan(service, opened, fixture.args, fixture.scope, {
              maxBytes: 7,
            })
          );

          expect(rejected).toMatchObject({ code: "budget-exhausted" });
          expect(fixture.reads).toEqual([]);
        })
      )
  );

  it.effect(
    "source replacement rejects the reviewed plan before parser or store writes",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* replacedSource() {
          const fixture = yield* selectedSourceFixture(opened, root);

          const service = yield* makeOperationService(opened.agentService, [
            fixture.adapter,
          ]);

          const plan = yield* createPlan(
            service,
            opened,
            fixture.args,
            fixture.scope
          );

          renameSync(fixture.file, `${fixture.file}.previous`);
          writeFileSync(fixture.file, "fixture\n");
          const applied = yield* applyReceipt(service, applyInput(plan));
          expect(applied.receipt.executionState).toBe("rejected");
          expect(applied.receipt.recovery).toBe("replan");
          expect(fixture.reads).toEqual([]);
          expect(
            (yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            })).events
          ).toHaveLength(0);
        })
      )
  );

  it.effect(
    "truncating a spooled source invalidates safe replay while preserving its spool receipt",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* truncatedResume() {
          const fixture = yield* selectedSourceFixture(opened, root);
          fixture.setBusy(true);

          const failures: AgentStoreFailure[] = [];

          const service = yield* makeOperationService(
            recordingAgentStore(opened.agentService, failures),
            [fixture.adapter]
          );

          const plan = yield* createPlan(
            service,
            opened,
            fixture.args,
            fixture.scope
          );

          const partial = yield* applyReceipt(service, applyInput(plan));
          expect(failures.map((failure) => failure.message)).toEqual([]);
          expect(partial.receipt.steps[0]?.state).toBe("spooled");
          expect(fixture.reads).toEqual(["fixture\n"]);
          writeFileSync(fixture.file, "f\n");
          fixture.setBusy(false);
          const resumed = yield* applyReceipt(service, applyInput(plan));
          expect(resumed.receipt.steps[0]?.state).toBe("rejected");
          expect(resumed.receipt.recovery).toBe("replan");
          expect(resumed.receipt.steps[0]?.spooledRefs).toEqual(
            partial.receipt.steps[0]?.spooledRefs
          );
          expect(fixture.reads).toEqual(["fixture\n"]);
          expect(
            (yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            })).events
          ).toHaveLength(0);
        })
      )
  );

  it.effect(
    "approved source growth and unrelated store appends preserve the reviewed selection",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* appendAllowed() {
          const fixture = yield* selectedSourceFixture(opened, root);

          const failures: AgentStoreFailure[] = [];

          const service = yield* makeOperationService(
            recordingAgentStore(opened.agentService, failures),
            [fixture.adapter]
          );

          const plan = yield* createPlan(
            service,
            opened,
            fixture.args,
            fixture.scope
          );

          appendFileSync(fixture.file, "more\n");
          yield* opened.service.append(
            fixtureBatch("evt_fixture_s03_unrelated_append", {
              ...emptyFlightContext,
              repoCommonDir: "fixture:s03:unrelated-repo",
            })
          );
          const applied = yield* applyReceipt(service, applyInput(plan));
          expect(failures.map((failure) => failure.message)).toEqual([]);
          expect(applied.receipt.executionState).toBe("succeeded");
          expect(fixture.reads).toEqual(["fixture\nmore\n"]);
          expect(applied.receipt.steps[0]?.inserted).toBe(1);
          expect(applied.receipt.resources.bytesRead).toBe(13);
          expect(applied.receipt.resources.recordsDecoded).toBeNull();
          expect(new TextEncoder().encode(fixture.reads[0]).byteLength).toBe(
            13
          );
          expect(
            applied.receipt.steps[0]?.gaps.some(
              (gap) => gap.includes("record") && gap.includes("unavailable")
            )
          ).toBe(true);
          expect(
            (yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            })).events
          ).toHaveLength(2);
        })
      )
  );

  it.effect(
    "unknown collection consent references do not grant source enrollment",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* unknownEnrollment() {
          const fixture = yield* selectedSourceFixture(opened, root);

          const service = yield* makeOperationService(opened.agentService, [
            fixture.adapter,
          ]);

          const plan = yield* createPlan(
            service,
            opened,
            fixture.args,
            fixture.scope
          );

          const denied = yield* Effect.flip(
            service.run({
              ...applyInput(plan),
              consentReceiptIds: ["fixture.s03.fabricated-enrollment"],
            })
          );

          expect(denied).toMatchObject({ code: "authorization-required" });
          expect(fixture.reads).toEqual([]);
        })
      )
  );
});

describe("S03 bounded operation execution", () => {
  for (const capped of [
    {
      intended: { bytesRead: 96, filesRead: 1 },
      kind: "bytes",
      remaining: { maxBytes: 32, maxFiles: 1 },
      validation: { bytesRead: 96, filesRead: 1 },
    },
    {
      intended: { bytesRead: 0, filesRead: 1 },
      kind: "files",
      remaining: { maxBytes: 128, maxFiles: 0 },
      validation: { bytesRead: 0, filesRead: 2 },
    },
  ]) {
    it.effect(
      `validation and execution share the cumulative ${capped.kind} limit`,
      () =>
        withFixtureStore((opened) =>
          Effect.gen(function* cumulativeWorkLimit() {
            let effects = 0;
            let remaining: OperationBounds | null = null;
            const usage = { recordsDecoded: 0, requests: 0, retries: 0 };

            const adapter = fixtureAdapter({
              execute: (_plan, step, context) =>
                Effect.gen(function* admittedExecution() {
                  remaining = yield* context.budget.remaining;

                  const admitted = yield* context.budget.reserve({
                    ...usage,
                    ...capped.intended,
                  });

                  effects += 1;
                  yield* admitted.complete({ ...usage, ...capped.intended });

                  return {
                    step: { ...step, inserted: 1, state: "committed" },
                  } satisfies OperationEffectResult;
                }),
              meteredWork: true,
              validate: (_plan, context) =>
                Effect.gen(function* meteredValidation() {
                  yield* context.budget.charge({
                    ...usage,
                    ...capped.validation,
                  });

                  return [];
                }),
            });

            const service = yield* makeOperationService(opened.agentService, [
              adapter,
            ]);

            const plan = yield* createPlan(
              service,
              opened,
              collectionArguments,
              fixtureScope,
              { maxBytes: 128, maxFiles: 2 }
            );

            const output = yield* applyReceipt(service, applyInput(plan));

            expect(remaining).toMatchObject(capped.remaining);
            expect(effects).toBe(0);
            expect(output.receipt.resources.bytesRead).toBe(
              capped.validation.bytesRead
            );
            expect(output.receipt.resources.recordsDecoded).toBe(0);
            expect(output.receipt.steps[0]?.inserted).toBe(0);
            expect(output.receipt.executionState).toBe("partial");
          })
        )
    );
  }

  it.effect(
    "an elapsed acquisition limit interrupts work and preserves an indeterminate receipt",
    () =>
      withFixtureStore((opened) =>
        Effect.gen(function* elapsedLimit() {
          const entered = yield* Deferred.make<boolean>();
          let started = 0;
          let released = 0;

          const adapter = fixtureAdapter({
            execute: () =>
              Effect.gen(function* timedAcquisition() {
                started += 1;
                yield* Deferred.succeed(entered, true);

                return yield* Effect.never;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    released += 1;
                  })
                )
              ),
            steps: () => [
              operationStep("fixture-timed"),
              operationStep("fixture-after-timeout"),
            ],
          });

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          const plan = yield* createPlan(service, opened);

          const running = yield* Effect.forkChild(
            applyReceipt(service, applyInput(plan))
          );

          yield* Deferred.await(entered);
          yield* TestClock.adjust(60_001);
          const output = yield* Fiber.join(running);
          expect(started).toBe(1);
          expect(released).toBe(1);
          expect(output.receipt.executionState).toBe("partial");
          expect(output.receipt.verificationState).toBe("indeterminate");
          expect(output.receipt.recovery).toBe("verify-indeterminate");
          expect(output.receipt.steps).toMatchObject([
            { id: "fixture-timed", inserted: 0, state: "indeterminate" },
            { id: "fixture-after-timeout", inserted: 0, state: "rejected" },
          ]);
          const retry = yield* applyReceipt(service, applyInput(plan));
          expect(retry.receipt).toEqual(output.receipt);
          expect(started).toBe(1);
        })
      )
  );
});

describe("S03 committed collection receipts", () => {
  it.effect(
    "a busy writer spools without advancing the safe cursor and replay deduplicates",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* spoolCursor() {
          const ref: SessionRef = {
            channel: "session-file",
            harness: "pi",
            id: "fixture:s03:session",
            mtimeMs: 2,
            path: path.join(root, "fixture-session.jsonl"),
            sessionId: "fixture-s03-session",
            size: 200,
            source: "harness.pi",
            worktree: null,
          };

          const prior = {
            cursor: fileCursorOf("harness.pi", {
              mtimeMs: 1,
              offset: 100,
              path: ref.path,
              size: 100,
            }),
            lastEventId: null,
            mtimeMs: 1,
            size: 100,
          };

          const advanced = fileCursorOf("harness.pi", {
            mtimeMs: 2,
            offset: 200,
            path: ref.path,
            size: 200,
          });

          const batch: EventBatch = {
            coverage: {
              adapterId: "harness.pi",
              expectedItems: 1,
              gaps: [],
              observedItems: 1,
              state: "complete",
              watermark: "fixture-s03-watermark",
              windowFrom: null,
              windowTo: null,
            },
            cursor: advanced,
            events: [
              {
                acquisition: "file-import",
                adapterId: "harness.pi",
                adapterVersion: "fixture.s03.v1",
                ai: null,
                context: emptyFlightContext,
                eventId: EventIdSchema.make("evt_fixture_s03_spool"),
                evidence: {
                  bounded: true,
                  hash: null,
                  ref: "fixture:s03:synthetic-record",
                },
                fieldSemantics: [],
                identity: emptyEventIdentity,
                kind: "other",
                observedAt: "2026-01-01T00:00:00.000Z",
                occurredAt: null,
                occurredAtPrecision: "unknown",
                origin: "fixture",
                payload: { fixture: "S03 synthetic spool record" },
                schemaVersion: "dx.event.v2",
                sourceVersion: "fixture.s03.v1",
                upstreamKey: "fixture:s03:record-1",
                usage: null,
              },
            ],
          };

          const reads: (CollectCursor | null)[] = [];

          const harness: Harness = {
            capabilities: {
              branchSources: [],
              liveHooks: false,
              storedFigure: null,
              subagents: false,
            },
            channels: ["session-file"],
            discover: Effect.succeed({
              harness: "pi",
              present: true,
              reason: null,
              roots: [root],
              sessions: 1,
              version: "fixture.s03.v1",
            }),
            displayName: "Synthetic S03 fixture",
            id: "pi",
            locate: () => Effect.succeed([ref]),
            read: (_ref, input) =>
              Effect.sync(() => {
                reads.push(input.cursor);

                return batch;
              }),
          };

          const source: PlannedSource = {
            context: emptyFlightContext,
            harness: "pi",
            input: ref.path,
            ref,
            source: "harness.pi",
            unavailable: null,
          };

          const env = {
            store: opened.service,
            storePath: path.join(root, "fixture.sqlite"),
          };

          const cursors = yield* HarnessCursors;
          yield* cursors.put(ref, prior);

          const spooled = yield* runPlannedStep(
            {
              ...env,
              store: {
                ...opened.service,
                append: () =>
                  Effect.fail(
                    new StoreBusy({ message: "Synthetic fixture writer lock" })
                  ),
              },
            },
            [],
            source
          ).pipe(Effect.provide(HarnessRegistry.fromHarnesses([harness])));

          expect(spooled.state).toBe("spooled");
          expect(spooled.inserted).toBe(0);
          expect(spooled.spooledRefs).toHaveLength(1);
          expect(spooled.readCursor).toEqual(advanced);
          expect(spooled.safeCursor).toEqual(prior.cursor);
          expect(yield* cursors.get(ref)).toEqual(prior);
          const spoolRef = spooled.spooledRefs?.[0];

          if (spoolRef === undefined) {
            return yield* Effect.die(
              new Error("Expected a persisted fixture spool")
            );
          }

          expect(existsSync(spoolRef)).toBe(true);
          const imported = yield* runImportSpool(env);
          expect(imported).toMatchObject({
            duplicates: 0,
            files: 1,
            inserted: 1,
            rejected: [],
          });

          const replayed = yield* runPlannedStep(env, [], source).pipe(
            Effect.provide(HarnessRegistry.fromHarnesses([harness]))
          );

          expect(replayed.state).toBe("duplicate");
          expect(replayed.inserted).toBe(0);
          expect(replayed.duplicates).toBe(1);
          expect(reads).toEqual([prior.cursor, prior.cursor]);
          expect(replayed.safeCursor).toEqual(advanced);
          expect((yield* cursors.get(ref))?.cursor).toEqual(advanced);

          return yield* Effect.void;
        }).pipe(
          Effect.provide(
            Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
          )
        )
      )
  );
});

describe("S03 reviewed administration", () => {
  it.effect("a selected backup WAL change invalidates restore review", () =>
    withFixtureStore((opened, root) =>
      Effect.gen(function* backupWalReview() {
        const home = liveHome(root, path.join(root, "fixture.sqlite"));
        const seeded = yield* resetStore(home, "reset");

        const backup = yield* Effect.acquireRelease(
          openSqliteEventStore({ kind: "live", path: seeded.backup.path }),
          (owned) =>
            Effect.sync(() => {
              owned.close();
            })
        );

        const request: LiveAdministrationRequest = {
          backupId: seeded.backup.id,
          kind: "restore",
        };

        const reviewed = yield* previewAdministration(home, request);
        const mainDatabase = readFileSync(seeded.backup.path);
        const backupsBefore = readdirSync(backupsDir(home)).toSorted();

        yield* backup.service.append(
          fixtureBatch("evt_fixture_s03_backup_wal")
        );
        const changed = yield* previewAdministration(home, request);
        expect(readFileSync(seeded.backup.path)).toEqual(mainDatabase);
        expect(changed.fingerprint).not.toBe(reviewed.fingerprint);
        expect(changed.backupContentDigest).not.toBe(
          reviewed.backupContentDigest
        );
        expect(changed.selectedRefs).toContain(
          `file:${seeded.backup.path}-wal`
        );

        const rejected = yield* Effect.flip(
          applyReviewedAdministration(
            home,
            request,
            reviewed.fingerprint,
            reviewed.confirmText ?? "",
            "fixture-s03-stale-backup-wal"
          )
        );

        expect(rejected.reason).toBe("stale-plan");
        expect(readdirSync(backupsDir(home)).toSorted()).toEqual(backupsBefore);
        expect(
          (yield* opened.service.snapshot({
            branch: null,
            flightId: null,
            from: null,
            repoCommonDir: null,
            to: null,
          })).events
        ).toHaveLength(0);
      })
    )
  );
  it.effect(
    "nested empty directories count against the administration file bound",
    () =>
      withFixtureStore((_opened, root) =>
        Effect.gen(function* directoryBound() {
          const home = liveHome(root, path.join(root, "fixture.sqlite"));
          mkdirSync(
            path.join(root, "spool", "fixture-a", "fixture-b", "fixture-c"),
            { recursive: true }
          );

          const rejected = yield* Effect.flip(
            previewAdministration(
              home,
              { kind: "reset" },
              { maxBytes: 1_000_000, maxFiles: 1, maxRecords: 1000 }
            )
          );

          expect(rejected.message).toMatch(/bound|budget|limit/u);
          expect(existsSync(backupsDir(home))).toBe(false);
          expect(
            existsSync(
              path.join(root, "spool", "fixture-a", "fixture-b", "fixture-c")
            )
          ).toBe(true);
        })
      )
  );

  it.effect(
    "restore budget exhaustion after a safety backup preserves a partial result",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* partialRestoreBackup() {
          const home = liveHome(root, path.join(root, "fixture.sqlite"));
          const seeded = yield* resetStore(home, "reset");
          yield* opened.service.append(
            fixtureBatch("evt_fixture_s03_partial_restore")
          );

          const request: LiveAdministrationRequest = {
            backupId: seeded.backup.id,
            kind: "restore",
          };

          const reviewed = yield* previewAdministration(home, request, {
            maxBytes: 16_000_000,
            maxFiles: 100,
            maxRecords: 10_000,
          });

          const partial = yield* applyReviewedAdministration(
            home,
            request,
            reviewed.fingerprint,
            reviewed.confirmText ?? "",
            "fixture-s03-partial-restore",
            {
              maxBytes: 2_000_000,
              maxFiles: 100,
              maxRecords: 10_000,
            }
          );

          expect(partial.backupIds).toHaveLength(1);
          expect(
            partial.partialErrors.some((gap) => gap.includes("limit"))
          ).toBe(true);
          expect(partial.verificationUnavailable).toContain(
            "backup-content-digests"
          );
          expect(partial.removedCount).toBeNull();
          expect(partial.resources.bytesRead).toBeLessThanOrEqual(2_000_000);
        })
      )
  );

  for (const operationKind of ["reset", "restore"] as const) {
    it.effect(
      `a ${operationKind} retry recovers its consumed receipt after reopening and store invalidation`,
      () =>
        withFixtureStore((opened, root) =>
          Effect.gen(function* administrationRecovery() {
            const home = liveHome(root, path.join(root, "fixture.sqlite"));

            let request: Extract<
              LiveAdministrationRequest,
              { kind: "reset" | "restore" }
            > = { kind: "reset" };

            if (operationKind === "restore") {
              const seedReview = yield* previewAdministration(home, request);

              const seeded = yield* applyReviewedAdministration(
                home,
                request,
                seedReview.fingerprint,
                seedReview.confirmText ?? "",
                "fixture-s03-seed-reset"
              );

              const backupId = yield* Effect.fromNullishOr(seeded.backupIds[0]);
              request = { backupId, kind: "restore" };
              yield* opened.service.append(
                fixtureBatch("evt_fixture_s03_before_restore")
              );
            }

            const reviewed = yield* previewAdministration(home, request);
            let applies = 0;

            const backend: LiveAdministrationBackend = {
              applyReviewedAdministration: (
                selected,
                fingerprint,
                confirmation,
                id,
                limits
              ) => {
                applies += 1;

                return applyReviewedAdministration(
                  home,
                  selected,
                  fingerprint,
                  confirmation,
                  id,
                  limits
                );
              },
              home,
              previewAdministration: (selected, limits) =>
                previewAdministration(home, selected, limits),
              probeReviewedAdministration: (retained, ids, limits) =>
                probeReviewedAdministration(home, retained, ids, limits),
            };

            const failures: AgentStoreFailure[] = [];

            const service = yield* makeOperationService(
              recordingAgentStore(opened.agentService, failures),
              makeLiveAdministrationAdapters(backend, opened.agentService)
            );

            const before = yield* opened.agentService.identity;

            const args: OperationArguments =
              request.kind === "reset"
                ? { backupRequired: true, kind: "reset" }
                : {
                    backupId: request.backupId,
                    expectedContentDigest: yield* Effect.fromNullishOr(
                      reviewed.backupContentDigest
                    ),
                    kind: "restore",
                  };

            const scope: AgentScope = {
              ...fixtureScope,
              branchSelection: { branches: [], kind: "all" },
              repoId: null,
              sources: [],
              worktreeId: null,
            };

            const plan = yield* createPlan(service, opened, args, scope, {
              maxBytes: 16_000_000,
              maxFiles: 100,
              maxRecords: 10_000,
            });

            const confirmation = plan.preconditions.find(
              (entry) =>
                entry.kind === "backup-policy" &&
                entry.target === "confirmation"
            )?.expected;

            const input = {
              ...applyInput(plan, `fixture.s03.${operationKind}-key`),
              confirmation: confirmation ?? reviewed.confirmText,
            };

            const applied = yield* applyReceipt(service, input);
            expect(failures.map((failure) => failure.message)).toEqual([]);
            expect(
              applied.receipt.executionState,
              JSON.stringify({
                effects: applied.receipt.effects,
                resources: applied.receipt.resources,
                steps: applied.receipt.steps,
              })
            ).toBe("succeeded");
            expect(applied.receipt.steps[0]?.state).toBe("committed");
            expect(applied.receipt.effects.backupIds).toHaveLength(1);

            if (operationKind === "reset") {
              expect(applied.receipt.storeGeneration).toBeGreaterThan(
                before.storeGeneration
              );
            } else {
              expect(applied.receipt.storeGeneration).toBe(
                before.storeGeneration
              );
            }

            const replayed = yield* Effect.acquireUseRelease(
              openSqliteEventStore({ kind: "live", path: home.storePath }),
              (reopened) =>
                Effect.scoped(
                  Effect.gen(function* reopenAdministration() {
                    const restarted = yield* makeOperationService(
                      reopened.agentService,
                      makeLiveAdministrationAdapters(
                        backend,
                        reopened.agentService
                      )
                    );

                    const replay = yield* applyReceipt(restarted, input);

                    const get = yield* restarted.run({
                      action: "get",
                      operation: {
                        id: applied.receipt.id,
                        storeGeneration: before.storeGeneration,
                        storeId: before.storeId,
                      },
                    });

                    return { get, replay };
                  })
                ),
              (reopened) =>
                Effect.sync(() => {
                  reopened.close();
                })
            );

            expect(replayed.replay.reused).toBe(true);
            expect(replayed.replay.receipt).toEqual(applied.receipt);
            expect(replayed.get).toMatchObject({
              action: "get",
              receipt: {
                id: applied.receipt.id,
                storeGeneration: applied.receipt.storeGeneration,
              },
            });

            const recovered = yield* Effect.fromNullishOr(
              replayed.get.action === "get" ? replayed.get : null
            );

            expect(recovered.reviewedPlan).toMatchObject({
              arguments: plan.arguments,
              planDigest: plan.planDigest,
              scope: plan.scope,
              validity: "stale",
            });
            expect(recovered.reviewedPlanUnavailableReason).toBeNull();
            expect(applies).toBe(1);
            expect((yield* opened.agentService.identity).storeGeneration).toBe(
              applied.receipt.storeGeneration
            );
          })
        )
    );
  }

  it.effect(
    "configuration changes invalidate the review before writing the requested setting",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* staleConfiguration() {
          const home = liveHome(root, path.join(root, "fixture.sqlite"));

          const request = {
            action: "cursor-usage",
            enabled: true,
            kind: "configure",
          } as const;

          yield* writeLiveConfig(home, { cursorUsageImport: false, repos: [] });
          const reviewed = yield* previewAdministration(home, request);
          yield* writeLiveConfig(home, {
            cursorUsageImport: false,
            repos: ["fixture:s03:external-repo"],
          });
          const before = readFileSync(configPath(home), "utf-8");
          const beforeIdentity = yield* opened.agentService.identity;

          const rejected = yield* Effect.flip(
            applyReviewedAdministration(
              home,
              request,
              reviewed.fingerprint,
              "",
              "fixture-stale-config"
            )
          );

          expect(rejected.reason).toBe("stale-plan");
          expect(readFileSync(configPath(home), "utf-8")).toBe(before);
          expect(yield* opened.agentService.identity).toEqual(beforeIdentity);
          expect(existsSync(backupsDir(home))).toBe(false);
        })
      )
  );

  it.effect(
    "new selected evidence invalidates deletion before backup or removal",
    () =>
      withFixtureStore((opened, root) =>
        Effect.gen(function* staleDeletion() {
          const home = liveHome(root, path.join(root, "fixture.sqlite"));
          const target = path.join(root, "synthetic-repository");

          const context = {
            ...emptyFlightContext,
            repoCommonDir: path.join(target, ".git"),
            worktreePath: target,
          };

          yield* opened.service.append(
            fixtureBatch("evt_fixture_s03_before_review", context)
          );
          const request = { kind: "delete", target } as const;
          const reviewed = yield* previewAdministration(home, request);
          yield* opened.service.append(
            fixtureBatch("evt_fixture_s03_after_review", context)
          );
          const beforeIdentity = yield* opened.agentService.identity;

          const rejected = yield* Effect.flip(
            applyReviewedAdministration(
              home,
              request,
              reviewed.fingerprint,
              reviewed.confirmText ?? "",
              "fixture-stale-delete"
            )
          );

          expect(rejected.reason).toBe("stale-plan");
          expect(yield* opened.agentService.identity).toEqual(beforeIdentity);
          expect(
            (yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: context.repoCommonDir,
              to: null,
            })).events
          ).toHaveLength(2);
          expect(existsSync(backupsDir(home))).toBe(false);
        })
      )
  );
});
