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

const LOCAL_RUNTIMES: ReadonlySet<string> = new Set([
  "ollama",
  "lmstudio",
  "lm-studio",
  "llama.cpp",
  "llamacpp",
  "vllm",
  "local",
  "mlx",
]);

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

  return KNOWN_GATEWAYS.includes(alias) ? alias : null;
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
    if (LOCAL_RUNTIMES.has(segment)) {
      return "local";
    }

    const provider = PROVIDER_PREFIXES.get(segment);

    if (provider !== undefined) {
      return provider;
    }
  }

  return null;
};

export const inferProvider = (raw: string | null): ModelProvider => {
  if (raw === null || raw.trim() === "") {
    return "unknown";
  }

  const fromPrefix = providerFromPrefix(raw);

  if (fromPrefix !== null) {
    return fromPrefix;
  }

  const name = normalizeModel(raw) ?? "";

  return (
    MODEL_PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? "unknown"
  );
};

export const providerFor = (
  raw: string | null,
  hint: string | null
): ModelProvider => {
  if (hint !== null) {
    const normalized = hint.trim().toLowerCase();

    if (LOCAL_RUNTIMES.has(normalized)) {
      return "local";
    }

    const direct = PROVIDER_PREFIXES.get(normalized);

    if (direct !== undefined) {
      return direct;
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
