// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture result digests use local cryptographic hashes.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The tests read a labelled fixture and own their temporary store files.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The tests resolve only committed fixtures and owned store paths.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { AgentEventPage } from "../../src/dx/contracts/agent-store.js";
import {
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
} from "../../src/dx/contracts/version.js";
import type { SessionRef } from "../../src/dx/harness/contract.js";
import type {
  AgentHandle,
  AgentRef,
  AgentScope,
  StoreIdentity,
} from "../../src/dx/model/agent-common.js";
import type {
  Evaluation,
  Investigation,
  Lesson,
} from "../../src/dx/model/agent-learning.js";
import type {
  OperationPlan,
  OperationStep,
} from "../../src/dx/model/agent-operation.js";
import type {
  AgentCursor,
  AgentResult,
  AnalysisBasis,
} from "../../src/dx/model/agent-query.js";
import { EventBatchSchema } from "../../src/dx/model/event.js";
import type { EventBatch } from "../../src/dx/model/event.js";
import type { SnapshotSelector } from "../../src/dx/model/snapshot.js";
import {
  agentHash,
  canonicalAgentJson,
} from "../../src/dx/storage/agent-db.js";
import {
  invalidateAgentState,
  tombstoneAgentScope,
} from "../../src/dx/storage/agent-invalidation.js";
import type { StoredCursor } from "../../src/dx/storage/harness-cursors.js";
import { STORE_MIGRATIONS } from "../../src/dx/storage/migrations.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import type {
  OpenedEventStore,
  SqliteEventStoreOptions,
} from "../../src/dx/storage/sqlite-event-store.js";
import { emptySelector } from "./fakes.js";

const fixture = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      batches: Schema.Array(EventBatchSchema),
      fixtureId: Schema.String,
    })
  )
)(
  readFileSync(
    path.join(import.meta.dirname, "fixtures/s01/events.json"),
    "utf-8"
  )
);

const root = mkdtempSync(path.join(os.tmpdir(), "dft-s01-"));

const timestamp = "2026-01-01T00:00:00.000Z";

const repoId = "/fixture/s01/repo/.git";

const scope: AgentScope = {
  branchSelection: { branches: ["main"], kind: "selected" },
  flightId: null,
  repoId,
  resolution: "Explicit isolated S01 fixture",
  sources: ["fixture.s01"],
  tools: [],
  worktreeId: "/fixture/s01/repo",
};

const unaffectedScope: AgentScope = {
  ...scope,
  repoId: "/fixture/s01/unaffected-repo/.git",
  sources: ["fixture.s01.unaffected"],
  worktreeId: "/fixture/s01/unaffected-repo",
};

const window = {
  resolvedAt: timestamp,
  sinceInclusive: null,
  timezone: "UTC",
  untilExclusive: "2026-02-01T00:00:00.000Z",
};

const selector: SnapshotSelector = {
  ...emptySelector,
  branch: "main",
  from: window.sinceInclusive,
  repoCommonDir: repoId,
  to: window.untilExclusive,
};

const completeness: AgentResult["completeness"] = {
  aggregation: "complete",
  items: "complete",
  missingRefs: 0,
  omittedItems: 0,
  omittedSeries: 0,
  reason: null,
  series: "not-requested",
};

const applicability: Lesson["applicability"] = {
  coverageRequirements: ["fixture-only"],
  metricDefinitions: [{ id: "fixture.count", version: "fixture.v1" }],
  scope,
  sourceVersions: [{ id: "fixture.s01", version: "fixture.v1" }],
  toolVersions: [],
  widerScope: false,
  window,
  workflowConditions: ["Isolated test fixture"],
};

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const optionsFor = (name: string): SqliteEventStoreOptions => ({
  kind: "live",
  path: path.join(root, `${name}.sqlite`),
});

const withStore = <A, E>(
  options: SqliteEventStoreOptions,
  use: (opened: OpenedEventStore) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(openSqliteEventStore(options), use, (opened) =>
    Effect.sync(() => {
      opened.close();
    })
  );

const batchAt = (index: number): EventBatch => {
  const batch = fixture.batches[index];

  if (batch === undefined) {
    throw new Error(`Missing S01 fixture batch ${index}`);
  }

  return batch;
};

const unaffectedBatch = (): EventBatch => {
  const batch = batchAt(0);

  return Schema.decodeUnknownSync(EventBatchSchema)({
    ...batch,
    coverage: { ...batch.coverage, adapterId: "fixture.s01.unaffected" },
    events: batch.events.map((event) => ({
      ...event,
      adapterId: "fixture.s01.unaffected",
      context: {
        ...event.context,
        repoCommonDir: unaffectedScope.repoId,
        worktreePath: unaffectedScope.worktreeId,
      },
      eventId: `${event.eventId}_unaffected`,
      upstreamKey: `${event.upstreamKey}_unaffected`,
    })),
  });
};

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const handleFor = (
  identity: Pick<StoreIdentity, "storeId" | "storeGeneration">,
  id: string
): AgentHandle => ({
  id,
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
});

const refFor = (
  handle: AgentHandle,
  kind: AgentRef["kind"],
  basisId: string | null = null
): AgentRef => ({
  ...handleFor(handle, handle.id),
  basisId,
  kind,
  version: "fixture.v1",
});

const pageInput = (pageSelector: SnapshotSelector = selector) => ({
  cursor: null,
  eventWatermark: null,
  maxDecodedBytes: 1_000_000,
  maxElapsedMs: 60_000,
  maxFacts: 100,
  selector: pageSelector,
});

const basisFor = (
  identity: StoreIdentity,
  page: AgentEventPage,
  id: string
): AnalysisBasis => ({
  ...handleFor(identity, id),
  acquisitionReceiptIds: [],
  attributionVersion: "fixture.attribution.v1",
  configDigest: "fixture.config.v1",
  contractDigest: CONTRACT_DIGEST,
  contractVersion: CONTRACT_VERSION,
  coverage: page.coverage,
  createdAt: timestamp,
  descriptors: [{ id: "fixture.s01", version: "fixture.v1" }],
  eventWatermark: page.eventWatermark,
  interpretationInputs: JSON.stringify({
    branch: "main",
    fixtureId: fixture.fixtureId,
  }),
  metricDefinitions: [{ id: "fixture.count", version: "fixture.v1" }],
  normalizedFilters: {},
  originMix: [{ count: page.events.length, origin: "fixture" }],
  priceSheets: [
    {
      content: '{"fixture":true}',
      contentHash: hash('{"fixture":true}'),
      effectiveFrom: null,
      effectiveUntil: null,
      id: "fixture.price.v1",
    },
  ],
  queryKey: "fixture-s01-query",
  reconciliationVersion: "fixture.reconciliation.v1",
  reproducibility: "retained-inputs",
  retainedEvents: page.events,
  schemaVersion: "dx.basis.v1",
  scope,
  selectedEventDigest: agentHash(canonicalAgentJson(page.events)),
  supportedResultVersions: ["fixture.projection.v1"],
  window,
});

const resultFor = (
  basis: AnalysisBasis,
  id: string,
  value = "original fixture projection"
): AgentResult => {
  const orderedProjection = JSON.stringify({
    disclosures: ["Labelled S01 fixture only"],
    items: [{ fixture: true, value }],
    series: [],
    summary: {
      fixture: true,
      measurement: "unavailable",
      reason: "No live observations",
    },
  });

  return {
    ...handleFor(basis, id),
    basisId: basis.id,
    byteCount: Buffer.byteLength(orderedProjection, "utf-8"),
    capability: "dx_analyze",
    completeness,
    createdAt: timestamp,
    itemCount: 1,
    orderedProjection,
    projectionVersion: "fixture.projection.v1",
    queryDigest: `fixture-query-${id}`,
    resolutions: [],
    resultDigest: hash(orderedProjection),
    schemaVersion: "dx.result.v1",
    seriesCount: 0,
  };
};

const planFor = (identity: StoreIdentity, id: string): OperationPlan => ({
  ...handleFor(identity, id),
  arguments: {
    allowSourceGrowth: true,
    cursor: null,
    inputRefs: [],
    kind: "collect",
    parserVersion: "fixture.v1",
    selectedRoots: ["fixture:s01"],
    source: "fixture.s01",
  },
  bounds: {
    maxBytes: 1024,
    maxElapsedMs: 60_000,
    maxFiles: 1,
    maxRecords: 4,
    maxRequests: 0,
    maxRetries: 0,
  },
  consent: {
    reason: "Isolated fixture",
    receiptIds: [],
    scopeDigest: "fixture-scope",
    state: "authorized",
  },
  createdAt: timestamp,
  effects: {
    destructive: false,
    networkDestinations: [],
    reads: ["fixture:s01"],
    writes: ["fixture-store"],
  },
  expectedEvidenceImprovement: "Only labelled fixture observations",
  expiresAt: "2099-01-01T00:00:00.000Z",
  forecast: { bytes: null, cost: null, elapsedMs: null, requests: 0 },
  kind: "collect",
  planDigest: `digest-${id}`,
  preconditions: [
    {
      allowAppend: true,
      expected: String(identity.storeGeneration),
      kind: "store-generation",
      target: identity.storeId,
    },
  ],
  purpose: "Test durable operation storage",
  resumeBoundary: "complete-record",
  schemaVersion: "dx.operation.v1",
  scope,
  stopCondition: "Finish the isolated fixture",
  validity: "valid",
});

const startOwnedOperation = (opened: OpenedEventStore, id: string) =>
  Effect.gen(function* startWriterJournal() {
    yield* opened.service.append(batchAt(0));
    const identity = yield* opened.agentService.identity;
    const plan = planFor(identity, `plan-${id}`);

    yield* opened.agentService.putOperationPlan(plan);

    const reservation = yield* opened.agentService.reserveOperation(
      plan,
      plan.planDigest,
      `fixture-${id}-key`
    );

    const committed: OperationStep = {
      committedThrough: "fixture:s01:1",
      duplicates: 0,
      gaps: [],
      id: `fixture-${id}-committed`,
      inserted: 2,
      rejected: 0,
      remainingWork: "fixture:s01:2-3",
      retries: 0,
      safeCursor: "fixture-cursor-2",
      source: "fixture.s01",
      spooledRefs: [],
      state: "committed",
    };

    const running: OperationStep = {
      ...committed,
      committedThrough: null,
      id: `fixture-${id}-running`,
      inserted: 0,
      state: "running",
    };

    const committedJournal = yield* opened.agentService.appendOperationStep(
      reservation.receipt,
      committed,
      reservation.receipt.revision
    );

    const runningJournal = yield* opened.agentService.appendOperationStep(
      committedJournal,
      running,
      committedJournal.revision
    );

    const runningReceipt = yield* opened.agentService.updateOperation(
      {
        ...runningJournal,
        executionState: "running",
        recovery: "safe-resume",
        revision: runningJournal.revision + 1,
        startedAt: timestamp,
      },
      runningJournal.revision
    );

    const receipt = yield* opened.agentService.requestOperationCancellation(
      runningReceipt,
      runningReceipt.revision
    );

    return { committed, plan, receipt, running };
  });

const lessonFor = (identity: StoreIdentity, id: string): Lesson => ({
  ...handleFor(identity, id),
  applicability,
  authorKind: "agent",
  claim: "This isolated fixture has four observations",
  claimKind: "descriptive",
  contradictingRefs: [],
  createdAt: timestamp,
  criterion: "Count only the committed labelled fixture",
  invalidationConditions: ["Different fixture inputs"],
  kind: "lesson",
  limitations: ["Fixture evidence does not establish live support"],
  previousRevision: null,
  revision: 0,
  schemaVersion: "dx.learning.v1",
  status: "proposed",
  supersededBy: null,
  supersedes: null,
  supportingRefs: [],
  updatedAt: timestamp,
});

const evaluationFor = (
  lesson: Lesson,
  id: string,
  conclusion: Evaluation["conclusion"]
): Evaluation => ({
  ...handleFor(lesson, id),
  authorKind: "agent",
  basisIds: [],
  comparabilityLimitations: ["Isolated fixture evidence only"],
  comparedWindows: [window],
  conclusion,
  coverage: [batchAt(0).coverage],
  createdAt: timestamp,
  criterion: lesson.criterion,
  evidenceRefs: [],
  operationIds: [],
  originMix: [{ count: 2, origin: "fixture" }],
  outcome: `Fixture evaluation ${conclusion}`,
  relation: "descriptive-association",
  schemaVersion: "dx.learning.v1",
  target: { id: lesson.id, kind: "lesson", revision: lesson.revision },
});

const createV4Store = (file: string): void => {
  const db = new DatabaseSync(file);

  try {
    for (const migration of STORE_MIGRATIONS) {
      if (migration.version <= 4) {
        for (const statement of migration.statements) {
          db.exec(statement);
        }

        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
    }

    db.prepare(
      "INSERT INTO store_meta (key, value) VALUES ('store_kind', 'live')"
    ).run();

    const insert = db.prepare(
      "INSERT INTO events (event_id, adapter_id, kind, origin, flight_id, repo_common_dir, branch, occurred_at, observed_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    for (const event of batchAt(0).events) {
      insert.run(
        event.eventId,
        event.adapterId,
        event.kind,
        event.origin,
        event.context.flightId,
        event.context.repoCommonDir,
        event.context.branch,
        event.occurredAt,
        event.observedAt,
        JSON.stringify(event)
      );
    }
  } finally {
    db.close();
  }
};

const invalidate = (
  file: string,
  reason: "reset" | "restore" | "replacement",
  options: { readonly preserveOperationId?: string } = {}
): void => {
  const db = new DatabaseSync(file);

  try {
    db.exec("BEGIN IMMEDIATE");
    invalidateAgentState(db, reason, options);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }

    throw error;
  } finally {
    db.close();
  }
};

const ordinaryReset = (file: string): void => {
  const db = new DatabaseSync(file);

  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM snapshot_events");
    db.exec("DELETE FROM snapshots");
    db.exec("DELETE FROM coverage");
    db.exec("DELETE FROM events");
    invalidateAgentState(db, "reset");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }

    throw error;
  } finally {
    db.close();
  }
};

