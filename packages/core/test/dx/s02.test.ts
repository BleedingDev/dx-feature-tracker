// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture owns and removes its temporary SQLite directories.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture constructs its isolated SQLite file path.
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Ref, Schema } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../src/dx/contracts/agent-store.js";
import type { CostOptions } from "../../src/dx/metrics/cost/metric.js";
import type { PriceTable } from "../../src/dx/metrics/cost/price-table.js";
import { AGENT_PROFILE_VERSION } from "../../src/dx/model/agent-common.js";
import type { AgentRef, AgentScope } from "../../src/dx/model/agent-common.js";
import type { AgentQueryInput } from "../../src/dx/model/agent-query.js";
import {
  AgentCursorSchema,
  AgentResultMetadataSchema,
  AnalysisBasisMetadataSchema,
} from "../../src/dx/model/agent-query.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { compareAgentBases } from "../../src/dx/reports/agent/comparison.js";
import { runAgentQuery } from "../../src/dx/reports/agent/query.js";
import { selectAnalyzeSnapshot } from "../../src/dx/reports/analyze/select.js";
import { makeSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import type { OpenedEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import { deriveAgentUsageRows } from "../../src/dx/usage/derive.js";
import {
  emptyCoverage,
  emptySelector,
  fakeManifest,
  makeFakeEventStore,
} from "./fakes.js";

const timestamp = "2026-10-02T10:00:00.000Z";

const repo = "/fixture/repo";

const worktree = "/fixture/worktree";

const event = (
  id: string,
  overrides: Partial<DxEventEnvelope> = {}
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: "dx.harness.cursor",
  adapterVersion: "fixture",
  ai: {
    agentId: null,
    agentType: "main",
    branchSource: "harness-recorded",
    channel: "session-file",
    cwd: worktree,
    effort: null,
    effortSource: null,
    harness: "cursor",
    harnessVersion: "fixture",
    model: "model-x",
    modelRaw: "model-x",
    parentSessionId: null,
    provider: "openai",
    sessionId: "session-fixture",
    via: null,
  },
  context: {
    ...emptyFlightContext,
    branch: "feature/x",
    repoCommonDir: repo,
    worktreePath: worktree,
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    requestId: id,
    sessionId: "session-fixture",
  },
  kind: "ai.turn",
  observedAt: timestamp,
  occurredAt: timestamp,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: id,
  usage: {
    premiumRequests: null,
    requestKey: id,
    serviceTier: null,
    speed: null,
    tokens: { ...unknownTokens, inputFresh: 1000, output: 100 },
    toolFigure: null,
    webSearchRequests: null,
  },
  ...overrides,
});

const input = (overrides: Partial<AgentQueryInput> = {}): AgentQueryInput => ({
  agent: {
    budget: {
      maxDecodedBytes: 4_194_304,
      maxElapsedMs: 60_000,
      maxFacts: 1000,
      maxItems: 50,
      maxNetworkRequests: 0,
      maxOutputBytes: 131_072,
      maxSeriesBuckets: 10,
      maxStacks: 10,
    },
    detail: "expanded",
    policies: {
      acquisition: "recorded-only",
      derivation: "bounded-refresh",
      learning: "hidden",
      prices: "cached-only",
    },
    profileVersion: AGENT_PROFILE_VERSION,
  },
  capability: "dx_usage",
  selectors: { groupBy: ["tool"], repo: [repo], since: ["7d"], tz: ["UTC"] },
  ...overrides,
});

const withStore = <A, E>(
  use: (opened: OpenedEventStore) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(tmpdir(), "dft-s02-"));

      const opened = makeSqliteEventStore({
        kind: "live",
        path: path.join(directory, "fixture.sqlite"),
      });

      return { directory, opened };
    }),
    ({ opened }) => use(opened),
    ({ directory, opened }) =>
      Effect.sync(() => {
        opened.close();
        rmSync(directory, { force: true, recursive: true });
      })
  );

