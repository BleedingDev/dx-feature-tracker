export type ModelAlias =
  | { readonly key: string; readonly kind: "alias" }
  | { readonly kind: "unpriced"; readonly reason: string };

const alias = (key: string): ModelAlias => ({ key, kind: "alias" });

const unpriced = (reason: string): ModelAlias => ({ kind: "unpriced", reason });

const NO_FIXED_MODEL = unpriced(
  "Auto/default has no fixed model and the tool does not report the model behind it"
);

export const MODEL_ALIASES: ReadonlyMap<string, ModelAlias> = new Map([
  ["auto", NO_FIXED_MODEL],
  ["default", NO_FIXED_MODEL],
  [
    "codex-auto-review",
    unpriced(
      "Codex's built-in approval reviewer; OpenAI publishes no price for it"
    ),
  ],
  [
    "claude-luna",
    unpriced(
      "a model router profile name; the upstream model it dispatched to is the one to price"
    ),
  ],
  ["deepseek-v4.1-flash", alias("deepseek-flash")],
  ["deepseek-v4-1-flash", alias("deepseek-flash")],
  ["gpt-5-codex", alias("gpt-5")],
  ["gpt-5-codex-mini", alias("gpt-5-mini")],
  ["gpt-5.1-codex", alias("gpt-5.1")],
  ["gpt-5.1-codex-max", alias("gpt-5.1")],
  ["gpt-5.1-codex-mini", alias("gpt-5-mini")],
  ["gpt-5.2-codex", alias("gpt-5.2")],
]);

const EFFORT_SUFFIX =
  /-(?:thinking(?:-[a-z]+)?|low|medium|high|xhigh|max|minimal|none)$/u;

const FAST_SUFFIX = "-fast";

const DATE_SUFFIX = /(?:-|@)20\d{2}-?\d{2}-?\d{2}$/u;

const DEEPSEEK_SNAPSHOT_SUFFIX =
  /^(?<name>deepseek-.+)-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u;

const BEDROCK_PREFIX = /^(?:(?:us|eu|apac|global|jp|au)\.)?anthropic\./u;

const BEDROCK_VERSION = /-v\d+:\d+$/u;

const BRACKET_SUFFIX = /\[[^\]]*\]$/u;

const REORDERED_CLAUDE =
  /^claude-(?<version>\d+(?:-\d+)?)-(?<family>opus|sonnet|haiku|fable|mythos)$/u;

const DOTTED_FAMILY = /^(?:gpt|gemini|grok|kimi|glm|deepseek|o\d)-/u;

const lastSegment = (raw: string): string =>
  raw.trim().toLowerCase().split("/").at(-1)?.trim() ?? "";

export interface ModelName {
  readonly base: string;
  readonly impliedSpeed: "fast" | null;
}

export const parseModelName = (raw: string): ModelName => {
  let name = lastSegment(raw)
    .replace(BRACKET_SUFFIX, "")
    .replace(BEDROCK_PREFIX, "")
    .replace(BEDROCK_VERSION, "");

  let fast = false;
  let changed = true;

  while (changed) {
    const before = name;

    if (name.endsWith(FAST_SUFFIX)) {
      fast = true;
      name = name.slice(0, -FAST_SUFFIX.length);
    }

    name = name.replace(EFFORT_SUFFIX, "");
    changed = name !== before;
  }

  return { base: name, impliedSpeed: fast ? "fast" : null };
};

const claudeForms = (name: string): readonly string[] => {
  if (!name.startsWith("claude-")) {
    return [];
  }

  const dashed = name.replaceAll(".", "-");
  const reordered = REORDERED_CLAUDE.exec(dashed);

  return reordered?.groups === undefined
    ? [dashed]
    : [
        dashed,
        `claude-${reordered.groups.family ?? ""}-${reordered.groups.version ?? ""}`,
      ];
};

const dottedForms = (name: string): readonly string[] =>
  DOTTED_FAMILY.test(name)
    ? [name.replace(/(?<major>\d)-(?<minor>\d)(?=-|$)/u, "$<major>.$<minor>")]
    : [];

export const withoutDate = (key: string): string =>
  key.replace(DATE_SUFFIX, "");

export const candidateKeys = (base: string): readonly string[] => {
  const undated = withoutDate(base).replace(
    DEEPSEEK_SNAPSHOT_SUFFIX,
    "$<name>"
  );

  return [
    ...new Set([
      base,
      ...claudeForms(base),
      ...dottedForms(base),
      undated,
      ...claudeForms(undated),
      ...dottedForms(undated),
    ]),
  ].filter((key) => key !== "");
};

export type KeyResolution =
  | {
      readonly impliedSpeed: "fast" | null;
      readonly key: string;
      readonly kind: "key";
    }
  | { readonly kind: "unpriced"; readonly reason: string };

export const resolvePriceKey = (
  raw: string | null,
  has: (key: string) => boolean
): KeyResolution => {
  if (raw === null || raw.trim() === "") {
    return { kind: "unpriced", reason: "the tool recorded no model" };
  }

  const { base, impliedSpeed } = parseModelName(raw);

  for (const candidate of candidateKeys(base)) {
    const aliased = MODEL_ALIASES.get(candidate);

    if (aliased?.kind === "unpriced") {
      return aliased;
    }

    if (has(candidate)) {
      return { impliedSpeed, key: candidate, kind: "key" };
    }

    if (aliased?.kind === "alias" && has(aliased.key)) {
      return { impliedSpeed, key: aliased.key, kind: "key" };
    }
  }

  return {
    kind: "unpriced",
    reason: `no public price for ${base}; not guessed`,
  };
};
