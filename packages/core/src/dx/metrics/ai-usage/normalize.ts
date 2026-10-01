import { Option, Schema } from "effect";

import { rawUsageRuleFor } from "../../harness/rules.js";
import { AI_SOURCES_BY_RANK } from "../../harness/source-kinds.js";
import type {
  AiSourceKind,
  LedgerKind,
  TokenCategory,
} from "../../model/ai.js";
import {
  AiSourceKindSchema,
  LedgerKindSchema,
  TokenCategorySchema,
} from "../../model/ai.js";
import type { ValueMethod } from "../../model/common.js";
import { ValueMethodSchema } from "../../model/common.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { EvidenceId } from "../../model/ids.js";
import { EvidenceIdSchema } from "../../model/ids.js";

export type UsageScope = "detail" | "aggregate";

export interface AiUsageRow {
  readonly adapterId: string;
  readonly branch: string | null;
  readonly category: TokenCategory;
  readonly currency: string | null;
  readonly evidenceId: EvidenceId;
  readonly ledger: LedgerKind;
  readonly matchKeys: readonly string[];
  readonly method: ValueMethod;
  readonly rawCategory: string | null;
  readonly scope: UsageScope;
  readonly sourceKind: AiSourceKind;
  readonly value: number;
}

export interface UncoveredUsage {
  readonly adapterId: string;
  readonly evidenceId: EvidenceId;
  readonly fields: readonly string[];
  readonly reason: string;
  readonly sourceKind: string | null;
}

export interface NormalizedUsage {
  readonly rows: readonly AiUsageRow[];
  readonly uncovered: readonly UncoveredUsage[];
  readonly usageEvents: number;
}

const TOKEN_KEYS = new Map<string, TokenCategory>([
  ["cache-write", "cache-write"],
  ["cacheRead", "cached-input"],
  ["cacheWrite", "cache-write"],
  ["cached-input", "cached-input"],
  ["cachedInput", "cached-input"],
  ["input", "input"],
  ["output", "output"],
  ["reasoning", "reasoning"],
  ["total", "total"],
]);

const TokenMapSchema = Schema.Record(
  Schema.String,
  Schema.NullOr(Schema.Finite)
);

const MeasurementSchema = Schema.Struct({
  category: Schema.optional(TokenCategorySchema),
  currency: Schema.optional(Schema.NullOr(Schema.String)),
  ledger: LedgerKindSchema,
  method: Schema.optional(ValueMethodSchema),
  rawCategory: Schema.optional(Schema.NullOr(Schema.String)),
  unit: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.NullOr(Schema.Finite),
});

type Measurement = typeof MeasurementSchema.Type;

const CostSchema = Schema.Struct({
  currency: Schema.optional(Schema.NullOr(Schema.String)),
  ledger: LedgerKindSchema,
  method: Schema.optional(ValueMethodSchema),
  value: Schema.NullOr(Schema.Finite),
});

const MoneyFieldsSchema = Schema.Struct({
  charge: Schema.optional(Schema.NullOr(Schema.Finite)),
  costLedger: Schema.optional(Schema.NullOr(Schema.String)),
  costUsd: Schema.optional(Schema.NullOr(Schema.Finite)),
  currency: Schema.optional(Schema.NullOr(Schema.String)),
  listPriceEstimateUsd: Schema.optional(Schema.NullOr(Schema.Finite)),
});

type MoneyFields = typeof MoneyFieldsSchema.Type;

const UsageFlagsSchema = Schema.Struct({
  requestKey: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(Schema.NullOr(Schema.String)),
  semanticsVerified: Schema.optional(Schema.Boolean),
  sourceKind: Schema.optional(Schema.NullOr(Schema.String)),
  verifiedRawFields: Schema.optional(Schema.Array(Schema.String)),
});

type UsageFlags = typeof UsageFlagsSchema.Type;

const decodeTokens = Schema.decodeUnknownOption(TokenMapSchema);

const decodeMeasurements = Schema.decodeUnknownOption(
  Schema.Array(Schema.Unknown)
);

const decodeMeasurement = Schema.decodeUnknownOption(MeasurementSchema);

const decodeCost = Schema.decodeUnknownOption(CostSchema);

const decodeMoney = Schema.decodeUnknownOption(MoneyFieldsSchema);

const decodeFlags = Schema.decodeUnknownOption(UsageFlagsSchema);

const decodeRawUsage = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown)
);

const decodeSourceKind = Schema.decodeUnknownOption(AiSourceKindSchema);

const EMPTY_FLAGS: UsageFlags = {};

