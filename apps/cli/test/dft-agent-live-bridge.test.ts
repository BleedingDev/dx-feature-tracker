// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture artifact receipts use a digest of the exact bytes written.
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- The metadata export fixture owns and cleans its temporary file and SQLite store.
} from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture artifacts stay in their owned temporary directory.
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  AgentError,
  configPath,
  contextForRepo,
  liveHome,
  makeFakeAgentStore,
  makeOperationService,
  openSqliteEventStore,
  operationStep,
  OperationPlanSchema,
  resetStore,
} from "@rat-stack/core/dx";
import type {
  AgentScope,
  AgentStoreFailure,
  LiveAdministrationPreview,
  LiveAdministrationRequest,
  OperationAdapter,
  OperationEffectResult,
  OperationInput,
  OperationOutput,
  OperationPlan,
  OperationPreparation,
  OperationReceipt,
  OperationServiceApi,
} from "@rat-stack/core/dx";
import { Effect } from "effect";
import { vi } from "vitest";

import {
  DASHBOARD_OPERATION_BOUNDS,
  makeDashboardOperationBridge,
} from "../src/dft-agent-live-bridge.js";

const totals = {
  commitSnapshots: 3,
  coverage: 2,
  events: 7,
  spoolFiles: 4,
  storeSnapshots: 1,
};

const confirmation = "fixture exact reviewed confirmation";

const exportScope: AgentScope = {
  branchSelection: { branches: [], kind: "all" },
  flightId: null,
  repoId: null,
  resolution: "Synthetic metadata export fixture scope.",
  sources: [],
  tools: [],
  worktreeId: null,
};

const fixtureError = (code: AgentError["code"], message: string) =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "none", ref: null },
    ref: null,
    retryable: false,
  });

const receiptFor = (
  plan: OperationPlan,
  idempotencyKey: string
): OperationReceipt => ({
  afterRevision: null,
  beforeRevision: "fixture:before-revision",
  cancellationRequested: false,
  completedAt: null,
  effects: {
    backupArtifacts: [
      {
        contentDigest: "fixture:backup-digest",
        id: "fixture:safety-backup",
        restorationVersion: "fixture:backup-version",
        storeGeneration: plan.storeGeneration,
        storeId: plan.storeId,
      },
    ],
    backupIds: ["fixture:safety-backup"],
    configDigest: null,
    evidenceIds: [],
    exportArtifacts: [],
    exports: [],
    filesChanged: [],
    remainingStoreGeneration: plan.storeGeneration,
    removalReason: "Synthetic fixture effect needs verification.",
    removedCount: null,
    removedRefs: [],
  },
  executionState: "partial",
  id: "fixture:receipt",
  idempotencyKey,
  planDigest: plan.planDigest,
  planId: plan.id,
  recovery: "verify-indeterminate",
  resources: {
    bytesRead: null,
    elapsedMs: null,
    recordsDecoded: null,
    requests: 0,
    retries: 0,
  },
  resultingBasisId: null,
  revision: 1,
  schemaVersion: "dx.operation.v1",
  startedAt: "2026-10-01T00:00:00.000Z",
  steps: [],
  storeGeneration: plan.storeGeneration,
  storeId: plan.storeId,
  verificationRefs: [],
  verificationState: "indeterminate",
});

