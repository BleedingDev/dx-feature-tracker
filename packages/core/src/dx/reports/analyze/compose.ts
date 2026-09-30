import type {
  MetricOutput,
  ReportComposerService,
  StoreSnapshot,
} from "../../contracts/services.js";
import { SourceCoverageSchema } from "../../model/coverage.js";
import type { SourceCoverage } from "../../model/coverage.js";
import {
  FindingCandidateSchema,
  MetricResultSchema,
} from "../../model/metric.js";
import type { FindingCandidate, MetricResult } from "../../model/metric.js";
import type { AnalyzeReport } from "../../model/report.js";
import { REPORT_SCHEMA_VERSION } from "../../model/report.js";
import { canonicalKeyOf, compareText, uniqueByKey } from "./canonical.js";
import { metricKey, reviewMetric } from "./honesty.js";

const SEVERITY_ORDER: Readonly<Record<FindingCandidate["severity"], number>> = {
  high: 0,
  info: 3,
  low: 2,
  medium: 1,
};

const metricJson = canonicalKeyOf(MetricResultSchema);

const findingJson = canonicalKeyOf(FindingCandidateSchema);

const coverageJson = canonicalKeyOf(SourceCoverageSchema);

const NON_LIVE_ORIGINS = new Set(["fixture", "synthetic", "replay"]);

const sortedUnique = (items: readonly string[]): string[] =>
  [...new Set(items)].toSorted(compareText);

const compareMetrics = (a: MetricResult, b: MetricResult): number =>
  compareText(metricKey(a), metricKey(b)) ||
  compareText(a.definition.version, b.definition.version) ||
  compareText(metricJson(a), metricJson(b));

const compareFindings = (a: FindingCandidate, b: FindingCandidate): number =>
  a.rank - b.rank ||
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
  compareText(a.findingId, b.findingId) ||
  compareText(findingJson(a), findingJson(b));

const compareCoverage = (a: SourceCoverage, b: SourceCoverage): number =>
  compareText(a.adapterId, b.adapterId) ||
  compareText(a.state, b.state) ||
  compareText(coverageJson(a), coverageJson(b));

const selectorNotes = (snapshot: StoreSnapshot): string[] => {
  const { selector } = snapshot.manifest;

  const parts = [
    selector.repoCommonDir === null ? null : `repo=${selector.repoCommonDir}`,
    selector.branch === null ? null : `branch=${selector.branch}`,
    selector.flightId === null ? null : `flight=${selector.flightId}`,
    selector.from === null ? null : `from=${selector.from}`,
    selector.to === null ? null : `to=${selector.to}`,
  ].filter((p): p is string => p !== null);

  return [
    `Snapshot ${snapshot.manifest.snapshotId} at watermark ${snapshot.manifest.eventWatermark}; selector ${parts.length === 0 ? "unscoped" : parts.join(", ")}.`,
  ];
};

const originNotes = (snapshot: StoreSnapshot): string[] =>
  snapshot.manifest.originMix.flatMap((o) =>
    o.count > 0 && NON_LIVE_ORIGINS.has(o.origin)
      ? [
          `Snapshot includes ${o.count} ${o.origin} event(s); these are not live evidence.`,
        ]
      : []
  );

const coverageNotes = (coverage: readonly SourceCoverage[]): string[] =>
  coverage.flatMap((c) => {
    if (c.state === "complete") {
      return [];
    }

    const gaps = sortedUnique(c.gaps.map((g) => g.code));

    return [
      `Source ${c.adapterId} coverage ${c.state}${gaps.length === 0 ? "" : ` (gaps: ${gaps.join(", ")})`}.`,
    ];
  });

const metricStateNotes = (metrics: readonly MetricResult[]): string[] =>
  metrics.flatMap((m) => {
    const key = metricKey(m);

    if (m.value === null) {
      return [`Metric ${key} ${m.measurement}: ${m.reason ?? ""}`.trim()];
    }

    if (m.method === "estimated" || m.measurement === "estimated") {
      return [
        `Metric ${key} is an estimate (method ${m.method}), not a source-reported value.`,
      ];
    }

    if (m.measurement === "partial") {
      return [
        `Metric ${key} is partial${m.reason === null || m.reason === "" ? "." : `: ${m.reason}`}`,
      ];
    }

    return [];
  });

const conflictNotes = (metrics: readonly MetricResult[]): string[] => {
  const counts = new Map<string, number>();

  for (const m of metrics) {
    counts.set(metricKey(m), (counts.get(metricKey(m)) ?? 0) + 1);
  }

  return [...counts.entries()].flatMap(([key, n]) =>
    n > 1
      ? [
          `Metric ${key} has ${n} conflicting results; all are kept and none is summed.`,
        ]
      : []
  );
};

const findingNotes = (
  findings: readonly FindingCandidate[],
  metrics: readonly MetricResult[]
): string[] => {
  const known = new Set<string>(metrics.map((m) => m.metricId));

  return findings.flatMap((f) => {
    const missing = f.metricIds.filter((id) => !known.has(id));

    return missing.length === 0
      ? []
      : [
          `Finding ${f.findingId} references metric(s) absent from this report: ${sortedUnique(missing).join(", ")}.`,
        ];
  });
};

export const composeAnalyzeReport = (
  snapshot: StoreSnapshot,
  outputs: readonly MetricOutput[],
  disclosures: readonly string[] = []
): AnalyzeReport => {
  const reviewed = uniqueByKey(
    outputs.flatMap((o) => o.results),
    metricJson
  ).map(reviewMetric);

  const metrics = uniqueByKey(
    reviewed.map((r) => r.metric),
    metricJson
  ).toSorted(compareMetrics);

  const findings = uniqueByKey(
    outputs.flatMap((o) => o.findings),
    findingJson
  ).toSorted(compareFindings);

  const coverage = uniqueByKey(
    [...snapshot.coverage, ...metrics.flatMap((m) => m.coverage)],
    coverageJson
  ).toSorted(compareCoverage);

  const notes = [
    ...disclosures,
    ...selectorNotes(snapshot),
    ...sortedUnique(originNotes(snapshot)),
    ...(outputs.length === 0 || metrics.length === 0
      ? ["No metric outputs were supplied; nothing was computed."]
      : []),
    ...sortedUnique(coverageNotes(coverage)),
    ...sortedUnique(reviewed.flatMap((r) => r.notes)),
    ...sortedUnique(conflictNotes(metrics)),
    ...sortedUnique(metricStateNotes(metrics)),
    ...sortedUnique(findingNotes(findings, metrics)),
  ];

  return {
    coverage,
    findings,
    flightId: snapshot.manifest.selector.flightId,
    metrics,
    notes: [...new Set(notes)],
    schemaVersion: REPORT_SCHEMA_VERSION,
    snapshot: snapshot.manifest,
  };
};

export const analyzeReportComposer: ReportComposerService = {
  analyze: (snapshot, outputs) => composeAnalyzeReport(snapshot, outputs),
};
