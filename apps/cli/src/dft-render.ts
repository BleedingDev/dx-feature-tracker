import type { FlightHistoryRow, HistoryMeasure } from "@rat-stack/core/dx";

export const measureText = (measure: HistoryMeasure): string => {
  if (measure.value === null) {
    return `unavailable (${measure.reason ?? "no reason given"})`;
  }

  const label =
    measure.method === "estimated" || measure.measurement === "estimated"
      ? " [estimate, not a charge]"
      : "";

  return `${measure.value} ${measure.unit}${label}`;
};

export const moneyLines = (row: FlightHistoryRow): readonly string[] => [
  `  billed (usage export):     ${measureText(row.money.billed)}`,
  `  metered (Cursor-reported): ${measureText(row.money.metered)}`,
  `  estimate (source):         ${measureText(row.money.estimatedSource)}`,
  `  estimate (price table):    ${measureText(row.money.estimatedPriceTable)}`,
];

export const usageLines = (row: FlightHistoryRow): readonly string[] => [
  `  requests:    ${measureText(row.requests)}`,
  ...row.tokens.map(
    (token) =>
      `  tokens ${token.category.padEnd(12)} ${measureText(token.measure)}`
  ),
  `  agent time:  ${measureText(row.agentTime)}`,
  `  active time: ${measureText(row.activeTime)}`,
];

export const rowHeader = (row: FlightHistoryRow): string =>
  row.repoCommonDir === null
    ? `account (unattributed) last ${row.lastActivityAt ?? "unknown"}`
    : `${row.branch ?? "(no branch)"} [${row.status.value}] ${row.repoCommonDir} last ${row.lastActivityAt ?? "unknown"}`;

export const historyText = (rows: readonly FlightHistoryRow[]): string =>
  rows.length === 0
    ? "No flights with activity in the selected window."
    : rows
        .flatMap((row) => [
          rowHeader(row),
          ...moneyLines(row),
          ...usageLines(row),
        ])
        .join("\n");

export const ledgerValues = (row: FlightHistoryRow): readonly number[] =>
  [
    row.money.billed,
    row.money.metered,
    row.money.estimatedSource,
    row.money.estimatedPriceTable,
  ].flatMap((measure) => (measure.value === null ? [] : [measure.value]));

interface AnalyzeMetricLike {
  readonly measurement: string;
  readonly method: string;
  readonly metricId: string;
  readonly reason: string | null;
  readonly unit: string;
  readonly value: number | null;
}

interface AnalyzeLike {
  readonly metrics: readonly AnalyzeMetricLike[];
  readonly snapshot: { readonly selector: { readonly branch: string | null } };
}

const ANALYZE_LINES: readonly (readonly [string, string])[] = [
  ["branch age", "dx.flight.branch-age.ms"],
  ["agent time", "dx.flight.agent.ms"],
  ["active time", "dx.flight.active.ms"],
  ["commits", "dx.flight.commits"],
  ["requests", "dx.ai-usage.requests"],
  ["tokens input", "dx.ai-usage.tokens.input"],
  ["tokens cached-input", "dx.ai-usage.tokens.cached-input"],
  ["tokens cache-write", "dx.ai-usage.tokens.cache-write"],
  ["tokens output", "dx.ai-usage.tokens.output"],
  ["tokens reasoning", "dx.ai-usage.tokens.reasoning"],
  ["billed (charge)", "dx.cost.charge.usd"],
  ["metered (Cursor-reported)", "dx.cost.metered.usd"],
  ["estimate (source)", "dx.cost.list-price-estimate.source.usd"],
  ["estimate (price table)", "dx.cost.list-price-estimate.price-table.usd"],
];

const durationText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);

  return minutes < 60
    ? `${String(minutes)}m`
    : `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
};

const metricText = (metric: AnalyzeMetricLike | undefined): string => {
  if (metric === undefined) {
    return "unavailable (metric not computed)";
  }

  if (metric.value === null) {
    return `unavailable (${metric.reason ?? "no reason given"})`;
  }

  const estimate =
    metric.measurement === "estimated" ? " [estimate, not a charge]" : "";

  return metric.unit === "ms"
    ? durationText(metric.value)
    : `${String(metric.value)} ${metric.unit}${estimate}`;
};

export const analyzeText = (report: AnalyzeLike): string => {
  const byId = new Map(report.metrics.map((m) => [m.metricId, m]));

  return [
    `branch ${report.snapshot.selector.branch ?? "(all branches)"}`,
    ...ANALYZE_LINES.map(
      ([label, id]) => `  ${label.padEnd(26)} ${metricText(byId.get(id))}`
    ),
    "  (--json for the full report)",
  ].join("\n");
};
