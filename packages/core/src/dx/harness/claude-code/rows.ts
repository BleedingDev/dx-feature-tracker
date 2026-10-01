import { Option, Schema } from "effect";

const RawLineSchema = Schema.Record(Schema.String, Schema.Unknown);

type RawLine = typeof RawLineSchema.Type;

const decodeRawLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(RawLineSchema)
);

const Count = Schema.optional(Schema.NullOr(Schema.Finite));

const Text = Schema.optional(Schema.NullOr(Schema.String));

const UsageSchema = Schema.Struct({
  cache_creation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ephemeral_1h_input_tokens: Count,
        ephemeral_5m_input_tokens: Count,
      })
    )
  ),
  cache_creation_input_tokens: Count,
  cache_read_input_tokens: Count,
  input_tokens: Count,
  output_tokens: Count,
  output_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ thinking_tokens: Count }))
  ),
  server_tool_use: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        web_fetch_requests: Count,
        web_search_requests: Count,
      })
    )
  ),
  service_tier: Text,
  speed: Text,
});

export type ClaudeUsage = typeof UsageSchema.Type;

const MessageSchema = Schema.Struct({
  id: Text,
  model: Text,
  stop_reason: Text,
  usage: Schema.optional(Schema.NullOr(UsageSchema)),
});

const decodeMessage = Schema.decodeUnknownOption(MessageSchema);

const ModelUsageSchema = Schema.Struct({
  cacheCreationInputTokens: Count,
  cacheReadInputTokens: Count,
  costUSD: Count,
  inputTokens: Count,
  outputTokens: Count,
  webSearchRequests: Count,
});

export type ClaudeModelUsage = typeof ModelUsageSchema.Type;

const decodeModelUsage = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, ModelUsageSchema)
);

const decodeText = Schema.decodeUnknownOption(Schema.String);

const decodeNumber = Schema.decodeUnknownOption(Schema.Finite);

const decodeBoolean = Schema.decodeUnknownOption(Schema.Boolean);

const textOf = (line: RawLine, key: string): string | null => {
  const value = Option.getOrNull(decodeText(line[key]));

  return value === null || value.trim() === "" ? null : value;
};

const numberOf = (line: RawLine, key: string): number | null =>
  Option.getOrNull(decodeNumber(line[key]));

const flagOf = (line: RawLine, key: string): boolean =>
  Option.getOrElse(decodeBoolean(line[key]), () => false);

export interface RowPlace {
  readonly agentId: string | null;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly isSidechain: boolean;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly uuid: string | null;
  readonly version: string | null;
}

export interface AssistantRow extends RowPlace {
  readonly attributionAgent: string | null;
  readonly effort: string | null;
  readonly entrypoint: string | null;
  readonly kind: "assistant";
  readonly messageId: string | null;
  readonly model: string | null;
  readonly perTurnEffort: string | null;
  readonly requestId: string | null;
  readonly stopReason: string | null;
  readonly usage: ClaudeUsage | null;
}

export interface UserRow extends RowPlace {
  readonly kind: "user";
  readonly promptId: string | null;
}

export type TitleSource = "custom" | "ai" | "agent";

export interface TitleRow {
  readonly kind: "title";
  readonly sessionId: string | null;
  readonly source: TitleSource;
  readonly title: string;
}

export interface CostRow {
  readonly hasUnknownModelCost: boolean;
  readonly kind: "cost";
  readonly models: Readonly<Record<string, ClaudeModelUsage>>;
  readonly sessionId: string | null;
  readonly startTime: number | null;
  readonly totalCostUsd: number | null;
}

export type SkipReason = "synthetic" | "api-error" | "unparsed-assistant";

export type ClaudeRow =
  | AssistantRow
  | UserRow
  | TitleRow
  | CostRow
  | { readonly kind: "boundary" }
  | { readonly kind: "other" }
  | { readonly kind: "malformed" }
  | { readonly kind: "skipped"; readonly reason: SkipReason };

export const SYNTHETIC_MODEL = "<synthetic>";

