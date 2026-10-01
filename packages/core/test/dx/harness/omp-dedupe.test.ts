// @effect-diagnostics nodeBuiltinImport:off -- Archived OMP sessions are gzip files; the test builds one in memory with node:zlib.
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type { HarnessScope } from "../../../src/dx/harness/contract.js";
import type { MemoryFile } from "../../../src/dx/harness/file-store.js";
import {
  OMP_EXTENSION_MARKER,
  OMP_HOOK_EVENTS,
  OmpHarness,
  OmpStore,
  ompExtensionSource,
  ompHookKind,
} from "../../../src/dx/harness/omp/index.js";
import type { OmpMemoryInput } from "../../../src/dx/harness/omp/index.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
} from "../../../src/dx/model/event.js";

const ROOT = "/h/.omp/agent/sessions";

const ARCHIVE = "/h/.omp/agent/archive/sessions";

interface UsageInput {
  readonly cacheRead?: number;
  readonly cost?: number;
  readonly input: number;
  readonly output: number;
  readonly premiumRequests?: number;
  readonly reasoningTokens?: number;
}

const usageOf = (usage: UsageInput) => {
  const cacheRead = usage.cacheRead ?? 0;

  return {
    cacheRead,
    cacheWrite: 0,
    cost: { total: usage.cost ?? 0.001 },
    input: usage.input,
    output: usage.output,
    premiumRequests: usage.premiumRequests ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    totalTokens: usage.input + usage.output + cacheRead,
  };
};

interface HeaderInput {
  readonly cwd?: string;
  readonly id: string;
  readonly parentSession?: string;
  readonly at: string;
}

const header = (input: HeaderInput) =>
  JSON.stringify({
    cwd: input.cwd ?? "/r",
    id: input.id,
    parentSession: input.parentSession ?? null,
    timestamp: input.at,
    type: "session",
    version: 3,
  });

const user = (id: string, at: string) =>
  JSON.stringify({
    id,
    message: { attribution: "user", content: [], role: "user" },
    parentId: null,
    timestamp: at,
    type: "message",
  });

interface ReplyInput {
  readonly api?: string;
  readonly at: string;
  readonly content?: readonly Readonly<
    Record<string, string | Readonly<Record<string, string>>>
  >[];
  readonly id: string;
  readonly model?: string;
  readonly provider?: string;
  readonly stopReason?: string;
  readonly usage: UsageInput;
}

const reply = (input: ReplyInput) =>
  JSON.stringify({
    id: input.id,
    message: {
      api: input.api ?? "openai-responses",
      content: input.content ?? [],
      model: input.model ?? "gpt-5.6-luna",
      provider: input.provider ?? "cliproxy",
      role: "assistant",
      stopReason: input.stopReason ?? "stop",
      usage: usageOf(input.usage),
    },
    parentId: null,
    timestamp: input.at,
    type: "message",
  });

const jsonl = (...lines: readonly string[]) => `${lines.join("\n")}\n`;

const at = (second: number) =>
  `2026-10-01T10:00:${String(second).padStart(2, "0")}.000Z`;

const file = (path: string, text: string): MemoryFile => ({
  mtimeMs: 1,
  path,
  text,
});

const ompOver = (input: Partial<OmpMemoryInput>) =>
  Layer.effect(OmpHarness, OmpHarness.make).pipe(
    Layer.provide(
      OmpStore.memory({ files: [], roots: [ROOT, ARCHIVE], ...input })
    )
  );

const readEverything = (scope: HarnessScope = everywhere) =>
  Effect.gen(function* readAllRefs() {
    const harness = yield* OmpHarness;
    const refs = yield* harness.locate(scope);
    const batches: EventBatch[] = [];

    for (const ref of refs) {
      batches.push(
        yield* harness.read(ref, {
          context: emptyFlightContext,
          cursor: null,
          origin: "fixture",
        })
      );
    }

    const unique = new Map<string, DxEventEnvelope>();

    for (const event of batches.flatMap((batch) => batch.events)) {
      unique.set(event.eventId, event);
    }

    return { batches, events: [...unique.values()] };
  });

