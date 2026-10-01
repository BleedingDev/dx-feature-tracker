import type { ModelProvider } from "../../../harness/ids.js";
import { inferProvider, isLocalRuntime } from "../../../harness/provider.js";
import type {
  AiAttribution,
  AiTokens,
  AiUsage,
  ToolFigure,
} from "../../../model/attribution.js";
import type { ContextTier, ModelRates } from "../price-table.js";
import { parseModelName, resolvePriceKey } from "./aliases.js";
import {
  ANTHROPIC_CACHE_WRITE_1H_MULTIPLIER,
  ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER,
  COPILOT_PREMIUM_REQUEST_USD,
  WEB_SEARCH_USD_PER_REQUEST,
  tierPricing,
} from "./rules.js";
import type { PriceSheet } from "./sheet.js";
import { versionAt } from "./sheet.js";

export interface PricedRequest {
  readonly ai: AiAttribution | null;
  readonly occurredAt: string | null;
  readonly usage: AiUsage | null;
}

export type PricePart =
  | "input"
  | "cache-read"
  | "cache-write-5m"
  | "cache-write-1h"
  | "output"
  | "web-search"
  | "premium-requests";

export interface EstimateLine {
  readonly part: PricePart;
  readonly quantity: number;
  readonly unit: "tokens" | "requests";
  readonly usd: number;
  readonly usdPerUnit: number;
}

export type EstimateMethod =
  | "maker-price"
  | "local"
  | "cursor-list-price"
  | "copilot-premium-request";

export interface PriceRef {
  readonly effectiveFrom: string | null;
  readonly key: string;
  readonly sheet: string;
  readonly version: string;
}

export interface PremiumRequests {
  readonly count: number;
  readonly usd: number;
}

export interface PricedEstimate {
  readonly complete: boolean;
  readonly contextTier: number | null;
  readonly currency: "USD";
  readonly kind: "priced";
  readonly lines: readonly EstimateLine[];
  readonly method: EstimateMethod;
  readonly multiplier: number;
  readonly notes: readonly string[];
  readonly premiumRequests: PremiumRequests | null;
  readonly price: PriceRef | null;
  readonly serviceTier: string | null;
  readonly usd: number;
}

export type NoPriceReason =
  | "no-usage"
  | "no-tokens"
  | "total-only"
  | "model-unpriced"
  | "missing-rate";

export interface NoPrice {
  readonly detail: string;
  readonly kind: "no-price";
  readonly premiumRequests: PremiumRequests | null;
  readonly reason: NoPriceReason;
}

export type RequestEstimate = PricedEstimate | NoPrice;

export interface RequestLedgers {
  readonly billed: ToolFigure | null;
  readonly estimate: RequestEstimate;
  readonly toolFigure: ToolFigure | null;
}

const PER_MILLION = 1_000_000;

const round = (value: number): number =>
  Math.round(value * 1_000_000_000) / 1_000_000_000;

const noPrice = (
  reason: NoPriceReason,
  detail: string,
  premiumRequests: PremiumRequests | null
): NoPrice => ({ detail, kind: "no-price", premiumRequests, reason });

const premiumOf = (usage: AiUsage | null): PremiumRequests | null => {
  const count = usage?.premiumRequests ?? null;

  return count === null || count <= 0
    ? null
    : { count, usd: round(count * COPILOT_PREMIUM_REQUEST_USD) };
};

const writeSplit = (tokens: AiTokens) => {
  const fiveMinutes = tokens.cacheWrite5m ?? 0;
  const oneHour = tokens.cacheWrite1h ?? 0;
  const rest = Math.max((tokens.cacheWrite ?? 0) - fiveMinutes - oneHour, 0);

  return { fiveMinutes: fiveMinutes + rest, oneHour };
};

const promptTokens = (tokens: AiTokens): number => {
  const writes = writeSplit(tokens);

  return (
    (tokens.inputFresh ?? 0) +
    (tokens.cacheRead ?? 0) +
    writes.fiveMinutes +
    writes.oneHour
  );
};

