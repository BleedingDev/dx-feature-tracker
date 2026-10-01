import { Option, Schema } from "effect";

import type {
  AiAttribution,
  AiTokens,
  AiUsage,
  ToolFigure,
  ToolFigureKind,
} from "../model/attribution.js";
import { hasKnownTokens, unknownTokens } from "../model/attribution.js";
import type { DxEventEnvelope } from "../model/event.js";
import type { BranchSource, Channel, HarnessId } from "./ids.js";
import { normalizeModel, providerFor, viaFor } from "./provider.js";
import { rawUsageRuleFor, rulesFor } from "./rules.js";

export interface CollectorOrigin {
  readonly channel: Channel;
  readonly estimateKind: ToolFigureKind;
  readonly harness: HarnessId | null;
  readonly inputIncludesCache: boolean;
  readonly storesCharge: boolean;
  readonly via: string | null;
}

const cursor = (channel: Channel): CollectorOrigin => ({
  channel,
  estimateKind: "list-price",
  harness: "cursor",
  inputIncludesCache: false,
  storesCharge: true,
  via: "cursor",
});

const tokensOnly = (
  harness: HarnessId | null,
  channel: Channel,
  inputIncludesCache: boolean
): CollectorOrigin => ({
  channel,
  estimateKind: "api-equivalent",
  harness,
  inputIncludesCache,
  storesCharge: false,
  via: null,
});

const BILLING_EXPORT: CollectorOrigin = {
  channel: "usage-api",
  estimateKind: "list-price",
  harness: null,
  inputIncludesCache: false,
  storesCharge: true,
  via: null,
};

export const COLLECTOR_ORIGINS: ReadonlyMap<string, CollectorOrigin> = new Map([
  ["cursor-hooks", cursor("hooks")],
  ["cursor-local-db", cursor("local-db")],
  ["cursor-chats-store", cursor("local-db")],
  ["cursor-cli", cursor("cli-stream")],
  ["cursor-sdk", cursor("cli-stream")],
  ["cursor-transcripts", cursor("transcript")],
  ["cursor-usage-export", cursor("usage-api")],
  ["cursor-usage-api", cursor("usage-api")],
  ["cursor-dashboard-response", cursor("usage-api")],
  ["cursor-extension", cursor("extension")],
  ["claude-jsonl", tokensOnly("claude-code", "session-file", false)],
  ["codex-session", tokensOnly("codex", "session-file", true)],
  ["opencode", tokensOnly("opencode", "session-file", false)],
  ["entire", tokensOnly(null, "transcript", false)],
  ["provider-usage", BILLING_EXPORT],
]);

export type EventWithoutBlocks = Omit<DxEventEnvelope, "ai" | "usage">;

const Text = Schema.NullOr(Schema.String);

const Amount = Schema.NullOr(Schema.Finite);

const TokenMap = Schema.Record(Schema.String, Schema.NullOr(Schema.Finite));

const CostSchema = Schema.Struct({
  currency: Schema.optional(Text),
  ledger: Schema.String,
  value: Amount,
});

const MeasurementSchema = Schema.Struct({
  category: Schema.optional(Text),
  ledger: Schema.String,
  value: Amount,
});

type Payload = DxEventEnvelope["payload"];

const textField = (payload: Payload, key: string): string | null =>
  Option.getOrNull(
    Schema.decodeUnknownOption(Schema.NonEmptyString)(payload[key])
  );

const amountField = (payload: Payload, key: string): number | null =>
  Option.getOrNull(Schema.decodeUnknownOption(Schema.Finite)(payload[key]));

const tokenMapField = (
  payload: Payload,
  key: string
): Readonly<Record<string, number | null>> | null =>
  Option.getOrNull(Schema.decodeUnknownOption(TokenMap)(payload[key]));

const TOKEN_ALIASES: ReadonlyMap<string, keyof AiTokens> = new Map([
  ["input", "inputFresh"],
  ["inputFresh", "inputFresh"],
  ["cached-input", "cacheRead"],
  ["cachedInput", "cacheRead"],
  ["cacheRead", "cacheRead"],
  ["cache-write", "cacheWrite"],
  ["cacheWrite", "cacheWrite"],
  ["cacheWrite5m", "cacheWrite5m"],
  ["cacheWrite1h", "cacheWrite1h"],
  ["output", "output"],
  ["reasoning", "reasoning"],
  ["total", "total"],
]);

