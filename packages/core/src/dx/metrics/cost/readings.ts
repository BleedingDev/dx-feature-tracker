import { Option, Schema } from "effect";

import {
  LIST_PRICE_FIELDS,
  SOURCE_KIND_ALIASES,
  rulesForEvent,
} from "../../harness/rules.js";
import {
  UNKNOWN_SOURCE_RANK,
  aiSourceHarness,
  aiSourceRank,
} from "../../harness/source-kinds.js";
import { AiSourceKindSchema, TokenCategorySchema } from "../../model/ai.js";
import type { TokenCategory } from "../../model/ai.js";
import type { AiUsage } from "../../model/attribution.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { PricedRequest } from "./price-book/estimate.js";

export const MoneyLedgerSchema = Schema.Literals([
  "charge",
  "metered",
  "list-price-estimate",
  "unallocated",
]);

export type MoneyLedger = typeof MoneyLedgerSchema.Type;

export interface ReadingBase {
  readonly adapterId: string;
  readonly branch: string | null;
  readonly dedupeKey: string;
  readonly eventId: string;
  readonly occurredAt: string | null;
  readonly sourceKind: string | null;
}

export interface MoneyReading extends ReadingBase {
  readonly ledger: MoneyLedger;
  readonly rawField: string;
  readonly usd: number;
}

export type TokenCounts = Partial<Record<TokenCategory, number>>;

export interface TokenReading extends ReadingBase {
  readonly model: string | null;
  readonly request?: PricedRequest | null;
  readonly requests: number | null;
  readonly tokens: TokenCounts;
}

export interface Rejection {
  readonly eventId: string;
  readonly reason: string;
}

export interface ExtractedReadings {
  readonly collapsedDuplicates: number;
  readonly listPrices: ReadonlyMap<string, number>;
  readonly money: readonly MoneyReading[];
  readonly rejections: readonly Rejection[];
  readonly tokens: readonly TokenReading[];
}

const OptText = Schema.optional(Schema.NullOr(Schema.String));

const OptCount = Schema.optional(Schema.NullOr(Schema.Finite));

const MeasurementSchema = Schema.Struct({
  category: OptText,
  currency: OptText,
  ledger: Schema.String,
  rawCategory: OptText,
  unit: OptText,
  value: Schema.Finite,
});

type Measurement = typeof MeasurementSchema.Type;

const TokenRecordSchema = Schema.Struct({
  "cache-write": OptCount,
  "cached-input": OptCount,
  input: OptCount,
  other: OptCount,
  output: OptCount,
  reasoning: OptCount,
  total: OptCount,
});

const ChargeObjectSchema = Schema.Struct({
  currency: OptText,
  value: Schema.Finite,
});

const orNull = <A>(option: Option.Option<A>): A | null =>
  Option.getOrNull(option);

const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString);

const decodeNumber = Schema.decodeUnknownOption(Schema.Finite);

const decodeList = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const decodeMeasurement = Schema.decodeUnknownOption(MeasurementSchema);

const decodeTokens = Schema.decodeUnknownOption(TokenRecordSchema);

const decodeChargeObject = Schema.decodeUnknownOption(ChargeObjectSchema);

const decodeSourceKind = Schema.decodeUnknownOption(AiSourceKindSchema);

const decodeCategory = Schema.decodeUnknownOption(TokenCategorySchema);

const decodeLedger = Schema.decodeUnknownOption(MoneyLedgerSchema);

const isUsd = (currency: string | null | undefined): boolean =>
  currency === null ||
  currency === undefined ||
  currency.toUpperCase() === "USD";

const toUsd = (measurement: Measurement): number | null => {
  if (!isUsd(measurement.currency)) {
    return null;
  }

  const unit = measurement.unit?.toLowerCase() ?? null;

  if (unit === "usd-cents" || unit === "cents") {
    return measurement.value / 100;
  }

  return unit === null || unit === "usd" ? measurement.value : null;
};

