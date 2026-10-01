import { Option, Schema } from "effect";

import type { ContextTier, ModelRates, PriceTable } from "../price-table.js";
import { decodePriceTable, ModelRatesSchema } from "../price-table.js";
import { matchSlug } from "./slug.js";

export type CatalogSource = "models.dev" | "litellm";

export const CATALOG_URLS: Readonly<Record<CatalogSource, string>> = {
  litellm:
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  "models.dev": "https://models.dev/api.json",
};

export const FIRST_PARTY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "zai",
  "moonshotai",
  "deepseek",
] as const;

export const CatalogSchema = Schema.Struct({
  fetchedAt: Schema.String,
  models: Schema.Record(Schema.String, ModelRatesSchema),
  source: Schema.Literals(["models.dev", "litellm"]),
});

export type Catalog = typeof CatalogSchema.Type;

const Rate = Schema.optionalKey(Schema.NullOr(Schema.Finite));

const ModelsDevTierSchema = Schema.Struct({
  cache_read: Rate,
  cache_write: Rate,
  input: Schema.Finite,
  output: Schema.Finite,
  tier: Schema.Struct({ size: Schema.Finite, type: Schema.Literal("context") }),
});

const decodeModelsDevTier = Schema.decodeUnknownOption(ModelsDevTierSchema);

const ModelsDevModelSchema = Schema.Struct({
  cost: Schema.Struct({
    cache_read: Rate,
    cache_write: Rate,
    input: Schema.Finite,
    output: Schema.Finite,
    tiers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
});

const ModelsDevRootSchema = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      models: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    })
  )
);

const LiteLlmEntrySchema = Schema.Struct({
  cache_creation_input_token_cost: Rate,
  cache_creation_input_token_cost_above_1hr: Rate,
  cache_read_input_token_cost: Rate,
  cache_read_input_token_cost_above_200k_tokens: Rate,
  input_cost_per_token: Schema.Finite,
  input_cost_per_token_above_200k_tokens: Rate,
  output_cost_per_token: Schema.Finite,
  output_cost_per_token_above_200k_tokens: Rate,
});

const LiteLlmRootSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown)
);

const decodeModelsDevModel = Schema.decodeUnknownOption(ModelsDevModelSchema);

const decodeLiteLlmEntry = Schema.decodeUnknownOption(LiteLlmEntrySchema);

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

const perMillion = (value: number | null | undefined): number | null =>
  value === null || value === undefined || value < 0
    ? null
    : round(value * 1e6);

const plain = (value: number | null | undefined): number | null =>
  value === null || value === undefined || value < 0 ? null : round(value);

const modelsDevTiers = (raw: readonly unknown[]): readonly ContextTier[] =>
  raw
    .flatMap((item) => Option.toArray(decodeModelsDevTier(item)))
    .map((tier) => ({
      aboveInputTokens: tier.tier.size,
      "cache-write": plain(tier.cache_write),
      "cached-input": plain(tier.cache_read),
      input: round(tier.input),
      output: round(tier.output),
    }))
    .toSorted((a, b) => a.aboveInputTokens - b.aboveInputTokens);

const LITELLM_LONG_CONTEXT = 200_000;

const liteLlmTiers = (
  entry: typeof LiteLlmEntrySchema.Type
): readonly ContextTier[] => {
  const input = perMillion(entry.input_cost_per_token_above_200k_tokens);
  const output = perMillion(entry.output_cost_per_token_above_200k_tokens);

  return input === null || output === null
    ? []
    : [
        {
          aboveInputTokens: LITELLM_LONG_CONTEXT,
          "cached-input": perMillion(
            entry.cache_read_input_token_cost_above_200k_tokens
          ),
          input,
          output,
        },
      ];
};

