export type EffortSource = "model-name-suffix" | "source-field" | "unavailable";

export interface ModelEffort {
  readonly model: string;
  readonly effort: string | null;
  readonly effortSource: EffortSource;
  readonly effortReason: string | null;
}

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "thinking",
]);

const AUTO_MODELS: ReadonlySet<string> = new Set(["auto", "default"]);

const splitSuffix = (raw: string) => {
  const tokens = raw.split("-");
  const stripped: string[] = [];

  while (tokens.length > 1) {
    const last = tokens.at(-1)?.toLowerCase() ?? "";

    if (!EFFORT_LEVELS.has(last)) {
      break;
    }

    stripped.unshift(last);
    tokens.pop();
  }

  return { base: tokens.join("-"), stripped };
};

export const parseModelEffort = (
  rawModel: string,
  sourceEffort: string | null = null
): ModelEffort => {
  const trimmed = rawModel.trim();
  const { base, stripped } = splitSuffix(trimmed);

  if (sourceEffort !== null) {
    return {
      effort: sourceEffort,
      effortReason: null,
      effortSource: "source-field",
      model: stripped.length > 0 ? base : trimmed,
    };
  }

  if (stripped.length > 0) {
    return {
      effort: stripped.join("+"),
      effortReason:
        "parsed from the model name suffix; Cursor encodes the reasoning variant in the model id",
      effortSource: "model-name-suffix",
      model: base,
    };
  }

  return {
    effort: null,
    effortReason: AUTO_MODELS.has(trimmed.toLowerCase())
      ? "Cursor auto model selection; the concrete model and effort are not reported locally"
      : "the source reports no reasoning level and the model name carries no effort suffix",
    effortSource: "unavailable",
    model: trimmed,
  };
};