interface Collector {
  readonly money: MoneyReading[];
  readonly rejections: Rejection[];
  readonly tokens: TokenCounts;
}

const addToken = (
  into: TokenCounts,
  category: TokenCategory,
  value: number
) => {
  into[category] = (into[category] ?? 0) + value;
};

const collectMeasurement = (
  measurement: Measurement,
  base: ReadingBase,
  out: Collector
) => {
  if (measurement.ledger === "tokens") {
    const category = orNull(decodeCategory(measurement.category));

    if (category !== null) {
      addToken(out.tokens, category, measurement.value);
    }

    return;
  }

  const ledger = orNull(decodeLedger(measurement.ledger));

  if (ledger === null) {
    return;
  }

  const usd = toUsd(measurement);

  if (usd === null) {
    out.rejections.push({
      eventId: base.eventId,
      reason: "non-usd-or-unknown-unit",
    });

    return;
  }

  out.money.push({
    ...base,
    ledger,
    rawField: `measurements.${measurement.rawCategory ?? ledger}`,
    usd,
  });
};

const fromMeasurements = (
  event: DxEventEnvelope,
  base: ReadingBase,
  out: Collector
) => {
  const list = orNull(decodeList(event.payload.measurements)) ?? [];

  for (const item of list) {
    const measurement = orNull(decodeMeasurement(item));

    if (measurement !== null) {
      collectMeasurement(measurement, base, out);
    }
  }
};

const ledgerForCost = (costLedger: string): MoneyLedger | null => {
  if (costLedger === "charge") {
    return "charge";
  }

  if (costLedger === "metered") {
    return "metered";
  }

  return costLedger === "unallocated" ? "unallocated" : null;
};

const fromCostLedger = (
  event: DxEventEnvelope,
  base: ReadingBase,
  out: Collector
): boolean => {
  const { payload } = event;
  const costLedger = orNull(decodeText(payload.costLedger));

  if (costLedger === null) {
    return false;
  }

  const amount = orNull(decodeNumber(payload.costUsd));

  if (amount === null) {
    return true;
  }

  const ledger = ledgerForCost(costLedger);

  if (ledger === null) {
    out.rejections.push({
      eventId: base.eventId,
      reason: `cost-ledger-${costLedger}`,
    });

    return true;
  }

  if (!isUsd(orNull(decodeText(payload.currency)))) {
    out.rejections.push({ eventId: base.eventId, reason: "non-usd-currency" });

    return true;
  }

  const charged =
    ledger === "charge" ? orNull(decodeNumber(payload.charge)) : null;

  out.money.push(
    charged === null
      ? { ...base, ledger, rawField: "costUsd", usd: amount }
      : { ...base, ledger, rawField: "charge", usd: charged }
  );

  return true;
};

const fromCharge = (
  event: DxEventEnvelope,
  base: ReadingBase,
  out: Collector
) => {
  const { payload } = event;
  const direct = orNull(decodeNumber(payload.charge));
  const nested = orNull(decodeChargeObject(payload.charge));
  const value = direct ?? nested?.value ?? null;

  if (value === null) {
    return;
  }

  const currency =
    nested === null ? orNull(decodeText(payload.currency)) : nested.currency;

  if (!isUsd(currency)) {
    out.rejections.push({ eventId: base.eventId, reason: "non-usd-currency" });

    return;
  }

  out.money.push({ ...base, ledger: "charge", rawField: "charge", usd: value });
};

const fromListPrice = (
  event: DxEventEnvelope,
  base: ReadingBase,
  out: Collector
) => {
  const value = orNull(decodeNumber(event.payload.listPriceEstimateUsd));

  if (value !== null) {
    out.money.push({
      ...base,
      ledger: "list-price-estimate",
      rawField: "listPriceEstimateUsd",
      usd: value,
    });
  }
};

