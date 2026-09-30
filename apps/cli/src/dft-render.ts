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
