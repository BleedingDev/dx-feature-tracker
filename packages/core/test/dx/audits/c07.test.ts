// @effect-diagnostics nodeBuiltinImport:off -- This audit reads committed fixtures and opens throwaway SQLite files in an owned temp directory.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type {
  EventStoreService,
  MetricOutput,
  StoreSnapshot,
} from "../../../src/dx/contracts/services.js";
import { aiUsageMetric } from "../../../src/dx/metrics/ai-usage/metric.js";
import { costMetric } from "../../../src/dx/metrics/cost/metric.js";
import { frictionMetric } from "../../../src/dx/metrics/friction/metric.js";
import { gitChurnMetric } from "../../../src/dx/metrics/git/metric.js";
import { provenanceMetric } from "../../../src/dx/metrics/provenance/metric.js";
import { EventBatchSchema } from "../../../src/dx/model/event.js";
import type { EventBatch } from "../../../src/dx/model/event.js";
import { SnapshotIdSchema } from "../../../src/dx/model/ids.js";
import type { AnalyzeReport } from "../../../src/dx/model/report.js";
import {
  AnalyzeReportSchema,
  ExplainTimelineSchema,
} from "../../../src/dx/model/report.js";
import type { SnapshotSelector } from "../../../src/dx/model/snapshot.js";
import { composeAnalyzeReport } from "../../../src/dx/reports/analyze/compose.js";
import { selectAnalyzeSnapshot } from "../../../src/dx/reports/analyze/select.js";
import {
  lookupEvidence,
  resolveEvidence,
} from "../../../src/dx/reports/evidence/resolve.js";
import { explainTimeline } from "../../../src/dx/reports/explain/explain.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";

const fixturesRoot = path.join(import.meta.dirname, "..", "fixtures");

const decodeFixture = <S extends Schema.Top>(
  schema: S & { readonly DecodingServices: never },
  parts: readonly string[]
): S["Type"] =>
  Schema.decodeUnknownSync(schema)(
    JSON.parse(readFileSync(path.join(fixturesRoot, ...parts), "utf-8"))
  );

const BatchDocSchema = Schema.Struct({
  batches: Schema.Array(EventBatchSchema),
  fixtureId: Schema.String,
});

const OUT_OF_SCOPE_ADAPTERS = new Set(["github-actions"]);

const loadBatches = (
  parts: readonly string[],
  skip: ReadonlySet<string> = OUT_OF_SCOPE_ADAPTERS
): EventBatch[] =>
  decodeFixture(BatchDocSchema, parts)
    .batches.filter((b) => !skip.has(b.coverage.adapterId))
    .map((b) => ({
      ...b,
      events: b.events.filter((e) => !OUT_OF_SCOPE_ADAPTERS.has(e.adapterId)),
    }));

const GoldenSchema = Schema.Struct({
  branch: Schema.String,
  eventIds: Schema.Array(Schema.String),
  lanes: Schema.Array(Schema.String),
  metrics: Schema.Array(
    Schema.Struct({
      evidenceCount: Schema.Int,
      measurement: Schema.String,
      method: Schema.String,
      metricId: Schema.String,
      reasoned: Schema.Boolean,
      value: Schema.NullOr(Schema.Finite),
    })
  ),
  unavailableCoverage: Schema.Array(Schema.String),
});

const golden = decodeFixture(GoldenSchema, ["c07", "golden-analyze.json"]);

const baseBatches = [
  ...loadBatches(["core", "core-golden-flight.json"]),
  ...loadBatches(["c07", "branch-extras.json"]),
  ...loadBatches(
    ["core", "core-unavailable-sources.json"],
    new Set([...OUT_OF_SCOPE_ADAPTERS, "cursor-usage-csv"])
  ),
];

const lateBatches = loadBatches(["c07", "late-collect.json"]);

const selector: SnapshotSelector = {
  branch: golden.branch,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
};

const METRICS = [
  aiUsageMetric,
  costMetric,
  frictionMetric,
  gitChurnMetric,
  provenanceMetric,
];

const computeAll = (snapshot: StoreSnapshot): MetricOutput[] =>
  METRICS.map((m) => m.compute(snapshot));

const NULL_STATES = new Set([
  "unavailable",
  "unsupported",
  "disabled",
  "partial",
]);

const MUST_BE_MEASURED = {
  "dx.ai-usage.tokens.cached-input": 800,
  "dx.ai-usage.tokens.input": 1200,
  "dx.ai-usage.tokens.output": 350,
  "dx.friction.test-failures": 1,
  "dx.friction.test-runs": 2,
  "dx.git.commits": 2,
  "dx.git.lines-added": 48,
  "dx.git.lines-deleted": 8,
} as const satisfies Readonly<Record<string, number>>;