const hasBreakdown = (tokens: AiTokens): boolean =>
  [
    tokens.inputFresh,
    tokens.cacheRead,
    tokens.cacheWrite,
    tokens.cacheWrite5m,
    tokens.cacheWrite1h,
    tokens.output,
  ].some((value) => value !== null);

interface EffectiveRates {
  readonly cacheRead: number;
  readonly cacheReadListed: boolean;
  readonly cacheWrite1h: number;
  readonly cacheWrite5m: number;
  readonly cacheWriteListed: boolean;
  readonly input: number;
  readonly output: number;
}

const tierFor = (rates: ModelRates, prompt: number): ContextTier | undefined =>
  (rates.tiers ?? []).findLast((tier) => prompt > tier.aboveInputTokens);

type RateField = "cache-write" | "cache-write-1h" | "cached-input";

const rateOf = (
  rates: ModelRates,
  tier: ContextTier | undefined,
  field: RateField
): number | null => tier?.[field] ?? rates[field] ?? null;

const cacheWriteRates = (
  input: number,
  listed5m: number | null,
  listed1h: number | null,
  anthropic: boolean
) => {
  const fiveMinutes =
    listed5m ??
    (anthropic ? input * ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER : input);

  return {
    cacheWrite1h:
      listed1h ??
      (anthropic ? input * ANTHROPIC_CACHE_WRITE_1H_MULTIPLIER : fiveMinutes),
    cacheWrite5m: fiveMinutes,
  };
};

const effectiveRates = (
  rates: ModelRates,
  tier: ContextTier | undefined,
  maker: ModelProvider
): EffectiveRates | null => {
  const input = tier?.input ?? rates.input ?? null;
  const output = tier?.output ?? rates.output ?? null;

  if (input === null || output === null) {
    return null;
  }

  const anthropic = maker === "anthropic";
  const cacheRead = rateOf(rates, tier, "cached-input");
  const listedWrite = rateOf(rates, tier, "cache-write");

  return {
    ...cacheWriteRates(
      input,
      listedWrite,
      rateOf(rates, tier, "cache-write-1h"),
      anthropic
    ),
    cacheRead: cacheRead ?? input,
    cacheReadListed: cacheRead !== null,
    cacheWriteListed: listedWrite !== null || anthropic,
    input,
    output,
  };
};

const rateNotes = (rates: EffectiveRates, tokens: AiTokens): string[] => [
  ...(!rates.cacheReadListed && (tokens.cacheRead ?? 0) > 0
    ? ["no cached-input price listed; cache reads priced as input"]
    : []),
  ...(!rates.cacheWriteListed && (tokens.cacheWrite ?? 0) > 0
    ? ["no cache-write price listed; cache writes priced as input"]
    : []),
];

const tokenLine = (
  part: PricePart,
  count: number | null,
  usdPerMillion: number,
  multiplier: number
): EstimateLine[] =>
  count === null || count <= 0
    ? []
    : [
        {
          part,
          quantity: count,
          unit: "tokens",
          usd: round((count * usdPerMillion * multiplier) / PER_MILLION),
          usdPerUnit: round((usdPerMillion * multiplier) / PER_MILLION),
        },
      ];

const hasUnpricedSearches = (usage: AiUsage, maker: ModelProvider): boolean =>
  (usage.webSearchRequests ?? 0) > 0 && !WEB_SEARCH_USD_PER_REQUEST.has(maker);

const webSearchLine = (
  usage: AiUsage,
  maker: ModelProvider,
  notes: string[]
): EstimateLine[] => {
  const count = usage.webSearchRequests ?? null;

  if (count === null || count <= 0) {
    return [];
  }

  const price = WEB_SEARCH_USD_PER_REQUEST.get(maker);

  if (price === undefined) {
    notes.push(
      `${String(count)} web search request(s) have no public price for ${maker}`
    );

    return [];
  }

  return [
    {
      part: "web-search",
      quantity: count,
      unit: "requests",
      usd: round(count * price),
      usdPerUnit: price,
    },
  ];
};