const fixtures = (options: { readonly stalePreview?: boolean } = {}) => {
  const currentRepo = process.cwd();

  const canonical = contextForRepo(currentRepo);

  const home = liveHome("/fixture/dashboard-live-home");

  const plans = new Map<string, OperationPlan>();

  const receipts: OperationReceipt[] = [];

  const identity = {
    revision: "fixture:revision",
    storeGeneration: 1,
    storeId: "fixture:store",
  };

  const previewAdministration = vi.fn((request: LiveAdministrationRequest) => {
    let plan: LiveAdministrationPreview["plan"] = null;

    if (request.kind === "delete") {
      plan = {
        branches: [],
        confirmText: confirmation,
        hookFiles: [],
        repo: {
          commonDir: canonical.repoCommonDir ?? "fixture:repo-id",
          name: "fixture-repository",
          root: request.target,
        },
        spoolDirs: [],
        totals,
        tracked: true,
      };
    } else if (request.kind === "reset") {
      plan = {
        confirmText: "reset",
        hookFiles: [],
        repos: [{ events: 7, repoCommonDir: "fixture:repo-id" }],
        spoolDirs: [],
        totals,
      };
    }

    const preview: LiveAdministrationPreview = {
      backup:
        request.kind === "restore"
          ? {
              bytes: 100,
              createdAt: "2026-10-01T00:00:00.000Z",
              id: request.backupId,
              path: "/fixture/dashboard-live-home/backups/selected",
              reason: "reset",
              repo: null,
              retrack: [],
            }
          : null,
      backupContentDigest:
        request.kind === "restore" ? "fixture:backup-content" : null,
      configDigest: "fixture:config-content",
      configuration: { cursorUsageImport: false, repos: [] },
      confirmText:
        request.kind === "delete" || request.kind === "reset"
          ? confirmation
          : null,
      fileDigests: [],
      fingerprint: "fixture:preview-fingerprint",
      plan,
      request,
      resources: {
        bytesRead: 100,
        elapsedMs: 1,
        filesRead: 1,
        recordsDecoded: 0,
      },
      selectedRefs: ["fixture:selected-ref"],
    };

    return Effect.succeed(preview);
  });

  const getOperationPlan = vi.fn((handle: { readonly id: string }) => {
    const plan = plans.get(handle.id);

    return plan === undefined
      ? Effect.fail(
          fixtureError(
            "operation-not-found",
            "Synthetic fixture has no reviewed plan."
          )
        )
      : Effect.succeed(plan);
  });

  const store = makeFakeAgentStore({
    getOperationPlan,
    identity: Effect.succeed(identity),
  });

  const run = vi.fn(
    Effect.fn("fixtureDashboardOperations.run")(function* run(
      input: OperationInput
    ): Effect.fn.Return<OperationOutput, AgentStoreFailure> {
      if (input.action === "plan") {
        const plan = OperationPlanSchema.make({
          arguments: input.arguments,
          bounds: input.bounds,
          consent: {
            reason: "Synthetic fixture requires exact text.",
            receiptIds: [],
            scopeDigest: "fixture:scope-digest",
            state: "required",
          },
          createdAt: "2026-10-01T00:00:00.000Z",
          effects: {
            destructive:
              input.arguments.kind !== "configure" &&
              input.arguments.kind !== "export",
            networkDestinations: [],
            reads: [],
            writes: [],
          },
          expectedEvidenceImprovement: "Synthetic fixture operation.",
          expiresAt: "2026-10-01T00:15:00.000Z",
          forecast: { bytes: null, cost: null, elapsedMs: null, requests: 0 },
          id: `fixture:plan-${String(plans.size + 1)}`,
          kind: input.arguments.kind,
          planDigest: `fixture:digest-${String(plans.size + 1)}`,
          preconditions: [
            {
              allowAppend: false,
              expected:
                options.stalePreview === true
                  ? "fixture:changed-fingerprint"
                  : "fixture:preview-fingerprint",
              kind: "selected-content",
              target: "administration.fingerprint",
            },
            {
              allowAppend: false,
              expected: "fixture:config-content",
              kind: "config-digest",
              target: "administration.current-config",
            },
            {
              allowAppend: false,
              expected: confirmation,
              kind: "backup-policy",
              target: "confirmation",
            },
          ],
          purpose: input.purpose,
          resumeBoundary: "atomic-step",
          schemaVersion: "dx.operation.v1",
          scope: input.scope,
          stopCondition: "Synthetic fixture stops after one step.",
          storeGeneration: identity.storeGeneration,
          storeId: identity.storeId,
          validity: "valid",
        });

        plans.set(plan.id, plan);

        return { action: "plan", plan };
      }

      if (input.action === "apply") {
        const retained = plans.get(input.plan.id);

        if (retained === undefined) {
          return yield* fixtureError(
            "operation-not-found",
            "Synthetic fixture has no reviewed plan."
          );
        }

        const receipt = receiptFor(retained, input.idempotencyKey);
        receipts.push(receipt);

        return { action: "apply", receipt, reused: false };
      }

      return yield* fixtureError(
        "invalid-transition",
        "Synthetic fixture accepts plan and apply only."
      );
    })
  );

  const operations: OperationServiceApi = { descriptors: [], run };

  const bridge = makeDashboardOperationBridge({
    currentRepo,
    engine: { home, previewAdministration },
    operations,
    store,
  });

  return {
    bridge,
    canonical,
    getOperationPlan,
    home,
    identity,
    plans,
    previewAdministration,
    receipts,
    run,
  };
};

