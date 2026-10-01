import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import {
  ClaudeCodeHarness,
  ClaudeCodeStore,
  QUIET_MS,
} from "../../../src/dx/harness/claude-code/index.js";
import type { ClaudeCodeMemoryInput } from "../../../src/dx/harness/claude-code/index.js";
import { everywhere } from "../../../src/dx/harness/contract.js";
import type { ReadInput } from "../../../src/dx/harness/contract.js";
import type { MemoryFile } from "../../../src/dx/harness/file-store.js";
import { registryWith } from "../../../src/dx/harness/registry.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";

const root = "/h/.claude/projects";

const project = `${root}/-w-repo`;

interface ToolInput {
  readonly command?: string;
  readonly file_path?: string;
  readonly path?: string;
}

type ContentBlock =
  | { readonly text: string; readonly type: "text" }
  | {
      readonly id: string;
      readonly input: ToolInput;
      readonly name: string;
      readonly type: "tool_use";
    };

interface RowSpec {
  readonly agentId?: string;
  readonly content?: readonly ContentBlock[];
  readonly branch?: string;
  readonly cacheRead?: number | null;
  readonly cacheWrite?: number;
  readonly cwd?: string;
  readonly input?: number;
  readonly messageId: string;
  readonly model?: string;
  readonly output: number;
  readonly requestId?: string | null;
  readonly session: string;
  readonly stop?: string | null;
  readonly thinking?: number;
  readonly at?: string;
}

const assistant = (spec: RowSpec): string =>
  JSON.stringify({
    agentId: spec.agentId,
    cwd: spec.cwd ?? "/w/repo",
    effort: "high",
    gitBranch: spec.branch ?? "feature/a",
    isSidechain: spec.agentId !== undefined,
    message: {
      content: spec.content ?? [{ text: "synthetic", type: "text" }],
      id: spec.messageId,
      model: spec.model ?? "claude-sonnet-5",
      role: "assistant",
      stop_reason: spec.stop === undefined ? "end_turn" : spec.stop,
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: spec.cacheWrite ?? 10,
        },
        cache_creation_input_tokens: spec.cacheWrite ?? 10,
        cache_read_input_tokens:
          spec.cacheRead === undefined ? 100 : spec.cacheRead,
        input_tokens: spec.input ?? 2,
        output_tokens: spec.output,
        output_tokens_details: { thinking_tokens: spec.thinking ?? 0 },
        service_tier: "standard",
        speed: "standard",
      },
    },
    requestId:
      spec.requestId === undefined ? `req-${spec.messageId}` : spec.requestId,
    sessionId: spec.session,
    timestamp: spec.at ?? "2026-10-01T10:00:00.000Z",
    type: "assistant",
    uuid: `u-${spec.messageId}-${String(spec.output)}`,
    version: "2.1.286",
  });

const prompt = (session: string, promptId: string): string =>
  JSON.stringify({
    cwd: "/w/repo",
    gitBranch: "feature/a",
    message: { content: "synthetic", role: "user" },
    promptId,
    sessionId: session,
    timestamp: "2026-10-01T09:59:59.000Z",
    type: "user",
    uuid: `p-${promptId}`,
  });

const lines = (...rows: readonly string[]): string => `${rows.join("\n")}\n`;

const storeWith = (
  files: readonly MemoryFile[],
  extra: Partial<ClaudeCodeMemoryInput> = {}
) =>
  Layer.fresh(ClaudeCodeHarness.layer).pipe(
    Layer.provide(ClaudeCodeStore.memory({ files, roots: [root], ...extra }))
  );

const input: ReadInput = {
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture",
};

const readAll = Effect.gen(function* readEverything() {
  const harness = yield* ClaudeCodeHarness;
  const refs = yield* harness.locate(everywhere);
  const events: DxEventEnvelope[] = [];

  for (const ref of refs) {
    const batch = yield* harness.read(ref, input);

    events.push(...batch.events);
  }

  return events;
});

