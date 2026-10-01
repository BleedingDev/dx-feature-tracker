import type { ModelProvider } from "./ids.js";

export const KNOWN_GATEWAYS: readonly string[] = [
  "cliproxy",
  "openrouter",
  "github-copilot",
  "cursor",
  "litellm",
  "requesty",
  "vercel",
];

const GATEWAY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["copilot", "github-copilot"],
  ["githubcopilot", "github-copilot"],
  ["github", "github-copilot"],
  ["vercel-ai-gateway", "vercel"],
]);

export const LOCAL_RUNTIMES: readonly string[] = [
  "ollama",
  "lmstudio",
  "llama.cpp",
  "vllm",
  "mlx",
  "local",
];

const LOCAL_RUNTIME_ALIASES: ReadonlyMap<string, string> = new Map([
  ["lm-studio", "lmstudio"],
  ["llamacpp", "llama.cpp"],
]);

const localRuntimeOf = (segment: string): string | null => {
  const alias = LOCAL_RUNTIME_ALIASES.get(segment) ?? segment;

  return LOCAL_RUNTIMES.includes(alias) ? alias : null;
};

export const isLocalRuntime = (via: string | null): boolean =>
  via !== null && LOCAL_RUNTIMES.includes(via);

const PROVIDER_PREFIXES: ReadonlyMap<string, ModelProvider> = new Map([
  ["anthropic", "anthropic"],
  ["claude", "anthropic"],
  ["openai", "openai"],
  ["azure", "openai"],
  ["google", "google"],
  ["gemini", "google"],
  ["vertex", "google"],
  ["deepseek", "deepseek"],
  ["xai", "xai"],
  ["x-ai", "xai"],
  ["moonshot", "moonshot"],
  ["moonshotai", "moonshot"],
  ["kimi", "moonshot"],
  ["zhipu", "zhipu"],
  ["zhipuai", "zhipu"],
  ["z-ai", "zhipu"],
  ["zai", "zhipu"],
  ["qwen", "qwen"],
  ["alibaba", "qwen"],
  ["meta", "meta"],
  ["meta-llama", "meta"],
  ["mistral", "mistral"],
  ["mistralai", "mistral"],
]);

const MODEL_PATTERNS: readonly (readonly [RegExp, ModelProvider])[] = [
  [/claude|opus|sonnet|haiku/u, "anthropic"],
  [/^(?:gpt|o1|o3|o4|chatgpt|codex|davinci|text-embedding)/u, "openai"],
  [/gemini|gemma/u, "google"],
  [/deepseek/u, "deepseek"],
  [/grok/u, "xai"],
  [/kimi|moonshot/u, "moonshot"],
  [/glm|chatglm|zhipu/u, "zhipu"],
  [/qwen|qwq/u, "qwen"],
  [/llama/u, "meta"],
  [/mistral|mixtral|codestral|devstral|magistral|ministral/u, "mistral"],
  [/^(?:auto|default|composer|cursor-small|cursor-fast)/u, "cursor"],
];

const DATE_SUFFIX = /-20\d{2}-?\d{2}-?\d{2}$/u;

const segmentsOf = (raw: string): readonly string[] =>
  raw
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "");

const gatewayOf = (segment: string): string | null => {
  const alias = GATEWAY_ALIASES.get(segment) ?? segment;

  return KNOWN_GATEWAYS.includes(alias) ? alias : localRuntimeOf(segment);
};

export const normalizeModel = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }

  const name = segmentsOf(raw).at(-1);

  return name === undefined
    ? null
    : name.replace(DATE_SUFFIX, "").replace(/\[[^\]]*\]$/u, "");
};

export const inferVia = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }

  for (const segment of segmentsOf(raw).slice(0, -1)) {
    const gateway = gatewayOf(segment);

    if (gateway !== null) {
      return gateway;
    }
  }

  return null;
};

const providerFromPrefix = (raw: string): ModelProvider | null => {
  for (const segment of segmentsOf(raw).slice(0, -1)) {
    const provider = PROVIDER_PREFIXES.get(segment);

    if (provider !== undefined) {
      return provider;
    }
  }

  return null;
};

const makerOf = (raw: string): ModelProvider => {
  const fromPrefix = providerFromPrefix(raw);

  if (fromPrefix !== null) {
    return fromPrefix;
  }

  const name = normalizeModel(raw) ?? "";

  return (
    MODEL_PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? "unknown"
  );
};

const runsLocally = (raw: string): boolean =>
  segmentsOf(raw)
    .slice(0, -1)
    .some((segment) => localRuntimeOf(segment) !== null);

export const inferProvider = (raw: string | null): ModelProvider => {
  if (raw === null || raw.trim() === "") {
    return "unknown";
  }

  const maker = makerOf(raw);

  return maker === "unknown" && runsLocally(raw) ? "local" : maker;
};

export const providerFor = (
  raw: string | null,
  hint: string | null
): ModelProvider => {
  if (hint !== null) {
    const normalized = hint.trim().toLowerCase();
    const direct = PROVIDER_PREFIXES.get(normalized);

    if (direct !== undefined) {
      return direct;
    }

    if (localRuntimeOf(normalized) !== null) {
      const maker = inferProvider(raw);

      return maker === "unknown" ? "local" : maker;
    }
  }

  return inferProvider(raw);
};

export const viaFor = (
  raw: string | null,
  hint: string | null
): string | null =>
  (hint === null ? null : gatewayOf(hint.trim().toLowerCase())) ??
  inferVia(raw);