const append = (opened: OpenedEventStore, events: readonly DxEventEnvelope[]) =>
  opened.service.append({
    coverage: {
      ...emptyCoverage("dx.harness.cursor"),
      observedItems: events.length,
      state: "partial",
    },
    cursor: null,
    events,
  });

const table = (rate: number, version: string): PriceTable => ({
  currency: "USD",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  id: "fixture-table",
  models: { "model-x": { input: rate, output: rate } },
  source: "labelled-fixture",
  unit: "usd-per-million-tokens",
  version,
});

const options = (rate: number, version: string): CostOptions => ({
  priceTable: table(rate, version),
  subscription: null,
});

const UsageSummarySchema = Schema.Struct({
  aggregation: Schema.Literals(["complete", "partial"]),
  total: Schema.Struct({
    values: Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)),
  }),
});

const summaryOf = Schema.decodeUnknownSync(UsageSummarySchema);

const SeriesSchema = Schema.Struct({
  omittedStacks: Schema.Int,
  stacks: Schema.Array(Schema.Json),
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)),
});

const seriesOf = Schema.decodeUnknownSync(SeriesSchema);

const decodeFixtureBasisHeader = Schema.decodeUnknownSync(
  Schema.fromJsonString(AnalysisBasisMetadataSchema)
);

const decodeFixtureResultHeader = Schema.decodeUnknownSync(
  Schema.fromJsonString(AgentResultMetadataSchema)
);

const decodeFixtureCursor = Schema.decodeUnknownSync(
  Schema.fromJsonString(AgentCursorSchema)
);

const ref = (
  store: AgentStoreService,
  basisId: string,
  id: string
): Effect.Effect<AgentRef, AgentStoreFailure> =>
  store.identity.pipe(
    Effect.map((identity) => ({
      basisId,
      id,
      kind: "evidence",
      storeGeneration: identity.storeGeneration,
      storeId: identity.storeId,
      version: "dx.event.v2",
    }))
  );

