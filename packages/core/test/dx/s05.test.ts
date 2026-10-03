// @effect-diagnostics-next-line nodeBuiltinImport:off -- These tests own and remove their SQLite fixture directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- These tests resolve only their owned fixture paths.
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Schema } from "effect";
import type { Scope } from "effect";

import { makeDxCapabilities } from "../../src/dx/capabilities.js";
import { AgentStore } from "../../src/dx/contracts/agent-store.js";
import { EventStore } from "../../src/dx/contracts/event-store.js";
import {
  learningRecordRef,
  makeLearningService,
} from "../../src/dx/learning/service.js";
import { makeAdministrationBackend } from "../../src/dx/live/engine.js";
import type { LearningInput } from "../../src/dx/model/agent-learning.js";
import {
  EvaluationSchema,
  LearningOutputSchema,
} from "../../src/dx/model/agent-learning.js";
import type { OperationInput } from "../../src/dx/model/agent-operation.js";
import { OperationOutputSchema } from "../../src/dx/model/agent-operation.js";
import { makeLiveAdministrationAdapters } from "../../src/dx/operations/live.js";
import { makeOperationService } from "../../src/dx/operations/service.js";
import { buildRegistry } from "../../src/dx/registry/registry.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import type { OpenedEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import { exerciseConfiguration } from "./fixtures/s05/configuration.js";
import {
  fixtureApplicability,
  fixtureBatch,
  fixtureBounds,
  fixtureCollectAdapter,
  fixtureInvestigation,
  fixtureLesson,
  fixtureRepo,
  fixtureRequest,
  fixtureScope,
  fixtureWindow,
} from "./fixtures/s05/scenario.js";

const withDirectory = <A, E>(use: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "dft-s05-"))),
    use,
    (directory) =>
      Effect.sync(() => {
        rmSync(directory, { force: true, recursive: true });
      })
  );

const withOpened = <A, E>(
  storePath: string,
  use: (
    opened: OpenedEventStore
  ) => Effect.Effect<A, E, EventStore | AgentStore | Scope.Scope>
) =>
  Effect.acquireUseRelease(
    openSqliteEventStore({ kind: "live", path: storePath }),
    (opened) =>
      Effect.scoped(
        use(opened).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(EventStore, opened.service),
              Layer.succeed(AgentStore, opened.agentService)
            )
          )
        )
      ),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  );

const capabilitiesFor = Effect.fnUntraced(function* capabilitiesFor(
  opened: OpenedEventStore,
  storePath: string,
  onExecute: () => void
) {
  const operation = yield* makeOperationService(opened.agentService, [
    fixtureCollectAdapter(opened.service, onExecute),
  ]);

  const learning = makeLearningService(opened.agentService, {
    context: { ...fixtureApplicability(), origin: "fixture" },
  });

  return makeDxCapabilities({
    collectors: [],
    defaultRepo: fixtureRepo,
    learning: learning.run,
    operation: operation.run,
    registry: buildRegistry([], [], []),
    selector: { branch: "fixture-main" },
    storePath,
  });
});

const usageInput = {
  agentQuery: fixtureRequest,
  branch: ["fixture-main"],
  groupBy: "tool" as const,
  repo: [fixtureRepo],
  since: fixtureWindow.sinceInclusive ?? "",
  tool: ["codex"],
  tz: "UTC",
  until: fixtureWindow.untilExclusive,
  worktree: [fixtureRepo],
};

const rejectCollection = () => {
  throw new Error("The learning fixture must not invoke collection");
};

