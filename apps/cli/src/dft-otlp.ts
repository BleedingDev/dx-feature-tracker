// @effect-diagnostics nodeBuiltinImport:off -- The OTLP receiver hashes request keys and inflates gzip bodies at the HTTP boundary with node:crypto and node:zlib.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  EVENT_SCHEMA_VERSION,
  EventIdSchema,
  emptyEventIdentity,
  emptyFlightContext,
  harnessAdapterId,
  normalizeModel,
  providerFor,
  viaFor,
} from "@rat-stack/core/dx";
import type { AiTokens, DxEventEnvelope } from "@rat-stack/core/dx";
import { DateTime, Option, Schema } from "effect";

export type OtlpValue = string | number | boolean | null;

export interface OtlpRecord {
  readonly attributes: ReadonlyMap<string, OtlpValue>;
  readonly body: OtlpValue;
  readonly eventName: string | null;
  readonly observedTimeUnixNano: string | null;
  readonly resource: ReadonlyMap<string, OtlpValue>;
  readonly timeUnixNano: string | null;
}

const NumberOrText = Schema.Union([Schema.String, Schema.Finite]);

const AnyValueSchema = Schema.Struct({
  boolValue: Schema.optional(Schema.Boolean),
  doubleValue: Schema.optional(NumberOrText),
  intValue: Schema.optional(NumberOrText),
  stringValue: Schema.optional(Schema.String),
});

type AnyValue = typeof AnyValueSchema.Type;

const KeyValueSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.optional(Schema.NullOr(AnyValueSchema)),
});

type KeyValue = typeof KeyValueSchema.Type;

const LogRecordSchema = Schema.Struct({
  attributes: Schema.optional(Schema.Array(KeyValueSchema)),
  body: Schema.optional(Schema.NullOr(AnyValueSchema)),
  eventName: Schema.optional(Schema.String),
  observedTimeUnixNano: Schema.optional(NumberOrText),
  timeUnixNano: Schema.optional(NumberOrText),
});

const ExportLogsSchema = Schema.Struct({
  resourceLogs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        resource: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              attributes: Schema.optional(Schema.Array(KeyValueSchema)),
            })
          )
        ),
        scopeLogs: Schema.optional(
          Schema.Array(
            Schema.Struct({
              logRecords: Schema.optional(Schema.Array(LogRecordSchema)),
            })
          )
        ),
      })
    )
  ),
});

const decodeExportLogs = Schema.decodeUnknownOption(
  Schema.fromJsonString(ExportLogsSchema)
);

const anyValueOf = (value: AnyValue | null | undefined): OtlpValue => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value.stringValue !== undefined) {
    return value.stringValue;
  }

  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }

  if (value.doubleValue !== undefined) {
    return Number(value.doubleValue);
  }

  return value.boolValue ?? null;
};

const attributesOf = (
  list: readonly KeyValue[] | undefined
): ReadonlyMap<string, OtlpValue> =>
  new Map((list ?? []).map((entry) => [entry.key, anyValueOf(entry.value)]));

const textOf = (value: string | number | undefined): string | null =>
  value === undefined ? null : String(value);

export const decodeOtlpJson = (text: string): readonly OtlpRecord[] | null =>
  Option.match(decodeExportLogs(text), {
    onNone: () => null,
    onSome: (request) =>
      (request.resourceLogs ?? []).flatMap((resourceLogs) => {
        const resource = attributesOf(resourceLogs.resource?.attributes);

        return (resourceLogs.scopeLogs ?? []).flatMap((scope) =>
          (scope.logRecords ?? []).map((record): OtlpRecord => ({
            attributes: attributesOf(record.attributes),
            body: anyValueOf(record.body),
            eventName: record.eventName ?? null,
            observedTimeUnixNano: textOf(record.observedTimeUnixNano),
            resource,
            timeUnixNano: textOf(record.timeUnixNano),
          }))
        );
      }),
  });

interface WireField {
  readonly bytes: Uint8Array;
  readonly field: number;
  readonly varint: bigint;
}

const VARINT = 0;

const FIXED64 = 1;

const LENGTH = 2;

const FIXED32 = 5;

const readVarint = (
  bytes: Uint8Array,
  start: number
): readonly [bigint, number] => {
  let value = 0n;
  let scale = 1n;
  let at = start;

  for (;;) {
    const byte = bytes[at];

    if (byte === undefined || at - start > 9) {
      throw new RangeError("truncated varint");
    }

    value += BigInt(byte % 128) * scale;
    scale *= 128n;
    at += 1;

    if (byte < 128) {
      return [value, at];
    }
  }
};