const countOrNull = (value: number | null | undefined): number | null =>
  value === null || value === undefined || value < 0 ? null : value;

const mergeTokens = (
  into: Record<keyof AiTokens, number | null>,
  entries: Iterable<readonly [string, number | null]>
): void => {
  for (const [key, value] of entries) {
    const field = TOKEN_ALIASES.get(key);
    const count = countOrNull(value);

    if (field !== undefined && count !== null) {
      into[field] = (into[field] ?? 0) + count;
    }
  }
};

const measurementTokens = (payload: Payload) =>
  Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(
      payload.measurements
    ),
    () => []
  ).flatMap((item) => {
    const entry = Option.getOrNull(
      Schema.decodeUnknownOption(MeasurementSchema)(item)
    );

    const category = entry?.category ?? null;

    return entry !== null && entry.ledger === "tokens" && category !== null
      ? [[category, entry.value] as const]
      : [];
  });

const hookTokens = (
  payload: Payload
): Readonly<Record<string, number | null>> | null => {
  if (payload.semanticsVerified === true) {
    return tokenMapField(payload, "normalizedCategories");
  }

  const rule = rawUsageRuleFor(textField(payload, "sourceKind"));

  if (rule === null) {
    return null;
  }

  const raw = tokenMapField(payload, "rawUsage") ?? {};

  const numeric = Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) =>
      value === null ? [] : [[key, value] as const]
    )
  );

  return rule.read(numeric)?.categories ?? null;
};

const tokensOf = (event: EventWithoutBlocks, origin: CollectorOrigin) => {
  const { payload } = event;
  const tokens: Record<keyof AiTokens, number | null> = { ...unknownTokens };

  mergeTokens(tokens, Object.entries(tokenMapField(payload, "tokens") ?? {}));
  mergeTokens(tokens, measurementTokens(payload));
  mergeTokens(tokens, Object.entries(hookTokens(payload) ?? {}));

  if (origin.inputIncludesCache && tokens.inputFresh !== null) {
    tokens.inputFresh = Math.max(
      tokens.inputFresh - (tokens.cacheRead ?? 0) - (tokens.cacheWrite ?? 0),
      0
    );
  }

  return tokens;
};

const figure = (
  amount: number | null,
  currency: string | null,
  kind: ToolFigureKind
): ToolFigure | null =>
  amount === null ? null : { amount, currency: currency ?? "USD", kind };

const costFigure = (
  payload: Payload,
  origin: CollectorOrigin
): ToolFigure | null => {
  const cost = Option.getOrNull(
    Schema.decodeUnknownOption(CostSchema)(payload.cost)
  );

  if (cost === null || cost.value === null) {
    return null;
  }

  if (cost.ledger === "charge" || cost.ledger === "metered") {
    return origin.storesCharge
      ? figure(cost.value, cost.currency ?? null, "charge")
      : figure(cost.value, cost.currency ?? null, origin.estimateKind);
  }

  return cost.ledger === "list-price-estimate"
    ? figure(cost.value, cost.currency ?? null, origin.estimateKind)
    : null;
};

const toolFigureOf = (
  payload: Payload,
  origin: CollectorOrigin
): ToolFigure | null => {
  const currency = textField(payload, "currency");
  const charge = amountField(payload, "charge");

  if (charge !== null && origin.storesCharge) {
    return figure(charge, currency, "charge");
  }

  const ledger = textField(payload, "costLedger");
  const costUsd = amountField(payload, "costUsd");

  if (
    origin.storesCharge &&
    costUsd !== null &&
    (ledger === "charge" || ledger === "metered")
  ) {
    return figure(costUsd, currency, "charge");
  }

  return (
    figure(
      amountField(payload, "listPriceEstimateUsd"),
      "USD",
      origin.estimateKind
    ) ?? costFigure(payload, origin)
  );
};

const LEGACY_BRANCH_SOURCES: ReadonlyMap<string, BranchSource> = new Map([
  ["claude-jsonl", "harness-recorded"],
  ["cursor-agent-store", "session-recorded"],
  ["collect-context", "cwd-inferred"],
]);

const branchSourceOf = (
  event: EventWithoutBlocks,
  origin: CollectorOrigin
): BranchSource => {
  if (event.context.branch === null) {
    return "unassigned";
  }

  const declared = textField(event.payload, "branchSource");
  const legacy = declared === null ? null : LEGACY_BRANCH_SOURCES.get(declared);

  if (legacy !== undefined && legacy !== null) {
    return legacy;
  }

  return origin.channel === "hooks" ? "hook" : "cwd-inferred";
};