export const sourceKindFrom = (
  declared: string | null | undefined,
  adapterId: string
): AiSourceKind | null => {
  const name = declared ?? adapterId;
  const direct = decodeSourceKind(name);

  if (Option.isSome(direct)) {
    return direct.value;
  }

  if (name.includes("transcript")) {
    return "transcript-estimate";
  }

  return AI_SOURCES_BY_RANK.find((kind) => name.includes(kind)) ?? null;
};

const present = (value: string | null): value is string =>
  value !== null && value !== "";

export const matchKeysOf = (event: DxEventEnvelope): string[] => {
  const { generationId, requestId, sessionId } = event.identity;
  const keys: string[] = [];

  if (present(requestId)) {
    keys.push(`request:${requestId}`);
  }

  if (present(sessionId)) {
    for (const id of [requestId, generationId]) {
      if (present(id)) {
        keys.push(`session:${sessionId}:id:${id}`);
      }
    }
  }

  return keys;
};

const methodFor = (
  event: DxEventEnvelope,
  fields: readonly string[],
  fallback: ValueMethod = "source-reported"
): ValueMethod =>
  event.fieldSemantics.find((entry) => fields.includes(entry.field))?.method ??
  fallback;

const scopeOf = (
  event: DxEventEnvelope,
  flags: UsageFlags,
  sourceKind: AiSourceKind
): UsageScope => {
  if (flags.scope === "provider-bucket") {
    return "aggregate";
  }

  const keyless =
    event.identity.requestId === null &&
    (flags.requestKey === undefined || flags.requestKey === null);

  return sourceKind === "usage-csv" && keyless ? "aggregate" : "detail";
};

interface RowSeed {
  readonly category: TokenCategory;
  readonly currency: string | null;
  readonly ledger: LedgerKind;
  readonly method: ValueMethod;
  readonly rawCategory: string | null;
  readonly value: number;
}

const tokenSeeds = (
  event: DxEventEnvelope,
  tokens: Readonly<Record<string, number | null>>,
  prefix: string,
  fallbackMethod: (key: string) => ValueMethod = () => "source-reported"
): RowSeed[] =>
  Object.entries(tokens).flatMap(([key, value]) => {
    const category = TOKEN_KEYS.get(key);

    if (category === undefined || value === null) {
      return [];
    }

    return [
      {
        category,
        currency: null,
        ledger: "tokens" as const,
        method: methodFor(
          event,
          [`${prefix}.${key}`, `payload.${prefix}.${key}`],
          fallbackMethod(key)
        ),
        rawCategory: key,
        value,
      },
    ];
  });

const measurementSeed = (entry: Measurement): RowSeed[] => {
  if (entry.value === null) {
    return [];
  }

  const cents = entry.unit === "usd-cents";

  return [
    {
      category:
        entry.ledger === "tokens" ? (entry.category ?? "other") : "other",
      currency: cents ? "USD" : (entry.currency ?? null),
      ledger: entry.ledger,
      method: entry.method ?? "source-reported",
      rawCategory: entry.rawCategory ?? null,
      value: cents ? entry.value / 100 : entry.value,
    },
  ];
};

const moneySeed = (
  ledger: LedgerKind,
  amount: number | null | undefined,
  currency: string | null | undefined,
  method: ValueMethod,
  rawCategory: string
): RowSeed[] =>
  amount === null || amount === undefined
    ? []
    : [
        {
          category: "other",
          currency: currency ?? "USD",
          ledger,
          method,
          rawCategory,
          value: amount,
        },
      ];

const moneySeeds = (money: MoneyFields): RowSeed[] => {
  const seeds = [
    ...moneySeed(
      "charge",
      money.charge,
      money.currency,
      "source-reported",
      "charge"
    ),
    ...moneySeed(
      "list-price-estimate",
      money.listPriceEstimateUsd,
      "USD",
      "estimated",
      "listPriceEstimateUsd"
    ),
  ];

  if (money.costLedger === "metered" || money.costLedger === "unallocated") {
    seeds.push(
      ...moneySeed(
        money.costLedger,
        money.costUsd,
        money.currency,
        "source-reported",
        "costUsd"
      )
    );
  }

  return seeds;
};

const numericRawUsage = (
  event: DxEventEnvelope
): Readonly<Record<string, number>> =>
  Option.match(decodeTokens(event.payload.rawUsage), {
    onNone: () => ({}),
    onSome: (map) =>
      Object.fromEntries(
        Object.entries(map).flatMap(([key, value]) =>
          value === null ? [] : [[key, value] as const]
        )
      ),
  });