const wireFields = (bytes: Uint8Array): readonly WireField[] => {
  const fields: WireField[] = [];
  let at = 0;

  while (at < bytes.length) {
    const [tag, next] = readVarint(bytes, at);
    const field = Number(tag / 8n);
    const wire = Number(tag % 8n);
    at = next;

    if (wire === VARINT) {
      const [value, after] = readVarint(bytes, at);
      fields.push({ bytes: new Uint8Array(), field, varint: value });
      at = after;
    } else if (wire === FIXED64 || wire === FIXED32) {
      const size = wire === FIXED64 ? 8 : 4;

      if (at + size > bytes.length) {
        throw new RangeError("truncated fixed field");
      }

      fields.push({ bytes: bytes.subarray(at, at + size), field, varint: 0n });
      at += size;
    } else if (wire === LENGTH) {
      const [length, after] = readVarint(bytes, at);
      const end = after + Number(length);

      if (end > bytes.length) {
        throw new RangeError("truncated length field");
      }

      fields.push({ bytes: bytes.subarray(after, end), field, varint: 0n });
      at = end;
    } else {
      throw new RangeError(`unsupported wire type ${String(wire)}`);
    }
  }

  return fields;
};

const utf8 = new TextDecoder();

const fixed64 = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const protoAnyValue = (bytes: Uint8Array): OtlpValue => {
  for (const item of wireFields(bytes)) {
    switch (item.field) {
      case 1: {
        return utf8.decode(item.bytes);
      }

      case 2: {
        return item.varint !== 0n;
      }

      case 3: {
        return Number(BigInt.asIntN(64, item.varint));
      }

      case 4: {
        return fixed64(item.bytes).getFloat64(0, true);
      }

      default: {
        break;
      }
    }
  }

  return null;
};

const protoKeyValue = (bytes: Uint8Array): readonly [string, OtlpValue] => {
  let key = "";
  let value: OtlpValue = null;

  for (const item of wireFields(bytes)) {
    if (item.field === 1) {
      key = utf8.decode(item.bytes);
    } else if (item.field === 2) {
      value = protoAnyValue(item.bytes);
    }
  }

  return [key, value];
};

const fieldsNamed = (bytes: Uint8Array, field: number): readonly Uint8Array[] =>
  wireFields(bytes).flatMap((item) =>
    item.field === field ? [item.bytes] : []
  );

const unixNano = (bytes: Uint8Array): string =>
  fixed64(bytes).getBigUint64(0, true).toString();

const protoLogRecord = (
  bytes: Uint8Array,
  resource: ReadonlyMap<string, OtlpValue>
): OtlpRecord => {
  const attributes = new Map<string, OtlpValue>();
  let body: OtlpValue = null;
  let eventName: string | null = null;
  let time: string | null = null;
  let observed: string | null = null;

  for (const item of wireFields(bytes)) {
    switch (item.field) {
      case 1: {
        time = unixNano(item.bytes);
        break;
      }

      case 5: {
        body = protoAnyValue(item.bytes);
        break;
      }

      case 6: {
        const [key, value] = protoKeyValue(item.bytes);
        attributes.set(key, value);
        break;
      }

      case 11: {
        observed = unixNano(item.bytes);
        break;
      }

      case 12: {
        eventName = utf8.decode(item.bytes);
        break;
      }

      default: {
        break;
      }
    }
  }

  return {
    attributes,
    body,
    eventName,
    observedTimeUnixNano: observed,
    resource,
    timeUnixNano: time,
  };
};

const protoResource = (bytes: Uint8Array): ReadonlyMap<string, OtlpValue> =>
  new Map(fieldsNamed(bytes, 1).map(protoKeyValue));

