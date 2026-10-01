import { Option, Schema } from "effect";

const Text = Schema.optionalKey(Schema.NullOr(Schema.String));

const Count = Schema.optionalKey(Schema.NullOr(Schema.Finite));

const Loose = Schema.optionalKey(Schema.Unknown);

export const OmpCostSchema = Schema.Struct({
  cacheRead: Count,
  cacheWrite: Count,
  input: Count,
  output: Count,
  total: Count,
});

export const OmpUsageSchema = Schema.Struct({
  cacheRead: Count,
  cacheWrite: Count,
  cost: Schema.optionalKey(Schema.NullOr(OmpCostSchema)),
  input: Count,
  output: Count,
  premiumRequests: Count,
  reasoningTokens: Count,
  totalTokens: Count,
});

export type OmpUsage = typeof OmpUsageSchema.Type;

const ContentPartSchema = Schema.Struct({
  arguments: Loose,
  name: Text,
  type: Schema.String,
});

export const OmpMessageSchema = Schema.Struct({
  api: Text,
  attribution: Text,
  content: Loose,
  details: Loose,
  duration: Count,
  errorStatus: Count,
  model: Text,
  provider: Text,
  responseId: Text,
  role: Schema.String,
  stopReason: Text,
  timestamp: Count,
  toolName: Text,
  ttft: Count,
  usage: Schema.optionalKey(Schema.NullOr(OmpUsageSchema)),
});

export type OmpMessage = typeof OmpMessageSchema.Type;

export const OmpLineSchema = Schema.Struct({
  agent: Text,
  configured: Text,
  customType: Text,
  cwd: Text,
  id: Text,
  message: Schema.optionalKey(OmpMessageSchema),
  model: Text,
  modelRole: Text,
  parentSession: Text,
  previousSessionFiles: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.String))
  ),
  role: Text,
  serviceTier: Loose,
  thinkingLevel: Text,
  timestamp: Text,
  title: Text,
  type: Schema.String,
});

export type OmpLine = typeof OmpLineSchema.Type;

const TypeOnlySchema = Schema.Struct({ type: Schema.String });

export type DecodedLine =
  | { readonly line: OmpLine; readonly state: "ok" }
  | { readonly state: "unrecognized"; readonly type: string }
  | { readonly state: "invalid" };

const decodeFull = Schema.decodeUnknownOption(
  Schema.fromJsonString(OmpLineSchema)
);

const decodeTypeOnly = Schema.decodeUnknownOption(
  Schema.fromJsonString(TypeOnlySchema)
);

export const decodeOmpLine = (text: string): DecodedLine =>
  Option.match(decodeFull(text), {
    onNone: (): DecodedLine =>
      Option.match(decodeTypeOnly(text), {
        onNone: (): DecodedLine => ({ state: "invalid" }),
        onSome: (base): DecodedLine => ({
          state: "unrecognized",
          type: base.type,
        }),
      }),
    onSome: (line): DecodedLine => ({ line, state: "ok" }),
  });

const decodeContent = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const decodePart = Schema.decodeUnknownOption(ContentPartSchema);

const PathArgumentsSchema = Schema.Struct({
  cwd: Loose,
  file: Loose,
  file_path: Loose,
  path: Loose,
  pattern: Loose,
});

const decodePathArguments = Schema.decodeUnknownOption(PathArgumentsSchema);

const decodeText = Schema.decodeUnknownOption(Schema.String);

const pathText = (value: Option.Option<string>): readonly string[] =>
  Option.match(value, {
    onNone: () => [],
    onSome: (text) =>
      text.trim() === "" || text.includes("://") ? [] : [text.trim()],
  });

export interface ToolCallSummary {
  readonly names: readonly string[];
  readonly paths: readonly string[];
}

export const toolCallsOf = (message: OmpMessage): ToolCallSummary => {
  const parts = Option.getOrElse(decodeContent(message.content), () => []);
  const names: string[] = [];
  const paths: string[] = [];

  for (const raw of parts) {
    const part = Option.getOrNull(decodePart(raw));

    if (part?.type !== "toolCall") {
      continue;
    }

    names.push(part.name ?? "unknown");

    const args = Option.getOrNull(decodePathArguments(part.arguments));

    if (args !== null) {
      for (const value of [
        args.cwd,
        args.path,
        args.file,
        args.file_path,
        args.pattern,
      ]) {
        paths.push(...pathText(decodeText(value)));
      }
    }
  }

  return { names, paths };
};

const TaskResultSchema = Schema.Struct({
  agent: Text,
  id: Schema.String,
  modelOverride: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))
  ),
  usage: Schema.optionalKey(Schema.NullOr(OmpUsageSchema)),
});

export type OmpTaskResult = typeof TaskResultSchema.Type;

const TaskDetailsSchema = Schema.Struct({
  progress: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  results: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const decodeTaskDetails = Schema.decodeUnknownOption(TaskDetailsSchema);

const decodeTaskResult = Schema.decodeUnknownOption(TaskResultSchema);

export interface TaskSpawns {
  readonly progress: readonly OmpTaskResult[];
  readonly results: readonly OmpTaskResult[];
}

export const taskSpawnsOf = (message: OmpMessage): TaskSpawns => {
  const details = Option.getOrNull(decodeTaskDetails(message.details));

  return {
    progress: (details?.progress ?? []).flatMap((item) =>
      Option.toArray(decodeTaskResult(item))
    ),
    results: (details?.results ?? []).flatMap((item) =>
      Option.toArray(decodeTaskResult(item))
    ),
  };
};

const ServiceTierSchema = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
]);

const decodeServiceTier = Schema.decodeUnknownOption(ServiceTierSchema);

export type ServiceTierSetting = typeof ServiceTierSchema.Type;

export const serviceTierOf = (line: OmpLine): ServiceTierSetting | null =>
  Option.getOrNull(decodeServiceTier(line.serviceTier));

const familyOfApi = (api: string | null): string | null => {
  if (api === null) {
    return null;
  }

  if (api.startsWith("openai")) {
    return "openai";
  }

  if (api.startsWith("anthropic")) {
    return "anthropic";
  }

  return api.startsWith("google") ? "google" : null;
};

export const serviceTierFor = (
  setting: ServiceTierSetting | null,
  api: string | null
): string | null => {
  if (setting === null) {
    return null;
  }

  if (Schema.is(Schema.String)(setting)) {
    return setting;
  }

  const family = familyOfApi(api);

  return family === null ? null : (setting[family] ?? null);
};
