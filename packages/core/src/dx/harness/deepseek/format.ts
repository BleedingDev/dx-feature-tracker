import { Option, Schema } from "effect";

const GENERATION_FILE =
  /^session(?:\.v(?<version>[1-9]\d*))?\.jsonl(?<zstd>\.zstd)?$/u;

export interface Generation {
  readonly compressed: boolean;
  readonly file: string;
  readonly projectDir: string;
  readonly sessionDir: string;
  readonly version: number;
}

const segmentsOf = (relative: string): readonly string[] =>
  relative.split(/[\\/]/u).filter((part) => part !== "");

export const generationOf = (relative: string): Generation | null => {
  const parts = segmentsOf(relative);

  if (parts.length !== 3) {
    return null;
  }

  const [projectDir = "", sessionDir = "", file = ""] = parts;
  const match = GENERATION_FILE.exec(file);

  if (match === null) {
    return null;
  }

  return {
    compressed: match.groups?.zstd !== undefined,
    file,
    projectDir,
    sessionDir,
    version: Number(match.groups?.version ?? "0"),
  };
};

export const isGenerationFile = (relative: string): boolean =>
  generationOf(relative) !== null;

const SAFE_CHARACTER = /^[A-Za-z0-9._-]$/u;

const escapeUnit = (code: number): string =>
  `~${code.toString(16).toUpperCase().padStart(4, "0")}`;

const MAX_PROJECT_KEY = 251;

export const projectKey = (cwd: string): string => {
  let readable = "";
  let separatorRun = false;

  // oxlint-disable-next-line unicorn/prefer-spread -- spreading yields code points; the key escapes UTF-16 code units like DeepSeek Harness.
  for (const character of cwd.split("")) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- DeepSeek Harness escapes UTF-16 code units, so the key must match unit by unit.
    const code = character.charCodeAt(0);

    if (character === "/" || character === "\\" || character === ":") {
      readable += separatorRun ? "" : "-";
      separatorRun = true;
    } else {
      readable +=
        character !== "~" && SAFE_CHARACTER.test(character)
          ? character
          : escapeUnit(code);
      separatorRun = false;
    }
  }

  const trimmed = readable.replace(/^-+/u, "") || "root";

  return `--${trimmed.slice(0, MAX_PROJECT_KEY)}--`;
};

export const NO_CWD_PROJECT = "_no-cwd" as const;

export const decodeSegment = (segment: string): string =>
  segment.replaceAll(/~(?<hex>[0-9A-F]{4})/gu, (_match, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16))
  );

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Text = Schema.optional(Schema.String);

export const HeaderSchema = Schema.Struct({
  createdAt: Schema.Finite,
  cwd: Text,
  delegationDepth: Schema.optional(Schema.Int),
  id: Schema.String,
  isSeeded: Schema.optional(Schema.Boolean),
  origin: Text,
  parentSession: Text,
  type: Schema.Literal("session"),
  version: Schema.optional(Schema.Int),
});

export type Header = typeof HeaderSchema.Type;

export const RowSchema = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  seq: Schema.Int,
  time: Schema.optional(Schema.Finite),
  type: Schema.String,
});

export type Row = typeof RowSchema.Type;

export const UsageSchema = Schema.Struct({
  cacheReadTokens: Schema.optional(Count),
  cacheWriteTokens: Schema.optional(Count),
  inputTokens: Count,
  outputTokens: Count,
  reasoningTokens: Schema.optional(Count),
  totalTokens: Schema.optional(Count),
});

export type Usage = typeof UsageSchema.Type;

const FailureSchema = Schema.Struct({ code: Text });

const FinishSchema = Schema.Struct({
  failure: Schema.optional(FailureSchema),
  kind: Schema.String,
});

const ResponseSchema = Schema.Struct({
  model: Text,
  provider: Text,
  responseId: Text,
  responseModel: Text,
  serviceTier: Text,
});

const ReplayStateSchema = Schema.Struct({
  response: Schema.optional(ResponseSchema),
});

export const StreamRecordSchema = Schema.Struct({
  chunk: Schema.optional(
    Schema.Struct({
      reason: Schema.optional(FinishSchema),
      replayState: Schema.optional(ReplayStateSchema),
      type: Schema.String,
      usage: Schema.optional(UsageSchema),
    })
  ),
  type: Schema.String,
});

export type StreamRecord = typeof StreamRecordSchema.Type;

const SlotFields = {
  step: Schema.Int,
  stream: Schema.optional(Schema.Array(Schema.Unknown)),
  turn: Schema.Int,
};

export const AssistantMessageSchema = Schema.Struct({
  ...SlotFields,
  interrupted: Schema.optional(Schema.Boolean),
  message: Schema.Struct({
    id: Text,
    source: Schema.optional(
      Schema.Struct({
        model: Text,
        provider: Text,
        replayState: Schema.optional(ReplayStateSchema),
      })
    ),
  }),
  usage: Schema.optional(UsageSchema),
});

export const AssistantAttemptSchema = Schema.Struct(SlotFields);

export const RetryStartedSchema = Schema.Struct({
  step: Schema.Int,
  turn: Schema.Int,
});

export const RouteSchema = Schema.Struct({
  model: Schema.String,
  provider: Schema.String,
  reasoningEffort: Text,
});

export const RequestHeaderSchema = Schema.Struct({
  header: Schema.Struct({
    adapterDefaults: Schema.optional(
      Schema.Struct({ reasoningEffort: Schema.optional(Schema.Boolean) })
    ),
    config: RouteSchema,
  }),
});

export const TurnStartSchema = Schema.Struct({ turn: Schema.Int });

export const TurnEndSchema = Schema.Struct({
  reason: Schema.optional(
    Schema.Struct({
      error: Schema.optional(FailureSchema),
      kind: Schema.String,
    })
  ),
  turn: Schema.Int,
});

export const EndSeedSchema = Schema.Struct({
  inherited: Schema.optional(Schema.Boolean),
});

export const TitleSchema = Schema.Struct({
  source: Schema.Struct({ kind: Schema.String }),
  title: Schema.String,
});

export const DescriptorSchema = Schema.Struct({
  agentModel: Text,
  agentProvider: Text,
  agentReasoningEffort: Text,
  mode: Text,
  persona: Text,
  provider: Text,
});

export const CompactionSummarySchema = Schema.Struct({
  compactionId: Schema.String,
  model: Text,
  provider: Text,
  usage: Schema.optional(UsageSchema),
});

export const TitleRequestSchema = Schema.Struct({
  route: Schema.optional(
    Schema.Struct({ model: Schema.String, provider: Schema.String })
  ),
});

export const SearchRequestSchema = Schema.Struct({
  body: Schema.optional(Schema.Struct({ model: Text })),
});

export const ToolCallSchema = Schema.Struct({
  arguments: Schema.String,
  callId: Schema.String,
  name: Schema.String,
  step: Schema.Int,
  turn: Schema.Int,
});

export const ToolArgumentsSchema = Schema.Struct({
  file_path: Text,
  path: Text,
  workdir: Text,
});

const decodeJson = <A>(schema: Schema.Codec<A>) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(schema));

export const decodeHeaderLine = decodeJson(HeaderSchema);

export const decodeRowLine = decodeJson(RowSchema);

export const decodeToolArguments = decodeJson(ToolArgumentsSchema);

export const decodeData = <A>(schema: Schema.Codec<A>) => {
  const decode = Schema.decodeUnknownOption(schema);

  return (row: Row): A | null => Option.getOrNull(decode(row.data));
};

export const decodeStreamRecord =
  Schema.decodeUnknownOption(StreamRecordSchema);
