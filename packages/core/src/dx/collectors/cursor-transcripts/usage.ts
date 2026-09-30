import type { FieldSemantics } from "../../model/event.js";

export type TokenCategory =
  | "cache-write"
  | "cached-input"
  | "input"
  | "output"
  | "reasoning"
  | "total";

export type TokenCounts = Readonly<Record<TokenCategory, number | null>>;

export const EMPTY_TOKENS: TokenCounts = {
  "cache-write": null,
  "cached-input": null,
  input: null,
  output: null,
  reasoning: null,
  total: null,
};

const RAW_TO_CATEGORY = new Map<string, TokenCategory>([
  ["cacheCreationInputTokens", "cache-write"],
  ["cacheReadInputTokens", "cached-input"],
  ["cacheReadTokens", "cached-input"],
  ["cacheWriteTokens", "cache-write"],
  ["cache_creation_input_tokens", "cache-write"],
  ["cache_read_input_tokens", "cached-input"],
  ["cachedInputTokens", "cached-input"],
  ["cached_input_tokens", "cached-input"],
  ["completionTokens", "output"],
  ["completion_tokens", "output"],
  ["inputTokens", "input"],
  ["input_tokens", "input"],
  ["outputTokens", "output"],
  ["output_tokens", "output"],
  ["promptTokens", "input"],
  ["prompt_tokens", "input"],
  ["reasoningTokens", "reasoning"],
  ["reasoning_tokens", "reasoning"],
  ["totalTokens", "total"],
  ["total_tokens", "total"],
]);

export type UsageState = "mapped" | "partial" | "unmapped" | "unavailable";

export type UsageCounters = Readonly<Record<string, number>>;

export interface MappedUsage {
  readonly semantics: readonly FieldSemantics[];
  readonly state: UsageState;
  readonly tokens: TokenCounts;
  readonly unmapped: UsageCounters;
}

const MAX_UNMAPPED_KEYS = 20;

export const UNAVAILABLE_USAGE: MappedUsage = {
  semantics: [],
  state: "unavailable",
  tokens: EMPTY_TOKENS,
  unmapped: {},
};

const stateOf = (mapped: number, unmapped: number): UsageState => {
  if (mapped === 0) {
    return unmapped === 0 ? "unavailable" : "unmapped";
  }

  return unmapped === 0 ? "mapped" : "partial";
};

export const mapUsage = (
  usage: UsageCounters | null,
  rawPrefix: string
): MappedUsage => {
  if (usage === null) {
    return UNAVAILABLE_USAGE;
  }

  const tokens: Record<TokenCategory, number | null> = { ...EMPTY_TOKENS };
  const unmapped = new Map<string, number>();
  const semantics: FieldSemantics[] = [];

  for (const [key, value] of Object.entries(usage)) {
    if (value < 0) {
      continue;
    }

    const category = RAW_TO_CATEGORY.get(key);

    if (category === undefined) {
      if (unmapped.size < MAX_UNMAPPED_KEYS) {
        unmapped.set(key, value);
      }

      continue;
    }

    tokens[category] = (tokens[category] ?? 0) + value;
    semantics.push({
      field: `tokens.${category}`,
      method: "source-reported",
      note: null,
      rawName: `${rawPrefix}.${key}`,
      unit: "tokens",
    });
  }

  return {
    semantics,
    state: stateOf(semantics.length, unmapped.size),
    tokens,
    unmapped: Object.fromEntries(unmapped),
  };
};