const fromTokenRecord = (event: DxEventEnvelope, out: Collector) => {
  const tokens = orNull(decodeTokens(event.payload.tokens));

  if (tokens === null) {
    return;
  }

  for (const category of TokenCategorySchema.literals) {
    const value = tokens[category];

    if (value !== null && value !== undefined) {
      addToken(out.tokens, category, value);
    }
  }
};

const baseOf = (event: DxEventEnvelope): ReadingBase => {
  const payloadKey = orNull(decodeText(event.payload.requestKey));

  return {
    adapterId: event.adapterId,
    branch: event.context.branch,
    dedupeKey:
      payloadKey ?? event.usage?.requestKey ?? `event:${event.eventId}`,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    sourceKind: orNull(decodeText(event.payload.sourceKind)),
  };
};

const listPriceOf = (event: DxEventEnvelope): number | null => {
  const { payload } = event;
  const field = orNull(decodeText(payload.costRawField));

  if (
    field === null ||
    !LIST_PRICE_FIELDS.has(field) ||
    !isUsd(orNull(decodeText(payload.currency)))
  ) {
    return null;
  }

  const figure = event.usage?.toolFigure ?? null;

  return figure === null || figure.kind === "list-price"
    ? orNull(decodeNumber(payload.costUsd))
    : null;
};

const writesOf = (usage: AiUsage): number | null => {
  const { cacheWrite, cacheWrite1h, cacheWrite5m } = usage.tokens;

  return cacheWrite1h === null && cacheWrite5m === null
    ? cacheWrite
    : Math.max(cacheWrite ?? 0, (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0));
};

const usageTokens = (usage: AiUsage): TokenCounts => {
  const { tokens } = usage;

  const entries: readonly (readonly [TokenCategory, number | null])[] = [
    ["input", tokens.inputFresh],
    ["cached-input", tokens.cacheRead],
    ["cache-write", writesOf(usage)],
    ["output", tokens.output],
    ["reasoning", tokens.reasoning],
    ["total", tokens.total],
  ];

  return Object.fromEntries(
    entries.flatMap(([category, value]) =>
      value === null ? [] : [[category, value]]
    )
  );
};

const rawUsageGated = (event: DxEventEnvelope): boolean =>
  rulesForEvent(event).rawUsage?.sourceKind ===
  orNull(decodeText(event.payload.sourceKind));

const requestOf = (event: DxEventEnvelope): PricedRequest | null =>
  event.usage === null || rawUsageGated(event)
    ? null
    : { ai: event.ai, occurredAt: event.occurredAt, usage: event.usage };

const extractEvent = (event: DxEventEnvelope) => {
  const base = baseOf(event);
  const out: Collector = { money: [], rejections: [], tokens: {} };

  fromMeasurements(event, base, out);

  if (!fromCostLedger(event, base, out)) {
    fromCharge(event, base, out);
  }

  fromListPrice(event, base, out);
  fromTokenRecord(event, out);

  if (
    Object.keys(out.tokens).length === 0 &&
    event.usage !== null &&
    !rawUsageGated(event)
  ) {
    Object.assign(out.tokens, usageTokens(event.usage));
  }

  const requests =
    orNull(decodeNumber(event.payload.requests)) ??
    orNull(decodeNumber(event.payload.requestUnits));

  const hasTokens = Object.keys(out.tokens).length > 0;

  const token: TokenReading | null =
    hasTokens || requests !== null
      ? {
          ...base,
          model:
            orNull(decodeText(event.payload.model)) ?? event.ai?.model ?? null,
          request: requestOf(event),
          requests,
          tokens: out.tokens,
        }
      : null;

  return { money: out.money, rejections: out.rejections, token };
};

const kindOf = (sourceKind: string | null) =>
  orNull(
    decodeSourceKind(
      sourceKind === null
        ? null
        : (SOURCE_KIND_ALIASES.get(sourceKind) ?? sourceKind)
    )
  );