describe("S01 durable agent store", () => {
  it.effect(
    "recovers consumed terminal receipts across ordinary resets and restore without reusing pending authority",
    () =>
      Effect.gen(function* terminalResetCase() {
        const options = optionsFor("ordinary-terminal-reset");
        const destination = "fixture:s01:export-artifact";

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* completedFixtureOperations() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;

            const basis = basisFor(
              identity,
              yield* opened.agentService.readEventPage(pageInput()),
              "basis-completed-export"
            );

            yield* opened.agentService.putBasis(basis);

            const exportPlan: OperationPlan = {
              ...planFor(identity, "plan-completed-export"),
              arguments: {
                basisId: basis.id,
                destination,
                disclosure: "metadata-only",
                kind: "export",
              },
              effects: {
                destructive: false,
                networkDestinations: [],
                reads: [basis.id],
                writes: [destination],
              },
              kind: "export",
            };

            const failedPlan = planFor(identity, "plan-failed-no-effects");
            const unusedPlan = planFor(identity, "plan-unused-terminal-reset");
            const unusedKey = "fixture-unused-terminal-reset-key";

            const finish = (
              plan: OperationPlan,
              state: "succeeded" | "failed",
              key: string
            ) =>
              Effect.gen(function* commitTerminalFixture() {
                yield* opened.agentService.putOperationPlan(plan);

                const reservation = yield* opened.agentService.reserveOperation(
                  plan,
                  plan.planDigest,
                  key
                );

                const running = yield* opened.agentService.updateOperation(
                  {
                    ...reservation.receipt,
                    executionState: "running",
                    revision: reservation.receipt.revision + 1,
                    startedAt: timestamp,
                  },
                  reservation.receipt.revision
                );

                const step: OperationStep = {
                  committedThrough: state === "succeeded" ? destination : null,
                  duplicates: 0,
                  gaps: state === "failed" ? ["Fixture input unavailable"] : [],
                  id: `step-${plan.id}`,
                  inserted: 0,
                  rejected: 0,
                  remainingWork: null,
                  retries: 0,
                  safeCursor: null,
                  source: state === "failed" ? "fixture.s01" : null,
                  spooledRefs: [],
                  state: state === "succeeded" ? "committed" : "failed",
                };

                const journal = yield* opened.agentService.appendOperationStep(
                  running,
                  step,
                  running.revision
                );

                const receipt = yield* opened.agentService.updateOperation(
                  {
                    ...journal,
                    completedAt: "2026-01-01T00:01:00.000Z",
                    effects:
                      state === "succeeded"
                        ? {
                            ...journal.effects,
                            exportArtifacts: [
                              {
                                basisId: basis.id,
                                contentDigest: "sha256:fixture-terminal-export",
                                destination,
                                disclosure: "metadata-only",
                              },
                            ],
                            exports: [destination],
                          }
                        : journal.effects,
                    executionState: state,
                    recovery: "none",
                    revision: journal.revision + 1,
                    verificationState:
                      state === "succeeded" ? "verified" : "not-attempted",
                  },
                  journal.revision
                );

                return { key, plan, receipt };
              });

            const succeeded = yield* finish(
              exportPlan,
              "succeeded",
              "fixture-completed-export-key"
            );

            const failed = yield* finish(
              failedPlan,
              "failed",
              "fixture-failed-no-effects-key"
            );

            yield* opened.agentService.putOperationPlan(unusedPlan);

            const unused = yield* opened.agentService.reserveOperation(
              unusedPlan,
              unusedPlan.planDigest,
              unusedKey
            );

            const lesson = lessonFor(identity, "lesson-before-ordinary-reset");
            yield* opened.agentService.createLearning(
              lesson,
              "fixture-learning-before-ordinary-reset"
            );

            const original = yield* Effect.all({
              lesson: opened.agentService.getLearning(lesson),
              snapshot: opened.service.snapshot(selector),
            });

            return {
              consumed: [succeeded, failed],
              identity,
              lesson,
              original,
              unused,
              unusedKey,
              unusedPlan,
            };
          })
        );

        expect(saved.original.lesson).toEqual(saved.lesson);
        expect(saved.original.snapshot.events).toEqual(batchAt(0).events);

        const checkRecovered = (phase: string) =>
          withStore(options, (opened) =>
            Effect.gen(function* verifyTerminalRecovery() {
              const identity = yield* opened.agentService.identity;

              for (const original of saved.consumed) {
                const before = yield* Effect.all({
                  identity: opened.agentService.identity,
                  receipt: opened.agentService.getOperation(original.receipt),
                });

                const retry = yield* opened.agentService.reserveOperation(
                  original.plan,
                  original.plan.planDigest,
                  original.key
                );

                const plan =
                  yield* opened.agentService.getOperationPlanForReceipt(
                    original.receipt
                  );

                const rejected = yield* Effect.all({
                  digest: Effect.flip(
                    opened.agentService.reserveOperation(
                      original.plan,
                      "fixture-different-terminal-digest",
                      original.key
                    )
                  ),
                  fresh: Effect.flip(
                    opened.agentService.reserveOperation(
                      original.plan,
                      original.plan.planDigest,
                      `fixture-fresh-${phase}-${original.plan.id}`
                    )
                  ),
                  ordinaryPlan: Effect.flip(
                    opened.agentService.getOperationPlan(original.plan)
                  ),
                });

                expect(retry.reused).toBe(true);
                expect(retry.receipt).toEqual(before.receipt);
                expect(retry.receipt).toEqual({
                  ...original.receipt,
                  storeGeneration: identity.storeGeneration,
                  storeId: identity.storeId,
                });
                expect(plan).toEqual({ ...original.plan, validity: "stale" });
                expect(rejected.digest).toMatchObject({
                  code: "idempotency-conflict",
                });
                expect(rejected.fresh).toMatchObject({
                  code: "stale-generation",
                });
                expect(rejected.ordinaryPlan).toMatchObject({
                  code: "stale-generation",
                });

                if (original.receipt.executionState === "failed") {
                  const resume = yield* Effect.flip(
                    opened.agentService.updateOperation(
                      {
                        ...before.receipt,
                        executionState: "running",
                        revision: before.receipt.revision + 1,
                      },
                      before.receipt.revision
                    )
                  );

                  expect(resume).toMatchObject({ code: "invalid-transition" });
                }

                const after = yield* Effect.all({
                  identity: opened.agentService.identity,
                  receipt: opened.agentService.getOperation(original.receipt),
                });

                expect(after).toEqual(before);
              }

              const current = yield* Effect.all({
                learning: opened.agentService.listLearning({
                  cursor: null,
                  includeSuperseded: false,
                  kinds: ["investigation", "lesson"],
                  limit: 100,
                  question: null,
                  scope,
                }),
                oldLesson: Effect.flip(
                  opened.agentService.getLearning(saved.lesson)
                ),
                snapshot: opened.service.snapshot(selector),
                unused: Effect.flip(
                  opened.agentService.reserveOperation(
                    saved.unusedPlan,
                    saved.unusedPlan.planDigest,
                    saved.unusedKey
                  )
                ),
                unusedReceipt: Effect.flip(
                  opened.agentService.getOperation(saved.unused.receipt)
                ),
              });

              expect(current.snapshot.events).toHaveLength(0);
              expect(current.snapshot.coverage).toHaveLength(0);
              expect(current.learning.records).toHaveLength(0);
              expect(current.oldLesson).toMatchObject({
                code: "stale-generation",
              });
              expect(current.unused).toMatchObject({
                code: "stale-generation",
              });
              expect(current.unusedReceipt).toMatchObject({
                code: "stale-generation",
              });

              return identity;
            })
          );

        for (let cycle = 1; cycle <= 18; cycle += 1) {
          ordinaryReset(options.path);
          const identity = yield* checkRecovered(`reset-${cycle}`);

          expect(identity.storeGeneration).toBe(
            saved.identity.storeGeneration + cycle
          );
        }

        const pending = yield* withStore(options, (opened) =>
          Effect.gen(function* pendingBeforeRestore() {
            const identity = yield* opened.agentService.identity;
            const plan = planFor(identity, "plan-pending-before-restore");
            const key = "fixture-pending-before-restore-key";
            yield* opened.agentService.putOperationPlan(plan);

            const reservation = yield* opened.agentService.reserveOperation(
              plan,
              plan.planDigest,
              key
            );

            return { identity, key, plan, reservation };
          })
        );

        invalidate(options.path, "restore");
        const restoredIdentity = yield* checkRecovered("restore");
        expect(restoredIdentity.storeGeneration).toBe(
          pending.identity.storeGeneration
        );

        const rejectedPending = yield* withStore(options, (opened) =>
          Effect.gen(function* inspectRestoredPending() {
            const before = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(
                pending.reservation.receipt
              ),
            });

            const rejected = yield* Effect.all({
              exact: Effect.flip(
                opened.agentService.reserveOperation(
                  pending.plan,
                  pending.plan.planDigest,
                  pending.key
                )
              ),
              fresh: Effect.flip(
                opened.agentService.reserveOperation(
                  pending.plan,
                  pending.plan.planDigest,
                  "fixture-pending-restore-fresh-key"
                )
              ),
              originalPlan: opened.agentService.getOperationPlanForReceipt(
                pending.reservation.receipt
              ),
            });

            const after = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(
                pending.reservation.receipt
              ),
            });

            expect(after).toEqual(before);

            return { ...rejected, receipt: before.receipt };
          })
        );

        expect(rejectedPending.exact).toMatchObject({
          code: "stale-generation",
        });
        expect(rejectedPending.fresh).toMatchObject({
          code: "plan-stale",
        });
        expect(rejectedPending.originalPlan).toEqual({
          ...pending.plan,
          validity: "stale",
        });
        expect(rejectedPending.receipt).toMatchObject({
          executionState: "interrupted",
          recovery: "replan",
        });
        expect(rejectedPending.receipt.effects.exportArtifacts).toHaveLength(0);
        expect(rejectedPending.receipt.effects.exports).toHaveLength(0);
      })
  );

  it.effect(
    "adds the alias index without invalidating a compatible retained basis",
    () =>
      Effect.gen(function* indexMigrationCase() {
        const options = optionsFor("index-only-migration");

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* compatibleV7Fixture() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;

            const basis = basisFor(
              identity,
              yield* opened.agentService.readEventPage(pageInput()),
              "basis-index-migration"
            );

            const result = resultFor(basis, "result-index-migration");
            const plan = planFor(identity, "plan-index-migration");
            const key = "fixture-index-migration-key";

            yield* opened.agentService.putBasis(basis);
            yield* opened.agentService.putResult(result);
            yield* opened.agentService.putOperationPlan(plan);

            const reservation = yield* opened.agentService.reserveOperation(
              plan,
              plan.planDigest,
              key
            );

            return { basis, identity, key, plan, reservation, result };
          })
        );

        const db = new DatabaseSync(options.path);

        try {
          db.exec("DROP INDEX agent_operation_aliases_operation");
          db.exec("PRAGMA user_version = 7");
        } finally {
          db.close();
        }

        const reopened = yield* withStore(options, (opened) =>
          Effect.all({
            basis: opened.agentService.getBasis(saved.basis),
            identity: opened.agentService.identity,
            result: opened.agentService.getResult(saved.result),
            retry: opened.agentService.reserveOperation(
              saved.plan,
              saved.plan.planDigest,
              saved.key
            ),
          })
        );

        const version = yield* Effect.acquireUseRelease(
          Effect.sync(() => new DatabaseSync(options.path)),
          (fixtureDb) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({ user_version: Schema.Int })
            )(fixtureDb.prepare("PRAGMA user_version").get()),
          (fixtureDb) =>
            Effect.sync(() => {
              fixtureDb.close();
            })
        );

        expect(version.user_version).toBe(8);
        expect(reopened.identity).toEqual(saved.identity);
        expect(reopened.basis).toEqual(saved.basis);
        expect(reopened.result).toEqual(saved.result);
        expect(reopened.retry).toEqual({
          receipt: saved.reservation.receipt,
          reused: true,
        });
      })
  );

  it.effect(
    "migrates v4 fixture evidence and keeps identity stable across reopen",
    () =>
      Effect.gen(function* migrationCase() {
        const options = optionsFor("migration");
        createV4Store(options.path);

        const first = yield* withStore(options, (opened) =>
          Effect.all({
            identity: opened.agentService.identity,
            snapshot: opened.service.snapshot(selector),
          })
        );

        const second = yield* withStore(
          options,
          (opened) => opened.agentService.identity
        );

        const other = yield* withStore(
          optionsFor("distinct"),
          (opened) => opened.agentService.identity
        );

        expect(first.snapshot.events).toEqual(batchAt(0).events);
        expect(second).toEqual(first.identity);
        expect(other.storeId).not.toBe(first.identity.storeId);
      })
  );

  it.effect(
    "retains one consistent historical basis and result while another writer appends",
    () =>
      Effect.gen(function* retainedCase() {
        const options = optionsFor("retained");

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* retainedSteps() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;
            const page = yield* opened.agentService.readEventPage(pageInput());
            const basis = basisFor(identity, page, "basis-retained");
            const result = resultFor(basis, "result-retained");

            yield* withStore(options, (other) =>
              other.service.append(batchAt(1))
            );

            yield* opened.agentService.putBasis(basis);
            yield* opened.agentService.putResult(result);

            yield* opened.agentService.putBasis(basis);
            yield* opened.agentService.putResult(result);

            const basisConflict = yield* Effect.flip(
              opened.agentService.putBasis({
                ...basis,
                configDigest: "fixture.changed-config",
              })
            );

            const resultConflict = yield* Effect.flip(
              opened.agentService.putResult(
                resultFor(basis, result.id, "Changed historical projection")
              )
            );

            expect(basisConflict).toMatchObject({
              code: "idempotency-conflict",
            });
            expect(resultConflict).toMatchObject({
              code: "idempotency-conflict",
            });

            const cursor: AgentCursor = {
              ...handleFor(identity, "cursor-retained"),
              axis: "items",
              basisId: basis.id,
              kind: "output-page",
              position: 1,
              projectionVersion: result.projectionVersion,
              queryDigest: result.queryDigest,
              resultId: result.id,
              storeRevision: null,
            };

            yield* opened.agentService.putCursor(cursor);
            const pinned = yield* opened.agentService.getBasis(basis);

            const current =
              yield* opened.agentService.readEventPage(pageInput());

            const inconsistent = yield* Effect.flip(
              opened.agentService.putBasis({
                ...basis,
                id: "basis-mixed-capture",
                retainedEvents: current.events,
                selectedEventDigest: agentHash(
                  canonicalAgentJson(current.events)
                ),
              })
            );

            const inconsistentCoverage = yield* Effect.flip(
              opened.agentService.putBasis({
                ...basis,
                coverage: current.coverage,
                id: "basis-mixed-coverage",
              })
            );

            expect(inconsistent).toMatchObject({ code: "basis-incompatible" });
            expect(inconsistentCoverage).toMatchObject({
              code: "basis-incompatible",
            });
            expect(pinned).toEqual(basis);
            expect(pinned.coverage).toEqual([batchAt(0).coverage]);
            expect(current.coverage).toEqual([batchAt(1).coverage]);
            expect(current.events).toHaveLength(4);
            expect(current.eventWatermark).not.toBe(basis.eventWatermark);

            const newest = {
              ...basisFor(identity, current, "basis-newest-scope"),
              createdAt: "2026-01-01T00:02:00.000Z",
              queryKey: "fixture-s01-other-query",
            };

            yield* opened.agentService.putBasis(newest);

            return { basis, cursor, newest, result };
          })
        );

        const reopened = yield* withStore(options, (opened) =>
          Effect.all({
            basis: opened.agentService.getBasis(saved.basis),
            cursor: opened.agentService.getCursor(saved.cursor),
            found: opened.agentService.findResult(
              saved.basis,
              "dx_analyze",
              saved.result.queryDigest
            ),
            latest: opened.agentService.latestBasis(saved.basis.queryKey),
            result: opened.agentService.getResult(saved.result),
            scoped: opened.agentService.latestBasisForScope(scope),
            wrongScope: opened.agentService.latestBasisForScope({
              ...scope,
              repoId: "/fixture/s01/other/.git",
            }),
          })
        );

        expect(reopened.basis.retainedEvents).toEqual(batchAt(0).events);
        expect(reopened.basis.priceSheets).toEqual(saved.basis.priceSheets);
        expect(reopened.result).toEqual(saved.result);
        expect(reopened.found).toEqual(saved.result);
        expect(reopened.latest).toEqual(saved.basis);
        expect(reopened.cursor).toEqual(saved.cursor);
        expect(reopened.scoped).toMatchObject({
          id: saved.newest.id,
          window: saved.newest.window,
        });
        expect(reopened.wrongScope).toBeNull();
      })
  );

  it.effect(
    "pages a half-open window within fact and decoded-byte bounds",
    () =>
      withStore(optionsFor("pages"), (opened) =>
        Effect.gen(function* pagingCase() {
          yield* Effect.forEach((batch: EventBatch) =>
            opened.service.append(batch)
          )(fixture.batches);

          const selected = {
            ...selector,
            from: "2026-01-01T00:01:00.000Z",
            to: "2026-01-01T00:03:00.000Z",
          };

          const first = yield* opened.agentService.readEventPage({
            ...pageInput(selected),
            maxFacts: 1,
          });

          expect(first.events.map((event) => event.eventId)).toEqual([
            "evt_s01_1",
          ]);
          expect(first.factsExamined).toBeLessThanOrEqual(1);
          expect(first.decodedBytes).toBeLessThanOrEqual(1_000_000);
          expect(first.complete).toBe(false);
          expect(first.nextCursor).not.toBeNull();

          const second = yield* opened.agentService.readEventPage({
            ...pageInput(selected),
            cursor: first.nextCursor,
            eventWatermark: first.eventWatermark,
            maxFacts: 1,
          });

          expect(second.events.map((event) => event.eventId)).toEqual([
            "evt_s01_2",
          ]);
          expect(second.complete).toBe(true);
          expect(second.eventWatermark).toBe(first.eventWatermark);

          const tiny = yield* Effect.flip(
            opened.agentService.readEventPage({
              ...pageInput(selected),
              maxDecodedBytes: 1,
            })
          );

          expect(tiny).toMatchObject({ code: "budget-exhausted" });
        })
      )
  );

  it.effect(
    "bounds source coverage rows and skips bodies beyond the decoded-byte budget",
    () =>
      withStore(optionsFor("coverage-bounds"), (opened) =>
        Effect.gen(function* coverageCase() {
          yield* opened.service.append(batchAt(0));

          const secondary: EventBatch = {
            coverage: {
              ...batchAt(0).coverage,
              adapterId: "fixture.s01.secondary",
              expectedItems: null,
              gaps: [
                {
                  code: "fixture-empty",
                  message: "This fixture source has no observations",
                },
              ],
              observedItems: 0,
              state: "none",
            },
            cursor: null,
            events: [],
          };

          yield* opened.service.append(secondary);

          const coverageScope = {
            ...scope,
            sources: ["fixture.s01", "fixture.s01.secondary"],
          };

          const bounded = yield* opened.agentService.readCoverage(
            coverageScope,
            1,
            1024
          );

          const tiny = yield* opened.agentService.readCoverage(
            coverageScope,
            2,
            1
          );

          expect(bounded.coverage).toEqual([batchAt(0).coverage]);
          expect(bounded.factsExamined).toBeLessThanOrEqual(1);
          expect(bounded.decodedBytes).toBeLessThanOrEqual(1024);
          expect(bounded.omitted).toBe(1);
          expect(tiny.coverage).toHaveLength(0);
          expect(tiny.decodedBytes).toBe(0);
          expect(tiny.omitted).toBe(2);
        })
      )
  );

  it.effect(
    "retains missing source coverage with associated tool placement and discloses unresolved placement",
    () =>
      withStore(optionsFor("missing-source-coverage"), (opened) =>
        Effect.gen(function* missingCoverageCase() {
          const associated = yield* Schema.decodeUnknownEffect(
            EventBatchSchema
          )({
            ...batchAt(0),
            events: batchAt(0).events.map((event) => ({
              ...event,
              ai: {
                agentId: null,
                agentType: null,
                branchSource: "harness-recorded",
                channel: "session-file",
                cwd: scope.worktreeId,
                effort: null,
                effortSource: null,
                harness: "codex",
                harnessVersion: "fixture.v1",
                model: null,
                modelRaw: null,
                parentSessionId: null,
                provider: "unknown",
                sessionId: "fixture:s01:codex-association",
                via: null,
              },
            })),
          });

          yield* opened.service.append(associated);

          const missing: EventBatch["coverage"] = {
            adapterId: "fixture.s01",
            expectedItems: null,
            gaps: [
              {
                code: "fixture-source-missing",
                message: "The labelled fixture source is unavailable",
              },
            ],
            observedItems: null,
            state: "none",
            watermark: null,
            windowFrom: null,
            windowTo: null,
          };

          const unassociated = {
            ...missing,
            adapterId: "fixture.s01.unassociated",
          };

          yield* opened.service.append({
            coverage: missing,
            cursor: null,
            events: [],
          });
          yield* opened.service.append({
            coverage: unassociated,
            cursor: null,
            events: [],
          });

          const toolScope: AgentScope = {
            ...scope,
            sources: ["fixture.s01", "fixture.s01.unassociated"],
            tools: ["codex"],
          };

          const page = yield* opened.agentService.readCoverage(
            toolScope,
            10,
            1024
          );

          expect(page.coverage).toHaveLength(2);
          expect(
            page.coverage.find((entry) => entry.adapterId === missing.adapterId)
          ).toEqual(missing);

          const unresolved = page.coverage.find(
            (entry) => entry.adapterId === unassociated.adapterId
          );

          expect({ ...unresolved, gaps: [] }).toEqual({
            ...unassociated,
            gaps: [],
          });
          expect(unresolved?.gaps.slice(0, -1)).toEqual(unassociated.gaps);
          expect(unresolved?.gaps.at(-1)?.code).toBe(
            "unresolved-tool-placement"
          );
          expect(unresolved?.gaps.at(-1)?.message).toMatch(
            /tool|worktree|placement/iu
          );
          expect(page.omitted).toBe(0);
          expect(page.decodedBytes).toBeLessThanOrEqual(1024);

          const unresolvedBranchScope: AgentScope = {
            ...toolScope,
            branchSelection: { branches: [], kind: "unresolved" },
            sources: ["fixture.s01"],
          };

          const unresolvedBranch = yield* opened.agentService.readCoverage(
            unresolvedBranchScope,
            10,
            1024
          );

          const [branchCoverage] = unresolvedBranch.coverage;

          expect(unresolvedBranch.coverage).toHaveLength(1);
          expect({ ...branchCoverage, gaps: [] }).toEqual({
            ...missing,
            gaps: [],
          });
          expect(branchCoverage?.gaps.slice(0, -1)).toEqual(missing.gaps);
          expect(branchCoverage?.gaps.at(-1)?.code).toBe(
            "unresolved-branch-placement"
          );
          expect(unresolvedBranch.omitted).toBe(0);
        })
      )
  );

  it.effect(
    "reads retained headers and pages within the combined item and series work budget",
    () =>
      withStore(optionsFor("result-pages"), (opened) =>
        Effect.gen(function* resultPagingCase() {
          yield* opened.service.append(batchAt(0));

          const identity = yield* opened.agentService.identity;

          const basis = basisFor(
            identity,
            yield* opened.agentService.readEventPage(pageInput()),
            "basis-result-pages"
          );

          const summary = {
            fixture: true,
            unavailableReason: "No live measurements",
          };

          const orderedProjection = JSON.stringify({
            disclosures: ["Labelled S01 fixture only"],
            items: [{ name: "row-a" }, { name: "row-b" }, { name: "row-c" }],
            series: [
              { bucket: "fixture-bucket-a" },
              { bucket: "fixture-bucket-b" },
            ],
            summary,
          });

          const result: AgentResult = {
            ...resultFor(basis, "result-pages"),
            byteCount: Buffer.byteLength(orderedProjection, "utf-8"),
            itemCount: 3,
            orderedProjection,
            resolutions: [
              { reason: null, ref: refFor(basis, "basis"), state: "found" },
            ],
            resultDigest: hash(orderedProjection),
            seriesCount: 2,
          };

          yield* opened.agentService.putBasis(basis);
          yield* opened.agentService.putResult(result);

          const headers = yield* Effect.all({
            basis: opened.agentService.getBasisMetadata(basis),
            result: opened.agentService.getResultMetadata(result),
          });

          expect(headers.basis.selectedEventDigest).toBe(
            basis.selectedEventDigest
          );
          expect(headers.result.itemCount).toBe(3);
          expect(headers.result.seriesCount).toBe(2);
          expect(headers.result.byteCount).toBe(
            Buffer.byteLength(orderedProjection, "utf-8")
          );

          const boundedHeaders = yield* Effect.all({
            basis: Effect.flip(opened.agentService.getBasisMetadata(basis, 1)),
            latestScope: Effect.flip(
              opened.agentService.latestBasisForScope(scope, 1)
            ),
            result: Effect.flip(
              opened.agentService.getResultMetadata(result, 1)
            ),
          });

          expect(boundedHeaders.basis).toMatchObject({
            code: "budget-exhausted",
          });
          expect(boundedHeaders.latestScope).toMatchObject({
            code: "budget-exhausted",
          });
          expect(boundedHeaders.result).toMatchObject({
            code: "budget-exhausted",
          });

          const headerOnly = yield* opened.agentService.readResultPage(result, {
            maxDecodedBytes: 1024,
            maxElapsedMs: 60_000,
            maxFacts: 1,
            maxItems: 2,
            maxSeriesBuckets: 2,
            maxStacks: 2,
            position: 0,
            seriesPosition: 0,
          });

          expect(headerOnly.factsExamined).toBe(1);
          expect(headerOnly.decodedBytes).toBeGreaterThan(0);
          expect(headerOnly.decodedBytes).toBeLessThanOrEqual(1024);
          expect(headerOnly.view.summary).toEqual(summary);
          expect(headerOnly.view.disclosures).toEqual([
            "Labelled S01 fixture only",
          ]);
          expect(headerOnly.resolutions).toEqual(result.resolutions);
          expect(headerOnly.view.items).toEqual([]);
          expect(headerOnly.view.series).toEqual([]);
          expect(headerOnly.nextPosition).toBe(0);
          expect(headerOnly.nextSeriesPosition).toBe(0);

          const first = yield* opened.agentService.readResultPage(result, {
            maxDecodedBytes: 1024,
            maxElapsedMs: 60_000,
            maxFacts: 3,
            maxItems: 2,
            maxSeriesBuckets: 2,
            maxStacks: 2,
            position: 0,
            seriesPosition: 0,
          });

          expect(first.factsExamined).toBe(3);
          expect(first.decodedBytes).toBeLessThanOrEqual(1024);
          expect(
            first.view.items.length + first.view.series.length
          ).toBeLessThanOrEqual(2);
          expect(first.view.summary).toEqual(summary);
          expect(first.resolutions).toEqual(result.resolutions);
          expect(first.view.items).toEqual([
            { name: "row-a" },
            { name: "row-b" },
          ]);
          expect(first.nextPosition).toBe(2);
          expect(first.nextSeriesPosition).toBe(0);

          const second = yield* opened.agentService.readResultPage(result, {
            maxDecodedBytes: 1024,
            maxElapsedMs: 60_000,
            maxFacts: 3,
            maxItems: 2,
            maxSeriesBuckets: 2,
            maxStacks: 2,
            position: first.nextPosition ?? 3,
            seriesPosition: first.nextSeriesPosition ?? 2,
          });

          expect(second.factsExamined).toBe(3);
          expect(second.decodedBytes).toBeLessThanOrEqual(1024);
          expect(second.view.items).toEqual([{ name: "row-c" }]);
          expect(second.view.series).toEqual([{ bucket: "fixture-bucket-a" }]);
          expect(second.nextPosition).toBeNull();
          expect(second.nextSeriesPosition).toBe(1);

          const seriesCursor: AgentCursor = {
            ...handleFor(identity, "cursor-series-pages"),
            axis: "series",
            basisId: basis.id,
            kind: "output-page",
            position: 1,
            projectionVersion: result.projectionVersion,
            queryDigest: result.queryDigest,
            resultId: result.id,
            storeRevision: null,
          };

          yield* opened.agentService.putCursor(seriesCursor);

          const persistedSeriesCursor =
            yield* opened.agentService.getCursor(seriesCursor);

          const seriesPage = yield* opened.agentService.readResultPage(result, {
            axis: "series",
            maxDecodedBytes: 1024,
            maxElapsedMs: 60_000,
            maxFacts: 2,
            maxItems: 2,
            maxSeriesBuckets: 1,
            maxStacks: 2,
            position: 0,
            seriesPosition: persistedSeriesCursor.position,
          });

          expect(persistedSeriesCursor.axis).toBe("series");
          expect(seriesPage.view.items).toHaveLength(0);
          expect(seriesPage.view.series).toEqual([
            { bucket: "fixture-bucket-b" },
          ]);
          expect(seriesPage.factsExamined).toBe(2);
          expect(seriesPage.nextSeriesPosition).toBeNull();
          expect(seriesPage.resolutions).toEqual(result.resolutions);
          expect([
            ...first.view.series,
            ...second.view.series,
            ...seriesPage.view.series,
          ]).toEqual([
            { bucket: "fixture-bucket-a" },
            { bucket: "fixture-bucket-b" },
          ]);
          expect([...first.view.items, ...second.view.items]).toEqual([
            { name: "row-a" },
            { name: "row-b" },
            { name: "row-c" },
          ]);

          yield* Effect.sync(() => {
            process.stdout.write(
              `${JSON.stringify({
                s01Measurements: {
                  decodedBytes: first.decodedBytes,
                  factsExamined: first.factsExamined,
                  fixtureId: fixture.fixtureId,
                  projectionBytes: result.byteCount,
                  seriesPageDecodedBytes: seriesPage.decodedBytes,
                  seriesPageFactsExamined: seriesPage.factsExamined,
                },
              })}\n`
            );
          });
          expect(
            second.view.items.length + second.view.series.length
          ).toBeLessThanOrEqual(2);

          const db = new DatabaseSync(optionsFor("result-pages").path);

          try {
            db.prepare(
              "UPDATE agent_result_headers SET summary = ? WHERE id = ?"
            ).run(`${" ".repeat(4096)}{`, result.id);

            const refusedSummary = yield* Effect.flip(
              opened.agentService.readResultPage(result, {
                maxDecodedBytes: 1024,
                maxElapsedMs: 60_000,
                maxFacts: 1,
                maxItems: 2,
                maxSeriesBuckets: 2,
                maxStacks: 2,
                position: 0,
                seriesPosition: 0,
              })
            );

            expect(refusedSummary).toMatchObject({ code: "budget-exhausted" });
          } finally {
            db.prepare(
              "UPDATE agent_result_headers SET summary = ? WHERE id = ?"
            ).run(JSON.stringify(summary), result.id);
            db.close();
          }
        })
      )
  );

  it.effect(
    "measures stored basis and result headers and refuses bytes before decoding JSON",
    () =>
      Effect.gen(function* measuredMetadataCase() {
        const options = optionsFor("measured-basis-metadata");

        yield* withStore(options, (opened) =>
          Effect.gen(function* storedMetadataSteps() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;

            const metadataScope: AgentScope = {
              ...scope,
              resolution: "Labelled S01 metadata fixture ✓",
            };

            const basis = {
              ...basisFor(
                identity,
                yield* opened.agentService.readEventPage({
                  ...pageInput(),
                  scope: metadataScope,
                }),
                "basis-measured-metadata"
              ),
              scope: metadataScope,
            };

            yield* opened.agentService.putBasis(basis);

            const metadata = yield* opened.agentService.getBasisMetadata(basis);

            const canonicalBytes = Buffer.byteLength(
              JSON.stringify(metadata),
              "utf-8"
            );

            const padded = `${" ".repeat(256)}\n${JSON.stringify(metadata, null, 2)}\n`;
            const storedBytes = Buffer.byteLength(padded, "utf-8");

            const writeHeader = (
              table: "agent_basis_headers" | "agent_result_headers",
              id: string,
              body: string
            ) =>
              Effect.sync(() => {
                const db = new DatabaseSync(options.path);

                try {
                  db.prepare(`UPDATE ${table} SET body = ? WHERE id = ?`).run(
                    body,
                    id
                  );
                } finally {
                  db.close();
                }
              });

            yield* writeHeader("agent_basis_headers", basis.id, padded);
            expect(storedBytes).toBeGreaterThan(canonicalBytes);
            expect(storedBytes).toBeGreaterThan(padded.length);

            const measured = yield* Effect.all({
              latest: opened.agentService.readLatestBasisMetadataForScope(
                metadataScope,
                storedBytes
              ),
              normalized: opened.agentService.getBasisMetadata(basis),
              pinned: opened.agentService.readBasisMetadata(basis, storedBytes),
            });

            expect(measured.normalized).toEqual(metadata);
            expect(measured.pinned).toEqual({
              decodedBytes: storedBytes,
              factsExamined: 1,
              metadata,
            });
            expect(measured.latest).toEqual(measured.pinned);

            const refused = yield* Effect.all({
              latest: opened.agentService.readLatestBasisMetadataForScope(
                metadataScope,
                canonicalBytes
              ),
              legacyLatest: Effect.flip(
                opened.agentService.latestBasisForScope(
                  metadataScope,
                  canonicalBytes
                )
              ),
              legacyPinned: Effect.flip(
                opened.agentService.getBasisMetadata(basis, canonicalBytes)
              ),
              pinned: opened.agentService.readBasisMetadata(
                basis,
                canonicalBytes
              ),
            });

            expect(refused.pinned).toEqual({
              decodedBytes: 0,
              factsExamined: 1,
              metadata: null,
            });
            expect(refused.latest).toEqual(refused.pinned);
            expect(refused.legacyPinned).toMatchObject({
              code: "budget-exhausted",
            });
            expect(refused.legacyLatest).toMatchObject({
              code: "budget-exhausted",
            });

            yield* writeHeader(
              "agent_basis_headers",
              basis.id,
              `${" ".repeat(storedBytes)}{`
            );

            const malformedRefused = yield* Effect.all({
              latest: opened.agentService.readLatestBasisMetadataForScope(
                metadataScope,
                1
              ),
              pinned: opened.agentService.readBasisMetadata(basis, 1),
            });

            expect(malformedRefused.pinned).toEqual(refused.pinned);
            expect(malformedRefused.latest).toEqual(refused.latest);
            yield* writeHeader("agent_basis_headers", basis.id, padded);

            const missing = yield* Effect.all({
              latest: opened.agentService.readLatestBasisMetadataForScope(
                { ...metadataScope, repoId: unaffectedScope.repoId },
                storedBytes
              ),
              pinned: opened.agentService.readBasisMetadata(
                handleFor(identity, "basis-missing-metadata"),
                storedBytes
              ),
              stale: Effect.flip(
                opened.agentService.readBasisMetadata(
                  {
                    ...handleFor(basis, basis.id),
                    storeGeneration: basis.storeGeneration + 1,
                  },
                  storedBytes
                )
              ),
            });

            expect(missing.pinned).toEqual({
              decodedBytes: 0,
              factsExamined: 0,
              metadata: null,
            });
            expect(missing.latest).toEqual(missing.pinned);
            expect(missing.stale).toMatchObject({ code: "stale-generation" });

            const result = resultFor(basis, "result-measured-metadata");
            yield* opened.agentService.putResult(result);

            const resultMetadata =
              yield* opened.agentService.getResultMetadata(result);

            const resultCanonicalBytes = Buffer.byteLength(
              JSON.stringify(resultMetadata),
              "utf-8"
            );

            const resultPadded = `${" ".repeat(256)}\n${JSON.stringify(resultMetadata, null, 2)}\n`;
            const resultStoredBytes = Buffer.byteLength(resultPadded, "utf-8");

            yield* writeHeader("agent_result_headers", result.id, resultPadded);
            expect(resultStoredBytes).toBeGreaterThan(resultCanonicalBytes);

            const measuredResult = yield* Effect.all({
              matching: opened.agentService.readMatchingResultMetadata(
                basis,
                result.capability,
                result.queryDigest,
                resultStoredBytes
              ),
              normalized: opened.agentService.getResultMetadata(result),
              pinned: opened.agentService.readResultMetadata(
                result,
                resultStoredBytes
              ),
            });

            expect(measuredResult.normalized).toEqual(resultMetadata);
            expect(measuredResult.pinned).toEqual({
              decodedBytes: resultStoredBytes,
              factsExamined: 1,
              metadata: resultMetadata,
            });
            expect(measuredResult.matching).toEqual(measuredResult.pinned);

            const refusedResult = yield* Effect.all({
              legacyMatching: Effect.flip(
                opened.agentService.findResultMetadata(
                  basis,
                  result.capability,
                  result.queryDigest,
                  resultCanonicalBytes
                )
              ),
              legacyPinned: Effect.flip(
                opened.agentService.getResultMetadata(
                  result,
                  resultCanonicalBytes
                )
              ),
              matching: opened.agentService.readMatchingResultMetadata(
                basis,
                result.capability,
                result.queryDigest,
                resultCanonicalBytes
              ),
              pinned: opened.agentService.readResultMetadata(
                result,
                resultCanonicalBytes
              ),
            });

            expect(refusedResult.pinned).toEqual({
              decodedBytes: 0,
              factsExamined: 1,
              metadata: null,
            });
            expect(refusedResult.matching).toEqual(refusedResult.pinned);
            expect(refusedResult.legacyMatching).toMatchObject({
              code: "budget-exhausted",
            });
            expect(refusedResult.legacyPinned).toMatchObject({
              code: "budget-exhausted",
            });

            yield* writeHeader(
              "agent_result_headers",
              result.id,
              `${" ".repeat(resultStoredBytes)}{`
            );

            const malformedResult = yield* Effect.all({
              matching: opened.agentService.readMatchingResultMetadata(
                basis,
                result.capability,
                result.queryDigest,
                1
              ),
              pinned: opened.agentService.readResultMetadata(result, 1),
            });

            expect(malformedResult.pinned).toEqual(refusedResult.pinned);
            expect(malformedResult.matching).toEqual(refusedResult.matching);
            yield* writeHeader("agent_result_headers", result.id, resultPadded);

            const missingResult = yield* Effect.all({
              matching: opened.agentService.readMatchingResultMetadata(
                basis,
                result.capability,
                "fixture-no-matching-result",
                resultStoredBytes
              ),
              pinned: opened.agentService.readResultMetadata(
                handleFor(identity, "result-missing-metadata"),
                resultStoredBytes
              ),
              stale: Effect.flip(
                opened.agentService.readResultMetadata(
                  {
                    ...handleFor(result, result.id),
                    storeGeneration: result.storeGeneration + 1,
                  },
                  resultStoredBytes
                )
              ),
            });

            expect(missingResult.pinned).toEqual({
              decodedBytes: 0,
              factsExamined: 0,
              metadata: null,
            });
            expect(missingResult.matching).toEqual(missingResult.pinned);
            expect(missingResult.stale).toMatchObject({
              code: "stale-generation",
            });

            yield* Effect.sync(() => {
              process.stdout.write(
                `${JSON.stringify({
                  s01Measurements: {
                    basisMetadataCanonicalBytes: canonicalBytes,
                    basisMetadataFactsExamined: measured.pinned.factsExamined,
                    basisMetadataRefusedDecodedBytes:
                      refused.pinned.decodedBytes,
                    basisMetadataStoredBytes: measured.pinned.decodedBytes,
                    fixtureId: fixture.fixtureId,
                    resultMetadataCanonicalBytes: resultCanonicalBytes,
                    resultMetadataFactsExamined:
                      measuredResult.pinned.factsExamined,
                    resultMetadataRefusedDecodedBytes:
                      refusedResult.pinned.decodedBytes,
                    resultMetadataStoredBytes:
                      measuredResult.pinned.decodedBytes,
                  },
                })}\n`
              );
            });
          })
        );
      })
  );

  it.effect(
    "measures cursor bytes and validates scalar bindings without decoding analysis headers",
    () =>
      Effect.gen(function* measuredCursorCase() {
        const options = optionsFor("measured-agent-cursor");

        yield* withStore(options, (opened) =>
          Effect.gen(function* measuredCursorSteps() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;

            const basis = basisFor(
              identity,
              yield* opened.agentService.readEventPage(pageInput()),
              "basis-measured-cursor"
            );

            const otherBasis = { ...basis, id: "basis-other-cursor" };

            const result = {
              ...resultFor(basis, "result-measured-cursor"),
              queryDigest: "fixture-cursor-query-✓",
            };

            const cursor: AgentCursor = {
              ...handleFor(identity, "cursor-measured-body"),
              axis: "items",
              basisId: basis.id,
              kind: "output-page",
              position: 0,
              projectionVersion: result.projectionVersion,
              queryDigest: result.queryDigest,
              resultId: result.id,
              storeRevision: null,
            };

            yield* opened.agentService.putBasis(basis);
            yield* opened.agentService.putBasis(otherBasis);
            yield* opened.agentService.putResult(result);
            yield* opened.agentService.putCursor(cursor);

            const headers = yield* Effect.all({
              basis: opened.agentService.getBasisMetadata(basis),
              result: opened.agentService.getResultMetadata(result),
            });

            const canonicalBytes = Buffer.byteLength(
              JSON.stringify(cursor),
              "utf-8"
            );

            const padded = `${" ".repeat(256)}\n${JSON.stringify(cursor, null, 2)}\n`;
            const storedBytes = Buffer.byteLength(padded, "utf-8");

            const measured = yield* Effect.acquireUseRelease(
              Effect.sync(() => new DatabaseSync(options.path)),
              (db) =>
                Effect.gen(function* cursorFixtureMutations() {
                  const writeBody = (
                    table:
                      | "agent_basis_headers"
                      | "agent_result_headers"
                      | "agent_cursors",
                    id: string,
                    body: string
                  ) =>
                    Effect.sync(() => {
                      db.prepare(
                        `UPDATE ${table} SET body = ? WHERE id = ?`
                      ).run(body, id);
                    });

                  yield* writeBody("agent_cursors", cursor.id, padded);
                  expect(storedBytes).toBeGreaterThan(canonicalBytes);
                  expect(storedBytes).toBeGreaterThan(padded.length);

                  const admitted = yield* opened.agentService.readCursor(
                    cursor,
                    storedBytes
                  );

                  expect(admitted).toEqual({
                    cursor,
                    decodedBytes: storedBytes,
                    factsExamined: 1,
                  });
                  expect(yield* opened.agentService.getCursor(cursor)).toEqual(
                    cursor
                  );

                  const refused = yield* opened.agentService.readCursor(
                    cursor,
                    canonicalBytes
                  );

                  expect(refused).toEqual({
                    cursor: null,
                    decodedBytes: 0,
                    factsExamined: 1,
                  });
                  yield* writeBody(
                    "agent_cursors",
                    cursor.id,
                    `${" ".repeat(storedBytes)}{`
                  );
                  expect(
                    yield* opened.agentService.readCursor(cursor, 1)
                  ).toEqual(refused);
                  yield* writeBody("agent_cursors", cursor.id, padded);

                  const unavailableHeader = `${" ".repeat(4096)}{`;

                  yield* writeBody(
                    "agent_basis_headers",
                    basis.id,
                    unavailableHeader
                  );
                  yield* writeBody(
                    "agent_result_headers",
                    result.id,
                    unavailableHeader
                  );

                  expect(
                    yield* opened.agentService.readCursor(cursor, storedBytes)
                  ).toEqual(admitted);
                  expect(yield* opened.agentService.getCursor(cursor)).toEqual(
                    cursor
                  );

                  const refusedHeaders = yield* Effect.all({
                    basis: opened.agentService.readBasisMetadata(basis, 1),
                    result: opened.agentService.readResultMetadata(result, 1),
                  });

                  expect(refusedHeaders.basis).toEqual({
                    decodedBytes: 0,
                    factsExamined: 1,
                    metadata: null,
                  });
                  expect(refusedHeaders.result).toEqual(refusedHeaders.basis);

                  const invalidHeaders = yield* Effect.all({
                    basis: Effect.flip(
                      opened.agentService.readBasisMetadata(basis, 100_000)
                    ),
                    result: Effect.flip(
                      opened.agentService.readResultMetadata(result, 100_000)
                    ),
                  });

                  expect(invalidHeaders.basis._tag).toBe("StoreError");
                  expect(invalidHeaders.result._tag).toBe("StoreError");

                  const invalidBindings: readonly {
                    code: string;
                    cursor: AgentCursor;
                  }[] = [
                    {
                      code: "cursor-mismatch",
                      cursor: { ...cursor, queryDigest: "fixture-wrong-query" },
                    },
                    {
                      code: "cursor-mismatch",
                      cursor: {
                        ...cursor,
                        projectionVersion: "fixture-wrong-projection",
                      },
                    },
                    {
                      code: "cursor-mismatch",
                      cursor: { ...cursor, basisId: otherBasis.id },
                    },
                    {
                      code: "basis-not-found",
                      cursor: { ...cursor, basisId: "basis-cursor-missing" },
                    },
                    {
                      code: "basis-content-unavailable",
                      cursor: { ...cursor, resultId: "result-cursor-missing" },
                    },
                    {
                      code: "cursor-mismatch",
                      cursor: { ...cursor, position: result.itemCount + 1 },
                    },
                    {
                      code: "cursor-mismatch",
                      cursor: { ...cursor, axis: "series", position: 1 },
                    },
                    {
                      code: "cursor-mismatch",
                      cursor: {
                        ...cursor,
                        axis: "series",
                        kind: "work-continuation",
                      },
                    },
                  ];

                  for (const binding of invalidBindings) {
                    yield* writeBody(
                      "agent_cursors",
                      cursor.id,
                      JSON.stringify(binding.cursor)
                    );

                    const rejected = yield* Effect.flip(
                      opened.agentService.readCursor(cursor, storedBytes)
                    );

                    expect(rejected).toMatchObject({ code: binding.code });
                  }

                  yield* writeBody("agent_cursors", cursor.id, padded);
                  yield* writeBody(
                    "agent_basis_headers",
                    basis.id,
                    JSON.stringify(headers.basis)
                  );
                  yield* writeBody(
                    "agent_result_headers",
                    result.id,
                    JSON.stringify(headers.result)
                  );

                  db.prepare(
                    "UPDATE agent_cursors SET epoch = epoch + 1 WHERE id = ?"
                  ).run(cursor.id);

                  const expired = yield* Effect.flip(
                    opened.agentService.readCursor(cursor, 1)
                  );

                  expect(expired).toMatchObject({ code: "cursor-mismatch" });
                  db.prepare(
                    "UPDATE agent_cursors SET epoch = epoch - 1 WHERE id = ?"
                  ).run(cursor.id);

                  const missing = yield* opened.agentService.readCursor(
                    handleFor(identity, "cursor-measured-missing"),
                    storedBytes
                  );

                  const stale = yield* Effect.flip(
                    opened.agentService.readCursor(
                      {
                        ...handleFor(cursor, cursor.id),
                        storeGeneration: cursor.storeGeneration + 1,
                      },
                      storedBytes
                    )
                  );

                  expect(missing).toEqual({
                    cursor: null,
                    decodedBytes: 0,
                    factsExamined: 0,
                  });
                  expect(stale).toMatchObject({ code: "stale-generation" });

                  return { admitted, refused };
                }),
              (db) =>
                Effect.sync(() => {
                  db.close();
                })
            );

            yield* Effect.sync(() => {
              process.stdout.write(
                `${JSON.stringify({
                  s01Measurements: {
                    cursorCanonicalBytes: canonicalBytes,
                    cursorFactsExamined: measured.admitted.factsExamined,
                    cursorRefusedDecodedBytes: measured.refused.decodedBytes,
                    cursorStoredBytes: measured.admitted.decodedBytes,
                    fixtureId: fixture.fixtureId,
                  },
                })}\n`
              );
            });
          })
        );
      })
  );

  it.effect(
    "atomically advances shared writer cursors and closes their native connection with the store",
    () =>
      Effect.gen(function* cursorCasCase() {
        const options = optionsFor("shared-cursor-cas");

        const ref: SessionRef = {
          channel: "session-file",
          harness: "codex",
          id: "fixture-s01-cursor-cas",
          mtimeMs: 10,
          path: "/fixture/s01/cursor.jsonl",
          sessionId: "fixture-s01-cursor-session",
          size: 20,
          source: "fixture:s01",
          worktree: scope.worktreeId,
        };

        const saved = yield* withStore(options, (first) =>
          Effect.gen(function* firstCursorOwner() {
            yield* first.service.append(batchAt(0));
            const [event] = batchAt(0).events;

            if (event === undefined) {
              throw new Error("Missing cursor fixture observation");
            }

            const initial: StoredCursor = {
              cursor: { adapterId: "fixture.s01", value: "fixture-offset-10" },
              lastEventId: event.eventId,
              mtimeMs: 10,
              size: 20,
            };

            const left: StoredCursor = {
              ...initial,
              cursor: { adapterId: "fixture.s01", value: "fixture-offset-20" },
            };

            const right: StoredCursor = {
              ...initial,
              cursor: { adapterId: "fixture.s01", value: "fixture-offset-30" },
            };

            const winner = yield* withStore(options, (second) =>
              Effect.gen(function* competingCursorOwners() {
                const firstCas = first.cursorService.putIfCurrent;
                const secondCas = second.cursorService.putIfCurrent;

                if (firstCas === undefined || secondCas === undefined) {
                  throw new Error("The shared SQLite cursor port requires CAS");
                }

                expect(yield* firstCas(ref, null, initial)).toBe(true);
                expect(yield* secondCas(ref, null, right)).toBe(false);

                const before = yield* Effect.all({
                  first: first.cursorService.get(ref),
                  second: second.cursorService.get(ref),
                });

                expect(before.first).toEqual(initial);
                expect(before.second).toEqual(initial);

                const committed = yield* Effect.all(
                  {
                    first: firstCas(ref, initial, left),
                    second: secondCas(ref, initial, right),
                  },
                  { concurrency: 2 }
                );

                expect(Object.values(committed).filter(Boolean)).toHaveLength(
                  1
                );
                const advanced = committed.first ? left : right;

                expect(yield* firstCas(ref, initial, initial)).toBe(false);

                const after = yield* Effect.all({
                  first: first.cursorService.get(ref),
                  second: second.cursorService.get(ref),
                });

                expect(after.first).toEqual(advanced);
                expect(after.second).toEqual(advanced);

                return advanced;
              })
            );

            return { cursorService: first.cursorService, winner };
          })
        );

        const closed = yield* Effect.flip(saved.cursorService.get(ref));

        expect(closed._tag).toBe("StoreError");
        expect(closed).toMatchObject({ operation: "cursor.get" });

        const reopened = yield* withStore(options, (opened) =>
          opened.cursorService.get(ref)
        );

        expect(reopened).toEqual(saved.winner);
      })
  );

  it.effect(
    "reserves one operation and persists journal revisions and cancellation",
    () =>
      Effect.gen(function* operationCase() {
        const options = optionsFor("operations");

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* operationSteps() {
            const identity = yield* opened.agentService.identity;
            const plan = planFor(identity, "plan-journal");
            yield* opened.agentService.putOperationPlan(plan);

            const reservations = yield* Effect.all(
              [
                opened.agentService.reserveOperation(
                  plan,
                  plan.planDigest,
                  "fixture-op-key"
                ),
                opened.agentService.reserveOperation(
                  plan,
                  plan.planDigest,
                  "fixture-op-key"
                ),
              ],
              { concurrency: 2 }
            );

            const [first, second] = reservations;
            expect(first?.receipt.id).toBe(second?.receipt.id);
            expect(
              reservations.filter((reservation) => !reservation.reused)
            ).toHaveLength(1);

            if (first === undefined) {
              throw new Error("Missing operation reservation");
            }

            const step: OperationStep = {
              committedThrough: "fixture:s01:1",
              duplicates: 0,
              gaps: [],
              id: "fixture-step",
              inserted: 2,
              rejected: 0,
              remainingWork: "fixture:s01:2-3",
              retries: 0,
              safeCursor: "fixture-cursor-2",
              source: "fixture.s01",
              spooledRefs: [],
              state: "committed",
            };

            const journal = yield* opened.agentService.appendOperationStep(
              first.receipt,
              step,
              first.receipt.revision
            );

            const stale = yield* Effect.flip(
              opened.agentService.updateOperation(
                { ...journal, executionState: "running" },
                first.receipt.revision
              )
            );

            expect(stale).toMatchObject({
              code: "revision-conflict",
            });

            const cancelled =
              yield* opened.agentService.requestOperationCancellation(
                journal,
                journal.revision
              );

            const conflictPlan = {
              ...plan,
              id: "plan-conflict",
              planDigest: "different-plan-digest",
            };

            yield* opened.agentService.putOperationPlan(conflictPlan);

            const conflict = yield* Effect.flip(
              opened.agentService.reserveOperation(
                conflictPlan,
                conflictPlan.planDigest,
                "fixture-op-key"
              )
            );

            expect(conflict).toMatchObject({
              code: "idempotency-conflict",
            });

            return { cancelled, plan, step };
          })
        );

        const reopened = yield* withStore(options, (opened) =>
          Effect.all({
            plan: opened.agentService.getOperationPlan(saved.plan),
            receipt: opened.agentService.getOperation(saved.cancelled),
          })
        );

        expect(reopened.plan).toEqual(saved.plan);
        expect(reopened.receipt.cancellationRequested).toBe(true);
        expect(reopened.receipt.steps).toEqual([saved.step]);
        expect(reopened.receipt.steps[0]?.safeCursor).toBe("fixture-cursor-2");
        expect(reopened.receipt.verificationState).toBe("not-attempted");
      })
  );

  it.effect(
    "keeps a live writer's running journal when a second owner opens",
    () =>
      Effect.gen(function* concurrentOwnerCase() {
        const options = optionsFor("live-writer-owner");

        yield* withStore(options, (owner) =>
          Effect.gen(function* liveOwnerSteps() {
            const saved = yield* startOwnedOperation(owner, "live-writer");

            const second = yield* withStore(options, (observer) =>
              observer.agentService.getOperation(saved.receipt)
            );

            const afterObserverClose = yield* owner.agentService.getOperation(
              saved.receipt
            );

            expect(second).toEqual(saved.receipt);
            expect(afterObserverClose).toEqual(saved.receipt);
            expect(afterObserverClose.executionState).toBe("running");
            expect(afterObserverClose.steps).toEqual([
              saved.committed,
              saved.running,
            ]);
          })
        );
      })
  );

  it.effect(
    "interrupts a closed writer on reopen while preserving committed journal evidence",
    () =>
      Effect.gen(function* closedOwnerCase() {
        const options = optionsFor("closed-writer-owner");

        const saved = yield* withStore(options, (opened) =>
          startOwnedOperation(opened, "closed-writer")
        );

        const recovered = yield* withStore(options, (opened) =>
          Effect.all({
            receipt: opened.agentService.getOperation(saved.receipt),
            snapshot: opened.service.snapshot(selector),
          })
        );

        expect(recovered.receipt.executionState).toBe("interrupted");
        expect(recovered.receipt.verificationState).toBe("indeterminate");
        expect(recovered.receipt.recovery).toBe("verify-indeterminate");
        expect(recovered.receipt.revision).toBe(saved.receipt.revision + 1);
        expect(recovered.receipt.cancellationRequested).toBe(
          saved.receipt.cancellationRequested
        );
        expect(recovered.receipt.steps).toEqual([
          saved.committed,
          { ...saved.running, state: "indeterminate" },
        ]);
        expect(recovered.snapshot.events).toEqual(batchAt(0).events);

        const reopened = yield* withStore(options, (opened) =>
          opened.agentService.getOperation(saved.receipt)
        );

        expect(reopened).toEqual(recovered.receipt);
      })
  );

  it.effect(
    "keeps independent evaluation appends and rejects stale investigation updates",
    () =>
      Effect.gen(function* learningCase() {
        const options = optionsFor("learning");

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* learningSteps() {
            const identity = yield* opened.agentService.identity;
            const lesson = lessonFor(identity, "lesson-evaluations");

            const created = yield* opened.agentService.createLearning(
              lesson,
              "fixture-lesson-key"
            );

            const retry = yield* opened.agentService.createLearning(
              lesson,
              "fixture-lesson-key"
            );

            expect(retry.reused).toBe(true);
            expect(retry.record).toEqual(created.record);

            const conflicting = yield* Effect.flip(
              opened.agentService.createLearning(
                { ...lesson, claim: "Different fixture claim" },
                "fixture-lesson-key"
              )
            );

            expect(conflicting).toMatchObject({
              code: "idempotency-conflict",
            });

            const support = evaluationFor(
              lesson,
              "evaluation-support",
              "supports"
            );

            const counter = evaluationFor(
              lesson,
              "evaluation-counter",
              "contradicts"
            );

            const evaluations = yield* Effect.all(
              [
                opened.agentService.appendEvaluation(
                  support,
                  "fixture-evaluation-support"
                ),
                opened.agentService.appendEvaluation(
                  counter,
                  "fixture-evaluation-counter"
                ),
              ],
              { concurrency: 2 }
            );

            expect(evaluations.every((evaluation) => !evaluation.reused)).toBe(
              true
            );

            const evaluationRetry = yield* opened.agentService.appendEvaluation(
              support,
              "fixture-evaluation-support"
            );

            expect(evaluationRetry.reused).toBe(true);

            const evaluationConflict = yield* Effect.flip(
              opened.agentService.appendEvaluation(
                { ...support, outcome: "Changed evaluation content" },
                "fixture-evaluation-support"
              )
            );

            expect(evaluationConflict).toMatchObject({
              code: "idempotency-conflict",
            });

            const investigation: Investigation = {
              ...handleFor(identity, "investigation-cas"),
              applicability,
              authorKind: "agent",
              comparedBasisIds: [],
              conclusion: null,
              createdAt: timestamp,
              inspectedRefs: [],
              kind: "investigation",
              limitations: ["Fixture only"],
              nextQueryRefs: [],
              observedResultRefs: [],
              operationIds: [],
              question: "What does this fixture show?",
              revision: 1,
              schemaVersion: "dx.learning.v1",
              startingBasisId: null,
              state: "open",
              updatedAt: timestamp,
            };

            yield* opened.agentService.createLearning(
              investigation,
              "fixture-investigation"
            );

            const investigationEvaluation: Evaluation = {
              ...support,
              id: "evaluation-investigation",
              target: {
                id: investigation.id,
                kind: "investigation",
                revision: investigation.revision,
              },
            };

            yield* opened.agentService.appendEvaluation(
              investigationEvaluation,
              "fixture-investigation-evaluation"
            );

            const updated = yield* opened.agentService.updateLearning(
              {
                ...investigation,
                conclusion: "Fixture association only",
                revision: investigation.revision + 1,
                state: "concluded",
              },
              investigation.revision,
              "fixture-investigation-update"
            );

            const stale = yield* Effect.flip(
              opened.agentService.updateLearning(
                {
                  ...investigation,
                  conclusion: "Stale conclusion",
                  revision: investigation.revision + 1,
                },
                investigation.revision,
                "fixture-investigation-stale"
              )
            );

            expect(stale).toMatchObject({
              code: "revision-conflict",
            });

            return {
              evaluation: support,
              initialInvestigation: investigation,
              investigation: updated.record,
              lesson,
            };
          })
        );

        const reopened = yield* withStore(options, (opened) =>
          Effect.all({
            evaluation: opened.agentService.getEvaluation(saved.evaluation),
            evaluations: opened.agentService.listEvaluations(saved.lesson, 100),
            investigation: opened.agentService.getLearning(saved.investigation),
            investigationEvaluations: opened.agentService.listEvaluations(
              saved.investigation,
              100
            ),
            investigationHistory: opened.agentService.getLearning(
              saved.investigation,
              saved.initialInvestigation.revision
            ),
            learning: opened.agentService.listLearning({
              cursor: null,
              includeSuperseded: false,
              kinds: ["investigation", "lesson"],
              limit: 100,
              question: null,
              scope,
            }),
            snapshot: opened.service.snapshot(selector),
          })
        );

        expect(
          reopened.evaluations.evaluations
            .map((evaluation) => evaluation.id)
            .toSorted()
        ).toEqual(["evaluation-counter", "evaluation-support"]);
        expect(
          reopened.evaluations.evaluations.every(
            (evaluation) => evaluation.originMix[0]?.origin === "fixture"
          )
        ).toBe(true);
        expect(reopened.evaluations.omitted).toBe(0);
        expect(reopened.evaluation).toEqual(saved.evaluation);
        expect(reopened.investigation).toEqual(saved.investigation);
        expect(reopened.investigationHistory).toEqual(
          saved.initialInvestigation
        );
        expect(
          reopened.investigationEvaluations.evaluations.map(
            (evaluation) => evaluation.id
          )
        ).toEqual(["evaluation-investigation"]);
        expect(reopened.learning.records).toHaveLength(2);
        expect(reopened.snapshot.events).toHaveLength(0);
        expect(reopened.snapshot.coverage).toHaveLength(0);
      })
  );

  it.effect(
    "evicts projection content explicitly while retaining authored learning and source events",
    () =>
      Effect.gen(function* evictionCase() {
        const options = {
          ...optionsFor("eviction"),
          agentRetention: { maxProjectionBytes: 800 },
        };

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* evictionSteps() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;
            const page = yield* opened.agentService.readEventPage(pageInput());
            const basis = basisFor(identity, page, "basis-eviction");
            yield* opened.agentService.putBasis(basis);
            const first = resultFor(basis, "result-evicted", "a".repeat(150));

            const second = {
              ...resultFor(basis, "result-retained-small", "b".repeat(150)),
              createdAt: "2026-01-01T00:01:00.000Z",
            };

            yield* opened.agentService.putResult(first);

            const retainedBytes = yield* Effect.acquireUseRelease(
              Effect.sync(() => new DatabaseSync(options.path)),
              (db) =>
                Effect.gen(function* retentionMeasurements() {
                  const query = db.prepare(
                    "SELECT COALESCE((SELECT SUM(byte_count) FROM agent_results WHERE projection IS NOT NULL), 0) + COALESCE((SELECT SUM(byte_count) FROM agent_result_items), 0) + COALESCE((SELECT SUM(LENGTH(CAST(h.summary AS BLOB)) + LENGTH(CAST(h.disclosures AS BLOB)) + LENGTH(CAST(h.resolutions AS BLOB))) FROM agent_result_headers h JOIN agent_results r ON r.id = h.id WHERE r.projection IS NOT NULL), 0) AS bytes"
                  );

                  const decodeBytes = Schema.decodeUnknownEffect(
                    Schema.Struct({ bytes: Schema.Int })
                  );

                  const beforeSecond = (yield* decodeBytes(query.get())).bytes;

                  yield* opened.agentService.putResult(second);

                  const afterSecond = (yield* decodeBytes(query.get())).bytes;

                  return Math.max(beforeSecond, afterSecond);
                }),
              (db) =>
                Effect.sync(() => {
                  db.close();
                })
            );

            expect(retainedBytes).toBeGreaterThan(first.byteCount);
            expect(retainedBytes).toBeLessThanOrEqual(
              options.agentRetention.maxProjectionBytes
            );

            yield* Effect.sync(() => {
              process.stdout.write(
                `${JSON.stringify({
                  s01Measurements: {
                    fixtureId: fixture.fixtureId,
                    maxProjectionBytes:
                      options.agentRetention.maxProjectionBytes,
                    peakRetainedProjectionBytes: retainedBytes,
                  },
                })}\n`
              );
            });

            const lesson = lessonFor(identity, "lesson-after-eviction");
            yield* opened.agentService.createLearning(
              lesson,
              "fixture-eviction-lesson"
            );

            return { basis, first, lesson, second };
          })
        );

        const reopened = yield* withStore(options, (opened) =>
          Effect.all({
            basis: opened.agentService.getBasis(saved.basis),
            evicted: Effect.flip(opened.agentService.getResult(saved.first)),
            evictedMetadata: opened.agentService.getResultMetadata(saved.first),
            lesson: opened.agentService.getLearning(saved.lesson),
            retained: opened.agentService.getResult(saved.second),
            snapshot: opened.service.snapshot(selector),
          })
        );

        expect(reopened.evicted).toMatchObject({
          code: "basis-content-unavailable",
        });
        expect(reopened.retained.resultDigest).toBe(saved.second.resultDigest);
        expect(reopened.evictedMetadata).toMatchObject({
          byteCount: saved.first.byteCount,
          completeness: saved.first.completeness,
          resultDigest: saved.first.resultDigest,
        });
        expect(reopened.basis.id).toBe(saved.basis.id);
        expect(reopened.lesson).toEqual(saved.lesson);
        expect(reopened.snapshot.events).toEqual(batchAt(0).events);
      })
  );

  it.effect(
    "invalidates mutable authority on restore and rejects all old handles after reset",
    () =>
      Effect.gen(function* invalidationCase() {
        const options = optionsFor("invalidation");

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* invalidationSteps() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;

            const basis = basisFor(
              identity,
              yield* opened.agentService.readEventPage(pageInput()),
              "basis-restore"
            );

            const result = resultFor(basis, "result-restore");
            const plan = planFor(identity, "plan-restore");
            yield* opened.agentService.putBasis(basis);
            yield* opened.agentService.putResult(result);
            yield* opened.agentService.putOperationPlan(plan);

            const reservation = yield* opened.agentService.reserveOperation(
              plan,
              plan.planDigest,
              "fixture-restore-op"
            );

            const cursor: AgentCursor = {
              ...handleFor(identity, "cursor-work-restore"),
              axis: "work",
              basisId: basis.id,
              kind: "work-continuation",
              position: 1,
              projectionVersion: result.projectionVersion,
              queryDigest: result.queryDigest,
              resultId: result.id,
              storeRevision: identity.revision,
            };

            yield* opened.agentService.putCursor(cursor);

            return {
              basis,
              cursor,
              identity,
              plan,
              receipt: reservation.receipt,
              result,
            };
          })
        );

        invalidate(options.path, "restore");

        const restored = yield* withStore(options, (opened) =>
          Effect.gen(function* restoredPlanView() {
            const before = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(saved.receipt),
            });

            const originalPlan =
              yield* opened.agentService.getOperationPlanForReceipt(
                saved.receipt
              );

            if (originalPlan === null) {
              throw new Error("Missing restored fixture operation plan");
            }

            const fresh = yield* Effect.flip(
              opened.agentService.reserveOperation(
                originalPlan,
                originalPlan.planDigest,
                "fixture-restore-fresh-key"
              )
            );

            const after = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(saved.receipt),
            });

            const current = yield* Effect.all({
              basis: opened.agentService.getBasis(saved.basis),
              cursor: Effect.flip(opened.agentService.getCursor(saved.cursor)),
              identity: opened.agentService.identity,
              plan: opened.agentService.getOperationPlan(saved.plan),
              reserve: Effect.flip(
                opened.agentService.reserveOperation(
                  saved.plan,
                  saved.plan.planDigest,
                  "fixture-restore-op"
                )
              ),
              result: opened.agentService.getResult(saved.result),
            });

            return { ...current, after, before, fresh, originalPlan };
          })
        );

        expect(restored.identity.storeId).toBe(saved.identity.storeId);
        expect(restored.identity.storeGeneration).toBe(
          saved.identity.storeGeneration
        );
        expect(restored.identity.revision).not.toBe(saved.identity.revision);
        expect(restored.basis).toEqual(saved.basis);
        expect(restored.result).toEqual(saved.result);
        expect(restored.plan.validity).not.toBe("valid");
        expect(restored.originalPlan).toMatchObject({
          ...handleFor(saved.plan, saved.plan.id),
          arguments: saved.plan.arguments,
          bounds: saved.plan.bounds,
          effects: saved.plan.effects,
          planDigest: saved.plan.planDigest,
          scope: saved.plan.scope,
          validity: "stale",
        });
        expect(restored.after).toEqual(restored.before);
        expect(restored.fresh._tag).toBe("AgentError");
        expect(restored.reserve).toMatchObject({
          code: "stale-generation",
        });
        expect(restored.before.receipt).toMatchObject({
          cancellationRequested: true,
          executionState: "interrupted",
          recovery: "replan",
        });
        expect(restored.cursor).toMatchObject({
          code: "cursor-mismatch",
        });
        invalidate(options.path, "reset");

        const reset = yield* withStore(options, (opened) =>
          Effect.all({
            basis: Effect.flip(opened.agentService.getBasis(saved.basis)),
            identity: opened.agentService.identity,
            refs: opened.agentService.resolveRefs([
              refFor(saved.basis, "basis"),
            ]),
          })
        );

        expect(reset.identity.storeGeneration).toBeGreaterThan(
          saved.identity.storeGeneration
        );
        expect(reset.basis).toMatchObject({
          code: "stale-generation",
        });
        expect(reset.refs[0]?.state).toBe("stale-generation");
      })
  );

  it.effect(
    "recovers one reset receipt through two generations without reviving unused authority",
    () =>
      Effect.gen(function* resetRecoveryCase() {
        const options = optionsFor("reset-recovery");

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* resetRecoverySteps() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;

            const plan: OperationPlan = {
              ...planFor(identity, "plan-reset-recovery"),
              arguments: { backupRequired: true, kind: "reset" },
              effects: {
                destructive: true,
                networkDestinations: [],
                reads: ["fixture-store"],
                writes: ["fixture-store"],
              },
              kind: "reset",
            };

            const unused = planFor(identity, "plan-unused-before-reset");

            yield* opened.agentService.putOperationPlan(plan);
            yield* opened.agentService.putOperationPlan(unused);

            const reservation = yield* opened.agentService.reserveOperation(
              plan,
              plan.planDigest,
              "fixture-reset-recovery-key"
            );

            const unusedReservation =
              yield* opened.agentService.reserveOperation(
                unused,
                unused.planDigest,
                "fixture-unused-key"
              );

            const step: OperationStep = {
              committedThrough: "fixture:s01:1",
              duplicates: 0,
              gaps: [],
              id: "fixture-reset-committed-step",
              inserted: 2,
              rejected: 0,
              remainingWork: "fixture-reset-awaiting-confirmation",
              retries: 0,
              safeCursor: "fixture-reset-before-generation-change",
              source: "fixture.s01",
              spooledRefs: [],
              state: "committed",
            };

            const journal = yield* opened.agentService.appendOperationStep(
              reservation.receipt,
              step,
              reservation.receipt.revision
            );

            const running = yield* opened.agentService.updateOperation(
              {
                ...journal,
                executionState: "running",
                recovery: "safe-resume",
                revision: journal.revision + 1,
                startedAt: timestamp,
              },
              journal.revision
            );

            return { identity, plan, running, unused, unusedReservation };
          })
        );

        invalidate(options.path, "reset", {
          preserveOperationId: saved.running.id,
        });

        const first = yield* withStore(options, (opened) =>
          Effect.gen(function* firstResetPlanView() {
            const before = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(saved.running),
            });

            const originalPlan =
              yield* opened.agentService.getOperationPlanForReceipt(
                saved.running
              );

            const currentPlan =
              yield* opened.agentService.getOperationPlanForReceipt(
                before.receipt
              );

            if (originalPlan === null) {
              throw new Error("Missing first reset fixture operation plan");
            }

            const after = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(saved.running),
            });

            const current = yield* Effect.all({
              fresh: Effect.flip(
                opened.agentService.reserveOperation(
                  originalPlan,
                  originalPlan.planDigest,
                  "fixture-reset-fresh-key-1"
                )
              ),
              plan: Effect.flip(
                opened.agentService.getOperationPlan(saved.plan)
              ),
              receipt: opened.agentService.getOperation(saved.running),
              retry: opened.agentService.reserveOperation(
                saved.plan,
                saved.plan.planDigest,
                "fixture-reset-recovery-key"
              ),
              unused: Effect.flip(
                opened.agentService.reserveOperation(
                  saved.unused,
                  saved.unused.planDigest,
                  "fixture-unused-key"
                )
              ),
            });

            return { ...current, after, before, currentPlan, originalPlan };
          })
        );

        expect(first.receipt.id).toBe(saved.running.id);
        expect(first.receipt.storeGeneration).toBeGreaterThan(
          saved.identity.storeGeneration
        );
        expect(first.retry.reused).toBe(true);
        expect(first.retry.receipt).toEqual(first.receipt);
        expect(first.receipt.steps).toEqual(saved.running.steps);
        expect(first.originalPlan).toMatchObject({
          ...handleFor(saved.plan, saved.plan.id),
          arguments: saved.plan.arguments,
          bounds: saved.plan.bounds,
          effects: saved.plan.effects,
          planDigest: saved.plan.planDigest,
          scope: saved.plan.scope,
          validity: "stale",
        });
        expect(first.currentPlan).toEqual(first.originalPlan);
        expect(first.originalPlan.storeGeneration).not.toBe(
          first.receipt.storeGeneration
        );
        expect(first.after).toEqual(first.before);
        expect(first.plan).toMatchObject({ code: "stale-generation" });
        expect(first.fresh).toMatchObject({ code: "stale-generation" });
        expect(first.unused).toMatchObject({ code: "stale-generation" });

        invalidate(options.path, "reset", {
          preserveOperationId: saved.running.id,
        });

        const second = yield* withStore(options, (opened) =>
          Effect.gen(function* secondResetPlanView() {
            const before = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(saved.running),
            });

            const originalPlan =
              yield* opened.agentService.getOperationPlanForReceipt(
                saved.running
              );

            const currentPlan =
              yield* opened.agentService.getOperationPlanForReceipt(
                before.receipt
              );

            const after = yield* Effect.all({
              identity: opened.agentService.identity,
              receipt: opened.agentService.getOperation(saved.running),
            });

            const current = yield* Effect.all({
              receipt: opened.agentService.getOperation(saved.running),
              retry: opened.agentService.reserveOperation(
                saved.plan,
                saved.plan.planDigest,
                "fixture-reset-recovery-key"
              ),
              snapshot: opened.service.snapshot(selector),
              unused: Effect.flip(
                opened.agentService.getOperation(
                  saved.unusedReservation.receipt
                )
              ),
            });

            return { ...current, after, before, currentPlan, originalPlan };
          })
        );

        expect(second.receipt.id).toBe(saved.running.id);
        expect(second.receipt.storeGeneration).toBeGreaterThan(
          first.receipt.storeGeneration
        );
        expect(second.retry.reused).toBe(true);
        expect(second.retry.receipt).toEqual(second.receipt);
        expect(second.receipt.steps).toEqual(saved.running.steps);
        expect(second.receipt.recovery).toBe(first.receipt.recovery);
        expect(second.originalPlan).toEqual(first.originalPlan);
        expect(second.currentPlan).toEqual(first.originalPlan);
        expect(second.after).toEqual(second.before);
        expect(second.unused).toMatchObject({ code: "stale-generation" });
        expect(second.snapshot.events).toEqual(batchAt(0).events);

        const db = new DatabaseSync(options.path);

        try {
          db.prepare("DELETE FROM agent_operation_plans WHERE id = ?").run(
            saved.plan.id
          );
        } finally {
          db.close();
        }

        const missing = yield* withStore(options, (opened) =>
          Effect.all({
            plan: opened.agentService.getOperationPlanForReceipt(saved.running),
            receipt: opened.agentService.getOperation(saved.running),
          })
        );

        expect(missing.plan).toBeNull();
        expect(missing.receipt).toEqual(second.receipt);
      })
  );

  it.effect(
    "tombstones a retained observation when its source replaces the same event id",
    () =>
      withStore(optionsFor("source-replacement"), (opened) =>
        Effect.gen(function* replacementCase() {
          yield* opened.service.append(batchAt(0));

          const identity = yield* opened.agentService.identity;

          const basis = basisFor(
            identity,
            yield* opened.agentService.readEventPage(pageInput()),
            "basis-replaced-observation"
          );

          const result = resultFor(basis, "result-replaced-observation");
          const [original] = batchAt(0).events;

          if (original === undefined) {
            throw new Error("Missing first replacement fixture observation");
          }

          yield* opened.service.append(unaffectedBatch());

          const unaffectedSelector = {
            ...selector,
            repoCommonDir: unaffectedScope.repoId,
          };

          const unaffectedBasis = {
            ...basisFor(
              identity,
              yield* opened.agentService.readEventPage({
                ...pageInput(unaffectedSelector),
                scope: unaffectedScope,
              }),
              "basis-unaffected-source"
            ),
            descriptors: [
              { id: "fixture.s01.unaffected", version: "fixture.v1" },
            ],
            scope: unaffectedScope,
          };

          const unaffectedResult = resultFor(
            unaffectedBasis,
            "result-unaffected-source"
          );

          yield* opened.agentService.putBasis(basis);
          yield* opened.agentService.putResult(result);
          yield* opened.agentService.putBasis(unaffectedBasis);
          yield* opened.agentService.putResult(unaffectedResult);

          const replacement = {
            ...original,
            payload: {
              fixture: true,
              replacement:
                "different observation under the same upstream identity",
            },
          };

          const appended = yield* opened.service.append({
            coverage: {
              ...batchAt(0).coverage,
              expectedItems: 1,
              observedItems: 1,
              watermark: "fixture-replaced",
            },
            cursor: null,
            events: [replacement],
            replace: {
              adapterId: original.adapterId,
              fromOccurredAt: timestamp,
            },
          });

          const old = yield* Effect.all({
            basis: Effect.flip(opened.agentService.getBasis(basis)),
            matchingMetadata: Effect.flip(
              opened.agentService.readMatchingResultMetadata(
                basis,
                result.capability,
                result.queryDigest,
                1
              )
            ),
            measuredMetadata: Effect.flip(
              opened.agentService.readResultMetadata(result, 1)
            ),
            refs: opened.agentService.resolveRefs(
              [
                refFor(basis, "basis"),
                refFor(
                  handleFor(identity, original.eventId),
                  "event",
                  basis.id
                ),
              ],
              scope
            ),
            result: Effect.flip(opened.agentService.getResult(result)),
            snapshot: opened.service.snapshot(selector),
            unaffectedBasis: opened.agentService.getBasis(unaffectedBasis),
            unaffectedRefs: opened.agentService.resolveRefs(
              [refFor(unaffectedBasis, "basis")],
              unaffectedScope
            ),
            unaffectedResult: opened.agentService.getResult(unaffectedResult),
          });

          expect(appended).toEqual({ duplicates: 0, inserted: 1 });
          expect(old.basis).toMatchObject({
            code: "basis-content-unavailable",
          });
          expect(old.result).toMatchObject({
            code: "basis-content-unavailable",
          });
          expect(old.measuredMetadata).toMatchObject({
            code: "basis-content-unavailable",
          });
          expect(old.matchingMetadata).toMatchObject({
            code: "basis-content-unavailable",
          });
          expect(old.refs.map((ref) => ref.state)).toEqual([
            "missing-in-basis",
            "missing-in-basis",
          ]);
          expect(old.snapshot.events).toEqual([replacement]);
          expect(old.unaffectedBasis).toEqual(unaffectedBasis);
          expect(old.unaffectedResult).toEqual(unaffectedResult);
          expect(old.unaffectedRefs[0]?.state).toBe("found");
        })
      )
  );

  it.effect(
    "refuses over-budget replacement atomically and preserves partial append observations",
    () =>
      withStore(optionsFor("bounded-append"), (opened) =>
        Effect.gen(function* boundedReplacementCase() {
          yield* opened.service.append({
            ...batchAt(0),
            events: batchAt(0).events.toReversed(),
          });

          const beforeSnapshot = yield* opened.service.snapshot(selector);
          const identity = yield* opened.agentService.identity;

          const basis = basisFor(
            identity,
            yield* opened.agentService.readEventPage(pageInput()),
            "basis-before-bounded-replacement"
          );

          const result = resultFor(basis, "result-before-bounded-replacement");
          const [original] = batchAt(0).events;

          if (original === undefined) {
            throw new Error("Missing bounded replacement fixture observation");
          }

          yield* opened.agentService.putBasis(basis);
          yield* opened.agentService.putResult(result);

          const replacement = {
            ...original,
            payload: {
              fixture: true,
              replacement: "Labelled bounded S01 replacement observation",
            },
          };

          const replacementBatch: EventBatch = {
            coverage: {
              ...batchAt(0).coverage,
              expectedItems: 1,
              observedItems: 1,
              watermark: "fixture-bounded-replacement",
              windowTo: timestamp,
            },
            cursor: null,
            events: [replacement],
            replace: {
              adapterId: batchAt(0).coverage.adapterId,
              fromOccurredAt: timestamp,
            },
          };

          const limits = {
            maxElapsedMs: 60_000,
            maxRemovedBytes: 1_000_000,
            maxRemovedRecords: 10,
          };

          const recordRefusal = yield* Effect.flip(
            opened.appendBounded(replacementBatch, {
              ...limits,
              maxRemovedRecords: 1,
            })
          );

          const byteRefusal = yield* Effect.flip(
            opened.appendBounded(replacementBatch, {
              ...limits,
              maxRemovedBytes: 1,
            })
          );

          expect(recordRefusal).toMatchObject({ code: "budget-exhausted" });
          expect(byteRefusal).toMatchObject({ code: "budget-exhausted" });

          const unchanged = yield* Effect.all({
            basis: opened.agentService.getBasis(basis),
            result: opened.agentService.getResult(result),
            snapshot: opened.service.snapshot(selector),
          });

          expect(unchanged.basis).toEqual(basis);
          expect(unchanged.result).toEqual(result);
          expect(unchanged.snapshot.events).toEqual(beforeSnapshot.events);
          expect(unchanged.snapshot.coverage).toEqual([batchAt(0).coverage]);

          const replaced = yield* opened.appendBounded(
            replacementBatch,
            limits
          );

          const removedBytes = batchAt(0).events.reduce(
            (bytes, event) =>
              bytes + Buffer.byteLength(JSON.stringify(event), "utf-8"),
            0
          );

          expect(replaced).toMatchObject({
            decodedBytes: removedBytes,
            duplicates: 0,
            inserted: 1,
            removedBytes,
            removedCount: 2,
            removedDigest: `sha256:${agentHash(
              canonicalAgentJson(
                batchAt(0).events.map((event) => ({
                  body: event,
                  eventId: event.eventId,
                }))
              )
            )}`,
            removedEventIds: batchAt(0).events.map((event) => event.eventId),
            removedIdsOmitted: 0,
          });
          expect(replaced.factsExamined).toBeLessThanOrEqual(
            limits.maxRemovedRecords
          );

          const tombstoned = yield* Effect.flip(
            opened.agentService.getBasis(basis)
          );

          expect(tombstoned).toMatchObject({
            code: "basis-content-unavailable",
          });

          const replacedSnapshot = yield* opened.service.snapshot(selector);

          expect(replacedSnapshot.events).toEqual([replacement]);
          expect(replacedSnapshot.coverage).toEqual([
            replacementBatch.coverage,
          ]);

          const currentBasis = basisFor(
            yield* opened.agentService.identity,
            yield* opened.agentService.readEventPage(pageInput()),
            "basis-after-bounded-replacement"
          );

          yield* opened.agentService.putBasis(currentBasis);

          const partial = yield* opened.appendBounded(batchAt(1), limits);

          expect(partial).toMatchObject({
            decodedBytes: 0,
            duplicates: 0,
            factsExamined: 0,
            inserted: 2,
            removedBytes: 0,
            removedCount: 0,
            removedDigest: null,
            removedEventIds: [],
            removedIdsOmitted: 0,
          });

          const retained = yield* Effect.all({
            basis: opened.agentService.getBasis(currentBasis),
            snapshot: opened.service.snapshot(selector),
          });

          expect(retained.basis).toEqual(currentBasis);
          expect(retained.snapshot.events).toEqual([
            replacement,
            ...batchAt(1).events,
          ]);

          yield* Effect.sync(() => {
            process.stdout.write(
              `${JSON.stringify({
                s01Measurements: {
                  boundedRemovedBytes: replaced.decodedBytes,
                  boundedRemovedFacts: replaced.factsExamined,
                  boundedRemovedRecords: replaced.removedCount,
                  fixtureId: fixture.fixtureId,
                },
              })}\n`
            );
          });
        })
      )
  );

  it.effect(
    "tombstones scoped basis references without deleting authored lessons",
    () =>
      Effect.gen(function* tombstoneCase() {
        const options = optionsFor("tombstones");

        const saved = yield* withStore(options, (opened) =>
          Effect.gen(function* tombstoneSteps() {
            yield* opened.service.append(batchAt(0));
            const identity = yield* opened.agentService.identity;

            const basis = basisFor(
              identity,
              yield* opened.agentService.readEventPage(pageInput()),
              "basis-tombstone"
            );

            yield* opened.agentService.putBasis(basis);
            const ref = refFor(basis, "basis");

            const lesson = {
              ...lessonFor(identity, "lesson-tombstone"),
              supportingRefs: [ref],
            };

            yield* opened.agentService.createLearning(
              lesson,
              "fixture-tombstone-lesson"
            );

            yield* opened.service.append(unaffectedBatch());

            const unaffectedSelector = {
              ...selector,
              repoCommonDir: unaffectedScope.repoId,
            };

            const unaffectedBasis = {
              ...basisFor(
                identity,
                yield* opened.agentService.readEventPage({
                  ...pageInput(unaffectedSelector),
                  scope: unaffectedScope,
                }),
                "basis-unaffected-repo"
              ),
              descriptors: [
                { id: "fixture.s01.unaffected", version: "fixture.v1" },
              ],
              scope: unaffectedScope,
            };

            const unaffectedResult = resultFor(
              unaffectedBasis,
              "result-unaffected-repo"
            );

            yield* opened.agentService.putBasis(unaffectedBasis);
            yield* opened.agentService.putResult(unaffectedResult);

            return {
              basis,
              lesson,
              ref,
              unaffectedBasis,
              unaffectedResult,
            };
          })
        );

        const db = new DatabaseSync(options.path);

        try {
          tombstoneAgentScope(db, repoId);
        } finally {
          db.close();
        }

        const reopened = yield* withStore(options, (opened) =>
          Effect.all({
            basis: Effect.flip(opened.agentService.getBasis(saved.basis)),
            lesson: opened.agentService.getLearning(saved.lesson),
            refs: opened.agentService.resolveRefs([saved.ref], scope),
            unaffectedBasis: opened.agentService.getBasis(
              saved.unaffectedBasis
            ),
            unaffectedRefs: opened.agentService.resolveRefs(
              [refFor(saved.unaffectedBasis, "basis")],
              unaffectedScope
            ),
            unaffectedResult: opened.agentService.getResult(
              saved.unaffectedResult
            ),
          })
        );

        expect(reopened.basis).toMatchObject({
          code: "basis-content-unavailable",
        });
        expect(reopened.refs[0]?.state).toBe("missing-in-basis");
        expect(reopened.lesson).toMatchObject({ supportingRefs: [saved.ref] });
        expect(reopened.unaffectedBasis).toEqual(saved.unaffectedBasis);
        expect(reopened.unaffectedResult).toEqual(saved.unaffectedResult);
        expect(reopened.unaffectedRefs[0]?.state).toBe("found");
      })
  );
});
