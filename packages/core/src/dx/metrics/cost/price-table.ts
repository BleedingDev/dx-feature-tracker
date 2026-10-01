import { Schema } from "effect";

import type { TokenCategory } from "../../model/ai.js";
import { matchSlug } from "./price-catalog/slug.js";
import type { TokenReading } from "./readings.js";

const RateSchema = Schema.optional(Schema.NullOr(Schema.Finite));

export const ContextTierSchema = Schema.Struct({
  aboveInputTokens: Schema.Finite,
  "cache-write": RateSchema,
  "cache-write-1h": RateSchema,
  "cached-input": RateSchema,
  input: Schema.Finite,
  output: Schema.Finite,
});

export type ContextTier = typeof ContextTierSchema.Type;

export const ModelRatesSchema = Schema.Struct({
  "cache-write": RateSchema,
  "cache-write-1h": RateSchema,
  "cached-input": RateSchema,
  input: RateSchema,
  output: RateSchema,
  reasoning: RateSchema,
  tiers: Schema.optional(Schema.Array(ContextTierSchema)),
});

export type ModelRates = typeof ModelRatesSchema.Type;

export const PriceTableSchema = Schema.Struct({
  currency: Schema.Literal("USD"),
  effectiveFrom: Schema.String,
  id: Schema.String,
  models: Schema.Record(Schema.String, ModelRatesSchema),
  source: Schema.String,
  unit: Schema.Literal("usd-per-million-tokens"),
  version: Schema.String,
});

export type PriceTable = typeof PriceTableSchema.Type;

export const decodePriceTable = Schema.decodeUnknownSync(PriceTableSchema);

export const priceMethodLabel = (table: PriceTable): string =>
  `price-table:${table.id}@${table.version}`;

const PRICED_CATEGORIES: readonly (keyof ModelRates & TokenCategory)[] = [
  "input",
  "cached-input",
  "cache-write",
  "output",
  "reasoning",
];

export type UnpricedReason =
  | "model-unknown"
  | "model-not-in-table"
  | "before-effective-date"
  | "missing-rate"
  | "total-only"
  | "no-tokens";

export type PriceOutcome =
  | {
      readonly kind: "priced";
      readonly unpricedCategories: readonly TokenCategory[];
      readonly usd: number;
    }
  | { readonly kind: "unpriced"; readonly reason: UnpricedReason };

const beforeEffective = (occurredAt: string | null, table: PriceTable) => {
  if (occurredAt === null) {
    return false;
  }

  const at = Date.parse(occurredAt);
  const from = Date.parse(table.effectiveFrom);

  return Number.isFinite(at) && Number.isFinite(from) && at < from;
};

const priceRates = (
  rates: ModelRates,
  tokens: TokenReading["tokens"]
): PriceOutcome => {
  let usd = 0;
  let pricedAny = false;
  const unpricedCategories: TokenCategory[] = [];

  for (const category of PRICED_CATEGORIES) {
    const count = tokens[category] ?? 0;

    if (count === 0) {
      continue;
    }

    const rate = rates[category] ?? null;

    if (rate === null) {
      unpricedCategories.push(category);
      continue;
    }

    usd += (count * rate) / 1_000_000;
    pricedAny = true;
  }

  if (!pricedAny && unpricedCategories.length > 0) {
    return { kind: "unpriced", reason: "missing-rate" };
  }

  if (!pricedAny) {
    const hasTotal = (tokens.total ?? 0) > 0 || (tokens.other ?? 0) > 0;

    return { kind: "unpriced", reason: hasTotal ? "total-only" : "no-tokens" };
  }

  return { kind: "priced", unpricedCategories, usd };
};

const ratesFor = (table: PriceTable, model: string): ModelRates | undefined => {
  const direct = table.models[model];

  if (direct !== undefined) {
    return direct;
  }

  const match = matchSlug(model, new Set(Object.keys(table.models)));

  return match.kind === "matched" ? table.models[match.catalogId] : undefined;
};

export const priceReading = (
  reading: TokenReading,
  table: PriceTable
): PriceOutcome => {
  if (reading.model === null) {
    return { kind: "unpriced", reason: "model-unknown" };
  }

  const rates = ratesFor(table, reading.model);

  if (rates === undefined) {
    return { kind: "unpriced", reason: "model-not-in-table" };
  }

  if (beforeEffective(reading.occurredAt, table)) {
    return { kind: "unpriced", reason: "before-effective-date" };
  }

  return priceRates(rates, reading.tokens);
};
