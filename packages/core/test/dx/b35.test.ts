// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B35 fixture file from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  fakeManifest,
  makeFakeEventStore,
} from "../../src/dx/contracts/fakes.js";
import { ReportComposer } from "../../src/dx/contracts/report-composer.js";
import type {
  MetricOutput,
  StoreSnapshot,
} from "../../src/dx/contracts/services.js";
import {
  AttributionStateSchema,
  MeasurementStateSchema,
  OriginSchema,
  ValueMethodSchema,
} from "../../src/dx/model/common.js";
import { SourceGapSchema } from "../../src/dx/model/coverage.js";
import type { SourceCoverage } from "../../src/dx/model/coverage.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EvidenceIdSchema,
  FlightIdSchema,
  MetricIdSchema,
  SnapshotIdSchema,
} from "../../src/dx/model/ids.js";
import { isHonestMetric } from "../../src/dx/model/metric.js";
import type {
  FindingCandidate,
  MetricResult,
} from "../../src/dx/model/metric.js";
import { AnalyzeReportSchema } from "../../src/dx/model/report.js";
import { composeAnalyzeReport } from "../../src/dx/reports/analyze/compose.js";
import {
  analyzeReportDescriptor,
  ReportComposerLive,
} from "../../src/dx/reports/analyze/layer.js";
import { selectAnalyzeSnapshot } from "../../src/dx/reports/analyze/select.js";

const MetricSpecSchema = Schema.Struct({
  attribution: AttributionStateSchema,
  evidenceIds: Schema.Array(Schema.String),
  measurement: MeasurementStateSchema,
  method: ValueMethodSchema,
  metricId: Schema.String,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  unit: Schema.String,
  value: Schema.NullOr(Schema.Finite),
});

type MetricSpec = typeof MetricSpecSchema.Type;

const FindingSpecSchema = Schema.Struct({
  evidenceIds: Schema.Array(Schema.String),
  findingId: Schema.String,
  metricIds: Schema.Array(Schema.String),
  rank: Schema.Int,
  severity: Schema.Literals(["info", "low", "medium", "high"]),
  summary: Schema.String,
});

const FixtureSchema = Schema.Struct({
  dishonest: Schema.Array(MetricSpecSchema),
  fixtureId: Schema.String,
  origin: Schema.Literal("fixture"),
  originMix: Schema.Array(
    Schema.Struct({ count: Schema.Int, origin: OriginSchema })
  ),
  outputs: Schema.Array(
    Schema.Struct({
      findings: Schema.Array(FindingSpecSchema),
      results: Schema.Array(MetricSpecSchema),
    })
  ),
  selector: Schema.Struct({
    branch: Schema.String,
    flightId: Schema.String,
    repoCommonDir: Schema.String,
  }),
  snapshotCoverage: Schema.Array(
    Schema.Struct({
      adapterId: Schema.String,
      gaps: Schema.Array(SourceGapSchema),
      state: Schema.Literals(["complete", "partial", "none"]),
    })
  ),
});

const fixture = Schema.decodeUnknownSync(FixtureSchema)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures/b35/branch-metrics.json"),
      "utf-8"
    )
  )
);

const AS_OF = "2026-09-30T12:00:00.000Z";

const toMetric = (s: MetricSpec): MetricResult => ({
  asOf: AS_OF,
  attribution: s.attribution,
  checkpoint: null,
  coverage: [],
  definition: {
    description: s.metricId,
    id: MetricIdSchema.make(s.metricId),
    unit: s.unit,
    version: "1.0.0",
  },
  denominator: null,
  evidenceIds: s.evidenceIds.map((e) => EvidenceIdSchema.make(e)),
  measurement: s.measurement,
  method: s.method,
  metricId: MetricIdSchema.make(s.metricId),
  numerator: null,
  reason: s.reason ?? null,
  unit: s.unit,
  value: s.value,
});

const outputs: MetricOutput[] = fixture.outputs.map((o) => ({
  findings: o.findings.map((f): FindingCandidate => ({
    ...f,
    evidenceIds: f.evidenceIds.map((e) => EvidenceIdSchema.make(e)),
    experiment: null,
    metricIds: f.metricIds.map((m) => MetricIdSchema.make(m)),
  })),
  results: o.results.map(toMetric),
}));

const coverage: SourceCoverage[] = fixture.snapshotCoverage.map((c) => ({
  ...c,
  expectedItems: null,
  observedItems: null,
  watermark: null,
  windowFrom: null,
  windowTo: null,
}));

const snapshot: StoreSnapshot = {
  coverage,
  events: [],
  manifest: {
    ...fakeManifest("snap-b35", {
      branch: fixture.selector.branch,
      flightId: FlightIdSchema.make(fixture.selector.flightId),
      from: null,
      repoCommonDir: fixture.selector.repoCommonDir,
      to: null,
    }),
    eventWatermark: "12",
    originMix: fixture.originMix,
  },
};

const encode = Schema.encodeSync(AnalyzeReportSchema);