export const parseModelsDev = (text: string, fetchedAt: string): Catalog => {
  const models: Record<string, ModelRates> = {};

  const decodedRoot = Schema.decodeUnknownOption(ModelsDevRootSchema)(text);

  if (Option.isNone(decodedRoot)) {
    return { fetchedAt, models, source: "models.dev" };
  }

  const root = decodedRoot.value;

  for (const provider of FIRST_PARTY_PROVIDERS) {
    const entries = root[provider]?.models ?? {};

    for (const [id, raw] of Object.entries(entries)) {
      const key = id.toLowerCase();
      const decoded = decodeModelsDevModel(raw);

      if (Option.isSome(decoded) && models[key] === undefined) {
        const { cost } = decoded.value;
        models[key] = {
          "cache-write": plain(cost.cache_write),
          "cached-input": plain(cost.cache_read),
          input: round(cost.input),
          output: round(cost.output),
          reasoning: 0,
          tiers: modelsDevTiers(cost.tiers ?? []),
        };
      }
    }
  }

  return { fetchedAt, models, source: "models.dev" };
};

export const parseLiteLlm = (text: string, fetchedAt: string): Catalog => {
  const models: Record<string, ModelRates> = {};

  const decodedRoot = Schema.decodeUnknownOption(LiteLlmRootSchema)(text);

  if (Option.isNone(decodedRoot)) {
    return { fetchedAt, models, source: "litellm" };
  }

  const root = decodedRoot.value;

  for (const [key, raw] of Object.entries(root)) {
    const decoded = key.includes("/") ? Option.none() : decodeLiteLlmEntry(raw);

    if (Option.isSome(decoded)) {
      const entry = decoded.value;

      models[key.toLowerCase()] = {
        "cache-write": perMillion(entry.cache_creation_input_token_cost),
        "cache-write-1h": perMillion(
          entry.cache_creation_input_token_cost_above_1hr
        ),
        "cached-input": perMillion(entry.cache_read_input_token_cost),
        input: round(entry.input_cost_per_token * 1e6),
        output: round(entry.output_cost_per_token * 1e6),
        reasoning: 0,
        tiers: liteLlmTiers(entry),
      };
    }
  }

  return { fetchedAt, models, source: "litellm" };
};

export const parseCatalog = (
  source: CatalogSource,
  text: string,
  fetchedAt: string
): Catalog =>
  source === "models.dev"
    ? parseModelsDev(text, fetchedAt)
    : parseLiteLlm(text, fetchedAt);

export const catalogPriceTable = (
  catalog: Catalog,
  bundled: PriceTable
): PriceTable =>
  decodePriceTable({
    currency: "USD",
    effectiveFrom: bundled.effectiveFrom,
    id: catalog.source,
    models: { ...catalog.models, ...bundled.models },
    source: `${catalog.source} public price catalog (${CATALOG_URLS[catalog.source]}) fetched ${catalog.fetchedAt}; ${bundled.id}@${bundled.version} rates win for models it lists`,
    unit: "usd-per-million-tokens",
    version: catalog.fetchedAt.slice(0, 10),
  });

export type ModelPriceResolution =
  | {
      readonly key: string;
      readonly kind: "priced";
      readonly rates: ModelRates;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export const resolveModel = (
  table: PriceTable,
  slug: string | null
): ModelPriceResolution => {
  const direct = slug === null ? undefined : table.models[slug];

  if (slug !== null && direct !== undefined) {
    return { key: slug, kind: "priced", rates: direct };
  }

  const match = matchSlug(slug, new Set(Object.keys(table.models)));

  if (match.kind === "unavailable") {
    return match;
  }

  const rates = table.models[match.catalogId];

  return rates === undefined
    ? { kind: "unavailable", reason: `no rates for ${match.catalogId}` }
    : { key: match.catalogId, kind: "priced", rates };
};

export const expandForModels = (
  table: PriceTable,
  slugs: readonly (string | null)[]
): PriceTable => {
  const extra: Record<string, ModelRates> = {};

  for (const slug of slugs) {
    const resolved = resolveModel(table, slug);

    if (slug !== null && resolved.kind === "priced") {
      extra[slug] = resolved.rates;
    }
  }

  return { ...table, models: { ...table.models, ...extra } };
};
