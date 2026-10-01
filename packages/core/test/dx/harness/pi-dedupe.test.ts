import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type { MemoryFile } from "../../../src/dx/harness/file-store.js";
import type { MemoryRepo } from "../../../src/dx/harness/git.js";
import { GitRunner } from "../../../src/dx/harness/git.js";
import { PiHarness, PiStore } from "../../../src/dx/harness/pi/index.js";
import type { CollectCursor } from "../../../src/dx/model/coverage.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";

const ROOT = "/home/user/.pi/agent/sessions";

const PROJECT = "/home/user/projects/demo";

const DIR = `${ROOT}/--home-user-projects-demo--`;

const input = {
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture" as const,
};

interface Tokens {
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
  readonly cost?: number;
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly totalTokens?: number;
}

const usageOf = (tokens: Tokens) => ({
  cacheRead: tokens.cacheRead ?? 0,
  cacheWrite: tokens.cacheWrite ?? 0,
  cacheWrite1h: tokens.cacheWrite1h,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: tokens.cost ?? 0,
  },
  input: tokens.input ?? 0,
  output: tokens.output ?? 0,
  reasoning: tokens.reasoning,
  totalTokens: tokens.totalTokens ?? 0,
});

const at = (second: number) =>
  `2026-10-01T10:00:${String(second).padStart(2, "0")}.000Z`;

interface HeaderExtra {
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly timestamp?: string;
}

const header = (id: string, extra: HeaderExtra = {}) =>
  JSON.stringify({
    cwd: PROJECT,
    id,
    timestamp: at(0),
    type: "session",
    version: 3,
    ...extra,
  });

const user = (id: string, parentId: string | null, second: number) =>
  JSON.stringify({
    id,
    message: { content: "Synthetic.", role: "user", timestamp: 0 },
    parentId,
    timestamp: at(second),
    type: "message",
  });

interface ToolCallBlock {
  readonly arguments: Readonly<
    Partial<Record<"agent" | "cwd" | "path", string>>
  >;
  readonly id: string;
  readonly name: string;
  readonly type: "toolCall";
}

interface AssistantOptions {
  readonly content?: readonly ToolCallBlock[];
  readonly model?: string;
  readonly provider?: string;
  readonly responseModel?: string;
  readonly stopReason?: string;
}

const assistant = (
  id: string,
  parentId: string | null,
  second: number,
  tokens: Tokens,
  options: AssistantOptions = {}
) =>
  JSON.stringify({
    id,
    message: {
      api: "anthropic-messages",
      content: options.content ?? [],
      model: options.model ?? "claude-sonnet-4-6",
      provider: options.provider ?? "anthropic",
      responseModel: options.responseModel,
      role: "assistant",
      stopReason: options.stopReason ?? "stop",
      thinkingLevel: "medium",
      timestamp: 0,
      usage: usageOf(tokens),
    },
    parentId,
    timestamp: at(second),
    type: "message",
  });

const readCall = (path: string): ToolCallBlock => ({
  arguments: { path },
  id: `call-${path}`,
  name: "read",
  type: "toolCall",
});

const lines = (...entries: readonly string[]) => `${entries.join("\n")}\n`;

const harnessWith = (
  files: readonly MemoryFile[],
  repos: readonly MemoryRepo[] = []
) =>
  PiHarness.layer.pipe(
    Layer.provide(
      PiStore.memory({ agentDir: "/home/user/.pi/agent", files, roots: [ROOT] })
    ),
    Layer.provide(GitRunner.memory(repos)),
    Layer.provide(NodeServices.layer)
  );

const readAll = (layer: Layer.Layer<PiHarness>) =>
  Effect.gen(function* readSessions() {
    const harness = yield* PiHarness;
    const refs = yield* harness.locate(everywhere);
    const byPath = new Map<string, readonly DxEventEnvelope[]>();

    for (const ref of refs) {
      byPath.set(ref.path, (yield* harness.read(ref, input)).events);
    }

    return byPath;
  }).pipe(Effect.provide(layer));