const usageKeys = (events: readonly DxEventEnvelope[]) =>
  events.flatMap((event) =>
    event.kind === "ai.usage"
      ? [[event.usage?.requestKey, event.usage?.tokens.total]]
      : []
  );

const PARENT = `${ROOT}/-r/2026-10-01T10-00-00-000Z_p1.jsonl`;

describe("OMP dedupe rules", () => {
  it.effect("counts a repeated entry once and keeps its largest usage", () =>
    Effect.gen(function* check1() {
      const { events } = yield* readEverything();
      expect(usageKeys(events)).toStrictEqual([["omp:s1:a1", 15]]);
    }).pipe(
      Effect.provide(
        ompOver({
          files: [
            file(
              `${ROOT}/-r/2026-10-01T10-00-00-000Z_s1.jsonl`,
              jsonl(
                header({ at: at(0), id: "s1" }),
                user("u1", at(1)),
                reply({ at: at(2), id: "a1", usage: { input: 5, output: 0 } }),
                reply({ at: at(2), id: "a1", usage: { input: 10, output: 5 } })
              )
            ),
          ],
        })
      )
    )
  );

  it.effect(
    "reads a subagent file whose header line is written twice as one session",
    () =>
      Effect.gen(function* check2() {
        const { events } = yield* readEverything();
        expect(
          events.filter((event) => event.kind === "ai.session")
        ).toHaveLength(2);
        expect(usageKeys(events)).toStrictEqual([["omp:c1:a1", 3]]);
      }).pipe(
        Effect.provide(
          ompOver({
            files: [
              file(PARENT, jsonl(header({ at: at(0), id: "p1" }))),
              file(
                `${ROOT}/-r/2026-10-01T10-00-00-000Z_p1/0-Scout.jsonl`,
                jsonl(
                  header({ at: at(1), id: "c1" }),
                  header({ at: at(1), id: "c1" }),
                  user("u1", at(2)),
                  reply({ at: at(3), id: "a1", usage: { input: 2, output: 1 } })
                )
              ),
            ],
          })
        )
      )
  );

  it.effect(
    "gives a moved or archived copy the same event ids as the original",
    () =>
      Effect.gen(function* archived() {
        const text = jsonl(
          header({ at: at(0), id: "s1" }),
          user("u1", at(1)),
          reply({ at: at(2), id: "a1", usage: { input: 4, output: 1 } })
        );

        const { batches } = yield* readEverything().pipe(
          Effect.provide(
            ompOver({
              files: [
                file(`${ROOT}/-r/2026-10-01T10-00-00-000Z_s1.jsonl`, text),
                {
                  bytes: new Uint8Array(gzipSync(text)),
                  mtimeMs: 1,
                  path: `${ARCHIVE}/-r/2026-10-01T10-00-00-000Z_s1.jsonl.gz`,
                },
              ],
            })
          )
        );

        const [original, archivedCopy] = batches.map((batch) =>
          batch.events.map((event) => event.eventId)
        );

        expect(original).toHaveLength(3);
        expect(archivedCopy).toStrictEqual(original);
      })
  );

  const lineage = [
    file(
      `${ROOT}/-r/2026-10-01T10-00-00-000Z_g1.jsonl`,
      jsonl(
        header({ at: at(0), id: "g1" }),
        user("u1", at(1)),
        reply({ at: at(2), id: "a1", usage: { input: 1, output: 1 } })
      )
    ),
    file(
      `${ROOT}/-r/2026-10-01T10-00-10-000Z_p2.jsonl`,
      jsonl(
        header({ at: at(10), id: "p2", parentSession: "g1" }),
        user("u1", at(1)),
        reply({ at: at(2), id: "a1", usage: { input: 1, output: 1 } }),
        user("u2", at(11)),
        reply({ at: at(12), id: "a2", usage: { input: 2, output: 2 } })
      )
    ),
    file(
      `${ROOT}/-r/2026-10-01T10-00-20-000Z_f3.jsonl`,
      jsonl(
        header({
          at: at(20),
          id: "f3",
          parentSession: `${ROOT}/-r/2026-10-01T10-00-10-000Z_p2.jsonl`,
        }),
        user("u1", at(1)),
        reply({ at: at(2), id: "a1", usage: { input: 1, output: 1 } }),
        user("u2", at(11)),
        reply({ at: at(12), id: "a2", usage: { input: 2, output: 2 } }),
        user("u3", at(21)),
        reply({ at: at(22), id: "a3", usage: { input: 3, output: 3 } })
      )
    ),
  ];

  it.effect(
    "counts history a fork copied only in the session that wrote it",
    () =>
      Effect.gen(function* check3() {
        const { events } = yield* readEverything();
        expect(usageKeys(events)).toStrictEqual([
          ["omp:g1:a1", 2],
          ["omp:p2:a2", 4],
          ["omp:f3:a3", 6],
        ]);
        expect(
          events
            .filter((event) => event.kind === "ai.turn")
            .map((event) => event.upstreamKey)
        ).toStrictEqual(["omp:g1:turn:u1", "omp:p2:turn:u2", "omp:f3:turn:u3"]);
      }).pipe(Effect.provide(ompOver({ files: lineage })))
  );

  it.effect(
    "keeps a fork's copied history under its original session when that file is gone",
    () =>
      Effect.gen(function* check4() {
        const { events } = yield* readEverything();
        expect(usageKeys(events)).toStrictEqual([
          ["omp:g1:a1", 2],
          ["omp:p2:a2", 4],
          ["omp:f3:a3", 6],
        ]);

        const orphan = events.find(
          (event) => event.usage?.requestKey === "omp:g1:a1"
        );

        expect(orphan?.payload.inheritedFrom).toBe("g1");
      }).pipe(Effect.provide(ompOver({ files: lineage.slice(1) })))
  );

  const taskResult = JSON.stringify({
    id: "t1",
    message: {
      details: {
        results: [
          {
            agent: "explore",
            id: "0-Scout",
            modelOverride: ["github-copilot/gpt-5.4:xhigh"],
            usage: usageOf({ input: 70, output: 30 }),
          },
        ],
      },
      role: "toolResult",
      toolName: "task",
    },
    parentId: null,
    timestamp: at(5),
    type: "message",
  });

  const parentFile = file(
    PARENT,
    jsonl(
      header({ at: at(0), id: "p1" }),
      user("u1", at(1)),
      reply({ at: at(2), id: "a1", usage: { input: 1, output: 1 } }),
      taskResult
    )
  );

  const childFile = file(
    `${ROOT}/-r/2026-10-01T10-00-00-000Z_p1/0-Scout.jsonl`,
    jsonl(
      header({ at: at(3), id: "c1" }),
      user("u1", at(3)),
      reply({ at: at(4), id: "b1", usage: { input: 40, output: 20 } }),
      reply({ at: at(4), id: "b2", usage: { input: 30, output: 10 } })
    )
  );

  it.effect(
    "counts a subagent's own file and never the parent's task result",
    () =>
      Effect.gen(function* check5() {
        const { events } = yield* readEverything();
        expect(usageKeys(events)).toStrictEqual([
          ["omp:p1:a1", 2],
          ["omp:c1:b1", 60],
          ["omp:c1:b2", 40],
        ]);
        expect(
          events
            .filter((event) => event.ai?.sessionId === "c1")
            .map((event) => [
              event.ai?.agentId,
              event.ai?.agentType,
              event.ai?.parentSessionId,
            ])
        ).toContainEqual(["0-Scout", "explore", "p1"]);
      }).pipe(Effect.provide(ompOver({ files: [parentFile, childFile] })))
  );

  it.effect(
    "falls back to the task result once when the subagent file is missing",
    () =>
      Effect.gen(function* check6() {
        const { events } = yield* readEverything();

        const fallback = events.find(
          (event) => event.payload.aggregate === true
        );

        expect(usageKeys(events)).toStrictEqual([
          ["omp:p1:a1", 2],
          ["omp:p1:task:0-Scout", 100],
        ]);
        expect([
          fallback?.ai?.agentId,
          fallback?.ai?.agentType,
          fallback?.ai?.parentSessionId,
          fallback?.ai?.model,
          fallback?.ai?.effort,
          fallback?.ai?.effortSource,
          fallback?.ai?.via,
        ]).toStrictEqual([
          "0-Scout",
          "explore",
          "p1",
          "gpt-5.4",
          "xhigh",
          "model-suffix",
          "github-copilot",
        ]);
      }).pipe(Effect.provide(ompOver({ files: [parentFile] })))
  );
});