const isLocal = (ai: AiAttribution): boolean =>
  ai.provider === "local" || isLocalRuntime(ai.via);

const localEstimate = (
  ai: AiAttribution,
  premiumRequests: PremiumRequests | null
): PricedEstimate => ({
  complete: true,
  contextTier: null,
  currency: "USD",
  kind: "priced",
  lines: [],
  method: "local",
  multiplier: 1,
  notes: [`runs locally${ai.via === null ? "" : ` on ${ai.via}`}; costs 0`],
  premiumRequests,
  price: null,
  serviceTier: null,
  usd: 0,
});

const fallbackEstimate = (
  request: PricedRequest,
  outcome: NoPrice
): RequestEstimate => {
  const figure = request.usage?.toolFigure ?? null;

  if (
    request.ai?.harness === "cursor" &&
    figure !== null &&
    figure.kind === "list-price" &&
    figure.currency.toUpperCase() === "USD"
  ) {
    return {
      complete: true,
      contextTier: null,
      currency: "USD",
      kind: "priced",
      lines: [],
      method: "cursor-list-price",
      multiplier: 1,
      notes: [`${outcome.detail}; Cursor's per-request list price used`],
      premiumRequests: outcome.premiumRequests,
      price: null,
      serviceTier: null,
      usd: figure.amount,
    };
  }

  if (outcome.premiumRequests !== null) {
    return {
      complete: false,
      contextTier: null,
      currency: "USD",
      kind: "priced",
      lines: [
        {
          part: "premium-requests",
          quantity: outcome.premiumRequests.count,
          unit: "requests",
          usd: outcome.premiumRequests.usd,
          usdPerUnit: COPILOT_PREMIUM_REQUEST_USD,
        },
      ],
      method: "copilot-premium-request",
      multiplier: 1,
      notes: [`${outcome.detail}; GitHub Copilot premium request price used`],
      premiumRequests: outcome.premiumRequests,
      price: null,
      serviceTier: null,
      usd: outcome.premiumRequests.usd,
    };
  }

  return outcome;
};

export interface SheetHit {
  readonly impliedSpeed: "fast" | null;
  readonly price: PriceRef;
  readonly rates: ModelRates;
}

export type SheetLookup =
  | ({ readonly kind: "found" } & SheetHit)
  | { readonly kind: "unpriced"; readonly reason: string };

export const lookupPrice = (
  sheets: readonly PriceSheet[],
  model: string | null,
  at: string | null
): SheetLookup => {
  let firstReason: string | null = null;

  for (const sheet of sheets) {
    const resolved = resolvePriceKey(
      model,
      (key) => sheet.models[key] !== undefined
    );

    if (resolved.kind === "unpriced") {
      firstReason ??= resolved.reason;
      continue;
    }

    const version = versionAt(sheet.models[resolved.key] ?? [], at);

    if (version !== undefined) {
      return {
        impliedSpeed: resolved.impliedSpeed,
        kind: "found",
        price: {
          effectiveFrom: version.effectiveFrom,
          key: resolved.key,
          sheet: sheet.id,
          version: sheet.version,
        },
        rates: version.rates,
      };
    }
  }

  return {
    kind: "unpriced",
    reason: firstReason ?? "no price sheet loaded",
  };
};

