import { DateTime, Option } from "effect";

import type { ModelProvider } from "../../../harness/ids.js";
import { versionAt } from "./sheet.js";

export const PRICING_RULES_SOURCE =
  "Maker pricing pages read 2026-10-01: Anthropic prompt caching (5 minute write 1.25x input, 1 hour write 2x input), Anthropic fast mode (Claude Opus 5.5, Opus 5 and Opus 4.8 at 2x; Opus 4.6 at USD 30/150 per million, 6x, from its 2026-02-07 launch with half off through 2026-02-16, and billed at standard since its removal on 2026-06-29; Opus 4.7 at the Opus 4.6 price from 2026-05-12 until its removal on 2026-07-24, per the Claude API release notes), Anthropic web search (USD 10 per 1,000 searches), OpenAI web search tool (USD 10 per 1,000 calls; search content tokens are already in the request's tokens), OpenAI Fast, formerly Priority (2x, except gpt-5.5 2.5x, gpt-5-mini 1.8x, gpt-4.1 and o3 1.75x, gpt-4o 1.7x, o4-mini 20/11x), OpenAI Ultrafast (gpt-6-astra 6x), OpenAI Flex and Batch (0.5x), DeepSeek peak hours (2x, 01:00-04:00 and 06:00-10:00 UTC on weekdays; Chinese public holidays are not modelled), GitHub Copilot premium requests (USD 0.04 each).";

export const ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER = 1.25;

export const ANTHROPIC_CACHE_WRITE_1H_MULTIPLIER = 2;

export const COPILOT_PREMIUM_REQUEST_USD = 0.04;

export const WEB_SEARCH_USD_PER_REQUEST: ReadonlyMap<ModelProvider, number> =
  new Map([
    ["anthropic", 0.01],
    ["openai", 0.01],
  ]);

export interface DatedMultiplier {
  readonly effectiveFrom: string | null;
  readonly multiplier: number;
}

const always = (multiplier: number): readonly DatedMultiplier[] => [
  { effectiveFrom: null, multiplier },
];

export const FAST_MODE_MULTIPLIERS: ReadonlyMap<
  string,
  readonly DatedMultiplier[]
> = new Map([
  ["claude-opus-5-5", always(2)],
  ["claude-opus-5", always(2)],
  ["claude-opus-4-8", always(2)],
  ["claude-opus-4-7", always(6)],
  [
    "claude-opus-4-6",
    [
      { effectiveFrom: null, multiplier: 3 },
      { effectiveFrom: "2026-02-17T00:00:00.000Z", multiplier: 6 },
      { effectiveFrom: "2026-06-29T00:00:00.000Z", multiplier: 1 },
    ],
  ],
]);

const OPENAI_FAST_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ["gpt-5.5", 2.5],
  ["gpt-5-mini", 1.8],
  ["gpt-4.1", 1.75],
  ["o3", 1.75],
  ["gpt-4o", 1.7],
  ["o4-mini", 20 / 11],
]);

const MODEL_TIER_MULTIPLIERS: ReadonlyMap<
  ModelProvider,
  ReadonlyMap<string, ReadonlyMap<string, number>>
> = new Map([
  [
    "openai",
    new Map([
      ["priority", OPENAI_FAST_MULTIPLIERS],
      ["fast", OPENAI_FAST_MULTIPLIERS],
      ["ultrafast", new Map([["gpt-6-astra", 6]])],
    ]),
  ],
]);

const DEEPSEEK_PEAK_MULTIPLIER = 2;

const DEEPSEEK_PEAK_UTC_HOURS = new Set([1, 2, 3, 6, 7, 8, 9]);

const SERVICE_TIER_MULTIPLIERS: ReadonlyMap<
  ModelProvider,
  ReadonlyMap<string, number>
> = new Map([
  [
    "openai",
    new Map([
      ["priority", 2],
      ["fast", 2],
      ["flex", 0.5],
      ["batch", 0.5],
    ]),
  ],
  ["anthropic", new Map([["batch", 0.5]])],
]);

const STANDARD_TIERS = new Set([
  "",
  "standard",
  "default",
  "auto",
  "on_demand",
]);

export interface TierPricing {
  readonly label: string | null;
  readonly multiplier: number;
  readonly unpricedTier: string | null;
}

const standard: TierPricing = {
  label: null,
  multiplier: 1,
  unpricedTier: null,
};

const speedPricing = (
  key: string,
  speed: "fast" | null,
  at: string | null
): TierPricing => {
  if (speed === null) {
    return standard;
  }

  const multiplier = versionAt(
    FAST_MODE_MULTIPLIERS.get(key) ?? [],
    at
  )?.multiplier;

  return multiplier === undefined
    ? { label: null, multiplier: 1, unpricedTier: "fast" }
    : { label: "fast", multiplier, unpricedTier: null };
};

const serviceTierPricing = (
  maker: ModelProvider,
  key: string,
  serviceTier: string | null
): TierPricing => {
  const tier = serviceTier?.trim().toLowerCase() ?? "";

  if (STANDARD_TIERS.has(tier)) {
    return standard;
  }

  const multiplier =
    MODEL_TIER_MULTIPLIERS.get(maker)?.get(tier)?.get(key) ??
    SERVICE_TIER_MULTIPLIERS.get(maker)?.get(tier);

  if (multiplier !== undefined) {
    return { label: tier, multiplier, unpricedTier: null };
  }

  return maker === "anthropic" && tier === "priority"
    ? { label: tier, multiplier: 1, unpricedTier: null }
    : { label: null, multiplier: 1, unpricedTier: tier };
};

const isDeepseekPeak = (at: string | null): boolean =>
  Option.match(at === null ? Option.none() : DateTime.make(at), {
    onNone: () => false,
    onSome: (when) => {
      const { hour, weekDay } = DateTime.toPartsUtc(when);

      return weekDay >= 1 && weekDay <= 5 && DEEPSEEK_PEAK_UTC_HOURS.has(hour);
    },
  });

const timeOfDayPricing = (
  maker: ModelProvider,
  at: string | null
): TierPricing =>
  maker === "deepseek" && isDeepseekPeak(at)
    ? {
        label: "peak",
        multiplier: DEEPSEEK_PEAK_MULTIPLIER,
        unpricedTier: null,
      }
    : standard;

const combine = (parts: readonly TierPricing[]): TierPricing => {
  const labels = parts.flatMap((part) =>
    part.label === null ? [] : [part.label]
  );

  return {
    label: labels.length === 0 ? null : labels.join("+"),
    multiplier: parts.reduce((product, part) => product * part.multiplier, 1),
    unpricedTier:
      parts.find((part) => part.unpricedTier !== null)?.unpricedTier ?? null,
  };
};

export interface TierRequest {
  readonly at: string | null;
  readonly key: string;
  readonly maker: ModelProvider;
  readonly serviceTier: string | null;
  readonly speed: string | null;
}

const speedOrTier = ({
  at,
  key,
  maker,
  serviceTier,
  speed,
}: TierRequest): readonly TierPricing[] => {
  const fast = speed?.trim().toLowerCase() === "fast";
  const byTier = serviceTierPricing(maker, key, serviceTier);

  if (maker === "anthropic") {
    return [speedPricing(key, fast ? "fast" : null, at), byTier];
  }

  return byTier.label === null && byTier.unpricedTier === null && fast
    ? [serviceTierPricing(maker, key, "fast")]
    : [byTier];
};

export const tierPricing = (request: TierRequest): TierPricing =>
  combine([
    ...speedOrTier(request),
    timeOfDayPricing(request.maker, request.at),
  ]);
