import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { EventStore } from "../../src/dx/contracts/event-store.js";
import { FakeEventStoreLayer } from "../../src/dx/contracts/fakes.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope, EventBatch } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { SqliteEventStoreLayer } from "../../src/dx/storage/sqlite-event-store.js";
import { runUsageQuery } from "../../src/dx/usage/capability.js";
import type { DxUsageInputType } from "../../src/dx/usage/contract.js";
import { usageOfRows } from "../../src/dx/usage/derive.js";
import type { DerivedRows, UsageFact } from "../../src/dx/usage/fact.js";
import { deriveRowsOf } from "../../src/dx/usage/load.js";
import { UsageFactStore } from "../../src/dx/usage/store.js";

interface Spec {
  readonly at: string | null;
  readonly id: string;
  readonly kind?: DxEventEnvelope["kind"];
  readonly parent?: string;
  readonly replaces?: string;
  readonly requestId?: string | null;
  readonly session: string | null;
  readonly figure?: number;
  readonly harness?: "claude-code" | "codex";
  readonly branch?: string;
}

const event = (spec: Spec): DxEventEnvelope => {
  const requestId =
    spec.requestId === undefined ? `req-${spec.id}` : spec.requestId;

  const harness = spec.harness ?? "claude-code";

  return {
    acquisition: "file-import",
    adapterId: `harness.${harness}`,
    adapterVersion: "fixture",
    ai: {
      agentId: null,
      agentType: null,
      branchSource: "harness-recorded",
      channel: spec.session === null ? "usage-api" : "session-file",
      cwd: null,
      effort: null,
      effortSource: null,
      harness,
      harnessVersion: null,
      model: "fixture-model",
      modelRaw: "fixture-model",
      parentSessionId: spec.parent ?? null,
      provider: "anthropic",
      sessionId: spec.session,
      via: null,
    },
    context: {
      ...emptyFlightContext,
      branch: spec.branch ?? "main",
      repoCommonDir: "/fixture/app/.git",
      worktreePath: "/fixture/app",
    },
    eventId: EventIdSchema.make(spec.id),
    evidence: { bounded: true, hash: null, ref: `fixture:${spec.id}` },
    fieldSemantics: [],
    identity: { ...emptyEventIdentity, requestId, sessionId: spec.session },
    kind: spec.kind ?? "ai.usage",
    observedAt: spec.at ?? "2026-09-30T00:00:00.000Z",
    occurredAt: spec.at,
    occurredAtPrecision: "exact",
    origin: "fixture",
    payload:
      spec.replaces === undefined ? {} : { replacesRequestKey: spec.replaces },
    schemaVersion: "dx.event.v2",
    sourceVersion: null,
    upstreamKey: spec.id,
    usage: {
      premiumRequests: null,
      requestKey: requestId,
      serviceTier: null,
      speed: null,
      tokens:
        spec.figure === undefined
          ? { ...unknownTokens, total: 100 }
          : unknownTokens,
      toolFigure:
        spec.figure === undefined
          ? null
          : { amount: spec.figure, currency: "USD", kind: "api-equivalent" },
    },
  };
};