const rank = (sourceKind: string | null): number => {
  const kind = kindOf(sourceKind);

  return kind === null ? UNKNOWN_SOURCE_RANK : aiSourceRank(kind);
};

const harnessOfKind = (sourceKind: string | null): string | null => {
  const kind = kindOf(sourceKind);

  return kind === null ? null : aiSourceHarness(kind);
};

interface Deduplicated<T> {
  readonly collapsed: number;
  readonly kept: T[];
}

const preferByPrecedence = <T extends ReadingBase>(
  items: readonly T[],
  keyOf: (item: T) => string
): Deduplicated<T> => {
  const chosen = new Map<string, T>();
  let collapsed = 0;

  for (const item of items) {
    const key = keyOf(item);
    const existing = chosen.get(key);

    if (existing === undefined) {
      chosen.set(key, item);
      continue;
    }

    collapsed += 1;

    if (rank(item.sourceKind) < rank(existing.sourceKind)) {
      chosen.set(key, item);
    }
  }

  return { collapsed, kept: [...chosen.values()] };
};

export const extractReadings = (
  events: readonly DxEventEnvelope[]
): ExtractedReadings => {
  const money: MoneyReading[] = [];
  const tokens: TokenReading[] = [];
  const rejections: Rejection[] = [];
  const listPrices = new Map<string, number>();
  const seen = new Set<string>();

  for (const event of events) {
    if (!event.kind.startsWith("ai.") || seen.has(event.eventId)) {
      continue;
    }

    seen.add(event.eventId);

    const extracted = extractEvent(event);
    const listPrice = listPriceOf(event);
    const key = baseOf(event).dedupeKey;

    if (listPrice !== null && !listPrices.has(key)) {
      listPrices.set(key, listPrice);
    }

    money.push(...extracted.money);
    rejections.push(...extracted.rejections);

    if (extracted.token !== null) {
      tokens.push(extracted.token);
    }
  }

  const moneyKept = preferByPrecedence(
    money,
    (item) => `${item.ledger}|${item.rawField}|${item.dedupeKey}`
  );

  const tokensKept = preferByPrecedence(tokens, (item) => item.dedupeKey);

  return {
    collapsedDuplicates: moneyKept.collapsed + tokensKept.collapsed,
    listPrices,
    money: moneyKept.kept,
    rejections,
    tokens: tokensKept.kept,
  };
};

export interface PreferredSelection<T> {
  readonly alternatives: readonly string[];
  readonly kept: readonly T[];
}

const bestKind = (
  kinds: readonly (string | null)[]
): string | null | undefined => kinds.toSorted((a, b) => rank(a) - rank(b))[0];

const preferredKinds = (
  kinds: readonly (string | null)[]
): ReadonlySet<string | null> => {
  const harnesses = [
    ...new Set(kinds.flatMap((kind) => harnessOfKind(kind) ?? [])),
  ];

  const harnessBests = harnesses.flatMap((harness) => {
    const best = bestKind(
      kinds.filter((kind) => harnessOfKind(kind) === harness)
    );

    return best === undefined ? [] : [best];
  });

  const sharedBest = bestKind(
    kinds.filter((kind) => harnessOfKind(kind) === null)
  );

  if (sharedBest === undefined) {
    return new Set(harnessBests);
  }

  return harnessBests.every((kind) => rank(sharedBest) < rank(kind))
    ? new Set([sharedBest])
    : new Set(harnessBests);
};

export const selectPreferredSource = <T extends ReadingBase>(
  items: readonly T[]
): PreferredSelection<T> => {
  const kinds = [...new Set(items.map((item) => item.sourceKind))];

  if (kinds.length <= 1) {
    return { alternatives: [], kept: items };
  }

  const keep = preferredKinds(kinds);

  return {
    alternatives: kinds.flatMap((kind) =>
      keep.has(kind) ? [] : [kind ?? "unknown"]
    ),
    kept: items.filter((item) => keep.has(item.sourceKind)),
  };
};
