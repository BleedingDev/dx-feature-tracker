import type { ModelRates } from "../price-table.js";
import type { ModelPriceVersion, PriceSheet } from "./sheet.js";

export const MAKER_SHEET_READ_AT = "2026-10-01";

export const DEEPSEEK_PEAK_CARD_FROM = "2026-08-16T16:00:00.000Z";

const DEEPSEEK_V4_1_FLASH_FROM = "2026-09-10T04:00:00.000Z";

type Rates = readonly [
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number | null,
];

type MakerRow = readonly [
  model: string,
  versions: readonly (readonly [effectiveFrom: string | null, rates: Rates])[],
];

const ratesOf = ([
  input,
  output,
  cacheRead,
  cacheWrite,
]: Rates): ModelRates => ({
  "cache-write": cacheWrite,
  "cached-input": cacheRead,
  input,
  output,
});

const DEEPSEEK_FLASH: MakerRow[1] = [
  [null, [0.14, 0.28, 0.0028, null]],
  [DEEPSEEK_PEAK_CARD_FROM, [0.22, 0.66, 0.007, null]],
  [DEEPSEEK_V4_1_FLASH_FROM, [0.15, 0.6, 0.003, null]],
];

const ROWS: readonly MakerRow[] = [
  ["claude-haiku-3-5", [[null, [0.8, 4, 0.08, 1]]]],
  ["claude-opus-4", [[null, [15, 75, 1.5, 18.75]]]],
  ["claude-opus-4-1", [[null, [15, 75, 1.5, 18.75]]]],
  ["claude-sonnet-4", [[null, [3, 15, 0.3, 3.75]]]],
  ["deepseek-flash", DEEPSEEK_FLASH],
  ["deepseek-v4-flash", DEEPSEEK_FLASH],
  [
    "deepseek-v4-pro",
    [
      [null, [0.435, 0.87, 0.003625, null]],
      [DEEPSEEK_PEAK_CARD_FROM, [0.66, 1.98, 0.022, null]],
    ],
  ],
];

const versionsOf = (row: MakerRow): ModelPriceVersion[] =>
  row[1].map(([effectiveFrom, rates]) => ({
    effectiveFrom,
    rates: ratesOf(rates),
  }));

export const makerSheet = (): PriceSheet => ({
  id: "maker",
  models: Object.fromEntries(ROWS.map((row) => [row[0], versionsOf(row)])),
  source: `maker pricing pages read ${MAKER_SHEET_READ_AT} for models the public catalog lacks or misprices: platform.claude.com/docs/en/about-claude/pricing (retired Claude 4 and 3.5 models) and api-docs.deepseek.com/quick_start/pricing (DeepSeek V4-Pro and Flash off-peak rates; the flat V4 rates before the peak/off-peak card of ${DEEPSEEK_PEAK_CARD_FROM}, the V4-Flash card until V4.1-Flash on ${DEEPSEEK_V4_1_FLASH_FROM}, from the DeepSeek change log and press coverage)`,
  version: MAKER_SHEET_READ_AT,
});