describe("dashboard shared live operation bridge", () => {
  it.effect(
    "apply uses the earlier reviewed plan and preserves backup and unknown outcome receipts",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* retainedReview() {
        const earlier = yield* fixture.bridge.plan("reset");

        const newer = yield* fixture.bridge.plan("restore", "fixture:backup");

        const receipt = yield* fixture.bridge.apply(
          earlier.review,
          earlier.confirmText,
          "fixture:click-key"
        );

        expect(earlier.plan.id).not.toBe(newer.plan.id);
        expect(earlier.totals).toBe(totals);
        expect(earlier.repos).toBe(1);
        expect(fixture.previewAdministration).toHaveBeenCalledTimes(2);
        expect(fixture.getOperationPlan).toHaveBeenCalledExactlyOnceWith(
          earlier.review.plan
        );
        expect(fixture.run).toHaveBeenLastCalledWith({
          action: "apply",
          confirmation,
          consentReceiptIds: [],
          expectedDigest: earlier.plan.planDigest,
          idempotencyKey: "fixture:click-key",
          plan: earlier.review.plan,
        });
        expect(receipt).toBe(fixture.receipts[0]);
        expect(receipt.effects.backupIds).toEqual(["fixture:safety-backup"]);
        expect(receipt.effects.backupArtifacts[0]?.contentDigest).toBe(
          "fixture:backup-digest"
        );
        expect(receipt.effects.removedCount).toBeNull();
        expect(receipt.verificationState).toBe("indeterminate");
        expect(receipt.recovery).toBe("verify-indeterminate");
      });
    }
  );

  it.effect(
    "destructive reviews use canonical unfiltered repository or whole-store scopes",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* exactScopes() {
        const deleted = yield* fixture.bridge.plan("delete");

        const reset = yield* fixture.bridge.plan("reset");

        const restored = yield* fixture.bridge.plan(
          "restore",
          "fixture:backup"
        );

        expect(deleted.plan.scope).toMatchObject({
          branchSelection: { branches: [], kind: "all" },
          flightId: null,
          repoId: fixture.canonical.repoCommonDir,
          sources: [],
          tools: [],
          worktreeId: fixture.canonical.worktreePath,
        });
        expect(deleted.plan.arguments).toEqual({
          backupRequired: true,
          kind: "delete",
          selectedRefs: [],
        });
        expect(reset.plan.scope).toMatchObject({
          branchSelection: { branches: [], kind: "all" },
          repoId: null,
          worktreeId: null,
        });
        expect(restored.plan.scope).toEqual(reset.plan.scope);
        expect(restored.plan.arguments).toEqual({
          backupId: "fixture:backup",
          expectedContentDigest: "fixture:backup-content",
          kind: "restore",
        });
        expect(restored.backup?.id).toBe("fixture:backup");
        expect(restored.repos).toBeNull();
        expect(restored.branches).toBeNull();
        expect(restored.totals).toBeNull();
        expect(restored.countsUnavailableReason).toContain("does not report");
        expect(reset.plan.bounds).toEqual(DASHBOARD_OPERATION_BOUNDS);
        expect(fixture.run.mock.calls[0]?.[0]).toMatchObject({
          action: "plan",
          target: fixture.identity,
        });
      });
    }
  );

  it.effect(
    "tampered reviews, unsupported fields and wrong typed text never apply",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* deniedReview() {
        const reviewed = yield* fixture.bridge.plan("reset");

        for (const item of [
          {
            code: "plan-stale",
            review: {
              ...reviewed.review,
              expectedDigest: "fixture:other-digest",
            },
            text: confirmation,
          },
          {
            code: "plan-stale",
            review: { ...reviewed.review, kind: "delete" },
            text: confirmation,
          },
          {
            code: "invalid-selector",
            review: { ...reviewed.review, autoApprove: true },
            text: confirmation,
          },
          {
            code: "invalid-selector",
            review: {
              ...reviewed.review,
              plan: { ...reviewed.review.plan, target: "fixture:other-target" },
            },
            text: confirmation,
          },
          {
            code: "authorization-required",
            review: reviewed.review,
            text: "yes",
          },
        ] as const) {
          const error = yield* Effect.flip(
            fixture.bridge.apply(item.review, item.text, "fixture:click-key")
          );

          expect(error._tag).toBe("AgentError");
          expect(error).toMatchObject({ code: item.code });
        }

        expect(fixture.run).toHaveBeenCalledTimes(1);
        expect(fixture.previewAdministration).toHaveBeenCalledTimes(1);
      });
    }
  );

  it.effect(
    "changed preview contents are rejected before a review is exposed",
    () => {
      const fixture = fixtures({ stalePreview: true });

      return Effect.gen(function* staleReview() {
        const error = yield* Effect.flip(fixture.bridge.plan("reset"));

        expect(error._tag).toBe("AgentError");
        expect(error).toMatchObject({ code: "plan-stale" });
        expect(fixture.run).toHaveBeenCalledTimes(1);
        expect(fixture.receipts).toEqual([]);
      });
    }
  );

  it.effect(
    "newer metadata export previews do not redirect an earlier retained review",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* retainedMetadataExport() {
        const earlier = yield* fixture.bridge.previewExport({
          basisId: "fixture:earlier-basis",
          destination: "/fixture/earlier-metadata.json",
          scope: exportScope,
        });

        const newer = yield* fixture.bridge.previewExport({
          basisId: "fixture:newer-basis",
          destination: "/fixture/newer-metadata.json",
          scope: exportScope,
        });

        yield* fixture.bridge.apply(
          earlier.review,
          earlier.confirmText,
          earlier.idempotencyKey
        );

        expect(earlier.plan.id).not.toBe(newer.plan.id);
        expect(earlier.plan.arguments).toEqual({
          basisId: "fixture:earlier-basis",
          destination: "/fixture/earlier-metadata.json",
          disclosure: "metadata-only",
          kind: "export",
        });
        expect(earlier.plan.scope).toEqual(exportScope);
        expect(earlier.confirmText).toBe(
          `EXPORT METADATA ${earlier.plan.consent.scopeDigest}`
        );
        expect(earlier.idempotencyKey).toBe(
          `dashboard:export:${earlier.plan.id}`
        );
        expect(fixture.run).toHaveBeenCalledTimes(3);
        expect(fixture.run).toHaveBeenLastCalledWith({
          action: "apply",
          confirmation: earlier.confirmText,
          consentReceiptIds: [],
          expectedDigest: earlier.plan.planDigest,
          idempotencyKey: earlier.idempotencyKey,
          plan: earlier.review.plan,
        });
        expect(fixture.previewAdministration).not.toHaveBeenCalled();
      });
    }
  );

  it.effect(
    "metadata export rejects unsupported selectors and wider retained disclosure",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* deniedMetadataExport() {
        const unsupported = {
          basisId: "fixture:metadata-basis",
          destination: "/fixture/metadata.json",
          scope: { ...exportScope, autoSync: true },
        };

        const selectorError = yield* Effect.flip(
          fixture.bridge.previewExport(unsupported)
        );

        expect(selectorError).toMatchObject({ code: "invalid-selector" });
        expect(fixture.run).not.toHaveBeenCalled();

        const reviewed = yield* fixture.bridge.previewExport({
          basisId: "fixture:metadata-basis",
          destination: "/fixture/metadata.json",
          scope: exportScope,
        });

        fixture.plans.set(reviewed.plan.id, {
          ...reviewed.plan,
          arguments: {
            basisId: reviewed.basisId,
            destination: reviewed.destination,
            disclosure: "redacted-evidence",
            kind: "export",
          },
        });

        const disclosureError = yield* Effect.flip(
          fixture.bridge.apply(
            reviewed.review,
            reviewed.confirmText,
            reviewed.idempotencyKey
          )
        );

        expect(disclosureError).toMatchObject({ code: "scope-denied" });
        expect(fixture.run).toHaveBeenCalledTimes(1);
        expect(fixture.receipts).toEqual([]);
        expect(fixture.previewAdministration).not.toHaveBeenCalled();
      });
    }
  );

  it.effect(
    "metadata export recovers a lost response across reset without a new artifact",
    () =>
      Effect.scoped(
        Effect.gen(function* durableMetadataExport() {
          const root = yield* Effect.acquireRelease(
            Effect.sync(() =>
              mkdtempSync(path.join(tmpdir(), "dft-bridge-export-"))
            ),
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

          const basisId = "fixture:metadata-export-basis";
          const destination = path.join(root, "metadata.json");

          const contents = JSON.stringify({
            basisId,
            fixture: "Synthetic metadata export with no live evidence.",
          });

          const contentDigest = createHash("sha256")
            .update(contents)
            .digest("hex");

          const effects = {
            destructive: false,
            networkDestinations: [],
            reads: [],
            writes: [destination],
          };

          let prepares = 0;
          let executions = 0;

          const adapter: OperationAdapter = {
            authorize: (plan, input) =>
              Effect.succeed(
                input.confirmation ===
                  `EXPORT METADATA ${plan.consent.scopeDigest}`
              ),
            descriptor: {
              authorization: "explicit-confirmation",
              cancellation: "before-start-only",
              effects,
              enabled: true,
              idempotency: "durable-key",
              kind: "export",
              reason: null,
              requiredInputs: ["basisId", "destination", "disclosure"],
              version: "fixture.metadata-export.v1",
            },
            execute: (plan, step) =>
              Effect.sync(() => {
                executions += 1;
                writeFileSync(destination, contents, { flag: "wx" });

                return {
                  effects: {
                    backupArtifacts: [],
                    backupIds: [],
                    configDigest: null,
                    evidenceIds: [],
                    exportArtifacts: [
                      {
                        basisId,
                        contentDigest,
                        destination,
                        disclosure: "metadata-only",
                      },
                    ],
                    exports: [destination],
                    filesChanged: [destination],
                    remainingStoreGeneration: plan.storeGeneration,
                    removalReason:
                      "Synthetic metadata export removes no observations.",
                    removedCount: null,
                    removedRefs: [],
                  },
                  resources: {
                    bytesRead: 0,
                    elapsedMs: null,
                    recordsDecoded: 0,
                    requests: 0,
                    retries: 0,
                  },
                  step: { ...step, state: "committed" },
                  verificationRefs: [],
                } satisfies OperationEffectResult;
              }),
            prepare: (input) =>
              Effect.sync(() => {
                prepares += 1;

                return {
                  arguments: input.arguments,
                  consent: {
                    reason: "Authorize the reviewed synthetic metadata export.",
                    receiptIds: [],
                    scopeDigest: "fixture:scope-digest",
                    state: "required",
                  },
                  effects,
                  expectedEvidenceImprovement:
                    "Exercise a durable metadata export receipt on a synthetic fixture.",
                  forecast: {
                    bytes: Buffer.byteLength(contents, "utf-8"),
                    cost: null,
                    elapsedMs: null,
                    requests: 0,
                  },
                  preconditions: [],
                  resumeBoundary: "atomic-step",
                  stopCondition:
                    "Write one synthetic metadata artifact and retain its receipt.",
                } satisfies OperationPreparation;
              }),
            probe: () => Effect.succeed({ state: "absent" }),
            replay: "probe-required",
            steps: () => [operationStep("fixture-export", "fixture:metadata")],
            validate: () => Effect.succeed([]),
          };

          const service = yield* makeOperationService(opened.agentService, [
            adapter,
          ]);

          let loseApplyResponse = false;

          const completed: OperationReceipt[] = [];

          const run = vi.fn(
            Effect.fn("fixtureMetadataExport.run")(function* run(
              request: OperationInput
            ) {
              const output = yield* service.run(request);

              if (request.action === "apply" && output.action === "apply") {
                completed.push(output.receipt);

                if (loseApplyResponse) {
                  loseApplyResponse = false;

                  return yield* fixtureError(
                    "source-unavailable",
                    "The synthetic apply response was lost after completion."
                  );
                }
              }

              return output;
            })
          );

          const previewAdministration = vi.fn(() =>
            Effect.die(
              "The metadata export fixture has no administration preview."
            )
          );

          const bridge = makeDashboardOperationBridge({
            currentRepo: process.cwd(),
            engine: { home: liveHome(root), previewAdministration },
            operations: { descriptors: service.descriptors, run },
            store: opened.agentService,
          });

          const reviewed = yield* bridge.previewExport({
            basisId,
            destination,
            scope: exportScope,
          });

          const unused = yield* bridge.previewExport({
            basisId: "fixture:unused-metadata-basis",
            destination: path.join(root, "unused-metadata.json"),
            scope: exportScope,
          });

          expect(executions).toBe(0);

          const keyError = yield* Effect.flip(
            bridge.apply(
              reviewed.review,
              reviewed.confirmText,
              "fixture:replacement-key"
            )
          );

          const confirmationError = yield* Effect.flip(
            bridge.apply(reviewed.review, "yes", reviewed.idempotencyKey)
          );

          expect(keyError).toMatchObject({ code: "idempotency-conflict" });
          expect(confirmationError).toMatchObject({
            code: "authorization-required",
          });
          expect(run).toHaveBeenCalledTimes(2);
          expect(executions).toBe(0);

          loseApplyResponse = true;

          const lostResponse = yield* Effect.flip(
            bridge.apply(
              reviewed.review,
              reviewed.confirmText,
              reviewed.idempotencyKey
            )
          );

          const first = yield* Effect.fromNullishOr(completed[0]);

          expect(lostResponse).toMatchObject({ code: "source-unavailable" });
          expect(first.executionState).toBe("succeeded");
          expect(first.verificationState).toBe("verified");
          expect(readFileSync(destination, "utf-8")).toBe(contents);

          yield* resetStore(
            liveHome(root, path.join(root, "fixture.sqlite")),
            "reset"
          );

          const resetIdentity = yield* opened.agentService.identity;

          expect(resetIdentity.storeGeneration).toBeGreaterThan(
            reviewed.plan.storeGeneration
          );

          const unusedError = yield* Effect.flip(
            bridge.apply(
              unused.review,
              unused.confirmText,
              unused.idempotencyKey
            )
          );

          expect(unusedError).toMatchObject({ code: "stale-generation" });

          const staleKeyError = yield* Effect.flip(
            bridge.apply(
              reviewed.review,
              reviewed.confirmText,
              "fixture:replacement-key"
            )
          );

          const staleConfirmationError = yield* Effect.flip(
            bridge.apply(reviewed.review, "yes", reviewed.idempotencyKey)
          );

          const staleDigestError = yield* Effect.flip(
            bridge.apply(
              { ...reviewed.review, expectedDigest: "fixture:altered-digest" },
              reviewed.confirmText,
              reviewed.idempotencyKey
            )
          );

          expect(staleKeyError).toMatchObject({ code: "idempotency-conflict" });
          expect(staleConfirmationError).toMatchObject({
            code: "authorization-required",
          });
          expect(staleDigestError).toMatchObject({
            code: "idempotency-conflict",
          });

          const retry = yield* bridge.apply(
            reviewed.review,
            reviewed.confirmText,
            reviewed.idempotencyKey
          );

          expect(prepares).toBe(2);
          expect(executions).toBe(1);
          expect(retry).toEqual({
            ...first,
            storeGeneration: resetIdentity.storeGeneration,
          });
          expect(retry.planId).toBe(reviewed.plan.id);
          expect(retry.planDigest).toBe(reviewed.plan.planDigest);
          expect(retry.idempotencyKey).toBe(reviewed.idempotencyKey);
          expect(first.effects.exportArtifacts).toEqual([
            {
              basisId,
              contentDigest,
              destination,
              disclosure: "metadata-only",
            },
          ]);
          expect(first.effects.exports).toEqual([destination]);
          expect(reviewed.plan.arguments).toEqual({
            basisId,
            destination,
            disclosure: "metadata-only",
            kind: "export",
          });
          expect(readFileSync(destination, "utf-8")).toBe(contents);
          expect(
            readdirSync(root).filter((name) => name.endsWith(".json"))
          ).toEqual(["metadata.json"]);
          expect(previewAdministration).not.toHaveBeenCalled();

          const recovered = yield* service.run({
            action: "get",
            operation: {
              id: first.id,
              storeGeneration: first.storeGeneration,
              storeId: first.storeId,
            },
          });

          expect(recovered).toEqual({
            action: "get",
            receipt: retry,
            reviewedPlan: { ...reviewed.plan, validity: "stale" },
            reviewedPlanUnavailableReason: null,
          });
        })
      )
  );

  for (const action of ["track", "untrack"] as const) {
    it.effect(
      `${action} binds exact config content and applies its shared confirmation`,
      () => {
        const fixture = fixtures();

        return Effect.gen(function* configuredRepo() {
          const receipt = yield* fixture.bridge.configure(
            action,
            process.cwd()
          );

          const plan = fixture.plans.values().next().value;

          expect(plan?.arguments).toEqual({
            expectedContentDigest: "fixture:config-content",
            kind: "configure",
            path: configPath(fixture.home),
            settings: {
              action: action === "track" ? "add-repo" : "remove-repo",
              target: fixture.canonical.worktreePath,
            },
          });
          expect(plan?.scope.repoId).toBe(fixture.canonical.repoCommonDir);
          expect(plan?.scope.branchSelection).toEqual({
            branches: [],
            kind: "all",
          });
          expect(fixture.run).toHaveBeenCalledTimes(2);
          expect(fixture.run.mock.calls[1]?.[0]).toMatchObject({
            action: "apply",
            confirmation,
            expectedDigest: plan?.planDigest,
            plan: { id: plan?.id },
          });
          expect(receipt).toBe(fixture.receipts[0]);
        });
      }
    );
  }

  it.effect(
    "usage configuration explicitly plans whole-store settings with bounded operation requests",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* configuredUsage() {
        yield* fixture.bridge.configure("usage", true);
        const plan = fixture.plans.values().next().value;

        expect(plan?.arguments).toMatchObject({
          kind: "configure",
          settings: { action: "cursor-usage", enabled: "true" },
        });
        expect(plan?.scope).toMatchObject({
          repoId: null,
          sources: [],
          tools: [],
          worktreeId: null,
        });
        expect(plan?.bounds.maxRequests).toBe(64);
        expect(plan?.bounds.maxRetries).toBe(0);
        expect(fixture.previewAdministration).toHaveBeenCalledExactlyOnceWith(
          { action: "cursor-usage", enabled: true, kind: "configure" },
          DASHBOARD_OPERATION_BOUNDS
        );
      });
    }
  );
});