describe("OMP session parsing", () => {
  const sessionPath = `${ROOT}/-r/2026-10-01T10-00-00-000Z_s1.jsonl`;

  it.effect(
    "skips invalid lines, reports them, and waits for an unfinished last line",
    () =>
      Effect.gen(function* lenient() {
        const complete = jsonl(
          header({ at: at(0), id: "s1" }),
          user("u1", at(1)),
          "{not json",
          reply({ at: at(2), id: "a1", usage: { input: 1, output: 1 } })
        );

        const partial = reply({
          at: at(3),
          id: "a2",
          usage: { input: 2, output: 2 },
        });

        const first = yield* readEverything().pipe(
          Effect.provide(
            ompOver({ files: [file(sessionPath, `${complete}${partial}`)] })
          )
        );

        const [batch] = first.batches;

        expect(usageKeys(first.events)).toStrictEqual([["omp:s1:a1", 2]]);
        expect(batch?.coverage.state).toBe("partial");
        expect(batch?.coverage.gaps.map((gap) => gap.code)).toStrictEqual([
          "invalid-lines",
        ]);

        const finished = yield* Effect.gen(function* readOn() {
          const harness = yield* OmpHarness;
          const [ref] = yield* harness.locate(everywhere);

          if (ref === undefined || batch === undefined) {
            return yield* Effect.die("session missing");
          }

          return yield* harness.read(
            { ...ref, mtimeMs: 2 },
            {
              context: emptyFlightContext,
              cursor: batch.cursor,
              origin: "fixture",
            }
          );
        }).pipe(
          Effect.provide(
            ompOver({ files: [file(sessionPath, `${complete}${partial}\n`)] })
          )
        );

        expect(usageKeys(finished.events)).toStrictEqual([
          ["omp:s1:a1", 2],
          ["omp:s1:a2", 4],
        ]);
      })
  );

  it.effect("keeps failed and empty replies as requests without usage", () =>
    Effect.gen(function* check7() {
      const { events } = yield* readEverything();
      expect(
        events
          .filter((event) => event.kind.startsWith("ai.request"))
          .map((event) => [event.payload.stopReason, event.usage])
      ).toStrictEqual([
        ["error", null],
        ["aborted", null],
      ]);
    }).pipe(
      Effect.provide(
        ompOver({
          files: [
            file(
              sessionPath,
              jsonl(
                header({ at: at(0), id: "s1" }),
                user("u1", at(1)),
                reply({
                  at: at(2),
                  id: "a1",
                  stopReason: "error",
                  usage: {
                    cost: 0,
                    input: 0,
                    output: 0,
                    premiumRequests: 0.33,
                  },
                }),
                reply({
                  at: at(3),
                  id: "a2",
                  stopReason: "aborted",
                  usage: { cost: 0, input: 0, output: 0 },
                })
              )
            ),
          ],
        })
      )
    )
  );

  it.effect("names the model maker, the gateway and every token bucket", () =>
    Effect.gen(function* check8() {
      const { events } = yield* readEverything();
      expect(
        events
          .filter((event) => event.kind === "ai.usage")
          .map((event) => [
            event.ai?.provider,
            event.ai?.via,
            event.ai?.model,
            event.usage?.tokens.inputFresh,
            event.usage?.tokens.cacheRead,
            event.usage?.tokens.output,
            event.usage?.tokens.reasoning,
            event.usage?.toolFigure?.kind ?? null,
            event.usage?.premiumRequests,
            event.usage?.serviceTier,
          ])
      ).toStrictEqual([
        [
          "openai",
          "github-copilot",
          "gpt-5.4",
          10,
          90,
          5,
          null,
          null,
          1,
          "priority",
        ],
        [
          "deepseek",
          "cliproxy",
          "deepseek-v4.1-flash",
          3,
          0,
          4,
          2,
          "api-equivalent",
          null,
          "priority",
        ],
        [
          "anthropic",
          null,
          "claude-haiku-4.5",
          6,
          0,
          1,
          null,
          "api-equivalent",
          null,
          null,
        ],
      ]);
    }).pipe(
      Effect.provide(
        ompOver({
          files: [
            file(
              sessionPath,
              jsonl(
                header({ at: at(0), id: "s1" }),
                JSON.stringify({
                  id: "t0",
                  parentId: null,
                  serviceTier: { openai: "priority" },
                  timestamp: at(0),
                  type: "service_tier_change",
                }),
                user("u1", at(1)),
                reply({
                  at: at(2),
                  id: "a1",
                  model: "gpt-5.4",
                  provider: "github-copilot",
                  usage: {
                    cacheRead: 90,
                    cost: 0,
                    input: 10,
                    output: 5,
                    premiumRequests: 1,
                  },
                }),
                reply({
                  at: at(3),
                  id: "a2",
                  model: "opencode-go/deepseek-v4.1-flash",
                  usage: { input: 3, output: 4, reasoningTokens: 2 },
                }),
                reply({
                  api: "anthropic-messages",
                  at: at(4),
                  id: "a3",
                  model: "claude-haiku-4.5",
                  provider: "anthropic",
                  usage: { input: 6, output: 1 },
                })
              )
            ),
          ],
        })
      )
    )
  );

  it.effect(
    "finds a session by the cwd in its header, never by its folder name",
    () =>
      Effect.gen(function* byHeader() {
        const harness = yield* OmpHarness;

        const refs = yield* harness.locate({
          ...everywhere,
          worktrees: ["/work/app"],
        });

        expect(refs.map((ref) => [ref.sessionId, ref.worktree])).toStrictEqual([
          ["s2", "/work/app"],
        ]);
      }).pipe(
        Effect.provide(
          ompOver({
            files: [
              file(
                `${ROOT}/--work-app--/2026-10-01T10-00-00-000Z_s1.jsonl`,
                jsonl(header({ at: at(0), cwd: "/elsewhere", id: "s1" }))
              ),
              file(
                `${ROOT}/-somewhere-else/2026-10-01T10-00-00-000Z_s2.jsonl`,
                jsonl(header({ at: at(0), cwd: "/work/app/src", id: "s2" }))
              ),
            ],
          })
        )
      )
  );

  it.effect("flags a session file that OMP's stats.db counts differently", () =>
    Effect.gen(function* check9() {
      const { batches } = yield* readEverything();
      expect(
        batches.flatMap((batch) => batch.coverage.gaps.map((gap) => gap.code))
      ).toStrictEqual(["stats-db-differs"]);
    }).pipe(
      Effect.provide(
        ompOver({
          files: [
            file(
              sessionPath,
              jsonl(
                header({ at: at(0), id: "s1" }),
                reply({ at: at(1), id: "a1", usage: { input: 1, output: 1 } })
              )
            ),
          ],
          stats: [{ cost: 0, rows: 3, sessionFile: sessionPath, tokens: 9 }],
        })
      )
    )
  );
});

describe("OMP live capture", () => {
  it("maps extension events to event kinds", () => {
    expect(
      Object.fromEntries(
        OMP_HOOK_EVENTS.map((event) => [event, ompHookKind(event)])
      )
    ).toStrictEqual({
      agent_end: "ai.turn",
      before_agent_start: "ai.request",
      session_shutdown: "ai.session",
      session_start: "ai.session",
      turn_start: "other",
    });
  });

  it("ships an extension that calls dft hook omp for every captured event", () => {
    const source = ompExtensionSource(["/opt/dft/bin/dft"]);

    expect(source.startsWith(OMP_EXTENSION_MARKER)).toBe(true);
    expect(source).toContain('["/opt/dft/bin/dft"]');
    expect(source).toContain('"hook", "omp", event');

    for (const event of OMP_HOOK_EVENTS) {
      expect(source).toContain(`"${event}"`);
    }
  });
});