export const HEAD_BRANCH = "HEAD";

const BOUNDARY_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "stop_hook_summary",
  "turn_duration",
  "compact_boundary",
]);

const BOUNDARY_TYPES: ReadonlySet<string> = new Set(["last-prompt"]);

const TITLE_KEYS = new Map<string, readonly [string, TitleSource]>([
  ["agent-name", ["agentName", "agent"]],
  ["ai-title", ["aiTitle", "ai"]],
  ["custom-title", ["customTitle", "custom"]],
]);

const MAX_TITLE_CHARS = 200;

const placeOf = (line: RawLine): RowPlace => ({
  agentId: textOf(line, "agentId"),
  cwd: textOf(line, "cwd"),
  gitBranch: textOf(line, "gitBranch"),
  isSidechain: flagOf(line, "isSidechain"),
  sessionId: textOf(line, "sessionId"),
  timestamp: textOf(line, "timestamp"),
  uuid: textOf(line, "uuid"),
  version: textOf(line, "version"),
});

const assistantRow = (line: RawLine): ClaudeRow =>
  Option.match(decodeMessage(line.message), {
    onNone: () => ({ kind: "skipped", reason: "unparsed-assistant" }),
    onSome: (message): ClaudeRow => {
      if (flagOf(line, "isApiErrorMessage")) {
        return { kind: "skipped", reason: "api-error" };
      }

      if (message.model === SYNTHETIC_MODEL) {
        return { kind: "skipped", reason: "synthetic" };
      }

      return {
        ...placeOf(line),
        attributionAgent: textOf(line, "attributionAgent"),
        effort: textOf(line, "effort"),
        entrypoint: textOf(line, "entrypoint"),
        kind: "assistant",
        messageId: message.id ?? null,
        model: message.model ?? null,
        perTurnEffort: textOf(line, "perTurnEffort"),
        requestId: textOf(line, "requestId"),
        stopReason: message.stop_reason ?? null,
        usage: message.usage ?? null,
      };
    },
  });

const costRow = (line: RawLine): CostRow => ({
  hasUnknownModelCost: flagOf(line, "hasUnknownModelCost"),
  kind: "cost",
  models: Option.getOrElse(decodeModelUsage(line.modelUsage), () => ({})),
  sessionId: textOf(line, "sessionId"),
  startTime: numberOf(line, "startTime"),
  totalCostUsd: numberOf(line, "totalCostUSD"),
});

const titleRow = (line: RawLine, type: string): ClaudeRow => {
  const spec = TITLE_KEYS.get(type);
  const title = spec === undefined ? null : textOf(line, spec[0]);

  return spec === undefined || title === null
    ? { kind: "other" }
    : {
        kind: "title",
        sessionId: textOf(line, "sessionId"),
        source: spec[1],
        title: title.trim().slice(0, MAX_TITLE_CHARS),
      };
};

const rowOfLine = (line: RawLine): ClaudeRow => {
  const type = textOf(line, "type");

  switch (type) {
    case "assistant": {
      return assistantRow(line);
    }

    case "user": {
      return {
        ...placeOf(line),
        kind: "user",
        promptId: textOf(line, "promptId"),
      };
    }

    case "cost-state": {
      return costRow(line);
    }

    case "system": {
      return BOUNDARY_SYSTEM_SUBTYPES.has(textOf(line, "subtype") ?? "")
        ? { kind: "boundary" }
        : { kind: "other" };
    }

    case null: {
      return { kind: "other" };
    }

    default: {
      if (BOUNDARY_TYPES.has(type)) {
        return { kind: "boundary" };
      }

      return titleRow(line, type);
    }
  }
};

export const decodeClaudeLine = (text: string): ClaudeRow =>
  Option.match(decodeRawLine(text), {
    onNone: () => ({ kind: "malformed" }),
    onSome: rowOfLine,
  });

export const recordedBranch = (row: RowPlace): string | null =>
  row.gitBranch === null || row.gitBranch === HEAD_BRANCH
    ? null
    : row.gitBranch;
