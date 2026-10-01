// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B39 fixture and opens a temporary SQLite store.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Console, Effect, Option, Schema } from "effect";

import {
  dxAnalyzeContract,
  dxEvidenceContract,
  dxExplainContract,
  dxStatusContract,
} from "../../src/dx/contracts/capabilities.js";
import { EventStore } from "../../src/dx/contracts/event-store.js";
import { fakeDescriptor } from "../../src/dx/contracts/fakes.js";
import type {
  DxMetric,
  EventStoreService,
} from "../../src/dx/contracts/services.js";
import { CONTRACT_VERSION } from "../../src/dx/contracts/version.js";
import { handleAnalyze } from "../../src/dx/mcp/handlers/analyze.js";
import { makeDxQueryCapabilities } from "../../src/dx/mcp/handlers/capabilities.js";
import type { DxHandlerDeps } from "../../src/dx/mcp/handlers/deps.js";
import { handleEvidence } from "../../src/dx/mcp/handlers/evidence.js";
import { handleExplain } from "../../src/dx/mcp/handlers/explain.js";
import { parseQuery } from "../../src/dx/mcp/handlers/selector.js";
import { handleStatus } from "../../src/dx/mcp/handlers/status.js";
import { isolateStdout } from "../../src/dx/mcp/handlers/stdio.js";
import { DxEventEnvelopeSchema } from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  EvidenceIdSchema,
  FlightIdSchema,
  MetricIdSchema,
} from "../../src/dx/model/ids.js";
import {
  AnalyzeReportSchema,
  ExplainTimelineSchema,
  StatusReportSchema,
} from "../../src/dx/model/report.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";

const FixtureEventSchema = Schema.Struct({
  adapterId: Schema.String,
  eventId: Schema.String,
  hash: Schema.String,
  kind: Schema.String,
  occurredAt: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  ref: Schema.String,
});

const FixtureSchema = Schema.Struct({
  branch: Schema.String,
  events: Schema.Array(FixtureEventSchema),
  fixtureId: Schema.String,
  flightId: Schema.String,
  late: FixtureEventSchema,
  repoCommonDir: Schema.String,
});

const fixture = Schema.decodeUnknownSync(FixtureSchema)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures/b39/events.json"),
      "utf-8"
    )
  )
);

const toEnvelope = (raw: typeof FixtureEventSchema.Type): DxEventEnvelope =>
  Schema.decodeUnknownSync(DxEventEnvelopeSchema)({
    acquisition: "file-import",
    adapterId: raw.adapterId,
    adapterVersion: "0.0.0-fixture",
    ai: null,
    context: {
      branch: fixture.branch,
      flightId: fixture.flightId,
      headSha: null,
      repoCommonDir: fixture.repoCommonDir,
      worktreePath: null,
    },
    eventId: raw.eventId,
    evidence: { bounded: true, hash: raw.hash, ref: raw.ref },
    fieldSemantics: [],
    identity: {
      commitSha: null,
      generationId: null,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: null,
      sessionId: null,
      turnId: null,
    },
    kind: raw.kind,
    observedAt: raw.occurredAt,
    occurredAt: raw.occurredAt,
    occurredAtPrecision: "exact",
    origin: "fixture",
    payload: raw.payload,
    schemaVersion: "dx.event.v2",
    sourceVersion: null,
    upstreamKey: raw.eventId,
    usage: null,
  });