describe("S02 recorded queries", () => {
  it.effect(
    "reuses a captured repository root alias without changing pinned scope",
    () =>
      withStore((opened) =>
        Effect.gen(function* pinnedRepoAlias() {
          const commonDir = `${repo}/.git`;
          yield* append(opened, [
            event("repo-alias", {
              context: {
                ...emptyFlightContext,
                branch: "feature/x",
                repoCommonDir: commonDir,
                worktreePath: repo,
              },
            }),
          ]);

          const request = input({
            capability: "dx_analyze",
            selectors: { repo: [commonDir] },
          });

          const capturedScope: AgentScope = {
            branchSelection: { branches: ["feature/x"], kind: "current" },
            flightId: null,
            repoId: commonDir,
            resolution: "labelled fixture canonical Git identity",
            sources: [],
            tools: [],
            worktreeId: repo,
          };

          const first = yield* runAgentQuery(request, {
            defaultScope: capturedScope,
            now: () => "2026-10-02T12:00:00.000Z",
            store: opened.agentService,
          });

          const pinned: AgentQueryInput = {
            ...request,
            agent: {
              ...request.agent,
              basisId: first.result.basisId,
              policies: { ...request.agent.policies, derivation: "ready-only" },
            },
            selectors: { repo: [repo] },
          };

          const replay = yield* runAgentQuery(pinned, {
            defaultScope: {
              ...capturedScope,
              branchSelection: { branches: ["renamed"], kind: "current" },
              worktreeId: "/reused/fixture/path",
            },
            now: () => "2026-10-03T12:00:00.000Z",
            store: opened.agentService,
          });

          expect(replay.result.resultDigest).toBe(first.result.resultDigest);
          expect(replay.context.scope).toEqual(first.context.scope);
          expect(replay.context.window).toEqual(first.context.window);

          const changedRepo = yield* Effect.flip(
            runAgentQuery(
              { ...pinned, selectors: { repo: [`${repo}/another-worktree`] } },
              { store: opened.agentService }
            )
          );

          const widenedRepo = yield* Effect.flip(
            runAgentQuery(
              { ...pinned, selectors: { repo: ["(all)"] } },
              { store: opened.agentService }
            )
          );

          const changedWorktree = yield* Effect.flip(
            runAgentQuery(
              {
                ...pinned,
                selectors: { repo: [repo], worktree: ["/reused/fixture/path"] },
              },
              { store: opened.agentService }
            )
          );

          for (const rejected of [changedRepo, widenedRepo, changedWorktree]) {
            expect(rejected._tag).toBe("AgentError");

            if (Predicate.isTagged(rejected, "AgentError")) {
              expect(rejected.code).toBe("basis-incompatible");
            }
          }
        })
      )
  );
  it.effect(
    "charges noncanonical header bytes before admitting another decode",
    () =>
      withStore((opened) =>
        Effect.gen(function* admittedHeaderBudget() {
          yield* append(opened, [
            event("header-source"),
            event("header-source-two"),
          ]);
          const request = input();

          const first = yield* runAgentQuery(
            {
              ...request,
              agent: {
                ...request.agent,
                budget: { ...request.agent.budget, maxItems: 1 },
              },
            },
            {
              now: () => "2026-10-02T12:00:00.000Z",
              store: opened.agentService,
            }
          );

          const identity = yield* opened.agentService.identity;

          const cursor = yield* opened.agentService.getCursor({
            ...identity,
            id: first.view.nextCursor ?? "",
          });

          const metadata = yield* opened.agentService.getBasisMetadata({
            ...identity,
            id: first.result.basisId,
          });

          const basisHeader = JSON.stringify(metadata, null, 2);
          const resultHeader = JSON.stringify(first.result, null, 2);
          const cursorBody = JSON.stringify(cursor, null, 2);
          const basisBytes = Buffer.byteLength(basisHeader);
          const resultBytes = Buffer.byteLength(resultHeader);
          const cursorBytes = Buffer.byteLength(cursorBody);
          const offeredResultBytes = yield* Ref.make<number | null>(null);
          const decodedResultHeaders = yield* Ref.make(0);
          const pagesRead = yield* Ref.make(0);

          const measuredStore: AgentStoreService = {
            ...opened.agentService,
            readBasisMetadata: (_handle, maxDecodedBytes) =>
              Effect.succeed(
                maxDecodedBytes < basisBytes
                  ? { decodedBytes: 0, factsExamined: 1, metadata: null }
                  : {
                      decodedBytes: basisBytes,
                      factsExamined: 1,
                      metadata: decodeFixtureBasisHeader(basisHeader),
                    }
              ),
            readCursor: (_handle, maxDecodedBytes) =>
              Effect.succeed(
                maxDecodedBytes < cursorBytes
                  ? { cursor: null, decodedBytes: 0, factsExamined: 1 }
                  : {
                      cursor: decodeFixtureCursor(cursorBody),
                      decodedBytes: cursorBytes,
                      factsExamined: 1,
                    }
              ),
            readMatchingResultMetadata: (
              _basis,
              _capability,
              _digest,
              maxDecodedBytes
            ) =>
              Effect.gen(function* readFixtureResultHeader() {
                yield* Ref.set(offeredResultBytes, maxDecodedBytes);

                if (maxDecodedBytes < resultBytes) {
                  return { decodedBytes: 0, factsExamined: 1, metadata: null };
                }

                yield* Ref.update(decodedResultHeaders, (count) => count + 1);

                return {
                  decodedBytes: resultBytes,
                  factsExamined: 1,
                  metadata: decodeFixtureResultHeader(resultHeader),
                };
              }),
            readResultPage: (handle, pageInput) =>
              Ref.update(pagesRead, (count) => count + 1).pipe(
                Effect.andThen(
                  opened.agentService.readResultPage(handle, pageInput)
                )
              ),
          };

          const maxDecodedBytes =
            Buffer.byteLength(JSON.stringify(identity)) +
            cursorBytes +
            basisBytes +
            resultBytes -
            1;

          const exhausted = yield* Effect.flip(
            runAgentQuery(
              {
                ...request,
                agent: {
                  ...request.agent,
                  basisId: first.result.basisId,
                  budget: { ...request.agent.budget, maxDecodedBytes },
                },
                cursor: cursor.id,
              },
              { store: measuredStore }
            )
          );

          expect(basisBytes).toBeGreaterThan(
            Buffer.byteLength(JSON.stringify(metadata))
          );
          expect(yield* Ref.get(offeredResultBytes)).toBe(resultBytes - 1);
          expect(yield* Ref.get(decodedResultHeaders)).toBe(0);
          expect(yield* Ref.get(pagesRead)).toBe(0);
          expect(exhausted._tag).toBe("AgentError");

          if (Predicate.isTagged(exhausted, "AgentError")) {
            expect(exhausted.code).toBe("budget-exhausted");
          }
        })
      )
  );
  it.effect(
    "rejects new detail under an unsupported captured reconciliation policy",
    () =>
      withStore((opened) =>
        Effect.gen(function* policyDrift() {
          yield* append(opened, [event("policy-source")]);
          const request = input();

          const initial = yield* runAgentQuery(request, {
            now: () => "2026-10-02T12:00:00.000Z",
            store: opened.agentService,
          });

          const identity = yield* opened.agentService.identity;

          const retained = yield* opened.agentService.getBasis({
            ...identity,
            id: initial.result.basisId,
          });

          const historical = {
            ...retained,
            id: "fixture-historical-policy",
            reconciliationVersion: "fixture-unsupported-policy",
          };

          yield* opened.agentService.putBasis(historical);

          const unavailable = yield* Effect.flip(
            runAgentQuery(
              {
                agent: { ...request.agent, basisId: historical.id },
                capability: "dx_explain",
                selectors: {},
              },
              { store: opened.agentService }
            )
          );

          expect(unavailable._tag).toBe("AgentError");

          if (Predicate.isTagged(unavailable, "AgentError")) {
            expect(unavailable.code).toBe("basis-incompatible");
          }
        })
      )
  );
  it.effect(
    "bounds series and stacks independently while preserving full totals",
    () =>
      withStore((opened) =>
        Effect.gen(function* seriesBounds() {
          const cursor = event("cursor-series");

          const codex = event("codex-series", {
            ai: cursor.ai === null ? null : { ...cursor.ai, harness: "codex" },
          });

          const nextDay = event("next-day", {
            observedAt: "2026-10-03T10:00:00.000Z",
            occurredAt: "2026-10-03T10:00:00.000Z",
          });

          yield* append(opened, [cursor, codex, nextDay]);
          const request = input();

          const result = yield* runAgentQuery(
            {
              ...request,
              agent: {
                ...request.agent,
                budget: {
                  ...request.agent.budget,
                  maxSeriesBuckets: 1,
                  maxStacks: 1,
                },
              },
            },
            {
              now: () => "2026-10-04T12:00:00.000Z",
              store: opened.agentService,
            }
          );

          const bucket = seriesOf(result.view.series[0]);
          expect(result.context.completeness.aggregation).toBe("complete");
          expect(summaryOf(result.view.summary).total.values.requests).toBe(3);
          expect(result.context.completeness.series).toBe("truncated");
          expect(result.view.series).toHaveLength(1);
          expect(bucket.stacks).toHaveLength(1);
          expect(bucket.omittedStacks).toBe(1);
          expect(bucket.values.requests).toBe(2);
          expect(result.view.nextSeriesCursor).not.toBeNull();
        })
      )
  );
  it.effect(
    "keeps window, branch, worktree and prices across midnight and concurrent imports",
    () =>
      withStore((opened) =>
        Effect.gen(function* pinnedReplay() {
          yield* append(opened, [event("first"), event("second")]);
          const request = input();

          const first = yield* runAgentQuery(
            {
              ...request,
              agent: {
                ...request.agent,
                budget: { ...request.agent.budget, maxItems: 1 },
              },
            },
            {
              costOptions: options(1, "one"),
              now: () => "2026-10-02T23:59:00.000Z",
              store: opened.agentService,
            }
          );

          expect(first.context.completeness.aggregation).toBe("complete");
          expect(first.context.completeness.items).toBe("truncated");
          expect(first.view.nextCursor).not.toBeNull();
          yield* append(opened, [
            event("later", {
              observedAt: "2026-10-03T02:00:00.000Z",
              occurredAt: "2026-10-03T02:00:00.000Z",
            }),
          ]);

          const second = yield* runAgentQuery(
            {
              ...request,
              agent: {
                ...request.agent,
                basisId: first.result.basisId,
                detail: "summary",
              },
              cursor: first.view.nextCursor ?? "",
            },
            {
              costOptions: options(100, "two"),
              defaultScope: {
                branchSelection: { branches: ["renamed"], kind: "current" },
                flightId: null,
                repoId: repo,
                resolution: "current renamed/reused fixture path",
                sources: [],
                tools: [],
                worktreeId: "/reused/path",
              },
              now: () => "2026-10-03T03:00:00.000Z",
              store: opened.agentService,
            }
          );

          expect(second.result.resultDigest).toBe(first.result.resultDigest);
          expect(second.context.window).toEqual(first.context.window);
          expect(second.context.scope).toEqual(first.context.scope);
          expect(
            summaryOf(second.view.summary).total.values.estimate
          ).toBeCloseTo(0.0022);
          expect(second.context.effects.networkRequests).toBe(0);
          expect(second.context.effects.basisWrites).toBe(0);
          expect(second.context.resources.factsExamined).toBeLessThanOrEqual(
            request.agent.budget.maxFacts
          );
          expect(second.context.resources.outputBytes).toBe(
            Buffer.byteLength(JSON.stringify(second))
          );
        })
      )
  );

  it.effect(
    "marks input exhaustion partial and restarts the pinned watermark with a bounded continuation",
    () =>
      withStore((opened) =>
        Effect.gen(function* partialAggregation() {
          yield* append(opened, [
            event("one"),
            event("two"),
            event("three"),
            event("four"),
          ]);
          const request = input();

          const partial = yield* runAgentQuery(
            {
              ...request,
              agent: {
                ...request.agent,
                budget: { ...request.agent.budget, maxFacts: 2 },
              },
            },
            {
              now: () => "2026-10-02T12:00:00.000Z",
              store: opened.agentService,
            }
          );

          expect(partial.context.completeness.aggregation).toBe("partial");
          expect(summaryOf(partial.view.summary).aggregation).toBe("partial");
          expect(partial.context.resources.factsExamined).toBeLessThanOrEqual(
            2
          );
          const identity = yield* opened.agentService.identity;

          const cursor = yield* opened.agentService.getCursor({
            ...identity,
            id: partial.context.resources.continuation ?? "",
          });

          expect(cursor.axis).toBe("work");
          yield* append(opened, [event("after-watermark")]);

          const complete = yield* runAgentQuery(
            { ...request, cursor: cursor.id },
            {
              now: () => "2026-10-02T13:00:00.000Z",
              store: opened.agentService,
            }
          );

          expect(complete.context.completeness.aggregation).toBe("complete");
          expect(complete.result.resultDigest).not.toBe(
            partial.result.resultDigest
          );
          expect(summaryOf(complete.view.summary).total.values.requests).toBe(
            4
          );
          expect(complete.context.window).toEqual(partial.context.window);
        })
      )
  );

  it.effect(
    "tracks every missing and withheld reference under the same basis",
    () =>
      withStore((opened) =>
        Effect.gen(function* references() {
          yield* append(opened, [event("known")]);
          const request = input();

          const initial = yield* runAgentQuery(request, {
            now: () => "2026-10-02T12:00:00.000Z",
            store: opened.agentService,
          });

          const known = yield* ref(
            opened.agentService,
            initial.result.basisId,
            "known"
          );

          const missing = { ...known, id: "missing" };

          const evidence = yield* runAgentQuery(
            {
              agent: { ...request.agent, basisId: initial.result.basisId },
              capability: "dx_evidence",
              refs: [known, missing],
              selectors: { evidenceMode: ["hidden"] },
            },
            { store: opened.agentService }
          );

          expect(
            evidence.resolutions.map((resolution) => resolution.state)
          ).toEqual(["withheld", "missing-in-basis"]);
          expect(evidence.context.completeness.missingRefs).toBe(2);
          expect(evidence.view.disclosures.join(" ")).toContain(
            "Every requested reference"
          );

          const changedWindow = yield* Effect.flip(
            runAgentQuery(
              {
                ...request,
                agent: { ...request.agent, basisId: initial.result.basisId },
                selectors: { ...request.selectors, since: ["30d"] },
              },
              { store: opened.agentService }
            )
          );

          expect(changedWindow._tag).toBe("AgentError");
        })
      )
  );

  it.effect(
    "reports fallback price changes and rejects arithmetic across changed windows",
    () =>
      withStore((opened) =>
        Effect.gen(function* comparison() {
          yield* append(opened, [event("known")]);
          const request = input();

          const first = yield* runAgentQuery(request, {
            costOptions: options(1, "one"),
            now: () => "2026-10-02T12:00:00.000Z",
            store: opened.agentService,
          });

          const second = yield* runAgentQuery(
            {
              ...request,
              agent: {
                ...request.agent,
                previousBasisId: first.result.basisId,
              },
            },
            {
              costOptions: options(2, "two"),
              now: () => "2026-10-02T12:00:00.000Z",
              store: opened.agentService,
            }
          );

          expect(second.difference?.changes).toContain("prices");
          const identity = yield* opened.agentService.identity;

          const basis = yield* opened.agentService.getBasisMetadata({
            ...identity,
            id: first.result.basisId,
          });

          const different = compareAgentBases(basis, {
            ...basis,
            id: "different-window",
            window: {
              ...basis.window,
              untilExclusive: "2026-10-02T13:00:00.000Z",
            },
          });

          expect(different.comparable).toBe(false);
          expect(different.changes).toContain("window");
        })
      )
  );

  it.effect("keeps legacy snapshot reproduction explicitly weaker", () =>
    Effect.gen(function* legacySnapshot() {
      const store = makeFakeEventStore();
      yield* store.append({
        coverage: emptyCoverage("fixture"),
        cursor: null,
        events: [event("legacy")],
      });
      yield* store.putSnapshotManifest(fakeManifest("legacy-snapshot"));

      const selected = yield* selectAnalyzeSnapshot(store, {
        asOf: null,
        selector: emptySelector,
        snapshotId: fakeManifest("legacy-snapshot").snapshotId,
      });

      expect(selected.snapshot.events[0]?.context.branch).toBe("feature/x");
      expect(selected.disclosures.join(" ")).toContain(
        "evidence-selection-only"
      );
    })
  );
});