export const decodeOtlpProtobuf = (
  bytes: Uint8Array
): readonly OtlpRecord[] | null => {
  try {
    return fieldsNamed(bytes, 1).flatMap((resourceLogs) => {
      const [resourceBytes] = fieldsNamed(resourceLogs, 1);

      const resource =
        resourceBytes === undefined
          ? new Map<string, OtlpValue>()
          : protoResource(resourceBytes);

      return fieldsNamed(resourceLogs, 2).flatMap((scopeLogs) =>
        fieldsNamed(scopeLogs, 2).map((record) =>
          protoLogRecord(record, resource)
        )
      );
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }

    throw error;
  }
};

export interface OtlpBody {
  readonly bytes: Uint8Array;
  readonly contentEncoding: string | null;
  readonly contentType: string | null;
}

export const MAX_OTLP_BODY = 8 * 1024 * 1024;

export type InflatedOtlp = OtlpBody | "too-large" | "invalid";

export const inflateOtlp = (body: OtlpBody): InflatedOtlp => {
  if (!(body.contentEncoding ?? "").toLowerCase().includes("gzip")) {
    return body;
  }

  try {
    return {
      ...body,
      bytes: gunzipSync(body.bytes, { maxOutputLength: MAX_OTLP_BODY }),
      contentEncoding: null,
    };
  } catch (error) {
    return error instanceof RangeError ? "too-large" : "invalid";
  }
};

export const decodeOtlpLogs = (
  body: OtlpBody
): readonly OtlpRecord[] | null => {
  const inflated = inflateOtlp(body);

  if (inflated === "too-large" || inflated === "invalid") {
    return null;
  }

  const type = (inflated.contentType ?? "").toLowerCase();

  return type.includes("json")
    ? decodeOtlpJson(utf8.decode(inflated.bytes))
    : decodeOtlpProtobuf(inflated.bytes);
};

const text = (value: OtlpValue | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const result = String(value).trim();

  return result === "" ? null : result;
};

const count = (value: OtlpValue | undefined): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const result = Number(value);

  return Number.isFinite(result) && result >= 0 ? result : null;
};

const sum = (...values: readonly (number | null)[]): number | null =>
  values.every((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);

const isoFrom = (input: number | string): string | null =>
  Option.match(DateTime.make(input), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });

const nanoToIso = (value: string | null): string | null =>
  value === null || !/^\d+$/u.test(value) || value === "0"
    ? null
    : isoFrom(Number(BigInt(value) / 1_000_000n));

const isoOf = (value: OtlpValue | undefined): string | null => {
  const raw = text(value);

  return raw === null ? null : isoFrom(raw);
};

const occurredAt = (record: OtlpRecord, fallback: string): string =>
  isoOf(record.attributes.get("event.timestamp")) ??
  nanoToIso(record.timeUnixNano) ??
  nanoToIso(record.observedTimeUnixNano) ??
  fallback;

const eventNameOf = (record: OtlpRecord): string | null =>
  text(record.attributes.get("event.name")) ??
  (record.eventName?.startsWith("event ") === true ? null : record.eventName) ??
  text(record.body);

export type OtelTool = "claude-code" | "codex";

export interface OtelUsage {
  readonly durationMs: number | null;
  readonly effort: string | null;
  readonly event: string;
  readonly model: string | null;
  readonly requestId: string | null;
  readonly requestKey: string;
  readonly sessionId: string | null;
  readonly speed: string | null;
  readonly serviceTier: string | null;
  readonly time: string;
  readonly tokens: AiTokens;
  readonly tool: OtelTool;
  readonly toolCostUsd: number | null;
  readonly version: string | null;
}

const isClaudeRequest = (record: OtlpRecord, name: string | null): boolean =>
  name === "api_request" || name === "claude_code.api_request"
    ? text(record.resource.get("service.name"))?.startsWith("claude") !== false
    : false;

const isCodexWarmup = (record: OtlpRecord): boolean =>
  count(record.attributes.get("output_token_count")) === 0 &&
  (count(record.attributes.get("reasoning_token_count")) ?? 0) === 0 &&
  text(record.attributes.get("model_reasoning_effort")) === null;

const isCodexCompletion = (record: OtlpRecord, name: string | null): boolean =>
  name === "codex.sse_event" &&
  text(record.attributes.get("event.kind")) === "response.completed" &&
  !isCodexWarmup(record);

const claudeUsage = (record: OtlpRecord, observedAt: string): OtelUsage => {
  const attr = (key: string) => record.attributes.get(key);
  const time = occurredAt(record, observedAt);
  const sessionId = text(attr("session.id"));
  const requestId = text(attr("request_id"));
  const inputFresh = count(attr("input_tokens"));
  const output = count(attr("output_tokens"));
  const cacheRead = count(attr("cache_read_tokens"));
  const cacheWrite = count(attr("cache_creation_tokens"));
  const cost = attr("cost_usd");

  return {
    durationMs: count(attr("duration_ms")),
    effort: text(attr("effort")),
    event: "claude_code.api_request",
    model: text(attr("model")),
    requestId,
    requestKey:
      requestId ??
      `claude-code:${sessionId ?? "-"}:${time}:${text(attr("event.sequence")) ?? "-"}`,
    serviceTier: null,
    sessionId,
    speed: text(attr("speed")),
    time,
    tokens: {
      cacheRead,
      cacheWrite,
      cacheWrite1h: null,
      cacheWrite5m: null,
      inputFresh,
      output,
      reasoning: null,
      total: sum(inputFresh, output, cacheRead, cacheWrite),
    },
    tool: "claude-code",
    toolCostUsd: cost === undefined || cost === null ? null : count(cost),
    version: text(record.resource.get("service.version")),
  };
};