const batchOf = (events: readonly DxEventEnvelope[]) => ({
  coverage: {
    adapterId: "b39-fixture",
    expectedItems: null,
    gaps: [],
    observedItems: events.length,
    state: "complete" as const,
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events,
});

const decodeTokens = Schema.decodeUnknownOption(
  Schema.Struct({ inputTokens: Schema.Finite })
);

const inputTokensMetric: DxMetric = {
  compute: (snapshot) => {
    const usage = snapshot.events.filter((e) => e.kind === "ai.usage");

    const total = usage.reduce(
      (sum, e) =>
        sum +
        Option.match(decodeTokens(e.payload), {
          onNone: () => 0,
          onSome: (tokens) => tokens.inputTokens,
        }),
      0
    );

    return {
      findings: [],
      results: [
        {
          asOf: snapshot.manifest.createdAt,
          attribution: "not-applicable",
          checkpoint: null,
          coverage: [],
          definition: {
            description: "fixture input tokens",
            id: MetricIdSchema.make("b39.input-tokens"),
            unit: "tokens",
            version: "1",
          },
          denominator: null,
          evidenceIds: usage.map((e) => EvidenceIdSchema.make(e.eventId)),
          measurement: usage.length === 0 ? "unavailable" : "measured",
          method: "source-reported",
          metricId: MetricIdSchema.make("b39.input-tokens"),
          numerator: null,
          reason: usage.length === 0 ? "no ai.usage events" : null,
          unit: "tokens",
          value: usage.length === 0 ? null : total,
        },
      ],
    };
  },
  definitions: [
    {
      description: "fixture input tokens",
      id: MetricIdSchema.make("b39.input-tokens"),
      unit: "tokens",
      version: "1",
    },
  ],
  descriptor: fakeDescriptor("metric/b39-fixture", "metric", "B39"),
};

const throwingMetric: DxMetric = {
  compute: () => {
    throw new Error("boom");
  },
  definitions: [],
  descriptor: fakeDescriptor("metric/b39-throws", "metric", "B39"),
};

const deps: DxHandlerDeps = {
  descriptors: [
    { ...inputTokensMetric.descriptor, readiness: "ready" },
    { ...throwingMetric.descriptor, readiness: "disabled" },
  ],
  metrics: [inputTokensMetric, throwingMetric],
};

const root = mkdtempSync(path.join(os.tmpdir(), "dft-b39-"));

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const withStore = <A, E>(
  name: string,
  use: (store: EventStoreService) => Effect.Effect<A, E, EventStore>
) =>
  Effect.acquireUseRelease(
    openSqliteEventStore({ kind: "live", path: path.join(root, name) }),
    (opened) =>
      Effect.provideService(use(opened.service), EventStore, opened.service),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  );

const flightInput = { flight: fixture.flightId };

describe("B39 MCP query handlers", () => {
  it.effect("analyze persists a snapshot that explain and evidence reuse", () =>
    withStore("reuse.sqlite", (store) =>
      Effect.gen(function* b39Case1() {
        yield* store.append(batchOf(fixture.events.map(toEnvelope)));
        const report = yield* handleAnalyze(deps, flightInput);
        expect(Schema.is(AnalyzeReportSchema)(report)).toBe(true);
        const { snapshotId } = report.snapshot;
        expect(report.flightId).toBe(FlightIdSchema.make(fixture.flightId));
        expect(report.snapshot.enabledDescriptors.map((d) => d.id)).toEqual([
          "metric/b39-fixture",
        ]);
        expect(report.snapshot.metricDefinitions).toEqual([
          { id: "b39.input-tokens", version: "1" },
        ]);

        const tokens = report.metrics.find(
          (m) => m.metricId === "b39.input-tokens"
        );

        expect(tokens?.value).toBe(1200);
        expect(
          report.notes.some((n) => n.includes("metric/b39-throws failed"))
        ).toBe(true);
        expect(
          report.notes.some((n) =>
            n.includes(`Persisted snapshot metadata ${snapshotId}`)
          )
        ).toBe(true);
        expect(yield* store.snapshotCount).toBe(1);

        yield* store.append(batchOf([toEnvelope(fixture.late)]));

        const timeline = yield* handleExplain(deps, { snapshotId });
        expect(Schema.is(ExplainTimelineSchema)(timeline)).toBe(true);
        expect(timeline.snapshotId).toBe(snapshotId);
        expect(timeline.total).toBe(2);

        const evidence = yield* handleEvidence(deps, {
          evidenceIds: ["b39-evt-usage", "b39-evt-late"],
          snapshotId,
        });

        expect(evidence.items.map((i) => i.evidenceId)).toEqual([
          "b39-evt-usage",
        ]);
        expect(JSON.stringify(evidence.items)).not.toContain(
          "must never be echoed"
        );

        const pinned = yield* handleAnalyze(deps, { snapshotId });
        expect(pinned.snapshot.snapshotId).toBe(snapshotId);
        expect(
          pinned.metrics.find((m) => m.metricId === "b39.input-tokens")?.value
        ).toBe(1200);
      })
    )
  );

  it.effect(
    "latest analyze returns a new snapshotId and discloses changed evidence",
    () =>
      withStore("latest.sqlite", (store) =>
        Effect.gen(function* b39Case2() {
          yield* store.append(batchOf(fixture.events.map(toEnvelope)));
          const first = yield* handleAnalyze(deps, flightInput);
          yield* store.append(batchOf([toEnvelope(fixture.late)]));
          const second = yield* handleAnalyze(deps, flightInput);
          expect(second.snapshot.snapshotId).not.toBe(
            first.snapshot.snapshotId
          );
          expect(
            second.notes.some((n) =>
              n.includes(
                `analyzed latest snapshot ${second.snapshot.snapshotId}`
              )
            )
          ).toBe(true);
          expect(
            second.notes.some((n) =>
              n.includes(
                `Evidence changed since previous snapshot ${first.snapshot.snapshotId}`
              )
            )
          ).toBe(true);
          const again = yield* handleAnalyze(deps, flightInput);
          expect(again.snapshot.snapshotId).toBe(second.snapshot.snapshotId);
          expect(yield* store.snapshotCount).toBe(2);
        })
      )
  );

  it.effect("read-only analyze computes the report without storing it", () =>
    withStore("read-only.sqlite", (store) =>
      Effect.gen(function* b39ReadOnly() {
        yield* store.append(batchOf(fixture.events.map(toEnvelope)));
        const readOnly = { ...deps, persistSnapshots: false };
        const report = yield* handleAnalyze(readOnly, flightInput);
        yield* handleAnalyze(readOnly, flightInput);

        expect(
          report.metrics.find((m) => m.metricId === "b39.input-tokens")?.value
        ).toBe(1200);
        expect(
          report.notes.some((n) => n.startsWith("Persisted snapshot metadata"))
        ).toBe(false);
        expect(yield* store.snapshotCount).toBe(0);
      })
    )
  );

  it.effect(
    "unknown snapshot fails explicitly and never substitutes latest",
    () =>
      withStore("unknown.sqlite", (store) =>
        Effect.gen(function* b39Case3() {
          yield* store.append(batchOf(fixture.events.map(toEnvelope)));

          const analyze = yield* Effect.flip(
            handleAnalyze(deps, { snapshotId: "missing-snapshot" })
          );

          expect(analyze._tag).toBe("SnapshotNotFound");

          const explain = yield* Effect.flip(
            handleExplain(deps, { snapshotId: "missing-snapshot" })
          );

          expect(explain._tag).toBe("SnapshotNotFound");

          const evidence = yield* Effect.flip(
            handleEvidence(deps, {
              evidenceIds: ["b39-evt-usage"],
              snapshotId: "missing-snapshot",
            })
          );

          expect(evidence._tag).toBe("SnapshotNotFound");
          expect(yield* store.snapshotCount).toBe(0);
        })
      )
  );

  it.effect(
    "input validation rejects bad asOf, conflicting selectors and empty evidence",
    () =>
      Effect.gen(function* b39Case4() {
        const badAsOf = yield* Effect.flip(parseQuery({ asOf: "yesterday" }));
        expect(badAsOf.field).toBe("asOf");

        const both = yield* Effect.flip(
          parseQuery({ asOf: "2026-09-30T12:00:00Z", snapshotId: "x" })
        );

        expect(both.field).toBe("asOf");
        const blank = yield* Effect.flip(parseQuery({ flight: "  " }));
        expect(blank.field).toBe("flight");

        const empty = yield* Effect.flip(
          withStore("empty.sqlite", () =>
            handleEvidence(deps, { evidenceIds: [] })
          )
        );

        expect(empty._tag).toBe("InvalidInput");
      })
  );

  it.effect(
    "status lists descriptors including disabled ones and store facts",
    () =>
      withStore("status.sqlite", () =>
        Effect.gen(function* b39Case5() {
          const status = yield* handleStatus(deps);
          expect(Schema.is(StatusReportSchema)(status)).toBe(true);
          expect(status.contractVersion).toBe(CONTRACT_VERSION);
          expect(status.snapshotCount).toBe(0);
          expect(status.storePath).toContain("status.sqlite");
          expect(
            status.descriptors.map((d) => `${d.id}:${d.readiness}`)
          ).toEqual(["metric/b39-fixture:ready", "metric/b39-throws:disabled"]);
        })
      )
  );

  it.effect(
    "capabilities bind the frozen contracts and keep stdout clean",
    () =>
      withStore("caps.sqlite", (store) =>
        Effect.gen(function* b39Case6() {
          yield* store.append(batchOf(fixture.events.map(toEnvelope)));
          const caps = makeDxQueryCapabilities(deps);
          expect(caps.map((c) => c.contract)).toEqual([
            dxStatusContract,
            dxAnalyzeContract,
            dxExplainContract,
            dxEvidenceContract,
          ]);
          const writes: string[] = [];
          const original = process.stdout.write.bind(process.stdout);
          const errWrite = process.stderr.write.bind(process.stderr);
          process.stdout.write = (chunk: string | Uint8Array) => {
            writes.push(String(chunk));

            return true;
          };

          process.stderr.write = () => true;

          try {
            yield* isolateStdout(
              Console.log("diagnostic that must not hit stdout")
            );
            const [status, analyze, explain, evidence] = caps;
            yield* status.handler({});
            const report = yield* analyze.handler({ flight: fixture.flightId });
            yield* explain.handler({ snapshotId: report.snapshot.snapshotId });
            yield* evidence.handler({
              evidenceIds: ["b39-evt-commit"],
              snapshotId: report.snapshot.snapshotId,
            });
          } finally {
            process.stdout.write = original;
            process.stderr.write = errWrite;
          }

          expect(writes).toEqual([]);
        })
      )
  );
});
