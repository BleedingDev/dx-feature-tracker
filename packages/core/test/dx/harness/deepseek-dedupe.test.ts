import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type {
  ReadInput,
  SessionRef,
} from "../../../src/dx/harness/contract.js";
import { DeepseekHarness } from "../../../src/dx/harness/deepseek/index.js";
import type { MemoryFile } from "../../../src/dx/harness/file-store.js";
import type { CollectCursor } from "../../../src/dx/model/coverage.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { deriveUsageFacts } from "../../../src/dx/usage/derive.js";
import {
  memoryFile,
  memoryHarness,
  rawLog,
  zstdLog,
} from "./deepseek-fixtures.js";

const T0 = 1_790_000_000_000;

const CWD = "/home/user/work/repo";

type Json = string | number | boolean | null | readonly Json[] | JsonObject;

interface JsonObject {
  readonly [key: string]: Json;
}

interface UsageInput extends JsonObject {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

const line = (value: JsonObject): string => JSON.stringify(value);

const header = (id: string, extra: JsonObject = {}): string =>
  line({
    createdAt: T0,
    cwd: CWD,
    delegationDepth: 0,
    id,
    isSeeded: false,
    type: "session",
    version: 4,
    ...extra,
  });

const row = (seq: number, type: string, data: JsonObject = {}): string =>
  line({ data, seq, time: T0 + seq * 1000, type });

const usageChunk = (seq: number, usage: UsageInput) => ({
  chunk: { type: "usage", usage },
  time: T0 + seq * 1000,
  type: "chunk",
});

const finishChunk = (seq: number, reason: JsonObject) => ({
  chunk: { reason, type: "finish" },
  time: T0 + seq * 1000,
  type: "chunk",
});

interface MessageOptions {
  readonly dataUsage?: UsageInput | null;
  readonly provider?: string;
  readonly responseId?: string;
  readonly responseModel?: string;
  readonly stream?: readonly Json[];
}

const message = (
  seq: number,
  turn: number,
  step: number,
  options: MessageOptions = {}
): string => {
  const response = {
    model: "deepseek-flash",
    provider: options.provider ?? "deepseek-official",
    responseId: options.responseId ?? `resp-${String(seq)}`,
    responseModel: options.responseModel ?? "deepseek-v4-flash",
  };

  const data = {
    message: {
      id: `msg-${String(seq)}`,
      role: "assistant",
      source: {
        kind: "model",
        model: "deepseek-flash",
        provider: response.provider,
        replayState: { response },
      },
    },
    step,
    stream: options.stream ?? [finishChunk(seq, { kind: "stop" })],
    turn,
  };

  const usage = options.dataUsage ?? null;

  return row(
    seq,
    "assistant/message",
    usage === null ? data : { ...data, usage }
  );
};

const attempt = (
  seq: number,
  turn: number,
  step: number,
  usage: UsageInput | null,
  code = "PROVIDER_ERROR"
): string =>
  row(seq, "assistant/attempt", {
    step,
    stream: [
      ...(usage === null ? [] : [usageChunk(seq, usage)]),
      finishChunk(seq, { failure: { code, message: "x" }, kind: "error" }),
    ],
    turn,
  });

const turnRows = (seq: number, turn: number, body: readonly string[]) => [
  row(seq, "turn/start", { turn }),
  row(seq + 1, "request/header", {
    header: {
      config: {
        model: "deepseek-flash",
        provider: "deepseek-official",
        reasoningEffort: "high",
      },
    },
    reason: "initial",
  }),
  ...body,
  row(seq + 90, "turn/end", { reason: { kind: "completed" }, turn }),
];

const U1: UsageInput = {
  cacheReadTokens: 100,
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 115,
};

const U2: UsageInput = {
  cacheReadTokens: 200,
  inputTokens: 20,
  outputTokens: 7,
  totalTokens: 227,
};

const input = (cursor: CollectCursor | null = null): ReadInput => ({
  context: emptyFlightContext,
  cursor,
  origin: "fixture",
});

const readAll = (files: readonly MemoryFile[]) =>
  Effect.gen(function* readFiles() {
    const harness = yield* DeepseekHarness;
    const refs = yield* harness.locate(everywhere);

    const batches = yield* Effect.forEach((ref: SessionRef) =>
      harness.read(ref, input())
    )(refs);

    return { batches, events: batches.flatMap((batch) => batch.events), refs };
  }).pipe(Effect.provide(memoryHarness(files)));

const usageOf = (events: readonly DxEventEnvelope[]) =>
  events.filter((event) => event.kind === "ai.usage");

const totalOf = (events: readonly DxEventEnvelope[]) =>
  usageOf(events).reduce(
    (sum, event) => sum + (event.usage?.tokens.total ?? 0),
    0
  );

const factTotals = (events: readonly DxEventEnvelope[]) =>
  deriveUsageFacts(events).facts.map((fact) => fact.tokens.total);

const session = (id: string, lines: readonly string[], cwd = CWD) =>
  memoryFile({ cwd, id }, zstdLog([[header(id)], [...lines]]));

describe("DeepSeek dedupe rules", () => {
  it.effect("counts a request once when its usage is also in the stream", () =>
    Effect.gen(function* streaming() {
      const { events } = yield* readAll([
        session(
          "session-a",
          turnRows(1, 1, [
            message(3, 1, 1, {
              dataUsage: U1,
              stream: [usageChunk(3, U1), finishChunk(3, { kind: "stop" })],
            }),
          ])
        ),
      ]);

      expect(usageOf(events)).toHaveLength(1);
      expect(totalOf(events)).toBe(115);
    })
  );

  it.effect(
    "takes the last usage chunk when a message has no usage of its own",
    () =>
      Effect.gen(function* lastChunk() {
        const { events } = yield* readAll([
          session(
            "session-a",
            turnRows(1, 1, [
              message(3, 1, 1, {
                stream: [
                  usageChunk(3, U1),
                  usageChunk(3, U2),
                  finishChunk(3, { kind: "stop" }),
                ],
              }),
            ])
          ),
        ]);

        expect(usageOf(events)).toHaveLength(1);
        expect(totalOf(events)).toBe(227);
      })
  );

  it.effect(
    "replaces an earlier sample of the same step and drops an identical repeat",
    () =>
      Effect.gen(function* replaced() {
        const { events } = yield* readAll([
          session(
            "session-a",
            turnRows(1, 1, [
              attempt(3, 1, 1, U1),
              message(4, 1, 1, { dataUsage: U2 }),
              message(5, 1, 1, { dataUsage: U2, responseId: "resp-4" }),
            ])
          ),
        ]);

        expect(
          usageOf(events).map((event) => event.usage?.requestKey)
        ).toStrictEqual(["deepseek:response:resp-4"]);
        expect(totalOf(events)).toBe(227);

        const turn = events.find((event) => event.kind === "ai.turn");

        expect(turn?.payload.requests).toBe(1);
      })
  );

  it.effect("adds every retried attempt of a step", () =>
    Effect.gen(function* retried() {
      const { events } = yield* readAll([
        session(
          "session-a",
          turnRows(1, 1, [
            attempt(3, 1, 1, U1),
            row(4, "llm/retry", { step: 1, turn: 1 }),
            row(5, "llm/retry-started", { step: 1, turn: 1 }),
            message(6, 1, 1, { dataUsage: U2 }),
          ])
        ),
      ]);

      const usage = usageOf(events);

      expect(usage.map((event) => event.payload.attempt)).toStrictEqual([0, 1]);
      expect(usage.map((event) => event.payload.outcome)).toStrictEqual([
        "error",
        "completed",
      ]);
      expect(totalOf(events)).toBe(342);
    })
  );

  it.effect(
    "skips history a fork inherited and keeps a resumed session whole",
    () =>
      Effect.gen(function* forked() {
        const parentTurn = turnRows(1, 1, [
          message(3, 1, 1, { dataUsage: U1 }),
        ]);

        const fork = memoryFile(
          { cwd: CWD, id: "fork-child" },
          zstdLog([
            [
              header("fork-child", {
                delegationDepth: 1,
                isSeeded: true,
                origin: "subagent",
                parentSession: "session-parent",
              }),
              ...parentTurn,
              row(95, "session/end-seed", { inherited: true }),
              row(96, "subagent/descriptor", {
                mode: "one-shot",
                provider: "fork",
                version: 3,
              }),
              ...turnRows(100, 2, [message(103, 2, 1, { dataUsage: U2 })]),
            ],
          ])
        );

        const resumed = session("session-parent", [
          ...parentTurn,
          row(95, "session/end-seed", {}),
          ...turnRows(100, 2, [
            message(103, 2, 1, { dataUsage: U2, responseId: "resp-parent-2" }),
          ]),
        ]);

        const { events } = yield* readAll([fork, resumed]);

        const child = events.filter(
          (event) => event.identity.sessionId === "fork-child"
        );

        const parent = events.filter(
          (event) => event.identity.sessionId === "session-parent"
        );

        expect(totalOf(child)).toBe(227);
        expect(totalOf(parent)).toBe(342);
        expect(usageOf(child)[0]?.ai?.agentType).toBe("fork");
        expect(usageOf(child)[0]?.ai?.parentSessionId).toBe("session-parent");
        expect(usageOf(child)[0]?.ai?.agentId).toBe("fork-child");
      })
  );

  it.effect("reads only the newest generation of a session", () =>
    Effect.gen(function* archived() {
      const lines = turnRows(1, 1, [message(3, 1, 1, { dataUsage: U1 })]);
      const id = "session-a";

      const { events, refs } = yield* readAll([
        memoryFile(
          { cwd: CWD, id },
          zstdLog([[header(id, { version: 3 }), ...lines]]),
          "session.v3.jsonl.zstd"
        ),
        memoryFile({ cwd: CWD, id }, zstdLog([[header(id)], lines])),
      ]);

      expect(refs.map((ref) => ref.path.split("/").at(-1))).toStrictEqual([
        "session.v4.jsonl.zstd",
      ]);
      expect(totalOf(events)).toBe(115);
    })
  );

  it.effect(
    "keeps a subagent's requests in its own session, counted once",
    () =>
      Effect.gen(function* subagent() {
        const parent = session(
          "session-parent",
          turnRows(1, 1, [message(3, 1, 1, { dataUsage: U1 })])
        );

        const child = memoryFile(
          { cwd: CWD, id: "child-uuid" },
          zstdLog([
            [
              header("child-uuid", {
                delegationDepth: 1,
                origin: "subagent",
                parentSession: "session-parent",
              }),
              row(0, "subagent/descriptor", {
                agentModel: "deepseek-flash",
                agentProvider: "deepseek-official",
                mode: "continuable",
                provider: "spawn",
                version: 3,
              }),
              ...turnRows(1, 1, [
                message(3, 1, 1, { dataUsage: U2, responseId: "resp-child" }),
              ]),
            ],
          ])
        );

        const { events, refs } = yield* readAll([parent, child]);

        expect(
          refs
            .map((ref) => ref.sessionId ?? "")
            .toSorted((a, b) => a.localeCompare(b))
        ).toStrictEqual(["child-uuid", "session-parent"]);
        expect(totalOf(events)).toBe(342);
        expect(
          usageOf(events).map((event) => [
            event.identity.sessionId,
            event.ai?.agentType ?? null,
          ])
        ).toStrictEqual([
          ["child-uuid", "spawn"],
          ["session-parent", null],
        ]);
      })
  );

  it.effect(
    "counts compaction calls and lists title requests without usage",
    () =>
      Effect.gen(function* sideRequests() {
        const { events } = yield* readAll([
          session(
            "session-a",
            turnRows(1, 1, [
              row(2, "session/title-llm-request", {
                route: {
                  model: "deepseek-flash",
                  provider: "deepseek-official",
                },
              }),
              message(3, 1, 1, { dataUsage: U1 }),
              row(4, "compaction/summary", {
                compactionId: "c1",
                model: "deepseek-flash",
                provider: "deepseek-official",
                usage: U2,
              }),
            ])
          ),
        ]);

        expect(
          events
            .filter(
              (event) =>
                event.kind === "ai.usage" || event.kind === "ai.request"
            )
            .map((event) => [event.kind, event.payload.requestSource])
        ).toStrictEqual([
          ["ai.request", "title"],
          ["ai.usage", "message"],
          ["ai.usage", "compaction"],
        ]);
        expect(totalOf(events)).toBe(342);
      })
  );

  it.effect(
    "keeps unknown token buckets null and proves zeros from the total",
    () =>
      Effect.gen(function* buckets() {
        const { events } = yield* readAll([
          session(
            "session-a",
            turnRows(1, 1, [
              message(3, 1, 1, {
                dataUsage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
              }),
              message(4, 1, 2, {
                dataUsage: { inputTokens: 8, outputTokens: 2 },
              }),
              message(5, 1, 3, {
                dataUsage: {
                  inputTokens: 8,
                  outputTokens: 4,
                  reasoningTokens: 3,
                  totalTokens: 12,
                },
              }),
            ])
          ),
        ]);

        expect(
          usageOf(events).map((event) => event.usage?.tokens)
        ).toStrictEqual([
          {
            cacheRead: 0,
            cacheWrite: 0,
            cacheWrite1h: null,
            cacheWrite5m: null,
            inputFresh: 8,
            output: 2,
            reasoning: null,
            total: 10,
          },
          {
            cacheRead: null,
            cacheWrite: null,
            cacheWrite1h: null,
            cacheWrite5m: null,
            inputFresh: 8,
            output: 2,
            reasoning: null,
            total: null,
          },
          {
            cacheRead: 0,
            cacheWrite: 0,
            cacheWrite1h: null,
            cacheWrite5m: null,
            inputFresh: 8,
            output: 4,
            reasoning: 3,
            total: 12,
          },
        ]);
        expect(usageOf(events)[0]?.ai?.effort).toBe("high");
        expect(usageOf(events)[0]?.ai?.effortSource).toBe("harness-recorded");
        expect(usageOf(events)[0]?.ai?.provider).toBe("deepseek");
        expect(usageOf(events)[0]?.ai?.via).toBeNull();
        expect(usageOf(events)[0]?.ai?.model).toBe("deepseek-v4-flash");
      })
  );

  it.effect(
    "reports a failed request that used no tokens without a usage block",
    () =>
      Effect.gen(function* failed() {
        const { events } = yield* readAll([
          session(
            "session-a",
            turnRows(1, 1, [
              attempt(
                3,
                1,
                1,
                { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                "INVALID_REQUEST"
              ),
            ])
          ),
        ]);

        const request = events.find((event) => event.kind === "ai.request");

        expect(request?.usage).toBeNull();
        expect(request?.payload.outcome).toBe("error");
        expect(request?.payload.errorCode).toBe("INVALID_REQUEST");
        expect(request?.ai?.model).toBe("deepseek-flash");
      })
  );

  it.effect("names the gateway a model was routed through", () =>
    Effect.gen(function* gateways() {
      const { events } = yield* readAll([
        session(
          "session-a",
          turnRows(1, 1, [
            message(3, 1, 1, {
              dataUsage: U1,
              provider: "openrouter",
              responseModel: "anthropic/claude-sonnet-5",
            }),
            message(4, 1, 2, {
              dataUsage: U1,
              provider: "my-proxy",
              responseModel: "gpt-5.6-luna",
            }),
            message(5, 1, 3, {
              dataUsage: U1,
              provider: "ollama",
              responseModel: "qwen3-coder:30b",
            }),
          ])
        ),
      ]);

      expect(
        usageOf(events).map((event) => [
          event.ai?.provider,
          event.ai?.via,
          event.ai?.model,
        ])
      ).toStrictEqual([
        ["anthropic", "openrouter", "claude-sonnet-5"],
        ["openai", "my-proxy", "gpt-5.6-luna"],
        ["qwen", "ollama", "qwen3-coder:30b"],
      ]);
    })
  );
});

describe("DeepSeek incremental reads", () => {
  const id = "session-a";
  const turn1 = turnRows(1, 1, [message(3, 1, 1, { dataUsage: U1 })]);
  const turn2 = turnRows(100, 2, [message(103, 2, 1, { dataUsage: U2 })]);
  const full = zstdLog([[header(id)], turn1, turn2]);
  const firstPart = zstdLog([[header(id)], turn1]);

  const readRef = (
    bytes: Uint8Array,
    mtimeMs: number,
    cursor: CollectCursor | null
  ) =>
    Effect.gen(function* readOnce() {
      const harness = yield* DeepseekHarness;
      const [ref] = yield* harness.locate(everywhere);

      if (ref === undefined) {
        return yield* Effect.die("no session located");
      }

      return yield* harness.read(ref, input(cursor));
    }).pipe(
      Effect.provide(
        memoryHarness([memoryFile({ cwd: CWD, id }, bytes, undefined, mtimeMs)])
      )
    );

  it.effect("continues from the cursor and never repeats an event", () =>
    Effect.gen(function* incremental() {
      const whole = yield* readRef(full, 2, null);
      const first = yield* readRef(firstPart, 1, null);
      const second = yield* readRef(full, 2, first.cursor);
      const again = yield* readRef(full, 2, second.cursor);

      expect(
        [...first.events, ...second.events].map((event) => event.eventId)
      ).toStrictEqual(whole.events.map((event) => event.eventId));
      expect(second.events.some((event) => event.kind === "ai.session")).toBe(
        false
      );
      expect(again.events).toStrictEqual([]);
    })
  );

  it.effect("keeps a same-step replacement that arrives in a later read", () =>
    Effect.gen(function* replacedLater() {
      const rows = turnRows(1, 1, [attempt(3, 1, 1, U1), attempt(4, 1, 1, U2)]);

      const before = zstdLog([[header(id)], rows.slice(0, 3)]);
      const after = zstdLog([[header(id)], rows.slice(0, 3), rows.slice(3)]);
      const whole = yield* readRef(after, 2, null);
      const first = yield* readRef(before, 1, null);
      const second = yield* readRef(after, 2, first.cursor);

      expect(factTotals(whole.events)).toStrictEqual([227]);
      expect(factTotals([...first.events, ...second.events])).toStrictEqual([
        227,
      ]);
    })
  );

  it.effect(
    "stops at a torn last frame and picks it up once it is complete",
    () =>
      Effect.gen(function* torn() {
        const whole = yield* readRef(full, 3, null);
        const cut = full.subarray(0, -7);
        const partial = yield* readRef(cut, 1, null);
        const repaired = yield* readRef(full, 3, partial.cursor);

        expect(partial.coverage.state).toBe("partial");
        expect(
          partial.coverage.gaps.map((gap) => gap.message).join(" ")
        ).toMatch(/incomplete/u);
        expect(totalOf(partial.events)).toBe(115);
        expect(
          [...partial.events, ...repaired.events].map((event) => event.eventId)
        ).toStrictEqual(whole.events.map((event) => event.eventId));
      })
  );

  it.effect(
    "reads an uncompressed log and ignores an unfinished last line",
    () =>
      Effect.gen(function* raw() {
        const lines = [header(id), ...turn1];
        const text = new TextDecoder().decode(rawLog(lines));
        const bytes = new TextEncoder().encode(`${text}{"type":"turn/st`);

        const batch = yield* Effect.gen(function* readRaw() {
          const harness = yield* DeepseekHarness;
          const refs: readonly SessionRef[] = yield* harness.locate(everywhere);
          const [ref] = refs;

          return ref === undefined ? null : yield* harness.read(ref, input());
        }).pipe(
          Effect.provide(
            memoryHarness([
              memoryFile({ cwd: CWD, id }, bytes, "session.v4.jsonl"),
            ])
          )
        );

        expect(totalOf(batch?.events ?? [])).toBe(115);
        expect(batch?.coverage.state).toBe("partial");
      })
  );
});