const readOne = (layer: Layer.Layer<PiHarness>, cursor: CollectCursor | null) =>
  Effect.gen(function* readFirst() {
    const harness = yield* PiHarness;
    const [ref] = yield* harness.locate(everywhere);

    if (ref === undefined) {
      return yield* Effect.die("no Pi session was located");
    }

    return yield* harness.read(ref, { ...input, cursor });
  }).pipe(Effect.provide(layer));

const usageEvents = (events: readonly DxEventEnvelope[] | undefined) =>
  (events ?? []).filter((event) => event.kind === "ai.usage");

const inputOf = (events: readonly DxEventEnvelope[] | undefined) =>
  usageEvents(events).reduce(
    (sum, event) => sum + (event.usage?.tokens.inputFresh ?? 0),
    0
  );

describe("pi request dedupe", () => {
  it.effect(
    "counts every assistant message of the tree, not only the active branch",
    () =>
      Effect.gen(function* tree() {
        const file = `${DIR}/2026-10-01T10-00-00-000Z_tree.jsonl`;

        const read = yield* readAll(
          harnessWith([
            {
              path: file,
              text: lines(
                header("tree"),
                user("u1", null, 1),
                assistant("a1", "u1", 2, { input: 10, output: 1 }),
                assistant("a2", "u1", 3, { input: 20, output: 1 })
              ),
            },
          ])
        );

        expect(inputOf(read.get(file))).toBe(30);
      })
  );

  it.effect("counts a line that was written twice once", () =>
    Effect.gen(function* repeated() {
      const file = `${DIR}/2026-10-01T10-00-00-000Z_twice.jsonl`;
      const reply = assistant("a1", "u1", 2, { input: 10, output: 1 });

      const read = yield* readAll(
        harnessWith([
          {
            path: file,
            text: lines(header("twice"), user("u1", null, 1), reply, reply),
          },
        ])
      );

      expect(usageEvents(read.get(file))).toHaveLength(1);
    })
  );

  it.effect("leaves the history a fork copied with its parent", () =>
    Effect.gen(function* fork() {
      const parent = `${DIR}/2026-10-01T10-00-00-000Z_parent.jsonl`;
      const child = `${DIR}/2026-10-01T10-00-09-000Z_child.jsonl`;

      const shared = [
        user("u1", null, 1),
        assistant("a1", "u1", 2, { input: 10 }),
      ];

      const read = yield* readAll(
        harnessWith([
          { path: parent, text: lines(header("parent"), ...shared) },
          {
            path: child,
            text: lines(
              header("child", { parentSession: parent, timestamp: at(9) }),
              ...shared,
              user("u2", "a1", 10),
              assistant("a2", "u2", 11, { input: 7 })
            ),
          },
        ])
      );

      expect(inputOf(read.get(parent))).toBe(10);
      expect(inputOf(read.get(child))).toBe(7);
      expect(usageEvents(read.get(child))[0]?.ai?.parentSessionId).toBe(
        "parent"
      );
    })
  );

  it.effect(
    "keeps the copied history of an orphaned fork under the parent's event ids",
    () =>
      Effect.gen(function* orphan() {
        const parent = `${DIR}/2026-10-01T10-00-00-000Z_parent.jsonl`;
        const child = `${DIR}/2026-10-01T10-00-09-000Z_child.jsonl`;

        const shared = [
          user("u1", null, 1),
          assistant("a1", "u1", 2, { input: 10 }),
        ];

        const original = yield* readAll(
          harnessWith([
            { path: parent, text: lines(header("parent"), ...shared) },
          ])
        );

        const orphaned = yield* readAll(
          harnessWith([
            {
              path: child,
              text: lines(
                header("child", { parentSession: parent, timestamp: at(9) }),
                ...shared,
                user("u2", "a1", 10),
                assistant("a2", "u2", 11, { input: 7 })
              ),
            },
          ])
        );

        const [kept] = usageEvents(orphaned.get(child));
        const [first] = usageEvents(original.get(parent));

        expect(inputOf(orphaned.get(child))).toBe(17);
        expect(kept?.eventId).toBe(first?.eventId);
      })
  );

  it.effect("gives a copied session file the original's event ids", () =>
    Effect.gen(function* copied() {
      const original = `${DIR}/2026-10-01T10-00-00-000Z_same.jsonl`;
      const copy = `${DIR}/abcd1234_d1_c1.jsonl`;

      const prefix = [
        header("same"),
        user("u1", null, 1),
        assistant("a1", "u1", 2, { input: 10 }),
      ];

      const read = yield* readAll(
        harnessWith([
          { path: original, text: lines(...prefix) },
          {
            path: copy,
            text: lines(
              ...prefix,
              user("u2", "a1", 3),
              assistant("a2", "u2", 4, { input: 5 })
            ),
          },
        ])
      );

      const ids = new Set(
        [
          ...usageEvents(read.get(original)),
          ...usageEvents(read.get(copy)),
        ].map((event) => event.eventId)
      );

      expect(ids.size).toBe(2);
      expect(usageEvents(read.get(copy))[1]?.ai?.agentType).toBe("ypi");
    })
  );

  it.effect("counts each request a subagent kept and skips its aggregate", () =>
    Effect.gen(function* subagent() {
      const file = `${DIR}/2026-10-01T10-00-00-000Z_sub.jsonl`;

      const child = (tokens: Tokens) => ({
        api: "openai-responses",
        content: [],
        model: "gpt-5.6-luna",
        provider: "cliproxy",
        role: "assistant",
        stopReason: "stop",
        thinkingLevel: "high",
        timestamp: 1_790_848_803_000,
        usage: usageOf(tokens),
      });

      const result = (messages: readonly ReturnType<typeof child>[]) =>
        JSON.stringify({
          id: "t1",
          message: {
            content: [],
            details: {
              results: [
                {
                  agent: "scout",
                  messages,
                  model: "cliproxy/gpt-5.6-luna",
                  usage: { cost: 0, input: 99, output: 9, turns: 2 },
                },
              ],
            },
            isError: false,
            role: "toolResult",
            timestamp: 0,
            toolCallId: "call-1",
            toolName: "subagent",
          },
          parentId: "a1",
          timestamp: at(5),
          type: "message",
        });

      const call: ToolCallBlock = {
        arguments: { agent: "scout", cwd: PROJECT },
        id: "call-1",
        name: "subagent",
        type: "toolCall",
      };

      const listed = yield* readAll(
        harnessWith([
          {
            path: file,
            text: lines(
              header("sub"),
              user("u1", null, 1),
              assistant("a1", "u1", 2, { input: 10 }, { content: [call] }),
              result([child({ input: 40 }), child({ input: 59 })])
            ),
          },
        ])
      );

      const aggregate = yield* readAll(
        harnessWith([
          {
            path: file,
            text: lines(
              header("sub"),
              user("u1", null, 1),
              assistant("a1", "u1", 2, { input: 10 }, { content: [call] }),
              result([])
            ),
          },
        ])
      );

      const children = usageEvents(listed.get(file)).filter(
        (event) => event.ai?.agentType === "scout"
      );

      expect(
        children.map((event) => event.usage?.tokens.inputFresh)
      ).toStrictEqual([40, 59]);
      expect(children[0]?.ai?.parentSessionId).toBe("sub");
      expect(children[0]?.ai?.cwd).toBe(PROJECT);
      expect(inputOf(aggregate.get(file))).toBe(109);
    })
  );

  it.effect("keeps a failed request without inventing tokens", () =>
    Effect.gen(function* failed() {
      const file = `${DIR}/2026-10-01T10-00-00-000Z_failed.jsonl`;

      const read = yield* readAll(
        harnessWith([
          {
            path: file,
            text: lines(
              header("failed"),
              user("u1", null, 1),
              assistant("a1", "u1", 2, {}, { stopReason: "error" }),
              assistant(
                "a2",
                "u1",
                3,
                { input: 5, output: 2 },
                { stopReason: "aborted" }
              )
            ),
          },
        ])
      );

      const events = read.get(file) ?? [];
      const failedRequest = events.find((event) => event.kind === "ai.request");

      expect(failedRequest?.usage).toBeNull();
      expect(failedRequest?.payload.failed).toBe(true);
      expect(
        usageEvents(events).map((event) => event.payload.stopReason)
      ).toStrictEqual(["aborted"]);
    })
  );

  it.effect(
    "counts compaction, branch summary, usage entries and tool usage once each",
    () =>
      Effect.gen(function* summaries() {
        const file = `${DIR}/2026-10-01T10-00-00-000Z_extra.jsonl`;

        const read = yield* readAll(
          harnessWith([
            {
              path: file,
              text: lines(
                header("extra"),
                user("u1", null, 1),
                assistant("a1", "u1", 2, { input: 1 }),
                JSON.stringify({
                  firstKeptEntryId: "u1",
                  id: "c1",
                  parentId: "a1",
                  summary: "Synthetic.",
                  timestamp: at(3),
                  type: "compaction",
                  usage: usageOf({ input: 2 }),
                }),
                JSON.stringify({
                  fromId: "c1",
                  id: "b1",
                  parentId: "u1",
                  summary: "Synthetic.",
                  timestamp: at(4),
                  type: "branch_summary",
                  usage: usageOf({ input: 4 }),
                }),
                JSON.stringify({
                  id: "w1",
                  kind: "cache_warm",
                  model: "claude-sonnet-4-6",
                  parentId: "b1",
                  provider: "anthropic",
                  timestamp: at(5),
                  type: "usage",
                  usage: usageOf({ cacheRead: 50 }),
                }),
                JSON.stringify({
                  id: "t1",
                  message: {
                    content: [],
                    isError: false,
                    role: "toolResult",
                    timestamp: 0,
                    toolCallId: "x",
                    toolName: "ask",
                    usage: usageOf({ input: 8 }),
                  },
                  parentId: "w1",
                  timestamp: at(6),
                  type: "message",
                })
              ),
            },
          ])
        );

        expect(
          usageEvents(read.get(file)).map((event) => [
            event.payload.requestKind,
            event.usage?.tokens.total,
          ])
        ).toStrictEqual([
          ["assistant", 1],
          ["compaction", 2],
          ["branch-summary", 4],
          ["usage", 50],
          ["tool", 8],
        ]);
      })
  );
});