const usageOf = (events: readonly DxEventEnvelope[]) =>
  events.filter((event) => event.kind === "ai.usage");

describe("Claude Code dedupe rules", () => {
  it.effect("keeps the largest streamed row of one request", () =>
    Effect.gen(function* streaming() {
      const usage = usageOf(yield* readAll);

      expect(usage).toHaveLength(1);
      expect(usage[0]?.usage?.tokens.output).toBe(115);
      expect(usage[0]?.usage?.tokens.reasoning).toBe(40);
      expect(usage[0]?.payload.rowCount).toBe(3);
      expect(usage[0]?.usage?.requestKey).toBe(
        "source:claude-jsonl:request:req-m1"
      );
    }).pipe(
      Effect.provide(
        storeWith([
          {
            path: `${project}/s1.jsonl`,
            text: lines(
              prompt("s1", "t1"),
              assistant({
                messageId: "m1",
                output: 3,
                session: "s1",
                stop: null,
              }),
              assistant({
                messageId: "m1",
                output: 115,
                session: "s1",
                thinking: 40,
              }),
              assistant({
                messageId: "m1",
                output: 115,
                session: "s1",
                thinking: 40,
              })
            ),
          },
        ])
      )
    )
  );

  it.effect(
    "keys gateway rows without a request id by message id and keeps the final split",
    () =>
      Effect.gen(function* gateway() {
        const usage = usageOf(yield* readAll);

        expect(usage).toHaveLength(1);
        expect(usage[0]?.usage?.tokens).toMatchObject({
          cacheRead: 84_096,
          inputFresh: 6736,
          output: 489,
        });
        expect(usage[0]?.usage?.requestKey).toBe(
          "source:claude-jsonl:message:resp_1"
        );
        expect(usage[0]?.ai).toMatchObject({
          model: "gpt-5.6-sol",
          provider: "openai",
          via: "gateway",
        });
      }).pipe(
        Effect.provide(
          storeWith([
            {
              path: `${project}/s1.jsonl`,
              text: lines(
                assistant({
                  at: "2026-10-01T10:00:00.100Z",
                  cacheRead: null,
                  input: 90_832,
                  messageId: "resp_1",
                  model: "gpt-5.6-sol",
                  output: 0,
                  requestId: null,
                  session: "s1",
                  stop: null,
                }),
                assistant({
                  at: "2026-10-01T10:00:00.900Z",
                  cacheRead: 84_096,
                  cacheWrite: 0,
                  input: 6736,
                  messageId: "resp_1",
                  model: "gpt-5.6-sol",
                  output: 489,
                  requestId: null,
                  session: "s1",
                  stop: "tool_use",
                })
              ),
            },
          ])
        )
      )
  );

  it.effect(
    "keeps a gateway request with only stream-start rows as an unknown split",
    () =>
      Effect.gen(function* streamStart() {
        const harness = yield* ClaudeCodeHarness;
        const refs = yield* harness.locate(everywhere);

        const batches = yield* Effect.forEach((ref: (typeof refs)[number]) =>
          harness.read(ref, input)
        )(refs);

        const events = batches.flatMap((batch) => batch.events);
        const usage = usageOf(events);

        const byKey = new Map(
          usage.map((event) => [event.usage?.requestKey, event])
        );

        const open = byKey.get("source:claude-jsonl:message:resp_open");
        const done = byKey.get("source:claude-jsonl:message:resp_done");

        expect(usage).toHaveLength(2);
        expect(open?.usage?.tokens).toStrictEqual({
          cacheRead: null,
          cacheWrite: null,
          cacheWrite1h: null,
          cacheWrite5m: null,
          inputFresh: null,
          output: null,
          reasoning: null,
          total: 29_972,
        });
        expect(open?.payload.rowCount).toBe(2);
        expect(done?.usage?.tokens).toMatchObject({
          cacheRead: 37_632,
          inputFresh: 5552,
          output: 179,
        });
        expect(
          batches.flatMap((batch) => batch.coverage.gaps.map((gap) => gap.code))
        ).toStrictEqual(["request-usage-incomplete"]);
      }).pipe(
        Effect.provide(
          storeWith([
            {
              path: `${project}/s1.jsonl`,
              text: lines(
                prompt("s1", "t1"),
                assistant({
                  cacheRead: null,
                  input: 29_972,
                  messageId: "resp_open",
                  model: "gpt-5.6-sol",
                  output: 0,
                  requestId: null,
                  session: "s1",
                  stop: null,
                }),
                prompt("s1", "t2"),
                assistant({
                  at: "2026-10-01T10:00:01.000Z",
                  cacheRead: null,
                  input: 29_972,
                  messageId: "resp_open",
                  model: "gpt-5.6-sol",
                  output: 0,
                  requestId: null,
                  session: "s1",
                  stop: null,
                }),
                assistant({
                  at: "2026-10-01T10:00:02.000Z",
                  cacheRead: null,
                  input: 43_908,
                  messageId: "resp_done",
                  model: "gpt-5.6-sol",
                  output: 0,
                  requestId: null,
                  session: "s1",
                  stop: null,
                }),
                assistant({
                  at: "2026-10-01T10:00:03.000Z",
                  cacheRead: 37_632,
                  cacheWrite: 0,
                  input: 5552,
                  messageId: "resp_done",
                  model: "gpt-5.6-sol",
                  output: 179,
                  requestId: null,
                  session: "s1",
                  stop: "tool_use",
                })
              ),
            },
          ])
        )
      )
  );

  it.effect(
    "gives a request copied into a forked session the same event id",
    () =>
      Effect.gen(function* forked() {
        const usage = usageOf(yield* readAll);

        expect(usage).toHaveLength(2);
        expect(new Set(usage.map((event) => event.eventId)).size).toBe(1);
        expect(usage.map((event) => event.ai?.sessionId)).toStrictEqual([
          "fork",
          "orig",
        ]);
      }).pipe(
        Effect.provide(
          storeWith([
            {
              path: `${project}/orig.jsonl`,
              text: lines(
                assistant({ messageId: "m1", output: 50, session: "orig" })
              ),
            },
            {
              path: `${project}/fork.jsonl`,
              text: lines(
                assistant({ messageId: "m1", output: 50, session: "fork" })
              ),
            },
          ])
        )
      )
  );

  it.effect("counts a parent request replayed into a subagent file once", () =>
    Effect.gen(function* replayed() {
      const usage = usageOf(yield* readAll);

      expect(usage.map((event) => event.ai?.sessionId)).toStrictEqual([
        "s1",
        "s1:agent-a1",
      ]);
      expect(usage.map((event) => event.usage?.tokens.output)).toStrictEqual([
        50, 20,
      ]);
      expect(usage[1]?.ai).toMatchObject({
        agentId: "a1",
        agentType: "Explore",
        parentSessionId: "s1",
      });
    }).pipe(
      Effect.provide(
        storeWith([
          {
            path: `${project}/s1.jsonl`,
            text: lines(
              assistant({ messageId: "m1", output: 50, session: "s1" })
            ),
          },
          {
            path: `${project}/s1/subagents/agent-a1.jsonl`,
            text: lines(
              assistant({
                agentId: "a1",
                messageId: "m1",
                output: 50,
                session: "s1",
              }),
              assistant({
                agentId: "a1",
                messageId: "m2",
                output: 20,
                session: "s1",
              })
            ),
          },
          {
            path: `${project}/s1/subagents/agent-a1.meta.json`,
            text: JSON.stringify({ agentType: "Explore", spawnDepth: 1 }),
          },
        ])
      )
    )
  );

  it.effect(
    "takes the completed row from a resumed workflow agent over its interrupted copy",
    () =>
      Effect.gen(function* resumedAgent() {
        const usage = usageOf(yield* readAll);

        expect(usage).toHaveLength(1);
        expect(usage[0]?.usage?.tokens.output).toBe(3503);
      }).pipe(
        Effect.provide(
          storeWith([
            {
              path: `${project}/s1/subagents/workflows/wf_1/agent-a1.jsonl`,
              text: lines(
                assistant({
                  agentId: "a1",
                  cacheRead: null,
                  messageId: "resp_9",
                  output: 0,
                  requestId: null,
                  session: "s1",
                  stop: null,
                })
              ),
            },
            {
              path: `${project}/s1/subagents/agent-a1.jsonl`,
              text: lines(
                assistant({
                  agentId: "a1",
                  messageId: "resp_9",
                  output: 3503,
                  requestId: null,
                  session: "s1",
                  stop: "tool_use",
                })
              ),
            },
          ])
        )
      )
  );

  it.effect("skips synthetic and failed rows and reports them", () =>
    Effect.gen(function* failed() {
      const harness = yield* ClaudeCodeHarness;
      const refs = yield* harness.locate(everywhere);

      const batches = yield* Effect.forEach((ref: (typeof refs)[number]) =>
        harness.read(ref, input)
      )(refs);

      const [batch] = batches;

      expect(batches).toHaveLength(1);
      expect(usageOf(batch?.events ?? [])).toHaveLength(0);
      expect(batch?.coverage.gaps.map((gap) => gap.code)).toStrictEqual([
        "synthetic-rows",
        "api-error-rows",
      ]);
    }).pipe(
      Effect.provide(
        storeWith([
          {
            path: `${project}/s1.jsonl`,
            text: lines(
              JSON.stringify({
                message: {
                  id: "x",
                  model: "<synthetic>",
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
                sessionId: "s1",
                type: "assistant",
              }),
              JSON.stringify({
                isApiErrorMessage: true,
                message: {
                  id: "y",
                  model: "<synthetic>",
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
                sessionId: "s1",
                type: "assistant",
              })
            ),
          },
        ])
      )
    )
  );

  it.effect(
    "lists every path the request's tool calls touched, across its streamed rows",
    () =>
      Effect.gen(function* touched() {
        const usage = usageOf(yield* readAll);

        expect(usage.map((event) => event.ai?.touchedPaths)).toStrictEqual([
          ["/h/notes/a.md", "/w/other", "/w/repo/src/b.ts"],
        ]);
        expect(usage[0]?.payload.toolCalls).toBe(3);
      }).pipe(
        Effect.provide(
          storeWith(
            [
              {
                path: `${project}/s1.jsonl`,
                text: lines(
                  assistant({
                    content: [
                      {
                        id: "t1",
                        input: { file_path: "~/notes/a.md" },
                        name: "Read",
                        type: "tool_use",
                      },
                    ],
                    messageId: "m1",
                    output: 30,
                    session: "s1",
                    stop: null,
                  }),
                  assistant({
                    content: [
                      {
                        id: "t2",
                        input: { command: "cd /w/other && ls" },
                        name: "Bash",
                        type: "tool_use",
                      },
                      {
                        id: "t3",
                        input: { path: "src/b.ts" },
                        name: "Grep",
                        type: "tool_use",
                      },
                    ],
                    messageId: "m1",
                    output: 60,
                    session: "s1",
                  })
                ),
              },
            ],
            { home: "/h" }
          )
        )
      )
  );

  it.effect("never treats a HEAD branch as a branch name", () =>
    Effect.gen(function* detached() {
      const usage = usageOf(yield* readAll);

      expect(usage[0]?.context.branch).toBeNull();
      expect(usage[0]?.ai?.branchSource).toBe("unassigned");
    }).pipe(
      Effect.provide(
        storeWith([
          {
            path: `${project}/s1.jsonl`,
            text: lines(
              assistant({
                branch: "HEAD",
                messageId: "m1",
                output: 5,
                session: "s1",
              })
            ),
          },
        ])
      )
    )
  );

  it.effect(
    "keeps the cumulative cost-state as one session figure, never per request",
    () =>
      Effect.gen(function* cost() {
        const events = yield* readAll;

        const figures = events.flatMap((event) =>
          event.usage?.toolFigure === null || event.usage === null
            ? []
            : [
                [
                  event.kind,
                  event.usage.toolFigure.amount,
                  event.usage.toolFigure.kind,
                ],
              ]
        );

        expect(figures).toStrictEqual([["ai.session", 0.4, "api-equivalent"]]);
      }).pipe(
        Effect.provide(
          storeWith([
            {
              path: `${project}/s1.jsonl`,
              text: lines(
                assistant({ messageId: "m1", output: 5, session: "s1" }),
                JSON.stringify({
                  sessionId: "s1",
                  startTime: 1,
                  totalCostUSD: 0.1,
                  type: "cost-state",
                }),
                assistant({ messageId: "m2", output: 5, session: "s1" }),
                JSON.stringify({
                  sessionId: "s1",
                  startTime: 1,
                  totalCostUSD: 0.4,
                  type: "cost-state",
                })
              ),
            },
          ])
        )
      )
  );
});

const liveFile = `${project}/s1.jsonl`;

const streamingStart = lines(
  prompt("s1", "t1"),
  assistant({ messageId: "m1", output: 40, session: "s1" }),
  assistant({ messageId: "m2", output: 3, session: "s1", stop: null })
);

const streamingDone = `${streamingStart}${lines(
  assistant({ messageId: "m2", output: 120, session: "s1" }),
  assistant({ messageId: "m3", output: 8, session: "s1" })
)}`;

const readOnce = (text: string, cursor: ReadInput["cursor"]) =>
  Effect.gen(function* readSessionOnce() {
    const harness = yield* ClaudeCodeHarness;
    const [ref] = yield* harness.locate(everywhere);

    if (ref === undefined) {
      return yield* Effect.die("no session located");
    }

    return yield* harness.read(ref, { ...input, cursor });
  }).pipe(Effect.provide(storeWith([{ mtimeMs: 0, path: liveFile, text }])));

const outputs = (events: readonly DxEventEnvelope[]) =>
  usageOf(events).map((event) => event.usage?.tokens.output);

describe("Claude Code incremental reads", () => {
  it.effect(
    "holds a streaming request back until it settles and then reads only new rows",
    () =>
      Effect.gen(function* incremental() {
        const first = yield* readOnce(streamingStart, null);

        expect(outputs(first.events)).toStrictEqual([40]);
        expect(first.coverage.gaps.map((gap) => gap.code)).toStrictEqual([
          "requests-in-progress",
        ]);

        const unchanged = yield* readOnce(streamingStart, first.cursor);

        expect(outputs(unchanged.events)).toStrictEqual([]);

        const grown = yield* readOnce(streamingDone, first.cursor);

        expect(outputs(grown.events)).toStrictEqual([120]);
        expect(usageOf(grown.events)[0]?.identity.turnId).toBe("t1");

        yield* TestClock.adjust(QUIET_MS);

        const quiet = yield* readOnce(streamingDone, grown.cursor);

        expect(outputs(quiet.events)).toStrictEqual([8]);

        const settled = yield* readOnce(streamingDone, quiet.cursor);

        expect(settled.events).toStrictEqual([]);
        expect(settled.cursor).toStrictEqual(quiet.cursor);
      })
  );
});

harnessConformance(
  "claude-code",
  registryWith(
    storeWith([
      {
        path: `${project}/s1.jsonl`,
        text: lines(
          prompt("s1", "t1"),
          assistant({ messageId: "m1", output: 40, session: "s1" }),
          assistant({
            messageId: "m2",
            model: "claude-haiku-4-5-20251001",
            output: 9,
            session: "s1",
          })
        ),
      },
      {
        path: `${project}/s1/subagents/agent-a1.jsonl`,
        text: lines(
          assistant({
            agentId: "a1",
            messageId: "m3",
            output: 7,
            session: "s1",
          })
        ),
      },
    ])
  ),
  { expectEvents: true, tier: "mock" }
);