const batchOf = (events: readonly DxEventEnvelope[]): EventBatch => ({
  coverage: {
    adapterId: "harness.claude-code",
    expectedItems: null,
    gaps: [],
    observedItems: events.length,
    state: "complete",
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events,
});

const day = (n: number, hour = 10): string =>
  `2026-09-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

const EVERYTHING = {
  branch: null,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
} as const;

const sqliteAt = (file: string, batchEvents: number) =>
  UsageFactStore.sqlite(file, { batchEvents }).pipe(
    Layer.provideMerge(SqliteEventStoreLayer({ kind: "live", path: file }))
  );

const tempFile = Effect.gen(function* tempStore() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();

  return path.join(dir, "dft.db");
}).pipe(Effect.provide(NodeServices.layer));

const ledgerOf = (facts: readonly UsageFact[]) =>
  facts
    .map((fact) => ({
      branch: fact.branch,
      factId: fact.factId,
      requests: fact.requests,
      session: fact.session,
      tokens: fact.tokens.total,
      toolFigure: fact.toolFigure?.amount ?? null,
    }))
    .toSorted((a, b) => a.factId.localeCompare(b.factId));

const tracked = (calls: string[][]) => ({
  derive: (events: readonly DxEventEnvelope[]): Effect.Effect<DerivedRows> => {
    calls.push(events.map((item) => item.eventId).toSorted());

    return deriveRowsOf(events);
  },
  everything: Effect.succeed([]),
});

const expectMatchesFullDerivation = Effect.gen(function* matches() {
  const store = yield* EventStore;
  const usage = yield* UsageFactStore;
  const all = (yield* store.snapshot(EVERYTHING)).events;
  const whole = usageOfRows(yield* deriveRowsOf(all));

  const stored = yield* usage.select({
    filters: {},
    sinceMs: null,
    untilMs: null,
  });

  const summary = yield* usage.summary;

  expect(ledgerOf(stored)).toStrictEqual(ledgerOf(whole.facts));
  expect(summary.facts).toBe(whole.facts.length);
  expect(summary.unresolved).toBe(whole.unresolved);
});

const parent = [
  event({ at: day(1), id: "a1", session: "A" }),
  event({ at: day(1, 11), id: "a2", session: "A" }),
];

const child = [
  event({ at: day(1, 12), id: "b1", parent: "A", session: "B" }),
  event({ at: day(1, 13), id: "b2", parent: "A", session: "B" }),
];

const other = [
  event({ at: day(2), id: "c1", session: "C" }),
  event({ at: day(2, 11), id: "c2", session: "C" }),
  event({ at: day(2, 12), id: "c3", requestId: "req-c1", session: null }),
];

describe("usage facts refresh incrementally", () => {
  it.effect(
    "re-derives only the sessions that new events touch and matches a full derivation",
    () =>
      Effect.gen(function* incremental() {
        const file = yield* tempFile;

        yield* Effect.gen(function* run() {
          const store = yield* EventStore;
          const usage = yield* UsageFactStore;
          const calls: string[][] = [];
          const refresh = usage.refresh(tracked(calls));

          yield* store.append(batchOf([...parent, ...child, ...other]));
          yield* refresh;
          yield* expectMatchesFullDerivation;

          expect(calls.flat().toSorted()).toStrictEqual(
            [...parent, ...child, ...other].map((e) => e.eventId).toSorted()
          );

          calls.length = 0;
          yield* refresh;

          expect(calls).toStrictEqual([]);

          yield* store.append(
            batchOf([event({ at: day(3), id: "c4", session: "C" })])
          );
          yield* refresh;
          yield* expectMatchesFullDerivation;

          expect(calls).toStrictEqual([["c1", "c2", "c3", "c4"]]);

          calls.length = 0;

          yield* store.append(
            batchOf([
              event({ at: day(3, 11), id: "b3", parent: "A", session: "B" }),
            ])
          );
          yield* refresh;
          yield* expectMatchesFullDerivation;

          expect(calls).toStrictEqual([["a1", "a2", "b1", "b2", "b3"]]);

          calls.length = 0;

          yield* store.append(
            batchOf([
              event({
                at: day(3, 12),
                id: "c2-again",
                replaces: "req-c2",
                requestId: "req-c2",
                session: "C",
              }),
              event({ at: day(3, 13), id: "join", parent: "A", session: "C" }),
            ])
          );
          yield* refresh;
          yield* expectMatchesFullDerivation;

          expect(calls).toHaveLength(1);
          expect(calls[0]).toContain("a1");
          expect(calls[0]).toContain("c1");

          calls.length = 0;

          yield* store.append({
            ...batchOf([]),
            replace: {
              adapterId: "harness.claude-code",
              fromOccurredAt: day(3),
            },
          });
          yield* refresh;
          yield* expectMatchesFullDerivation;

          expect(calls).toHaveLength(1);
        }).pipe(Effect.provide(sqliteAt(file, 3)));
      }).pipe(Effect.scoped)
  );

  it.effect(
    "derives a large store in bounded batches and refreshes one session cheaply",
    () =>
      Effect.gen(function* bounded() {
        const file = yield* tempFile;
        const sessions = 400;
        const perSession = 25;
        const batch = 1000;

        yield* Effect.gen(function* run() {
          const store = yield* EventStore;
          const usage = yield* UsageFactStore;
          const calls: string[][] = [];

          const events = Array.from({ length: sessions }, (_, session) =>
            Array.from({ length: perSession }, (__, index) =>
              event({
                at: day(1 + (session % 20), index % 24),
                id: `s${String(session)}-${String(index)}`,
                session: `session-${String(session)}`,
              })
            )
          ).flat();

          yield* store.append(batchOf(events));
          yield* usage.refresh(tracked(calls));

          expect(calls.length).toBeGreaterThanOrEqual(
            (sessions * perSession) / batch
          );
          expect(
            Math.max(...calls.map((ids) => ids.length))
          ).toBeLessThanOrEqual(batch);
          expect((yield* usage.summary).facts).toBe(sessions * perSession);

          calls.length = 0;

          yield* store.append(
            batchOf([event({ at: day(25), id: "late", session: "session-7" })])
          );
          yield* usage.refresh(tracked(calls));

          expect(calls.map((ids) => ids.length)).toStrictEqual([
            perSession + 1,
          ]);
          expect((yield* usage.summary).facts).toBe(sessions * perSession + 1);
        }).pipe(Effect.provide(sqliteAt(file, batch)));
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );
});

const windowed: readonly DxUsageInputType[] = [
  { tz: "UTC" },
  { groupBy: "branch", tz: "UTC" },
  { since: day(2), tz: "UTC", until: day(4) },
  { groupBy: "branch", since: day(3), tz: "UTC" },
  { since: day(5), tz: "UTC" },
  { groupBy: "tool", tool: ["codex"], tz: "UTC" },
  { branch: ["feature/x"], groupBy: "day", tz: "UTC" },
  { branch: ["(none)"], tz: "UTC" },
  { since: day(1), tool: ["claude-code"], tz: "UTC", until: day(2) },
];

const mixed: readonly DxEventEnvelope[] = [
  event({ at: day(1), id: "f1", session: "F" }),
  event({ at: day(3), branch: "feature/x", id: "f2", session: "F" }),
  event({
    at: day(4),
    figure: 0.5,
    id: "f-figure",
    kind: "ai.session",
    session: "F",
  }),
  event({ at: day(1), id: "g1", session: "G" }),
  event({
    at: day(6),
    figure: 0.25,
    id: "g-figure",
    kind: "ai.session",
    session: "G",
  }),
  event({ at: day(2), harness: "codex", id: "h1", session: "H" }),
  event({ at: day(5), harness: "codex", id: "h2", session: "H" }),
  event({ at: null, id: "untimed", session: "U" }),
  event({
    at: day(3),
    figure: 0.1,
    id: "lone-figure",
    kind: "ai.session",
    session: "L",
  }),
];

const answersOf = Effect.all(
  windowed.map((input) =>
    Effect.map(runUsageQuery(input), (output) => ({
      coverage: { ...output.coverage, derivedAt: null },
      groups: output.groups,
      notes: output.notes,
      other: output.other,
      series: output.series,
      total: output.total,
      unattributed: output.unattributed,
    }))
  )
);

describe("usage queries read only the facts they need", () => {
  it.effect(
    "answers windows and filters from the store exactly as from every fact",
    () =>
      Effect.gen(function* narrowed() {
        const file = yield* tempFile;

        const fromStore = yield* Effect.gen(function* stored() {
          const store = yield* EventStore;
          const usage = yield* UsageFactStore;

          yield* store.append(batchOf(mixed));

          const answers = yield* answersOf;

          const late = yield* usage.select({
            filters: { tool: ["codex"] },
            sinceMs: Date.parse(day(5)),
            untilMs: null,
          });

          expect(late.map((fact) => fact.factId).length).toBeLessThan(
            (yield* usage.summary).facts
          );

          return answers;
        }).pipe(Effect.provide(sqliteAt(file, 4)));

        const fromMemory = yield* Effect.gen(function* inMemory() {
          const store = yield* EventStore;

          yield* store.append(batchOf(mixed));

          return yield* answersOf;
        }).pipe(
          Effect.provide(
            Layer.merge(FakeEventStoreLayer, UsageFactStore.memory)
          )
        );

        expect(fromStore).toStrictEqual(fromMemory);
      }).pipe(Effect.scoped)
  );
});