describe("S02 reconciliation provenance", () => {
  it.effect(
    "explains session token suppression and each observed model cost partition",
    () =>
      Effect.sync(() => {
        const source = event("session-cost");

        const session = event("session-cost", {
          ai:
            source.ai === null
              ? null
              : {
                  ...source.ai,
                  model: null,
                  modelRaw: null,
                  provider: "unknown",
                },
          identity: { ...emptyEventIdentity, sessionId: "session-fixture" },
          kind: "ai.session",
          payload: {
            costState: {
              models: {
                "claude-sonnet-5": { costUsd: 2 },
                "gpt-6.1-sol": { costUsd: 1 },
              },
            },
          },
          usage: {
            premiumRequests: null,
            requestKey: null,
            serviceTier: null,
            speed: null,
            tokens: { ...unknownTokens, inputFresh: 1000 },
            toolFigure: { amount: 3, currency: "USD", kind: "api-equivalent" },
            webSearchRequests: null,
          },
        });

        const derived = deriveAgentUsageRows([session]);
        expect(derived.derived.rows).toHaveLength(2);

        for (const explanation of derived.explanations) {
          const tokens = explanation.fields.find(
            (field) => field.field === "tokens.inputFresh"
          );

          const model = explanation.fields.find(
            (field) => field.field === "model"
          );

          const amount = explanation.fields.find(
            (field) => field.field === "toolFigure.amount"
          );

          expect(tokens?.value).toBeNull();
          expect(tokens?.winnerEventId).toBeNull();
          expect(tokens?.rule).toBe(
            "session-money-ledger-excludes-request-tokens"
          );
          expect(model?.semantics).toBe("reconciled");
          expect(model?.winnerEventId).toBe("session-cost");
          expect(amount?.candidates[0]?.value).toBe(amount?.value);
          expect(amount?.value).not.toBe(3);
        }
      })
  );
  it.effect(
    "keeps an atomic token winner and disagreeing candidates from the same channel",
    () =>
      Effect.sync(() => {
        const preferred = event("preferred", {
          identity: {
            ...emptyEventIdentity,
            requestId: "same",
            sessionId: "session-fixture",
          },
          usage: {
            ...event("preferred").usage,
            premiumRequests: null,
            requestKey: "same",
            serviceTier: null,
            speed: null,
            tokens: { ...unknownTokens, inputFresh: 1000 },
            toolFigure: null,
            webSearchRequests: null,
          },
        });

        const fallback = event("fallback", {
          identity: preferred.identity,
          usage: {
            ...preferred.usage,
            premiumRequests: null,
            requestKey: "same",
            serviceTier: null,
            speed: null,
            tokens: { ...unknownTokens, output: 90 },
            toolFigure: null,
            webSearchRequests: null,
          },
        });

        const derived = deriveAgentUsageRows([fallback, preferred]);
        expect(derived.derived.rows[0]?.fact.tokens.output).toBeNull();

        const explained = derived.explanations[0]?.fields.find(
          (field) => field.field === "tokens.output"
        );

        expect(explained?.winnerEventId).toBe("preferred");
        expect(
          explained?.candidates.map((candidate) => candidate.eventId).toSorted()
        ).toEqual(["fallback", "preferred"]);
      })
  );

  it.effect(
    "keeps equal timing candidates provisional and the observed account charge unexplained",
    () =>
      Effect.sync(() => {
        const turn = event("turn-one");
        const other = event("turn-two");

        const account = event("account", {
          ai:
            turn.ai === null
              ? null
              : {
                  ...turn.ai,
                  branchSource: "unassigned",
                  channel: "usage-api",
                },
          context: emptyFlightContext,
          identity: { ...emptyEventIdentity, sessionId: "session-fixture" },
          occurredAt: "2026-10-02T10:00:01.000Z",
          usage: {
            premiumRequests: null,
            requestKey: null,
            serviceTier: null,
            speed: null,
            tokens: unknownTokens,
            toolFigure: { amount: 2, currency: "USD", kind: "charge" },
            webSearchRequests: null,
          },
        });

        const events = [turn, other, account];
        const derived = deriveAgentUsageRows(events);
        expect(derived.associations[0]?.semantics).toBe("provisional");
        expect(derived.associations[0]?.selectedTurnFactId).toBeNull();
        expect(derived.associations[0]?.candidates).toHaveLength(2);
        expect(
          derived.accountLedger.remainder.map((entry) => entry.eventId)
        ).toEqual(["account"]);
        expect(
          derived.derived.rows.filter((row) => row.fact.scope === "request")
        ).toHaveLength(2);
        expect(deriveAgentUsageRows(events.toReversed())).toEqual(derived);
      })
  );
});