const project = (report: AnalyzeReport) => ({
  metrics: report.metrics
    .map((m) => ({
      evidenceCount: m.evidenceIds.length,
      measurement: m.measurement,
      method: m.method,
      metricId: String(m.metricId),
      reasoned: m.reason !== null && m.reason !== "",
      value: m.value,
    }))
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  unavailableCoverage: report.coverage
    .filter((c) => c.state !== "complete")
    .map((c) => `${c.adapterId}:${c.state}`)
    .toSorted(),
});

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "dft-c07-"));

afterAll(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

const withStore = <A, E>(
  body: (store: EventStoreService) => Effect.Effect<A, E>
) =>
  Effect.gen(function* c07Store() {
    const opened = yield* openSqliteEventStore({
      kind: "replay",
      path: path.join(tempRoot, `c07-${randomUUID()}.sqlite`),
    });

    try {
      return yield* body(opened.service);
    } finally {
      opened.close();
    }
  });

const appendAll = (store: EventStoreService, batches: readonly EventBatch[]) =>
  Effect.forEach(batches, (b) => store.append(b), { discard: true });

const analyze = (store: EventStoreService) =>
  Effect.gen(function* c07Analyze() {
    const live = yield* store.snapshot(selector);

    yield* store.putSnapshotManifest(live.manifest);

    const selected = yield* selectAnalyzeSnapshot(store, {
      asOf: null,
      selector,
      snapshotId: live.manifest.snapshotId,
    });

    return composeAnalyzeReport(
      selected.snapshot,
      computeAll(selected.snapshot),
      selected.disclosures
    );
  });

describe("c07 golden analyze", () => {
  it.effect("matches the committed golden projection for the branch", () =>
    withStore((store) =>
      Effect.gen(function* c07Golden() {
        yield* appendAll(store, baseBatches);

        const report = yield* analyze(store);

        yield* Schema.decodeEffect(AnalyzeReportSchema)(report);

        const snapshot = yield* store.getSnapshot(report.snapshot.snapshotId);

        expect(
          snapshot.events.map((e) => String(e.eventId)).toSorted()
        ).toEqual([...golden.eventIds].toSorted());

        const byId = new Map(
          report.metrics.map((m) => [String(m.metricId), m])
        );

        for (const [id, value] of Object.entries(MUST_BE_MEASURED)) {
          expect(byId.get(id)?.value, id).toBe(value);
        }

        expect(project(report).metrics).toEqual(golden.metrics);

        expect(project(report).unavailableCoverage).toEqual(
          golden.unavailableCoverage
        );
      })
    )
  );

  it.effect("is identical under reversed and duplicated appends", () =>
    Effect.gen(function* c07Determinism() {
      const first = yield* withStore((store) =>
        Effect.gen(function* c07A() {
          yield* appendAll(store, baseBatches);

          return yield* analyze(store);
        })
      );

      const second = yield* withStore((store) =>
        Effect.gen(function* c07B() {
          const reversed = baseBatches.toReversed();

          yield* appendAll(store, [...reversed, ...reversed]);

          return yield* analyze(store);
        })
      );

      expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);

      expect(second.metrics).toEqual(first.metrics);
    })
  );
});

describe("c07 unavailable fields stay visible", () => {
  it.effect(
    "null metrics carry a non-value state and a reason; no zeros for missing sources",
    () =>
      withStore((store) =>
        Effect.gen(function* c07Unavailable() {
          yield* appendAll(store, baseBatches);

          const report = yield* analyze(store);

          for (const m of report.metrics) {
            if (m.value === null) {
              expect(NULL_STATES.has(m.measurement), m.metricId).toBe(true);

              expect(m.reason ?? "", m.metricId).not.toBe("");
            }

            if (
              m.measurement === "unavailable" ||
              m.measurement === "unsupported" ||
              m.measurement === "disabled"
            ) {
              expect(m.value, m.metricId).toBeNull();
            }

            if (m.method === "estimated" && m.value !== null) {
              expect(m.measurement, m.metricId).not.toBe("measured");
            }
          }

          const charge = report.metrics.filter((m) =>
            /charge/u.test(m.metricId)
          );

          expect(charge.length).toBeGreaterThan(0);

          for (const m of charge) {
            expect(m.value, m.metricId).toBeNull();
          }

          const notes = report.notes.join("\n");

          for (const entry of golden.unavailableCoverage) {
            const [adapterId] = entry.split(":");

            expect(notes).toContain(adapterId ?? "");
          }
        })
      )
  );
});