describe("S05 shared capability integration", () => {
  it.effect(
    "a bounded fixture collection retains consent, effects, basis differences and missing references after restart",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* collectAndResume() {
          const storePath = path.join(directory, "labelled-fixture.sqlite");
          let executed = 0;

          const onExecute = () => {
            executed += 1;
          };

          const retained = yield* withOpened(storePath, (opened) =>
            Effect.gen(function* collect() {
              yield* opened.service.append(fixtureBatch("fixture:s05:initial"));
              const caps = yield* capabilitiesFor(opened, storePath, onExecute);
              expect(
                caps.map((capability) => capability.contract.name)
              ).toEqual([
                "dx_status",
                "dx_analyze",
                "dx_explain",
                "dx_evidence",
                "dx_collect",
                "dx_mark",
                "dx_history",
                "dx_chats",
                "dx_usage",
                "dx_operation",
                "dx_learning",
              ]);
              const before = yield* caps[8].handler(usageInput);
              const identity = yield* opened.agentService.identity;

              const planned = yield* caps[9].handler({
                request: {
                  action: "plan",
                  arguments: {
                    allowSourceGrowth: false,
                    cursor: null,
                    inputRefs: [],
                    kind: "collect",
                    parserVersion: "fixture:s05:v1",
                    selectedRoots: ["fixture:s05:selected-input"],
                    source: "dx.harness.codex",
                  },
                  bounds: fixtureBounds,
                  purpose:
                    "Commit one labelled fixture record without live acquisition",
                  scope: fixtureScope,
                  target: identity,
                },
              });

              if (planned.action !== "plan") {
                return yield* Effect.die(
                  new Error("Expected the operation plan")
                );
              }

              expect(executed).toBe(0);
              expect(planned.plan.consent.receiptIds).toEqual([
                "fixture:s05:enrollment",
              ]);
              expect(planned.plan.bounds).toEqual(fixtureBounds);

              const applyInput: Extract<OperationInput, { action: "apply" }> = {
                action: "apply",
                consentReceiptIds: ["fixture:s05:enrollment"],
                expectedDigest: planned.plan.planDigest,
                idempotencyKey: "fixture:s05:collect-once",
                plan: planned.plan,
              };

              const applied = yield* caps[9].handler({ request: applyInput });

              if (applied.action !== "apply") {
                return yield* Effect.die(
                  new Error("Expected an apply receipt")
                );
              }

              expect(Schema.is(OperationOutputSchema)(applied)).toBe(true);
              expect(applied.receipt.executionState).toBe("succeeded");
              expect(applied.receipt.verificationState).toBe("verified");
              expect(applied.receipt.effects.evidenceIds).toEqual([
                "fixture:s05:collected",
              ]);
              expect(applied.receipt.steps[0]?.inserted).toBe(1);
              expect(applied.receipt.resources.requests).toBe(0);
              expect(applied.receipt.verificationRefs[0]?.kind).toBe("event");
              expect(executed).toBe(1);

              const after = yield* caps[8].handler({
                ...usageInput,
                agentQuery: {
                  ...fixtureRequest,
                  previousBasisId: before.result.basisId,
                },
              });

              expect(after.result.basisId).not.toBe(before.result.basisId);
              expect(after.difference?.previousBasisId).toBe(
                before.result.basisId
              );
              expect(after.difference?.changes).toContain("evidence");
              expect(after.context.originMix).toEqual([
                { count: 2, origin: "fixture" },
              ]);
              expect(after.context.effects.networkRequests).toBe(0);
              expect(after.context.completeness.aggregation).toBe("complete");

              const evidence = yield* caps[3].handler({
                agentQuery: {
                  ...fixtureRequest,
                  basisId: after.result.basisId,
                  policies: {
                    ...fixtureRequest.policies,
                    derivation: "bounded-refresh",
                    prices: "pinned",
                  },
                },
                evidenceIds: ["fixture:s05:collected", "fixture:s05:missing"],
              });

              expect(
                evidence.resolutions.map((resolution) => resolution.state)
              ).toContain("missing-in-basis");
              expect(evidence.context.completeness.missingRefs).toBe(1);
              expect(evidence.view.disclosures.length).toBeGreaterThan(0);

              return { after, applied, applyInput, evidence };
            })
          );

          yield* withOpened(storePath, (opened) =>
            Effect.gen(function* resume() {
              const caps = yield* capabilitiesFor(opened, storePath, onExecute);

              const recovered = yield* caps[9].handler({
                request: { action: "get", operation: retained.applied.receipt },
              });

              const replayed = yield* caps[9].handler({
                request: retained.applyInput,
              });

              if (recovered.action !== "get" || replayed.action !== "apply") {
                return yield* Effect.die(
                  new Error("Expected retained operation receipts")
                );
              }

              expect(recovered.receipt).toEqual(retained.applied.receipt);
              expect(replayed.receipt).toEqual(retained.applied.receipt);
              expect(replayed.reused).toBe(true);
              expect(executed).toBe(1);

              const evidence = yield* caps[3].handler({
                agentQuery: {
                  ...fixtureRequest,
                  basisId: retained.after.result.basisId,
                  policies: {
                    ...fixtureRequest.policies,
                    derivation: "ready-only",
                    prices: "pinned",
                  },
                },
                evidenceIds: ["fixture:s05:collected", "fixture:s05:missing"],
              });

              expect(evidence.result.resultDigest).toBe(
                retained.evidence.result.resultDigest
              );
              expect(evidence.resolutions).toEqual(
                retained.evidence.resolutions
              );
              expect(evidence.context.effects.basisWrites).toBe(0);

              return null;
            })
          );
        })
      )
  );

  it.effect(
    "scoped authored learning stays compact and retains missing citations and evaluations after restart",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* learnAndResume() {
          const storePath = path.join(directory, "labelled-learning.sqlite");

          const retained = yield* withOpened(storePath, (opened) =>
            Effect.gen(function* learn() {
              yield* opened.service.append(
                fixtureBatch("fixture:s05:learning-source")
              );

              const caps = yield* capabilitiesFor(
                opened,
                storePath,
                rejectCollection
              );

              const basis = yield* caps[8].handler(usageInput);
              const identity = yield* opened.agentService.identity;

              const investigationInput: Extract<
                LearningInput,
                { action: "record" }
              > = {
                action: "record",
                expectedRevision: null,
                idempotencyKey: "fixture:s05:record-investigation",
                record: fixtureInvestigation(identity, basis.result.basisId),
              };

              const lessonInput: Extract<LearningInput, { action: "record" }> =
                {
                  action: "record",
                  expectedRevision: null,
                  idempotencyKey: "fixture:s05:record-lesson",
                  record: fixtureLesson(identity, basis.result.basisId),
                };

              const investigation = yield* caps[10].handler({
                request: investigationInput,
              });

              const lesson = yield* caps[10].handler({ request: lessonInput });

              if (
                investigation.action !== "record" ||
                lesson.action !== "record"
              ) {
                return yield* Effect.die(
                  new Error("Expected authored learning records")
                );
              }

              const evaluationInput: Extract<
                LearningInput,
                { action: "evaluate" }
              > = {
                action: "evaluate",
                evaluation: EvaluationSchema.make({
                  authorKind: "agent",
                  basisIds: [],
                  comparabilityLimitations: [
                    "The missing fixture reference prevents evaluation",
                  ],
                  comparedWindows: [],
                  conclusion: "inconclusive",
                  coverage: [],
                  createdAt: fixtureWindow.resolvedAt,
                  criterion:
                    lessonInput.record.kind === "lesson"
                      ? lessonInput.record.criterion
                      : "Fixture criterion",
                  evidenceRefs: [],
                  id: "fixture:s05:evaluation",
                  operationIds: [],
                  originMix: [],
                  outcome: "The fixture provides no ownership observation",
                  relation: "descriptive-association",
                  schemaVersion: "dx.learning.v1",
                  storeGeneration: identity.storeGeneration,
                  storeId: identity.storeId,
                  target: {
                    id: lesson.record.id,
                    kind: "lesson",
                    revision: lesson.record.revision,
                  },
                }),
                idempotencyKey: "fixture:s05:evaluate-once",
              };

              const evaluation = yield* caps[10].handler({
                request: evaluationInput,
              });

              expect(evaluation.action).toBe("evaluate");
              expect(Schema.is(LearningOutputSchema)(evaluation)).toBe(true);

              return {
                evaluation,
                evaluationInput,
                investigation,
                investigationInput,
                lesson,
                lessonInput,
              };
            })
          );

          yield* withOpened(storePath, (opened) =>
            Effect.gen(function* resumeLearning() {
              const caps = yield* capabilitiesFor(
                opened,
                storePath,
                rejectCollection
              );

              const identity = yield* opened.agentService.identity;

              const list = yield* caps[10].handler({
                request: {
                  action: "list",
                  filter: {
                    applicability: fixtureApplicability(),
                    cursor: null,
                    includeSuperseded: false,
                    kinds: [],
                    limit: 10,
                    question: null,
                    scope: fixtureScope,
                  },
                  target: identity,
                },
              });

              if (list.action !== "list") {
                return yield* Effect.die(
                  new Error("Expected compact learning recall")
                );
              }

              expect(Schema.is(LearningOutputSchema)(list)).toBe(true);
              expect(list.items).toHaveLength(2);
              expect(list.items.every((item) => item.applicable)).toBe(true);
              expect(
                list.items.some(
                  (item) => item.kind === "lesson" && item.status === "proposed"
                )
              ).toBe(true);
              expect(
                list.items.every((item) => item.evidence.missing === 1)
              ).toBe(true);
              expect(JSON.stringify(list)).not.toContain("inspectedRefs");

              const investigation = yield* caps[10].handler({
                request: {
                  action: "get",
                  applicability: fixtureApplicability(),
                  ref: learningRecordRef(retained.investigation.record),
                  scope: fixtureScope,
                },
              });

              if (investigation.action !== "get") {
                return yield* Effect.die(
                  new Error("Expected investigation detail")
                );
              }

              expect(investigation.item.record.id).toBe(
                retained.investigation.record.id
              );
              expect(investigation.item.record.kind).toBe("investigation");
              expect(investigation.item.record.limitations).toEqual(
                expect.arrayContaining([
                  ...retained.investigation.record.limitations,
                ])
              );
              expect(
                investigation.item.evidence.some(
                  (resolution) => resolution.state === "missing-in-basis"
                )
              ).toBe(true);

              const replayed = yield* caps[10].handler({
                request: retained.lessonInput,
              });

              const evaluated = yield* caps[10].handler({
                request: retained.evaluationInput,
              });

              if (
                replayed.action !== "record" ||
                evaluated.action !== "evaluate"
              ) {
                return yield* Effect.die(
                  new Error("Expected idempotent learning replay")
                );
              }

              expect(replayed.reused).toBe(true);
              expect(replayed.record).toEqual(retained.lesson.record);
              expect(evaluated.reused).toBe(true);
              expect(evaluated).toEqual({
                ...retained.evaluation,
                reused: true,
              });

              const missing = yield* Effect.flip(
                caps[10].handler({
                  request: {
                    action: "get",
                    applicability: fixtureApplicability(),
                    ref: {
                      ...learningRecordRef(retained.lesson.record),
                      id: "fixture:s05:absent-lesson",
                    },
                    scope: fixtureScope,
                  },
                })
              );

              expect(missing._tag).toBe("AgentError");

              if (Predicate.isTagged(missing, "AgentError")) {
                expect(missing.code).toBe("learning-not-found");
                expect(missing.retryable).toBe(false);
              }

              return null;
            })
          );
        })
      )
  );

  it.effect(
    "the real configuration adapter requires reviewed confirmation and reuses its durable receipt",
    () =>
      withDirectory((directory) =>
        exerciseConfiguration(
          path.join(directory, "config.sqlite"),
          directory,
          {
            makeAdministrationBackend,
            makeDxCapabilities,
            makeLiveAdministrationAdapters,
            makeOperationService,
          }
        ).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              expect(outcome.before.cursorUsageImport).toBe(false);
              expect(outcome.afterPlanning.cursorUsageImport).toBe(false);
              expect(outcome.plan.consent.state).toBe("required");
              expect(outcome.denied._tag).toBe("AgentError");
              expect(outcome.denied.code).toBe("authorization-required");
              expect(outcome.applied.receipt.steps).toEqual([
                expect.objectContaining({ gaps: [], state: "committed" }),
              ]);
              expect(outcome.after.cursorUsageImport).toBe(true);
              expect(outcome.applied.receipt.executionState).toBe("succeeded");
              expect(outcome.applied.receipt.verificationState).toBe(
                "verified"
              );
              expect(outcome.applied.receipt.effects.filesChanged).toContain(
                outcome.configFile
              );
              expect(outcome.applied.receipt.effects.configDigest).toBeTruthy();
              expect(outcome.applied.receipt.resources.requests).toBe(0);
              expect(outcome.persisted.receipt).toEqual(
                outcome.applied.receipt
              );
              expect(outcome.resumed.receipt).toEqual(outcome.applied.receipt);
              expect(outcome.replayed.receipt).toEqual(outcome.applied.receipt);
              expect(outcome.replayed.reused).toBe(true);
              expect(outcome.applyCount).toBe(1);
            })
          )
        )
      )
  );
});
