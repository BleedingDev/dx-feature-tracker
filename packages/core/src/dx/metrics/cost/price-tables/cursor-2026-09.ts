import type { ModelRates, PriceTable } from "../price-table.js";
import { decodePriceTable } from "../price-table.js";

export const CURSOR_2026_09_SOURCE =
  "Cursor model list prices, https://cursor.com/docs/models and https://cursor.com/docs/account/pricing, read 2026-09-30. USD per million tokens, standard context, non-fast unless named, no regional uplift, no Cursor Token Rate. Reasoning is billed inside output tokens (reasoning is a subset of output), so its separate rate is 0. Auto has no fixed rate and is not listed.";

type ListedRates = readonly [
  input: number,
  cacheWrite: number | null,
  cacheRead: number,
  output: number,
];

interface ListedModel {
  readonly aliases: readonly string[];
  readonly name: string;
  readonly rates: ListedRates;
}

const listed = (
  name: string,
  rates: ListedRates,
  aliases: readonly string[] = []
): ListedModel => ({ aliases, name, rates });

const ANTHROPIC: readonly ListedModel[] = [
  listed("Claude 4 Sonnet", [3, 3.75, 0.3, 15], ["claude-sonnet-4"]),
  listed("Claude 4.5 Haiku", [1, 1.25, 0.1, 5], ["claude-haiku-4-5"]),
  listed("Claude 4.5 Opus", [5, 6.25, 0.5, 25], ["claude-opus-4-5"]),
  listed("Claude 4.5 Sonnet", [3, 3.75, 0.3, 15], ["claude-sonnet-4-5"]),
  listed("Claude 4.6 Opus", [5, 6.25, 0.5, 25], ["claude-opus-4-6"]),
  listed("Claude 4.6 Sonnet", [3, 3.75, 0.3, 15], ["claude-sonnet-4-6"]),
  listed("Claude 4.7 Opus", [5, 6.25, 0.5, 25], ["claude-opus-4-7"]),
  listed("Claude Opus 4.8", [5, 6.25, 0.5, 25], ["claude-opus-4-8"]),
  listed("Claude Opus 5", [5, 6.25, 0.5, 25], ["claude-opus-5"]),
  listed("Claude Opus 5.5", [4, 5, 0.2, 20], ["claude-opus-5-5"]),
  listed("Claude Sonnet 5", [2, 2.5, 0.2, 10], ["claude-sonnet-5"]),
  listed("Claude Sonnet 5.5", [2, 2.5, 0.2, 10], ["claude-sonnet-5-5"]),
  listed("Claude Fable 5", [10, 12.5, 1, 50], ["claude-fable-5"]),
  listed("Claude Fable 5.1", [10, 12.5, 0.25, 50], ["claude-fable-5-1"]),
];

const OPENAI: readonly ListedModel[] = [
  listed("GPT-5", [1.25, null, 0.125, 10], ["gpt-5-high", "gpt-5-low"]),
  listed(
    "GPT-5 Fast",
    [2.5, null, 0.25, 20],
    ["gpt-5-high-fast", "gpt-5-low-fast"]
  ),
  listed("GPT-5 Mini", [0.25, null, 0.025, 2]),
  listed("GPT-5-Codex", [1.25, null, 0.125, 10]),
  listed("GPT-5.1 Codex", [1.25, null, 0.125, 10]),
  listed("GPT-5.1 Codex Max", [1.25, null, 0.125, 10]),
  listed("GPT-5.1 Codex Mini", [0.25, null, 0.025, 2]),
  listed("GPT-5.2", [1.75, null, 0.175, 14], ["gpt-5.2-high"]),
  listed("GPT-5.2 Codex", [1.75, null, 0.175, 14]),
  listed("GPT-5.3 Codex", [1.75, null, 0.175, 14], ["gpt-5.3-codex-high"]),
  listed("GPT-5.4", [2.5, null, 0.25, 15]),
  listed("GPT-5.4 Mini", [0.75, null, 0.075, 4.5]),
  listed("GPT-5.4 Nano", [0.2, null, 0.02, 1.25]),
  listed("GPT-5.5", [5, null, 0.5, 30]),
  listed("GPT-5.6 Luna", [0.2, 0.25, 0.02, 1.2]),
  listed("GPT-5.6 Sol", [4, 5, 0.4, 20]),
  listed("GPT-5.6 Terra", [2, 2.5, 0.2, 12]),
];

const OTHERS: readonly ListedModel[] = [
  listed("Composer 2.5", [0.5, null, 0.2, 2.5]),
  listed("Composer 2.5 (Fast)", [3, null, 0.5, 15]),
  listed("Grok 4.5", [2, null, 0.5, 6]),
  listed("Grok 4.5 (Fast)", [4, null, 1, 18]),
  listed("Grok 4.6", [2, null, 0.5, 6]),
  listed("Grok 4.6 (Fast)", [4, null, 1, 12]),
  listed("Grok 4.7", [2, null, 0.5, 6]),
  listed("Grok 4.7 (Fast)", [4, null, 1, 12]),
  listed("Gemini 2.5 Flash", [0.3, null, 0.03, 2.5]),
  listed("Gemini 3 Flash", [0.5, null, 0.05, 3]),
  listed("Gemini 3 Pro", [2, null, 0.2, 12]),
  listed("Gemini 3.1 Pro", [2, null, 0.2, 12]),
  listed("Gemini 3.5 Flash", [1.5, null, 0.15, 9]),
  listed("Gemini 3.6 Flash", [1.5, null, 0.15, 7.5]),
  listed("Gemini 3.7 Flash", [0.75, null, 0.075, 3.5]),
  listed("Gemini 3.8 Flash", [0.75, null, 0.075, 3.5]),
  listed("GLM 5.2", [1.4, null, 0.26, 4.4]),
  listed("GLM 5.3", [1.4, null, 0.26, 4.4]),
  listed("GLM 5.3 Flash", [0.15, null, 0.029, 0.5]),
  listed("Kimi K2.7 Code", [0.95, null, 0.19, 4]),
  listed("Kimi K3", [3, null, 0.3, 15]),
  listed("Muse Spark 1.3", [1.25, null, 0.15, 4.25]),
];

export const cursorModelSlug = (name: string): string =>
  name.toLowerCase().replaceAll(/[()]/gu, "").trim().replaceAll(/\s+/gu, "-");

const toRates = ([
  input,
  cacheWrite,
  cacheRead,
  output,
]: ListedRates): ModelRates => ({
  "cache-write": cacheWrite,
  "cached-input": cacheRead,
  input,
  output,
  reasoning: 0,
});

const namesOf = (model: ListedModel): readonly string[] => {
  const slug = cursorModelSlug(model.name);
  const thinking = model.name.startsWith("Claude") ? [`${slug}-thinking`] : [];

  return [...new Set([model.name, slug, ...thinking, ...model.aliases])];
};

const modelEntries = [...ANTHROPIC, ...OPENAI, ...OTHERS].flatMap((model) =>
  namesOf(model).map((name) => [name, toRates(model.rates)] as const)
);

export const cursorPriceTable202609: PriceTable = decodePriceTable({
  currency: "USD",
  effectiveFrom: "2026-09-01T00:00:00Z",
  id: "cursor",
  models: Object.fromEntries(modelEntries),
  source: CURSOR_2026_09_SOURCE,
  unit: "usd-per-million-tokens",
  version: "2026-09",
});
