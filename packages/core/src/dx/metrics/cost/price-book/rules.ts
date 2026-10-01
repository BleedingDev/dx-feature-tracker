import type { ModelProvider } from "../../../harness/ids.js";

export const PRICING_RULES_SOURCE =
  "Maker pricing pages read 2026-10-01: Anthropic prompt caching (5 minute write 1.25x input, 1 hour write 2x input), Anthropic fast mode (Claude Opus 5 and 5.5 at 2x, Claude Opus 4.6 at 6x), Anthropic web search (USD 10 per 1,000 searches), OpenAI Priority processing (2x) and Flex and Batch (0.5x), GitHub Copilot premium requests (USD 0.04 each).";

export const ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER = 1.25;

export const ANTHROPIC_CACHE_WRITE_1H_MULTIPLIER = 2;

export const COPILOT_PREMIUM_REQUEST_USD = 0.04;

export const WEB_SEARCH_USD_PER_REQUEST: ReadonlyMap<ModelProvider, number> =
  new Map([["anthropic", 0.01]]);

export const FAST_MODE_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ["claude-opus-5-5", 2],
  ["claude-opus-5", 2],
  ["claude-opus-4-6", 6],
]);

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

const speedPricing = (key: string, speed: "fast" | null): TierPricing => {
  if (speed === null) {
    return standard;
  }

  const multiplier = FAST_MODE_MULTIPLIERS.get(key);

  return multiplier === undefined
    ? { label: null, multiplier: 1, unpricedTier: "fast" }
    : { label: "fast", multiplier, unpricedTier: null };
};

const serviceTierPricing = (
  maker: ModelProvider,
  serviceTier: string | null
): TierPricing => {
  const tier = serviceTier?.trim().toLowerCase() ?? "";

  if (STANDARD_TIERS.has(tier)) {
    return standard;
  }

  const multiplier = SERVICE_TIER_MULTIPLIERS.get(maker)?.get(tier);

  if (multiplier !== undefined) {
    return { label: tier, multiplier, unpricedTier: null };
  }

  return maker === "anthropic" && tier === "priority"
    ? { label: tier, multiplier: 1, unpricedTier: null }
    : { label: null, multiplier: 1, unpricedTier: tier };
};

export const tierPricing = (
  maker: ModelProvider,
  key: string,
  serviceTier: string | null,
  speed: string | null
): TierPricing => {
  const fast = speed?.trim().toLowerCase() === "fast";
  const byTier = serviceTierPricing(maker, serviceTier);

  if (maker !== "anthropic") {
    return byTier.label === null && byTier.unpricedTier === null && fast
      ? serviceTierPricing(maker, "fast")
      : byTier;
  }

  const bySpeed = speedPricing(key, fast ? "fast" : null);

  const labels = [bySpeed.label, byTier.label].filter(
    (label): label is string => label !== null
  );

  return {
    label: labels.length === 0 ? null : labels.join("+"),
    multiplier: bySpeed.multiplier * byTier.multiplier,
    unpricedTier: bySpeed.unpricedTier ?? byTier.unpricedTier,
  };
};
