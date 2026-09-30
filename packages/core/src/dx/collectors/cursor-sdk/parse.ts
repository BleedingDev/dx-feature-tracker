import { DateTime, Option, Schema } from "effect";

export const FLIGHT_RECORD_SCHEMA = "dxfr.cursor-sdk.v1";

const Text = Schema.String;

const Count = Schema.Finite;

export const TokenUsageSchema = Schema.Struct({
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  inputTokens: Count,
  outputTokens: Count,
  reasoningTokens: Schema.optional(Count),
  totalTokens: Schema.optional(Count),
});

export type SdkTokenUsage = typeof TokenUsageSchema.Type;

const UsageCostSchema = Schema.Struct({
  chargedCents: Count,
  rawCostCents: Count,
});

const FlightTagSchema = Schema.Struct({
  branch: Text,
  flightId: Schema.optional(Schema.NullOr(Text)),
});

export type FlightTag = typeof FlightTagSchema.Type;

const EnvelopeSchema = Schema.Struct({
  flight: Schema.optional(Schema.NullOr(Schema.Unknown)),
  record: Text,
  recordedAt: Text,
  schema: Text,
});

const StreamUsageSchema = Schema.Struct({
  agent_id: Text,
  run_id: Text,
  type: Schema.Literal("usage"),
  usage: TokenUsageSchema,
});

const StreamToolCallSchema = Schema.Struct({
  agent_id: Text,
  call_id: Text,
  name: Text,
  run_id: Text,
  status: Schema.Literals(["running", "completed", "error"]),
  type: Schema.Literal("tool_call"),
});

const StreamTypeSchema = Schema.Struct({ type: Text });

const RunResultSchema = Schema.Struct({
  durationMs: Schema.optional(Count),
  id: Text,
  model: Schema.optional(Schema.Struct({ id: Schema.optional(Text) })),
  requestId: Schema.optional(Text),
  status: Schema.Literals(["finished", "error", "cancelled"]),
  usage: Schema.optional(TokenUsageSchema),
});

const RunUsageSchema = Schema.Struct({
  cost: Schema.optional(UsageCostSchema),
  runId: Text,
  usage: TokenUsageSchema,
});

const AgentUsageSchema = Schema.Struct({
  cost: Schema.optional(UsageCostSchema),
  runs: Schema.Array(RunUsageSchema),
  usage: TokenUsageSchema,
});

const StreamLineSchema = Schema.Struct({
  message: Schema.Unknown,
});

const ResultLineSchema = Schema.Struct({
  agentId: Text,
  result: RunResultSchema,
});

const SettlementLineSchema = Schema.Struct({
  agentId: Text,
  usage: AgentUsageSchema,
});

export type SdkRunResult = typeof RunResultSchema.Type;

export type SdkAgentUsage = typeof AgentUsageSchema.Type;

interface Base {
  readonly flight: FlightTag;
  readonly line: number;
  readonly recordedAt: string;
}

export type FlightRecord =
  | (Base & {
      readonly type: "turn-usage";
      readonly agentId: string;
      readonly runId: string;
      readonly usage: SdkTokenUsage;
    })
  | (Base & {
      readonly type: "tool-call";
      readonly agentId: string;
      readonly callId: string;
      readonly name: string;
      readonly runId: string;
      readonly status: "running" | "completed" | "error";
    })
  | (Base & {
      readonly type: "run-result";
      readonly agentId: string;
      readonly result: SdkRunResult;
    })
  | (Base & {
      readonly type: "settlement";
      readonly agentId: string;
      readonly usage: SdkAgentUsage;
    });

export type LineOutcome =
  | { readonly kind: "record"; readonly record: FlightRecord }
  | { readonly kind: "ignored" }
  | {
      readonly kind: "rejected";
      readonly code: string;
      readonly message: string;
    };

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
);

const decodeEnvelope = Schema.decodeUnknownOption(EnvelopeSchema);

const decodeFlight = Schema.decodeUnknownOption(FlightTagSchema);

const decodeStreamLine = Schema.decodeUnknownOption(StreamLineSchema);

const decodeStreamType = Schema.decodeUnknownOption(StreamTypeSchema);

const decodeStreamUsage = Schema.decodeUnknownOption(StreamUsageSchema);

const decodeToolCall = Schema.decodeUnknownOption(StreamToolCallSchema);

