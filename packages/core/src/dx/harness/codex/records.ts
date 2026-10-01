import { Option, Schema } from "effect";

const Text = Schema.optional(Schema.NullOr(Schema.String));

const Count = Schema.optional(Schema.NullOr(Schema.Finite));

export const CodexUsageSchema = Schema.Struct({
  cache_write_input_tokens: Count,
  cached_input_tokens: Count,
  input_tokens: Count,
  output_tokens: Count,
  reasoning_output_tokens: Count,
  total_tokens: Count,
});

export type CodexUsage = typeof CodexUsageSchema.Type;

const ThreadSpawnSchema = Schema.Struct({
  agent_nickname: Text,
  agent_path: Text,
  agent_role: Text,
  depth: Count,
  parent_thread_id: Text,
});

const SubagentSourceSchema = Schema.Struct({
  other: Text,
  thread_spawn: Schema.optional(Schema.NullOr(ThreadSpawnSchema)),
});

const SourceSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    subagent: Schema.optional(
      Schema.NullOr(Schema.Union([Schema.String, SubagentSourceSchema]))
    ),
  }),
]);

export const SessionMetaSchema = Schema.Struct({
  agent_nickname: Text,
  agent_path: Text,
  agent_role: Text,
  cli_version: Text,
  cwd: Text,
  forked_from_id: Text,
  git: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        branch: Text,
        commit_hash: Text,
        repository_url: Text,
      })
    )
  ),
  id: Schema.String,
  model_provider: Text,
  originator: Text,
  parent_thread_id: Text,
  session_id: Text,
  source: Schema.optional(Schema.NullOr(SourceSchema)),
  thread_source: Text,
  timestamp: Text,
});

export type SessionMeta = typeof SessionMetaSchema.Type;

export const TurnContextSchema = Schema.Struct({
  collaboration_mode: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        settings: Schema.optional(
          Schema.NullOr(Schema.Struct({ reasoning_effort: Text }))
        ),
      })
    )
  ),
  cwd: Text,
  effort: Text,
  model: Text,
  turn_id: Text,
});

export type TurnContext = typeof TurnContextSchema.Type;

export const UsageRecordSchema = Schema.Struct({
  response_id: Text,
  thread_id: Text,
  turn_id: Text,
  usage: CodexUsageSchema,
});

export type UsageRecord = typeof UsageRecordSchema.Type;

export const TaskStartedSchema = Schema.Struct({
  started_at: Count,
  turn_id: Text,
});

const ErrorKindSchema = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Unknown),
]);

export type ErrorKind = typeof ErrorKindSchema.Type;

export const TaskCompleteSchema = Schema.Struct({
  completed_at: Count,
  duration_ms: Count,
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        codex_error_info: Schema.optional(Schema.NullOr(ErrorKindSchema)),
      })
    )
  ),
  started_at: Count,
  turn_id: Text,
});

export type TaskComplete = typeof TaskCompleteSchema.Type;

export const TurnAbortedSchema = Schema.Struct({
  reason: Text,
  turn_id: Text,
});

export const TokenCountSchema = Schema.Struct({
  info: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        last_token_usage: Schema.optional(Schema.NullOr(CodexUsageSchema)),
        total_token_usage: Schema.optional(Schema.NullOr(CodexUsageSchema)),
      })
    )
  ),
});

export type TokenCount = typeof TokenCountSchema.Type;

export const ThreadSettingsSchema = Schema.Struct({
  thread_id: Text,
  thread_settings: Schema.Struct({
    cwd: Text,
    model: Text,
    model_provider_id: Text,
    reasoning_effort: Text,
    service_tier: Text,
  }),
});

export type ThreadSettings = typeof ThreadSettingsSchema.Type;

export const SessionIndexEntrySchema = Schema.Struct({
  id: Schema.String,
  thread_name: Text,
  updated_at: Text,
});

const lineOf = <A, I, RD>(payload: Schema.Codec<A, I, RD>) =>
  Schema.fromJsonString(
    Schema.Struct({
      ordinal: Count,
      payload,
      timestamp: Text,
    })
  );

const decoderOf = <A, I>(payload: Schema.Codec<A, I>) =>
  Schema.decodeUnknownOption(lineOf(payload));

export const decodeMetaLine = decoderOf(SessionMetaSchema);

export const decodeTurnContextLine = decoderOf(TurnContextSchema);

export const decodeUsageRecordLine = decoderOf(UsageRecordSchema);

export const decodeTaskStartedLine = decoderOf(TaskStartedSchema);

export const decodeTaskCompleteLine = decoderOf(TaskCompleteSchema);

export const decodeTurnAbortedLine = decoderOf(TurnAbortedSchema);

export const decodeTokenCountLine = decoderOf(TokenCountSchema);

export const decodeThreadSettingsLine = decoderOf(ThreadSettingsSchema);

export const decodeSessionIndexLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionIndexEntrySchema)
);

const isText = Schema.is(Schema.String);

export const errorKindOf = (
  kind: ErrorKind | null | undefined
): string | null => {
  if (kind === null || kind === undefined) {
    return null;
  }

  return isText(kind) ? kind : (Object.keys(kind)[0] ?? null);
};

const TOP_TYPE = /"type":"(?<type>[a-z_]+)"/u;

const PAYLOAD_TYPE = /"payload":\{"type":"(?<type>[a-z_]+)"/u;

export const SNIFF_CHARS = 320;

export interface LineKind {
  readonly payloadType: string | null;
  readonly type: string | null;
}

const unknownKind: LineKind = { payloadType: null, type: null };

const TYPED_PAYLOADS: ReadonlySet<string> = new Set([
  "event_msg",
  "response_item",
]);

export const sniffLine = (head: string): LineKind => {
  const top = TOP_TYPE.exec(head);
  const payloadAt = head.indexOf('"payload":');

  if (top === null || (payloadAt !== -1 && payloadAt < top.index)) {
    return unknownKind;
  }

  const type = top.groups?.type ?? null;
  const payloadType = PAYLOAD_TYPE.exec(head)?.groups?.type ?? null;

  return payloadType === null && type !== null && TYPED_PAYLOADS.has(type)
    ? unknownKind
    : { payloadType, type };
};

const LineKindSchema = Schema.fromJsonString(
  Schema.Struct({
    payload: Schema.optional(
      Schema.NullOr(Schema.Struct({ type: Schema.optional(Schema.Unknown) }))
    ),
    type: Schema.String,
  })
);

const decodeLineKind = Schema.decodeUnknownOption(LineKindSchema);

export const lineKindOf = (text: string): LineKind =>
  Option.match(decodeLineKind(text), {
    onNone: () => unknownKind,
    onSome: (decoded) => {
      const payloadType = decoded.payload?.type;

      return {
        payloadType: isText(payloadType) ? payloadType : null,
        type: decoded.type,
      };
    },
  });

export const TOOL_CALL_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "tool_search_call",
]);