const unverifiedUsage = (event: DxEventEnvelope, flags: UsageFlags) => {
  if (flags.semanticsVerified === true) {
    return null;
  }

  const rule = rawUsageRuleFor(flags.sourceKind ?? null);

  return rule === null || event.adapterId !== rule.adapterId
    ? null
    : rule.read(numericRawUsage(event));
};

const hookCategories = (
  event: DxEventEnvelope,
  flags: UsageFlags
): Option.Option<Readonly<Record<string, number | null>>> => {
  if (flags.semanticsVerified === true) {
    return decodeTokens(event.payload.normalizedCategories);
  }

  const legacy = unverifiedUsage(event, flags);

  return legacy === null ? Option.none() : Option.some(legacy.categories);
};

const verifiedRawFieldsOf = (
  event: DxEventEnvelope,
  flags: UsageFlags
): readonly string[] | null => {
  if (flags.semanticsVerified === true) {
    return flags.verifiedRawFields ?? null;
  }

  return unverifiedUsage(event, flags)?.verifiedFields ?? [];
};

const eventSeeds = (event: DxEventEnvelope, flags: UsageFlags): RowSeed[] => {
  const { payload } = event;
  const cost = Option.getOrNull(decodeCost(payload.cost));

  const measurements = Option.getOrElse(
    decodeMeasurements(payload.measurements),
    () => []
  ).flatMap((entry) =>
    Option.match(decodeMeasurement(entry), {
      onNone: () => [],
      onSome: measurementSeed,
    })
  );

  const tokens = Option.match(decodeTokens(payload.tokens), {
    onNone: () => [],
    onSome: (map) => tokenSeeds(event, map, "tokens"),
  });

  const hookTokens = Option.match(hookCategories(event, flags), {
    onNone: () => [],
    onSome: (map) =>
      tokenSeeds(event, map, "normalizedCategories", (key) =>
        key === "input" ? "derived" : "source-reported"
      ),
  });

  const money = Option.match(decodeMoney(payload), {
    onNone: () => [],
    onSome: moneySeeds,
  });

  const costRows =
    cost === null || cost.ledger === "tokens"
      ? []
      : moneySeed(
          cost.ledger,
          cost.value,
          cost.currency,
          cost.method ?? "source-reported",
          "cost"
        );

  return [...measurements, ...tokens, ...hookTokens, ...money, ...costRows];
};

const hookUncovered = (
  event: DxEventEnvelope,
  flags: UsageFlags,
  evidenceId: EvidenceId
): UncoveredUsage[] => {
  const verified = verifiedRawFieldsOf(event, flags);

  if (verified === null) {
    return [];
  }

  const fields = Option.match(decodeRawUsage(event.payload.rawUsage), {
    onNone: () => [],
    onSome: (raw) => Object.keys(raw).filter((key) => !verified.includes(key)),
  });

  if (fields.length === 0) {
    return [];
  }

  const rule = rawUsageRuleFor(flags.sourceKind ?? null);

  return [
    {
      adapterId: event.adapterId,
      evidenceId,
      fields,
      reason:
        rule?.reason ??
        "usage fields with unverified semantics; not summed until a probe verifies them",
      sourceKind: rule?.sourceKind ?? flags.sourceKind ?? null,
    },
  ];
};

const carriesUsage = (event: DxEventEnvelope): boolean =>
  event.kind === "ai.usage" ||
  (event.kind === "ai.turn" &&
    Option.isSome(decodeMeasurements(event.payload.measurements)));

export const normalizeAiUsage = (
  events: readonly DxEventEnvelope[]
): NormalizedUsage => {
  const rows: AiUsageRow[] = [];
  const uncovered: UncoveredUsage[] = [];
  const usageBearing = events.filter(carriesUsage);

  for (const event of usageBearing) {
    const evidenceId = EvidenceIdSchema.make(event.eventId);

    const flags = Option.getOrElse(
      decodeFlags(event.payload),
      () => EMPTY_FLAGS
    );

    const sourceKind = sourceKindFrom(flags.sourceKind, event.adapterId);

    if (sourceKind === null) {
      uncovered.push({
        adapterId: event.adapterId,
        evidenceId,
        fields: [],
        reason: "usage event from an unrecognized AI source kind",
        sourceKind: flags.sourceKind ?? null,
      });
      continue;
    }

    uncovered.push(...hookUncovered(event, flags, evidenceId));

    const scope = scopeOf(event, flags, sourceKind);
    const matchKeys = matchKeysOf(event);

    for (const seed of eventSeeds(event, flags)) {
      rows.push({
        ...seed,
        adapterId: event.adapterId,
        branch: event.context.branch,
        evidenceId,
        matchKeys,
        scope,
        sourceKind,
      });
    }
  }

  return { rows, uncovered, usageEvents: usageBearing.length };
};