const priceTokens = (
  request: PricedRequest,
  usage: AiUsage,
  hit: SheetHit,
  maker: ModelProvider,
  premiumRequests: PremiumRequests | null
): RequestEstimate => {
  const notes: string[] = [];
  const { tokens } = usage;
  const prompt = promptTokens(tokens);
  const tier = tierFor(hit.rates, prompt);
  const rates = effectiveRates(hit.rates, tier, maker);

  if (rates === null) {
    return noPrice(
      "missing-rate",
      `${hit.price.key} has no input or output price`,
      premiumRequests
    );
  }

  const speed = usage.speed ?? hit.impliedSpeed;

  const service = tierPricing({
    at: request.occurredAt,
    key: hit.price.key,
    maker,
    serviceTier: usage.serviceTier,
    speed,
  });

  if (service.unpricedTier !== null) {
    notes.push(
      `${service.unpricedTier} tier has no public multiplier for ${hit.price.key}; priced at standard`
    );
  }

  notes.push(...rateNotes(rates, tokens));

  const cacheReadRate = service.cacheReadAsInput
    ? rates.input
    : rates.cacheRead;

  if (
    service.cacheReadAsInput &&
    rates.cacheReadListed &&
    (tokens.cacheRead ?? 0) > 0
  ) {
    notes.push(
      `batch lists no cached-input price for ${hit.price.key}; cache reads priced as batch input`
    );
  }

  const writes = writeSplit(tokens);
  const { multiplier } = service;

  const lines = [
    ...tokenLine("input", tokens.inputFresh, rates.input, multiplier),
    ...tokenLine("cache-read", tokens.cacheRead, cacheReadRate, multiplier),
    ...tokenLine(
      "cache-write-5m",
      writes.fiveMinutes,
      rates.cacheWrite5m,
      multiplier
    ),
    ...tokenLine(
      "cache-write-1h",
      writes.oneHour,
      rates.cacheWrite1h,
      multiplier
    ),
    ...tokenLine("output", tokens.output, rates.output, multiplier),
    ...webSearchLine(usage, maker, notes),
  ];

  if (premiumRequests !== null) {
    notes.push(
      `${String(premiumRequests.count)} GitHub Copilot premium request(s) not in the estimate; it uses the maker's token price`
    );
  }

  if (request.ai?.via !== null && request.ai?.via !== undefined) {
    notes.push(`priced at the maker's public price, not ${request.ai.via}'s`);
  }

  return {
    complete:
      tokens.inputFresh !== null &&
      tokens.output !== null &&
      service.unpricedTier === null &&
      !hasUnpricedSearches(usage, maker),
    contextTier: tier?.aboveInputTokens ?? null,
    currency: "USD",
    kind: "priced",
    lines,
    method: "maker-price",
    multiplier,
    notes,
    premiumRequests,
    price: hit.price,
    serviceTier: service.label,
    usd: round(lines.reduce((total, line) => total + line.usd, 0)),
  };
};

export const estimateRequest = (
  sheets: readonly PriceSheet[],
  request: PricedRequest
): RequestEstimate => {
  const { ai, usage } = request;
  const premiumRequests = premiumOf(usage);

  if (ai !== null && isLocal(ai)) {
    return localEstimate(ai, premiumRequests);
  }

  if (usage === null) {
    return fallbackEstimate(
      request,
      noPrice("no-usage", "no usage recorded", premiumRequests)
    );
  }

  if (!hasBreakdown(usage.tokens)) {
    return fallbackEstimate(
      request,
      usage.tokens.total === null
        ? noPrice("no-tokens", "no token counts recorded", premiumRequests)
        : noPrice(
            "total-only",
            "only a token total was recorded; the price depends on the split",
            premiumRequests
          )
    );
  }

  const model = ai?.model ?? ai?.modelRaw ?? null;
  const found = lookupPrice(sheets, model, request.occurredAt);

  if (found.kind === "unpriced") {
    return fallbackEstimate(
      request,
      noPrice("model-unpriced", found.reason, premiumRequests)
    );
  }

  const maker =
    ai === null || ai.provider === "unknown"
      ? inferProvider(found.price.key)
      : ai.provider;

  const rawSpeed =
    ai?.modelRaw === null || ai?.modelRaw === undefined
      ? null
      : parseModelName(ai.modelRaw).impliedSpeed;

  return priceTokens(
    request,
    usage,
    { ...found, impliedSpeed: found.impliedSpeed ?? rawSpeed },
    maker,
    premiumRequests
  );
};

export const requestLedgers = (
  sheets: readonly PriceSheet[],
  request: PricedRequest
): RequestLedgers => {
  const figure = request.usage?.toolFigure ?? null;

  return {
    billed: figure?.kind === "charge" ? figure : null,
    estimate: estimateRequest(sheets, request),
    toolFigure: figure !== null && figure.kind !== "charge" ? figure : null,
  };
};
