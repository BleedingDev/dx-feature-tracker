import { Effect, Layer } from "effect";

import {
  CodexHarness,
  CodexStore,
} from "../../../src/dx/harness/codex/index.js";
import type { CodexMemoryInput } from "../../../src/dx/harness/codex/index.js";
import { everywhere } from "../../../src/dx/harness/contract.js";
import type {
  ReadInput,
  SessionRef,
} from "../../../src/dx/harness/contract.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../../src/dx/model/event.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";

export const readInput = (
  context: FlightContext = emptyFlightContext
): ReadInput => ({ context, cursor: null, origin: "fixture" });

export const readAll = (input: ReadInput = readInput()) =>
  Effect.gen(function* readAllSessions() {
    const harness = yield* CodexHarness;
    const refs = yield* harness.locate(everywhere);
    const events: DxEventEnvelope[] = [];

    for (const ref of refs) {
      const batch = yield* harness.read(ref, input);

      events.push(...batch.events);
    }

    return { events, refs };
  });

export const usageOf = (
  events: readonly DxEventEnvelope[],
  sessionId: string
) =>
  events.filter(
    (event) => event.kind === "ai.usage" && event.ai?.sessionId === sessionId
  );

export interface Totals {
  readonly cached: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly requests: number;
  readonly total: number;
}

export const totalsOf = (events: readonly DxEventEnvelope[]): Totals => {
  const sum = {
    cached: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    requests: 0,
    total: 0,
  };

  for (const event of events) {
    const tokens = event.usage?.tokens;

    if (tokens === undefined) {
      continue;
    }

    sum.cached += tokens.cacheRead ?? 0;
    sum.input +=
      (tokens.inputFresh ?? 0) +
      (tokens.cacheRead ?? 0) +
      (tokens.cacheWrite ?? 0);
    sum.output += tokens.output ?? 0;
    sum.reasoning += tokens.reasoning ?? 0;
    sum.requests += 1;
    sum.total += tokens.total ?? 0;
  }

  return sum;
};

export const memoryHarness = (input: CodexMemoryInput) =>
  CodexHarness.layer.pipe(Layer.provide(CodexStore.memory(input)));

export const memoryRef = (
  file: string,
  text: string,
  mtimeMs: number | null = null
): SessionRef => ({
  channel: "session-file",
  harness: "codex",
  id: file,
  mtimeMs,
  path: file,
  sessionId: null,
  size: new TextEncoder().encode(text).byteLength,
  source: "harness.codex",
  worktree: null,
});

export const THREAD = "01a0f719-884c-7ba1-b80a-4ffb1432cfad";

export const PARENT = "01a0f700-0000-7000-8000-000000000000";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonFields = Readonly<Record<string, JsonValue>>;

export const timestampAt = (ordinal: number): string =>
  `2026-10-01T10:${String(10 + Math.floor(ordinal / 60)).padStart(2, "0")}:${String(ordinal % 60).padStart(2, "0")}.000Z`;

export const line = (
  ordinal: number,
  type: string,
  payload: JsonFields
): string =>
  `{"timestamp":"${timestampAt(ordinal)}","ordinal":${String(ordinal)},"type":"${type}","payload":${JSON.stringify(payload)}}`;

export const meta = (ordinal: number, fields: JsonFields = {}): string =>
  line(ordinal, "session_meta", {
    cli_version: "0.159.3",
    cwd: "/home/user/work/demo",
    git: { branch: "main", commit_hash: "abc123" },
    id: THREAD,
    model_provider: "openai",
    session_id: THREAD,
    source: "exec",
    timestamp: "2026-10-01T10:00:00.000Z",
    ...fields,
  });

export const turnStarted = (ordinal: number, turnId: string): string =>
  line(ordinal, "event_msg", { turn_id: turnId, type: "task_started" });

export const turnContext = (
  ordinal: number,
  turnId: string,
  model = "gpt-5.6-luna",
  effort = "high"
): string =>
  line(ordinal, "turn_context", {
    cwd: "/home/user/work/demo",
    effort,
    model,
    turn_id: turnId,
  });

export const usage = (input: number, cached: number, output: number) => ({
  cache_write_input_tokens: 0,
  cached_input_tokens: cached,
  input_tokens: input,
  output_tokens: output,
  reasoning_output_tokens: Math.floor(output / 2),
  total_tokens: input + output,
});

export const record = (
  ordinal: number,
  responseId: string,
  tokens: ReturnType<typeof usage>,
  threadId = THREAD,
  turnId = "01a0f719-9000-7000-8000-000000000001"
): string =>
  line(ordinal, "token_usage_record", {
    response_id: responseId,
    thread_id: threadId,
    turn_id: turnId,
    usage: tokens,
  });

export const tokenCount = (
  ordinal: number,
  total: number,
  last: ReturnType<typeof usage>
): string =>
  line(ordinal, "event_msg", {
    info: {
      last_token_usage: last,
      total_token_usage: { ...last, total_tokens: total },
    },
    type: "token_count",
  });

export const sessionText = (...lines: readonly string[]): string =>
  `${lines.join("\n")}\n`;