const decodeResultLine = Schema.decodeUnknownOption(ResultLineSchema);

const decodeSettlementLine = Schema.decodeUnknownOption(SettlementLineSchema);

const rejected = (line: number, code: string, detail: string): LineOutcome => ({
  code,
  kind: "rejected",
  message: `line ${line}: ${detail}`,
});

type StreamLine = typeof StreamLineSchema.Type;

const parseStream = (stream: StreamLine, base: Base): LineOutcome => {
  const { message } = stream;
  const usage = decodeStreamUsage(message);

  if (Option.isSome(usage)) {
    return {
      kind: "record",
      record: {
        ...base,
        agentId: usage.value.agent_id,
        runId: usage.value.run_id,
        type: "turn-usage",
        usage: usage.value.usage,
      },
    };
  }

  const tool = decodeToolCall(message);

  if (Option.isSome(tool)) {
    return {
      kind: "record",
      record: {
        ...base,
        agentId: tool.value.agent_id,
        callId: tool.value.call_id,
        name: tool.value.name,
        runId: tool.value.run_id,
        status: tool.value.status,
        type: "tool-call",
      },
    };
  }

  return Option.isSome(decodeStreamType(message))
    ? { kind: "ignored" }
    : rejected(base.line, "rejected-record", "unrecognised SDK message");
};

export const parseFlightLine = (text: string, line: number): LineOutcome => {
  if (text.trim().length === 0) {
    return { kind: "ignored" };
  }

  const json = decodeJson(text);

  if (Option.isNone(json)) {
    return rejected(line, "malformed-json", "not valid JSON");
  }

  const envelope = decodeEnvelope(json.value);

  if (Option.isNone(envelope)) {
    return rejected(
      line,
      "rejected-record",
      "missing schema/record/recordedAt"
    );
  }

  if (envelope.value.schema !== FLIGHT_RECORD_SCHEMA) {
    return rejected(
      line,
      "unsupported-schema-version",
      `schema ${envelope.value.schema} is not ${FLIGHT_RECORD_SCHEMA}`
    );
  }

  const flight = decodeFlight(envelope.value.flight);

  if (Option.isNone(flight) || flight.value.branch.trim().length === 0) {
    return rejected(
      line,
      "missing-flight-tag",
      "record has no explicit flight.branch tag; untagged SDK traffic is not attributed"
    );
  }

  const recordedAt = DateTime.make(envelope.value.recordedAt);

  if (Option.isNone(recordedAt)) {
    return rejected(
      line,
      "rejected-record",
      "recordedAt is not an ISO timestamp"
    );
  }

  const base: Base = {
    flight: flight.value,
    line,
    recordedAt: DateTime.formatIso(recordedAt.value),
  };

  switch (envelope.value.record) {
    case "stream": {
      const stream = decodeStreamLine(json.value);

      return Option.isSome(stream)
        ? parseStream(stream.value, base)
        : rejected(line, "rejected-record", "stream record has no message");
    }

    case "result": {
      const result = decodeResultLine(json.value);

      return Option.isSome(result)
        ? {
            kind: "record",
            record: {
              ...base,
              agentId: result.value.agentId,
              result: result.value.result,
              type: "run-result",
            },
          }
        : rejected(
            line,
            "rejected-record",
            "result record is not an SDK RunResult"
          );
    }

    case "settlement": {
      const settlement = decodeSettlementLine(json.value);

      return Option.isSome(settlement)
        ? {
            kind: "record",
            record: {
              ...base,
              agentId: settlement.value.agentId,
              type: "settlement",
              usage: settlement.value.usage,
            },
          }
        : rejected(
            line,
            "rejected-record",
            "settlement record is not an SDK AgentUsage"
          );
    }

    default: {
      return rejected(
        line,
        "rejected-record",
        `unknown record type ${envelope.value.record}`
      );
    }
  }
};

export const tokenMapOf = (usage: SdkTokenUsage) => ({
  cacheRead: usage.cacheReadTokens,
  cacheWrite: usage.cacheWriteTokens,
  input: usage.inputTokens,
  output: usage.outputTokens,
  reasoning: usage.reasoningTokens ?? null,
});

export const centsToUsd = (cents: number): number =>
  Math.round(cents * 10_000) / 1_000_000;