const codexUsage = (record: OtlpRecord, observedAt: string): OtelUsage => {
  const attr = (key: string) => record.attributes.get(key);
  const time = occurredAt(record, observedAt);
  const sessionId = text(attr("conversation.id"));
  const input = count(attr("input_token_count"));
  const cached = count(attr("cached_token_count"));
  const cacheWrite = count(attr("cache_write_token_count"));
  const output = count(attr("output_token_count"));
  const requestId = text(attr("response_id")) ?? text(attr("request_id"));

  return {
    durationMs: count(attr("duration_ms")),
    effort: text(attr("model_reasoning_effort")),
    event: "codex.sse_event",
    model: text(attr("model")),
    requestId,
    requestKey: requestId ?? `codex:${sessionId ?? "-"}:${time}`,
    serviceTier: text(attr("service_tier")),
    sessionId,
    speed: null,
    time,
    tokens: {
      cacheRead: cached,
      cacheWrite,
      cacheWrite1h: null,
      cacheWrite5m: null,
      inputFresh:
        input === null
          ? null
          : Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)),
      output,
      reasoning: count(attr("reasoning_token_count")),
      total: sum(input, output),
    },
    tool: "codex",
    toolCostUsd: null,
    version:
      text(attr("app.version")) ?? text(record.resource.get("service.version")),
  };
};

export const otelUsageOf = (
  record: OtlpRecord,
  observedAt: string
): OtelUsage | null => {
  const name = eventNameOf(record);

  if (isClaudeRequest(record, name)) {
    return claudeUsage(record, observedAt);
  }

  return isCodexCompletion(record, name)
    ? codexUsage(record, observedAt)
    : null;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const OTLP_ADAPTER_VERSION = "otlp-logs.v1";

export const otelEvent = (
  usage: OtelUsage,
  observedAt: string
): DxEventEnvelope => {
  const adapterId = harnessAdapterId(usage.tool);
  const upstreamKey = `otel:${usage.requestKey}`;

  return {
    acquisition: "api",
    adapterId,
    adapterVersion: OTLP_ADAPTER_VERSION,
    ai: {
      agentId: null,
      agentType: null,
      branchSource: "unassigned",
      channel: "otel",
      cwd: null,
      effort: usage.effort,
      effortSource: usage.effort === null ? null : "harness-recorded",
      harness: usage.tool,
      harnessVersion: usage.version,
      model: normalizeModel(usage.model),
      modelRaw: usage.model,
      parentSessionId: null,
      provider: providerFor(usage.model, null),
      sessionId: usage.sessionId,
      via: viaFor(usage.model, null),
    },
    context: emptyFlightContext,
    eventId: EventIdSchema.make(
      `sha256:${sha256(`${adapterId}\n${upstreamKey}`)}`
    ),
    evidence: { bounded: true, hash: null, ref: `${adapterId}:${upstreamKey}` },
    fieldSemantics: [],
    identity: {
      ...emptyEventIdentity,
      requestId: usage.requestId,
      sessionId: usage.sessionId,
    },
    kind: "ai.request",
    observedAt,
    occurredAt: usage.time,
    occurredAtPrecision: "exact",
    origin: "live",
    payload: { durationMs: usage.durationMs, otelEvent: usage.event },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: usage.version,
    upstreamKey,
    usage: {
      premiumRequests: null,
      requestKey: usage.requestId,
      serviceTier: usage.serviceTier,
      speed: usage.speed,
      tokens: usage.tokens,
      toolFigure:
        usage.toolCostUsd === null
          ? null
          : { amount: usage.toolCostUsd, currency: "USD", kind: "list-price" },
    },
  };
};

export const otelEvents = (
  records: readonly OtlpRecord[],
  observedAt: string
): readonly DxEventEnvelope[] =>
  records.flatMap((record) => {
    const usage = otelUsageOf(record, observedAt);

    return usage === null ? [] : [otelEvent(usage, observedAt)];
  });
