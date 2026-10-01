// @effect-diagnostics nodeBuiltinImport:off -- Builds synthetic OTLP request bodies (JSON, protobuf, gzip) for the receiver tests.
import { gzipSync } from "node:zlib";

export const SESSION = "11111111-2222-4333-8444-555555555555";

export const CONVERSATION = "01a0f000-0000-7000-8000-000000000001";

const text = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

const int = (key: string, value: number) => ({
  key,
  value: { intValue: String(value) },
});

const double = (key: string, value: number) => ({
  key,
  value: { doubleValue: value },
});

export const claudeLogsJson = (requestId: string): string =>
  JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            text("service.name", "claude-code"),
            text("service.version", "2.1.286"),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  text("event.name", "user_prompt"),
                  text("session.id", SESSION),
                  text("prompt", "<redacted>"),
                ],
                body: { stringValue: "claude_code.user_prompt" },
                timeUnixNano: "1790860637764000000",
              },
              {
                attributes: [
                  text("session.id", SESSION),
                  text("event.name", "api_request"),
                  text("event.timestamp", "2026-10-01T13:17:19.874Z"),
                  int("event.sequence", 41),
                  text("model", "claude-sonnet-5"),
                  int("input_tokens", 2),
                  int("output_tokens", 4),
                  int("cache_read_tokens", 27_778),
                  int("cache_creation_tokens", 27_117),
                  double("cost_usd", 0.25),
                  int("duration_ms", 1890),
                  text("request_id", requestId),
                  text("speed", "normal"),
                  text("effort", "medium"),
                ],
                body: { stringValue: "claude_code.api_request" },
                observedTimeUnixNano: "1790860639874000000",
                timeUnixNano: "1790860639874000000",
              },
            ],
            scope: { name: "com.anthropic.claude_code.events" },
          },
        ],
      },
    ],
  });

export interface CodexCompletion {
  readonly cached: number;
  readonly effort: string | null;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number | null;
  readonly timestamp: string;
}

const codexCompletionRecord = (completion: CodexCompletion) => ({
  attributes: [
    text("event.name", "codex.sse_event"),
    text("event.kind", "response.completed"),
    text("input_token_count", String(completion.input)),
    text("output_token_count", String(completion.output)),
    int("cached_token_count", completion.cached),
    ...(completion.reasoning === null
      ? []
      : [int("reasoning_token_count", completion.reasoning)]),
    int("tool_token_count", 0),
    ...(completion.effort === null
      ? []
      : [text("model_reasoning_effort", completion.effort)]),
    text("event.timestamp", completion.timestamp),
    text("conversation.id", CONVERSATION),
    text("app.version", "0.159.3"),
    text("model", "gpt-5.6-luna"),
  ],
  eventName: "event otel/src/events/session_telemetry.rs:1103",
  observedTimeUnixNano: "1790860683381242000",
});

export const codexLogsJson = (
  completions: readonly CodexCompletion[]
): string =>
  JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [text("service.name", "codex_exec")] },
        scopeLogs: [{ logRecords: completions.map(codexCompletionRecord) }],
      },
    ],
  });

const varint = (value: bigint): readonly number[] => {
  const out: number[] = [];
  let rest = value;

  do {
    const low = Number(rest % 128n);
    rest /= 128n;
    out.push(rest > 0n ? low + 128 : low);
  } while (rest > 0n);

  return out;
};

const tag = (field: number, wire: number): readonly number[] =>
  varint(BigInt(field * 8 + wire));

const message = (
  field: number,
  bytes: readonly number[]
): readonly number[] => [
  ...tag(field, 2),
  ...varint(BigInt(bytes.length)),
  ...bytes,
];

const utf8 = (field: number, value: string): readonly number[] =>
  message(field, [...new TextEncoder().encode(value)]);

const fixed64 = (field: number, value: bigint): readonly number[] => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);

  return [...tag(field, 1), ...bytes];
};

const intValue = (value: number): readonly number[] => [
  ...tag(3, 0),
  ...varint(BigInt.asUintN(64, BigInt(value))),
];

const attribute = (
  field: number,
  key: string,
  value: readonly number[]
): readonly number[] => message(field, [...utf8(1, key), ...message(2, value)]);

const textAttr = (key: string, value: string) =>
  attribute(6, key, utf8(1, value));

const intAttr = (key: string, value: number) =>
  attribute(6, key, intValue(value));

export const codexLogsProtobuf = (): Uint8Array => {
  const record = [
    ...fixed64(11, 1_790_860_683_381_242_000n),
    ...textAttr("event.name", "codex.sse_event"),
    ...textAttr("event.kind", "response.completed"),
    ...textAttr("input_token_count", "18842"),
    ...textAttr("output_token_count", "5"),
    ...intAttr("cached_token_count", 11_008),
    ...intAttr("cache_write_token_count", 0),
    ...intAttr("reasoning_token_count", 2),
    ...textAttr("model_reasoning_effort", "high"),
    ...textAttr("event.timestamp", "2026-10-01T13:18:03.381Z"),
    ...textAttr("conversation.id", CONVERSATION),
    ...textAttr("app.version", "0.159.3"),
    ...textAttr("model", "gpt-5.6-luna"),
    ...utf8(12, "event otel/src/events/session_telemetry.rs:1103"),
  ];

  const other = [
    ...fixed64(11, 1_790_860_683_143_454_000n),
    ...textAttr("event.name", "codex.turn_ttft"),
    ...intAttr("duration_ms", -1),
  ];

  const resource = attribute(1, "service.name", utf8(1, "codex_exec"));
  const scope = [...message(2, record), ...message(2, other)];
  const resourceLogs = [...message(1, resource), ...message(2, scope)];

  return new Uint8Array(message(1, resourceLogs));
};

export const gzip = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(gzipSync(bytes));
