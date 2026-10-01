import { Option, Schema } from "effect";

import type { HarnessDirs } from "./home.js";

export type PiFamilyTool = "omp" | "pi";

const Text = Schema.optionalKey(Schema.NullOr(Schema.String));

const Count = Schema.optionalKey(Schema.NullOr(Schema.Finite));

const LineSchema = Schema.Struct({
  message: Schema.optionalKey(
    Schema.Struct({ duration: Count, role: Text, ttft: Count })
  ),
  model: Text,
  modelId: Text,
  title: Text,
  type: Schema.String,
});

type Line = typeof LineSchema.Type;

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(LineSchema)
);

const OMP_ONLY_TYPES: ReadonlySet<string> = new Set([
  "service_tier_change",
  "session_init",
  "title",
  "title_change",
]);

const has = (value: string | number | null | undefined): boolean =>
  value !== undefined && value !== null;

const signOf = (line: Line): PiFamilyTool | null => {
  if (OMP_ONLY_TYPES.has(line.type)) {
    return "omp";
  }

  if (line.type === "session" || line.type === "model_change") {
    if (has(line.modelId)) {
      return "pi";
    }

    return has(line.title) || (line.type === "model_change" && has(line.model))
      ? "omp"
      : null;
  }

  const { message } = line;

  return message?.role === "assistant" &&
    (has(message.duration) || has(message.ttft))
    ? "omp"
    : null;
};

export const piFamilyToolOf = (head: string): PiFamilyTool | null => {
  for (const text of head.split("\n")) {
    const sign = Option.getOrNull(Option.map(decodeLine(text), signOf));

    if (sign !== null) {
      return sign;
    }
  }

  return null;
};

export const sharesPiAgentDir = (dirs: HarnessDirs): boolean =>
  dirs.pi === dirs.omp;

export const ownsSharedSession = (
  tool: PiFamilyTool,
  head: string
): boolean => {
  const owner = piFamilyToolOf(head) ?? "pi";

  return owner === tool;
};
