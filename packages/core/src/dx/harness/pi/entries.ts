import { Option, Schema } from "effect";

const Count = Schema.optional(Schema.NullOr(Schema.Finite));

const Text = Schema.optional(Schema.NullOr(Schema.String));

const Flag = Schema.optional(Schema.NullOr(Schema.Boolean));

export const PiCostSchema = Schema.Struct({ total: Count });

export const PiUsageSchema = Schema.Struct({
  cacheRead: Count,
  cacheWrite: Count,
  cacheWrite1h: Count,
  cost: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.Finite, PiCostSchema]))
  ),
  input: Count,
  output: Count,
  reasoning: Count,
  totalTokens: Count,
  turns: Count,
});

export type PiUsage = typeof PiUsageSchema.Type;

export const PiMessageSchema = Schema.Struct({
  api: Text,
  content: Schema.optional(Schema.Unknown),
  details: Schema.optional(Schema.Unknown),
  isError: Flag,
  model: Text,
  provider: Text,
  providerThinkingLevel: Text,
  responseId: Text,
  responseModel: Text,
  role: Text,
  stopReason: Text,
  thinkingLevel: Text,
  timestamp: Count,
  toolCallId: Text,
  toolName: Text,
  usage: Schema.optional(Schema.NullOr(PiUsageSchema)),
});

export type PiMessage = typeof PiMessageSchema.Type;

export const PiEntrySchema = Schema.Struct({
  cwd: Text,
  fromHook: Flag,
  id: Text,
  kind: Text,
  message: Schema.optional(Schema.NullOr(PiMessageSchema)),
  model: Text,
  modelId: Text,
  name: Text,
  parentId: Text,
  parentSession: Text,
  provider: Text,
  thinkingLevel: Text,
  timestamp: Text,
  type: Schema.String,
  usage: Schema.optional(Schema.NullOr(PiUsageSchema)),
  version: Count,
});

export type PiEntry = typeof PiEntrySchema.Type;

export const PiToolCallSchema = Schema.Struct({
  arguments: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
  ),
  id: Text,
  name: Text,
  type: Schema.String,
});

export type PiToolCall = typeof PiToolCallSchema.Type;

const PiSubagentResultSchema = Schema.Struct({
  agent: Text,
  exitCode: Count,
  messages: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  model: Text,
  stopReason: Text,
  usage: Schema.optional(Schema.NullOr(PiUsageSchema)),
});

export type PiSubagentResult = typeof PiSubagentResultSchema.Type;

const PiSubagentDetailsSchema = Schema.Struct({
  results: Schema.Array(PiSubagentResultSchema),
});

const decodeEntry = Schema.decodeUnknownOption(
  Schema.fromJsonString(PiEntrySchema)
);

const decodeMessage = Schema.decodeUnknownOption(PiMessageSchema);

const decodeContent = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const decodeToolCall = Schema.decodeUnknownOption(PiToolCallSchema);

const decodeDetails = Schema.decodeUnknownOption(PiSubagentDetailsSchema);

export const toolCallsOf = (message: PiMessage): readonly PiToolCall[] =>
  Option.getOrElse(decodeContent(message.content), () => []).flatMap((block) =>
    Option.match(decodeToolCall(block), {
      onNone: () => [],
      onSome: (call) => (call.type === "toolCall" ? [call] : []),
    })
  );

export const subagentResultsOf = (
  message: PiMessage
): readonly PiSubagentResult[] =>
  Option.match(decodeDetails(message.details), {
    onNone: () => [],
    onSome: (details) => details.results,
  });

export const nestedMessagesOf = (
  result: PiSubagentResult
): readonly PiMessage[] =>
  (result.messages ?? []).flatMap((item) =>
    Option.toArray(decodeMessage(item))
  );

export interface PiLine {
  readonly entry: PiEntry;
  readonly offset: number;
}

export interface PiFile {
  readonly endOffset: number;
  readonly header: PiEntry | null;
  readonly lines: readonly PiLine[];
  readonly malformed: number;
}

const encoder = new TextEncoder();

export const parsePiFile = (text: string): PiFile => {
  const lines: PiLine[] = [];
  let header: PiEntry | null = null;
  let malformed = 0;
  let offset = 0;
  let endOffset = 0;
  const segments = text.split("\n");

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const width = encoder.encode(segment).byteLength + (last ? 0 : 1);
    const decoded = segment.trim() === "" ? null : decodeEntry(segment);

    if (decoded !== null && Option.isSome(decoded)) {
      const entry = decoded.value;

      if (entry.type === "session" && header === null) {
        header = entry;
      } else {
        lines.push({ entry, offset });
      }

      endOffset = offset + width;
    } else if (decoded !== null && !last) {
      malformed += 1;
      endOffset = offset + width;
    } else if (decoded === null) {
      endOffset = offset + width;
    }

    offset += width;
  }

  return { endOffset, header, lines, malformed };
};

export const firstLineOf = (text: string): string =>
  text.split("\n", 1)[0] ?? "";

export const headerOf = (text: string): PiEntry | null =>
  Option.match(decodeEntry(firstLineOf(text)), {
    onNone: () => null,
    onSome: (entry) => (entry.type === "session" ? entry : null),
  });