const EFFORT_SOURCES = {
  "model-name-suffix": "model-suffix",
  "source-field": "harness-recorded",
  unavailable: null,
} as const;

const modelEffortOf = (
  payload: Payload,
  modelRaw: string | null,
  harness: HarnessId
) => {
  const recorded =
    textField(payload, "effort") ?? textField(payload, "reasoningEffort");

  if (modelRaw === null) {
    return {
      base: null,
      effort: recorded,
      effortSource: recorded === null ? null : ("harness-recorded" as const),
    };
  }

  const parsed = rulesFor(harness).effort(modelRaw, recorded);

  return {
    base: parsed.model,
    effort: parsed.effort,
    effortSource: EFFORT_SOURCES[parsed.effortSource],
  };
};

const attributionOf = (
  event: EventWithoutBlocks,
  origin: CollectorOrigin,
  harness: HarnessId
): AiAttribution => {
  const { payload } = event;

  const modelRaw =
    textField(payload, "model") ??
    textField(payload, "modelId") ??
    textField(payload, "modelID");

  const providerHint = textField(payload, "providerId");

  const { base, effort, effortSource } = modelEffortOf(
    payload,
    modelRaw,
    harness
  );

  return {
    agentId: textField(payload, "subagentId") ?? textField(payload, "agentId"),
    agentType:
      textField(payload, "subagentType") ?? textField(payload, "agentType"),
    branchSource: branchSourceOf(event, origin),
    channel: origin.channel,
    cwd: textField(payload, "cwd") ?? textField(payload, "directory"),
    effort,
    effortSource,
    harness,
    harnessVersion: event.sourceVersion,
    model: normalizeModel(base),
    modelRaw,
    parentSessionId: textField(payload, "parentSessionId"),
    provider: providerFor(base, providerHint),
    sessionId: event.identity.sessionId,
    via: viaFor(modelRaw, providerHint) ?? origin.via,
  };
};

const usageOf = (
  event: EventWithoutBlocks,
  origin: CollectorOrigin
): AiUsage | null => {
  const tokens = tokensOf(event, origin);
  const toolFigure = toolFigureOf(event.payload, origin);

  if (!hasKnownTokens(tokens) && toolFigure === null) {
    return null;
  }

  return {
    premiumRequests: countOrNull(amountField(event.payload, "premiumRequests")),
    requestKey: textField(event.payload, "requestKey"),
    serviceTier: textField(event.payload, "serviceTier"),
    speed: null,
    tokens,
    toolFigure,
  };
};

const SOURCE_KIND_ORIGINS: ReadonlyMap<string, CollectorOrigin> = new Map([
  ["usage-csv", cursor("usage-api")],
  ["dashboard-json", cursor("usage-api")],
  ["dashboard-response", cursor("usage-api")],
  ["sdk", cursor("cli-stream")],
  ["cursor-cli", cursor("cli-stream")],
  ["hooks-stop", cursor("hooks")],
  ["local-db", cursor("local-db")],
  ["transcript-estimate", cursor("transcript")],
  ["entire", tokensOnly(null, "transcript", false)],
  ["provider-receipt", BILLING_EXPORT],
]);

export const originOf = (event: EventWithoutBlocks): CollectorOrigin => {
  const direct = COLLECTOR_ORIGINS.get(event.adapterId);

  if (direct !== undefined) {
    return direct;
  }

  const declared = textField(event.payload, "sourceKind");

  const bySource =
    declared === null ? undefined : SOURCE_KIND_ORIGINS.get(declared);

  if (bySource !== undefined) {
    return bySource;
  }

  return event.adapterId.startsWith("cursor")
    ? cursor("usage-api")
    : BILLING_EXPORT;
};

const isAiKind = (event: EventWithoutBlocks): boolean =>
  event.kind.startsWith("ai.");

export const collectorBlocks = (
  event: EventWithoutBlocks
): Pick<DxEventEnvelope, "ai" | "usage"> => {
  if (!isAiKind(event)) {
    return { ai: null, usage: null };
  }

  const origin = originOf(event);

  return {
    ai:
      origin.harness === null
        ? null
        : attributionOf(event, origin, origin.harness),
    usage: usageOf(event, origin),
  };
};

export const withCollectorBlocks = (
  event: EventWithoutBlocks
): DxEventEnvelope => ({ ...event, ...collectorBlocks(event) });