describe("B35 analyze report composer", () => {
  it("produces a schema-valid report for a branch", () => {
    const report = composeAnalyzeReport(snapshot, outputs);
    expect(() => encode(report)).not.toThrow();
    expect(report.flightId).toBe("flight-b35");
    expect(report.snapshot.snapshotId).toBe("snap-b35");
    expect(report.metrics.map((m) => m.metricId)).toStrictEqual([
      "ai.cost.charge",
      "ai.cost.list-price-estimate",
      "ai.tokens.input",
      "ai.tokens.output",
      "ai.tokens.reasoning",
      "ai.tool-calls",
      "branch.time.active",
      "git.commits",
    ]);
    expect(report.metrics.every(isHonestMetric)).toBe(true);
    expect(report.findings.map((f) => f.findingId)).toStrictEqual([
      "f-test-failures",
      "f-cost-estimate-only",
    ]);
  });

  it("never recomputes metric values", () => {
    const report = composeAnalyzeReport(snapshot, outputs);
    const input = outputs.flatMap((o) => o.results);

    for (const m of report.metrics) {
      const original = input.find((i) => i.metricId === m.metricId);
      expect(m.value).toBe(original?.value);
    }
  });

  it("is deterministic under permutation and duplication", () => {
    const base = composeAnalyzeReport(snapshot, outputs);

    const permuted = composeAnalyzeReport(
      { ...snapshot, coverage: coverage.toReversed() },
      [
        ...outputs.toReversed().map((o) => ({
          findings: o.findings.toReversed(),
          results: o.results.toReversed(),
        })),
        outputs[0] ?? { findings: [], results: [] },
      ]
    );

    expect(JSON.stringify(permuted)).toBe(JSON.stringify(base));
  });

  it("discloses fixture origin, coverage gaps, unavailable and estimated values", () => {
    const { notes } = composeAnalyzeReport(snapshot, outputs);
    expect(notes).toContain(
      "Snapshot includes 12 fixture event(s); these are not live evidence."
    );
    expect(notes).toContain(
      "Source cursor-local-db coverage partial (gaps: no-cost)."
    );
    expect(notes).toContain(
      "Metric ai.tokens.reasoning unavailable: Cursor hooks do not report reasoning tokens."
    );
    expect(notes).toContain(
      "Metric ai.cost.list-price-estimate is an estimate (method estimated), not a source-reported value."
    );
    expect(notes).toContain(
      "Finding f-test-failures references metric(s) absent from this report: git.tests.failures."
    );
    expect(notes.some((n) => n.includes("branch=feature/demo"))).toBe(true);
  });

  it("repairs dishonest producer output without inventing numbers", () => {
    const report = composeAnalyzeReport(snapshot, [
      { findings: [], results: fixture.dishonest.map(toMetric) },
    ]);

    const byId = new Map<string, MetricResult>(
      report.metrics.map((m) => [m.metricId, m])
    );

    expect(byId.get("bad.no-reason")?.measurement).toBe("unavailable");
    expect(byId.get("bad.no-reason")?.reason).not.toBeNull();
    expect(byId.get("bad.value-when-unavailable")?.value).toBeNull();
    expect(byId.get("bad.estimate-as-measured")?.measurement).toBe("estimated");
    expect(byId.get("bad.estimate-as-measured")?.value).toBe(1.5);
    expect(report.metrics.every(isHonestMetric)).toBe(true);
  });

  it("keeps conflicting results visible instead of summing", () => {
    const first = outputs[0]?.results[0];
    expect(first).toBeDefined();

    if (first === undefined) {
      return;
    }

    const report = composeAnalyzeReport(snapshot, [
      { findings: [], results: [first, { ...first, value: 99 }] },
    ]);

    expect(report.metrics.map((m) => m.value)).toStrictEqual([12_000, 99]);
    expect(report.notes).toContain(
      "Metric ai.tokens.input has 2 conflicting results; all are kept and none is summed."
    );
  });

  it("reports an empty analysis explicitly", () => {
    const report = composeAnalyzeReport(snapshot, []);
    expect(report.metrics).toStrictEqual([]);
    expect(report.notes).toContain(
      "No metric outputs were supplied; nothing was computed."
    );
  });

  it("exposes a ready report descriptor", () => {
    expect(() =>
      Schema.decodeSync(ModuleDescriptorSchema)(analyzeReportDescriptor)
    ).not.toThrow();
    expect(analyzeReportDescriptor.readiness).toBe("ready");
    expect(analyzeReportDescriptor.kind).toBe("report");
  });

  it.effect("provides ReportComposer through the live layer", () =>
    Effect.gen(function* providesLayer() {
      const composer = yield* ReportComposer;
      const report = composer.analyze(snapshot, outputs);
      expect(report.metrics).toHaveLength(8);
    }).pipe(Effect.provide(ReportComposerLive))
  );

  it.effect("fails explicitly for an unknown pinned snapshot", () =>
    Effect.gen(function* unknownSnapshot() {
      const store = makeFakeEventStore();

      const error = yield* Effect.flip(
        selectAnalyzeSnapshot(store, {
          asOf: null,
          selector: snapshot.manifest.selector,
          snapshotId: SnapshotIdSchema.make("missing"),
        })
      );

      expect(error._tag).toBe("SnapshotNotFound");
    })
  );

  it.effect("reuses a pinned snapshot and discloses latest selection", () =>
    Effect.gen(function* pinnedAndLatest() {
      const store = makeFakeEventStore();
      yield* store.putSnapshotManifest(snapshot.manifest);

      const pinned = yield* selectAnalyzeSnapshot(store, {
        asOf: null,
        selector: snapshot.manifest.selector,
        snapshotId: SnapshotIdSchema.make("snap-b35"),
      });

      expect(pinned.mode).toBe("pinned");
      expect(pinned.snapshot.manifest.snapshotId).toBe("snap-b35");

      const latest = yield* selectAnalyzeSnapshot(store, {
        asOf: null,
        selector: snapshot.manifest.selector,
        snapshotId: null,
      });

      expect(latest.mode).toBe("latest");
      expect(latest.snapshot.manifest.snapshotId).toBe("fake-current");
      expect(latest.disclosures).toContain(
        "Evidence changed since previous snapshot snap-b35 (watermark 12 -> 0)."
      );

      const report = composeAnalyzeReport(
        latest.snapshot,
        [],
        latest.disclosures
      );

      expect(report.notes[0]).toBe(
        "No snapshotId requested; analyzed latest snapshot fake-current."
      );
    })
  );
});