describe("pi usage blocks", () => {
  it.effect("sums the buckets of one request and never Pi's totalTokens", () =>
    Effect.gen(function* buckets() {
      const file = `${DIR}/2026-10-01T10-00-00-000Z_tokens.jsonl`;

      const read = yield* readAll(
        harnessWith([
          {
            path: file,
            text: lines(
              header("tokens"),
              user("u1", null, 1),
              assistant("a1", "u1", 2, {
                cacheRead: 100,
                cacheWrite: 40,
                cacheWrite1h: 15,
                cost: 0.12,
                input: 10,
                output: 5,
                reasoning: 2,
                totalTokens: 9999,
              }),
              assistant("a2", "u1", 3, { input: 3, output: 4 })
            ),
          },
        ])
      );

      const [first, second] = usageEvents(read.get(file));

      expect(first?.usage).toMatchObject({
        tokens: {
          cacheRead: 100,
          cacheWrite: 40,
          cacheWrite1h: 15,
          cacheWrite5m: 25,
          inputFresh: 10,
          output: 5,
          reasoning: 2,
          total: 155,
        },
        toolFigure: { amount: 0.12, currency: "USD", kind: "api-equivalent" },
      });
      expect(second?.usage?.tokens.reasoning).toBeNull();
      expect(second?.usage?.toolFigure).toBeNull();
    })
  );

  it.effect("names the model maker, the gateway and the local runtime", () =>
    Effect.gen(function* models() {
      const file = `${DIR}/2026-10-01T10-00-00-000Z_models.jsonl`;

      const read = yield* readAll(
        harnessWith([
          {
            path: "/home/user/.pi/agent/models.json",
            text: JSON.stringify({
              providers: {
                cliproxy: { baseUrl: "http://127.0.0.1:8317/v1" },
                "mlx-box": { baseUrl: "http://localhost:8090/v1" },
              },
            }),
          },
          {
            path: file,
            text: lines(
              header("models"),
              user("u1", null, 1),
              assistant(
                "a1",
                "u1",
                2,
                { input: 1 },
                {
                  model: "antigravity/claude-sonnet-4-6",
                  provider: "cliproxy",
                }
              ),
              assistant(
                "a2",
                "u1",
                3,
                { input: 1 },
                {
                  model: "my-finetune",
                  provider: "mlx-box",
                }
              ),
              assistant(
                "a3",
                "u1",
                4,
                { input: 1 },
                {
                  model: "gpt-5.5",
                  provider: "openai-codex",
                  responseModel: "gpt-5.5-2026-09-01",
                }
              ),
              assistant(
                "a4",
                "u1",
                5,
                { input: 1 },
                {
                  model: "mlx-community/Ornith-1.0-35B-4bit",
                  provider: "omlx",
                }
              )
            ),
          },
        ])
      );

      expect(
        usageEvents(read.get(file)).map((event) => [
          event.ai?.provider,
          event.ai?.via,
          event.ai?.model,
        ])
      ).toStrictEqual([
        ["anthropic", "cliproxy", "claude-sonnet-4-6"],
        ["local", "mlx", "my-finetune"],
        ["openai", null, "gpt-5.5"],
        ["local", "mlx", "ornith-1.0-35b-4bit"],
      ]);
    })
  );
});

