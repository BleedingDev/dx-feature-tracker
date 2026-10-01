import { Schema } from "effect";

export const OMP_STATS_TOTALS_SQL =
  "SELECT session_file AS sessionFile, COUNT(*) AS rows, SUM(total_tokens) AS tokens, SUM(cost_total) AS cost FROM messages GROUP BY session_file";

export const OmpStatsTotalSchema = Schema.Struct({
  cost: Schema.NullOr(Schema.Finite),
  rows: Schema.Finite,
  sessionFile: Schema.String,
  tokens: Schema.NullOr(Schema.Finite),
});

export type OmpStatsTotal = typeof OmpStatsTotalSchema.Type;

export type OmpStatsTotals = ReadonlyMap<string, OmpStatsTotal>;

export const statsTotalsByFile = (
  rows: readonly OmpStatsTotal[]
): OmpStatsTotals => new Map(rows.map((row) => [row.sessionFile, row]));

export interface StatsComparison {
  readonly fileRows: number;
  readonly fileTokens: number;
  readonly statsRows: number;
  readonly statsTokens: number;
}

export const statsMismatch = (
  stats: OmpStatsTotal | undefined,
  fileRows: number,
  fileTokens: number
): StatsComparison | null => {
  if (stats === undefined) {
    return null;
  }

  const statsTokens = stats.tokens ?? 0;

  return stats.rows === fileRows && statsTokens === fileTokens
    ? null
    : { fileRows, fileTokens, statsRows: stats.rows, statsTokens };
};