describe("c07 evidence joins", () => {
  it.effect(
    "every metric/finding/timeline evidence ID resolves in the same snapshot",
    () =>
      withStore((store) =>
        Effect.gen(function* c07Joins() {
          yield* appendAll(store, baseBatches);

          const report = yield* analyze(store);

          const snapshot = yield* store.getSnapshot(report.snapshot.snapshotId);

          const explained = yield* explainTimeline(store, {
            asOf: null,
            cursor: null,
            limit: 500,
            selector,
            snapshotId: report.snapshot.snapshotId,
          });

          yield* Schema.decodeEffect(ExplainTimelineSchema)(explained.timeline);

          expect(explained.timeline.snapshotId).toBe(
            report.snapshot.snapshotId
          );

          expect(explained.timeline.lanes).toEqual(golden.lanes);

          expect(explained.timeline.total).toBe(golden.eventIds.length);

          const ids = [
            ...report.metrics.flatMap((m) => m.evidenceIds),
            ...report.findings.flatMap((f) => f.evidenceIds),
            ...explained.timeline.entries.flatMap((e) => e.evidenceIds),
          ].map(String);

          const unique = [...new Set(ids)];

          expect(unique.length).toBeGreaterThan(0);

          for (let i = 0; i < unique.length; i += 100) {
            const resolved = resolveEvidence(
              snapshot,
              unique.slice(i, i + 100)
            );

            expect(resolved.missing).toEqual([]);

            expect(resolved.snapshotId).toBe(report.snapshot.snapshotId);

            for (const item of resolved.items) {
              expect(item.excerpt ?? "").not.toMatch(/\/Users\/|\/home\//u);
            }
          }
        })
      )
  );
});

describe("c07 final audit: analyze, collect more, explain with the original snapshot", () => {
  it.effect(
    "pinned snapshot shows original facts; latest discloses the change",
    () =>
      withStore((store) =>
        Effect.gen(function* c07Final() {
          yield* appendAll(store, baseBatches);

          const report = yield* analyze(store);

          const original = report.snapshot.snapshotId;

          const lateId = String(lateBatches[0]?.events[0]?.eventId);

          yield* appendAll(store, lateBatches);

          const pinned = yield* explainTimeline(store, {
            asOf: null,
            cursor: null,
            limit: 500,
            selector,
            snapshotId: original,
          });

          expect(pinned.mode).toBe("pinned");

          expect(pinned.timeline.snapshotId).toBe(original);

          expect(pinned.timeline.total).toBe(golden.eventIds.length);

          expect(
            pinned.timeline.entries.map((e) => String(e.eventId))
          ).not.toContain(lateId);

          const pinnedEvidence = yield* lookupEvidence(store, {
            asOf: null,
            evidenceIds: [lateId, ...golden.eventIds.slice(0, 2)],
            selector,
            snapshotId: original,
          });

          expect(pinnedEvidence.snapshotId).toBe(original);

          expect(pinnedEvidence.items).toHaveLength(2);

          expect(pinnedEvidence.missing.map((m) => m.reason)).toEqual([
            "unknown-in-snapshot",
          ]);

          const again = yield* store.getSnapshot(original);

          expect(
            composeAnalyzeReport(again, computeAll(again)).metrics
          ).toEqual(report.metrics);

          const latest = yield* explainTimeline(store, {
            asOf: null,
            cursor: null,
            limit: 500,
            selector,
            snapshotId: null,
          });

          expect(latest.mode).toBe("latest");

          expect(latest.timeline.snapshotId).not.toBe(original);

          expect(
            latest.timeline.entries.map((e) => String(e.eventId))
          ).toContain(lateId);

          expect(latest.disclosures.join("\n")).toContain(
            latest.timeline.snapshotId
          );

          expect(latest.disclosures.join("\n")).toContain("Evidence changed");

          const missing = yield* Effect.flip(
            explainTimeline(store, {
              asOf: null,
              cursor: null,
              limit: 10,
              selector,
              snapshotId: SnapshotIdSchema.make("snap_c07_never_existed"),
            })
          );

          expect(missing._tag).toBe("SnapshotNotFound");

          const missingEvidence = yield* Effect.flip(
            lookupEvidence(store, {
              asOf: null,
              evidenceIds: [lateId],
              selector,
              snapshotId: SnapshotIdSchema.make("snap_c07_never_existed"),
            })
          );

          expect(missingEvidence._tag).toBe("SnapshotNotFound");
        })
      )
  );
});

export const c07ProjectForGolden = project;