describe("pi branch and cursor", () => {
  it.effect("gives a non-repo turn the one repo its tool calls touched", () =>
    Effect.gen(function* toolCalls() {
      const file = `${ROOT}/--home-user-scratch--/2026-10-01T10-00-00-000Z_orch.jsonl`;
      const other = "/home/user/projects/other";

      const repos: readonly MemoryRepo[] = [
        {
          repoCommonDir: `${PROJECT}/.git`,
          worktrees: [{ branch: "main", headSha: null, path: PROJECT }],
        },
        {
          repoCommonDir: `${other}/.git`,
          worktrees: [{ branch: "dev", headSha: null, path: other }],
        },
      ];

      const sessions = yield* readAll(
        harnessWith(
          [
            {
              path: file,
              text: lines(
                header("orch", { cwd: "/home/user/scratch" }),
                user("u1", null, 1),
                assistant(
                  "a1",
                  "u1",
                  2,
                  { input: 1 },
                  {
                    content: [readCall(`${PROJECT}/src/a.ts`)],
                  }
                ),
                user("u2", "a1", 3),
                assistant(
                  "a2",
                  "u2",
                  4,
                  { input: 1 },
                  {
                    content: [
                      readCall(`${PROJECT}/a.ts`),
                      readCall(`${other}/b.ts`),
                    ],
                  }
                )
              ),
            },
          ],
          repos
        )
      );

      expect(
        usageEvents(sessions.get(file)).map((event) => [
          event.ai?.branchSource,
          event.context.branch,
        ])
      ).toStrictEqual([
        ["tool-calls", "main"],
        ["unassigned", null],
      ]);
    })
  );

  it.effect("reads only what was appended since the cursor", () =>
    Effect.gen(function* incremental() {
      const file = `${DIR}/2026-10-01T10-00-00-000Z_grow.jsonl`;

      const before = lines(
        header("grow"),
        user("u1", null, 1),
        assistant("a1", "u1", 2, { input: 1 })
      );

      const after = `${before}${lines(user("u2", "a1", 3), assistant("a2", "u2", 4, { input: 2 }))}`;

      const first = yield* readOne(
        harnessWith([{ mtimeMs: 1, path: file, text: before }]),
        null
      );

      const second = yield* readOne(
        harnessWith([{ mtimeMs: 2, path: file, text: after }]),
        first.cursor
      );

      expect(usageEvents(first.events)).toHaveLength(1);
      expect(
        usageEvents(second.events).map(
          (event) => event.usage?.tokens.inputFresh
        )
      ).toStrictEqual([2]);
    })
  );
});
