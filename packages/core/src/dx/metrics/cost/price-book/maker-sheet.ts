import type { ModelRates } from "../price-table.js";
import type { PriceSheet } from "./sheet.js";

export const MAKER_SHEET_READ_AT = "2026-10-01";

type MakerRow = readonly [
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number | null,
];

const ROWS: readonly MakerRow[] = [
  ["claude-haiku-3-5", 0.8, 4, 0.08, 1],
  ["claude-opus-4", 15, 75, 1.5, 18.75],
  ["claude-opus-4-1", 15, 75, 1.5, 18.75],
  ["claude-sonnet-4", 3, 15, 0.3, 3.75],
  ["deepseek-v4-pro", 0.66, 1.98, 0.022, null],
];

const ratesOf = ([
  ,
  input,
  output,
  cacheRead,
  cacheWrite,
]: MakerRow): ModelRates => ({
  "cache-write": cacheWrite,
  "cached-input": cacheRead,
  input,
  output,
});

export const makerSheet = (): PriceSheet => ({
  id: "maker",
  models: Object.fromEntries(
    ROWS.map((row) => [row[0], [{ effectiveFrom: null, rates: ratesOf(row) }]])
  ),
  source: `maker pricing pages read ${MAKER_SHEET_READ_AT} for models the public catalog lacks or misprices: platform.claude.com/docs/en/about-claude/pricing (retired Claude 4 and 3.5 models) and api-docs.deepseek.com/quick_start/pricing (DeepSeek-V4-Pro-0813 off-peak rates)`,
  version: MAKER_SHEET_READ_AT,
});
