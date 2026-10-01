import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CodexHarness } from "../../../src/dx/harness/codex/index.js";
import { everywhere } from "../../../src/dx/harness/contract.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import {
  PARENT,
  THREAD,
  memoryHarness,
  memoryRef,
  meta,
  readInput,
  record,
  sessionText,
  timestampAt,
  tokenCount,
  totalsOf,
  turnContext,
  turnStarted,
  usage,
} from "./codex-support.js";

const FILE = `/home/user/.codex/sessions/2026/10/01/rollout-2026-10-01T12-54-00-${THREAD}.jsonl`;

const OWN_TURN = "01a0f719-9000-7000-8000-000000000001";

const PARENT_TURN = "01a0f700-1000-7000-8000-000000000001";

const readText = (text: string) =>
  Effect.gen(function* readSessionText() {
    const harness = yield* CodexHarness;

    return yield* harness.read(memoryRef(FILE, text), readInput());
  }).pipe(
    Effect.provide(memoryHarness({ files: [{ path: FILE, text }], roots: [] }))
  );

const usageIds = (events: readonly DxEventEnvelope[]) =>
  events.flatMap((event) =>
    event.kind === "ai.session" ? [] : [event.eventId]
  );

const usageEvents = (text: string) =>
  readText(text).pipe(
    Effect.map((batch) =>
      batch.events.filter((event) => event.kind === "ai.usage")
    )
  );

describe("codex request dedupe", () => {
  it.effect("counts a streamed response once", () =>
    Effect.gen(function* streamed() {
      const events = yield* usageEvents(
        sessionText(
          meta(0),
          turnStarted(1, OWN_TURN),
          turnContext(2, OWN_TURN),
          record(3, "resp_a", usage(100, 40, 10)),
          record(4, "resp_a", usage(100, 40, 10)),
          record(5, "resp_b", usage(200, 100, 20))
        )
      );

      expect(events.map((event) => event.usage?.requestKey)).toStrictEqual([
        "source:codex-session:request:resp_a",
        "source:codex-session:request:resp_b",
      ]);
      expect(totalsOf(events).total).toBe(330);
    })
  );

  it.effect("skips records another thread wrote into this file", () =>
    Effect.gen(function* foreign() {
      const events = yield* usageEvents(
        sessionText(
          meta(0, { parent_thread_id: PARENT, session_id: PARENT }),
          record(1, "resp_parent", usage(500, 0, 50), PARENT, PARENT_TURN),
          turnStarted(2, OWN_TURN),
          record(3, "resp_own", usage(100, 0, 10))
        )
      );

      expect(events.map((event) => event.identity.requestId)).toStrictEqual([
        "resp_own",
      ]);
      expect(events[0]?.ai?.parentSessionId).toBe(PARENT);
      expect(events[0]?.ai?.sessionId).toBe(THREAD);
    })
  );

  it.effect("trusts the thread id over subagent_history_start_ordinal", () =>
    Effect.gen(function* historyOrdinal() {
      const events = yield* usageEvents(
        sessionText(
          meta(0, {
            parent_thread_id: PARENT,
            source: { subagent: { other: "guardian" } },
            subagent_history_start_ordinal: 99,
          }),
          turnStarted(1, OWN_TURN),
          record(2, "resp_a", usage(100, 0, 10)),
          record(3, "resp_b", usage(120, 100, 10))
        )
      );

      expect(events.length).toBe(2);
      expect(events[0]?.ai?.agentType).toBe("guardian");
    })
  );

  it.effect(
    "drops token_count emissions whose cumulative total did not change",
    () =>
      Effect.gen(function* unchanged() {
        const events = yield* usageEvents(
          sessionText(
            meta(0, { cli_version: "0.144.0" }),
            turnStarted(1, OWN_TURN),
            turnContext(2, OWN_TURN),
            tokenCount(3, 110, usage(100, 0, 10)),
            tokenCount(4, 110, usage(100, 0, 10)),
            tokenCount(5, 330, usage(200, 100, 20)),
            tokenCount(6, 110, usage(100, 0, 10))
          )
        );

        expect(events.map((event) => event.usage?.tokens.total)).toStrictEqual([
          110, 220,
        ]);
        expect(
          events.every((event) => event.payload.usageSource === "token_count")
        ).toBe(true);
      })
  );

  it.effect("ignores the empty emission written after a compaction", () =>
    Effect.gen(function* compaction() {
      const events = yield* usageEvents(
        sessionText(
          meta(0),
          turnStarted(1, OWN_TURN),
          tokenCount(2, 500, usage(0, 0, 0)),
          tokenCount(3, 610, usage(100, 0, 10))
        )
      );

      expect(events.length).toBe(1);
    })
  );

  it.effect("skips history a fork replays from its parent", () =>
    Effect.gen(function* replay() {
      const v4Turn = "03aaaca0-f698-4d5f-8201-eca2474c9b9a";

      const events = yield* usageEvents(
        sessionText(
          meta(0, { forked_from_id: PARENT, source: "cli" }),
          turnStarted(1, PARENT_TURN),
          tokenCount(2, 1000, usage(900, 0, 100)),
          turnStarted(3, v4Turn),
          tokenCount(4, 2000, usage(900, 800, 100)),
          turnStarted(5, OWN_TURN),
          tokenCount(6, 2000, usage(900, 800, 100)),
          tokenCount(7, 2500, usage(450, 400, 50))
        )
      );

      expect(events.map((event) => event.usage?.tokens.total)).toStrictEqual([
        500,
      ]);
    })
  );

  it.effect("counts token_count deltas until per-response records begin", () =>
    Effect.gen(function* mixed() {
      const events = yield* usageEvents(
        sessionText(
          meta(0, { cli_version: "0.149.1" }),
          turnStarted(1, OWN_TURN),
          tokenCount(2, 110, usage(100, 0, 10)),
          tokenCount(3, 330, usage(200, 100, 20)),
          record(4, "resp_new", usage(300, 200, 30)),
          tokenCount(5, 330, usage(300, 200, 30)),
          tokenCount(6, 700, usage(340, 300, 30))
        )
      );

      expect(
        events.map((event) => [
          event.payload.usageSource,
          event.usage?.tokens.total,
        ])
      ).toStrictEqual([
        ["token_count", 110],
        ["token_count", 220],
        ["token_usage_record", 330],
      ]);
    })
  );

  it.effect("reads records whose keys come in another order", () =>
    Effect.gen(function* reordered() {
      const events = yield* usageEvents(
        sessionText(
          meta(0),
          `{"payload":${JSON.stringify({
            response_id: "resp_late",
            thread_id: THREAD,
            turn_id: OWN_TURN,
            usage: usage(100, 0, 10),
          })},"type":"token_usage_record","ordinal":1,"timestamp":"${timestampAt(1)}"}`
        )
      );

      expect(events.map((event) => event.identity.requestId)).toStrictEqual([
        "resp_late",
      ]);
      expect(events[0]?.occurredAt).toBe(timestampAt(1));
    })
  );

  it.effect("splits input into fresh, cached and written buckets", () =>
    Effect.gen(function* buckets() {
      const [event] = yield* usageEvents(
        sessionText(
          meta(0),
          turnStarted(1, OWN_TURN),
          record(2, "resp_a", {
            ...usage(112_575, 0, 395),
            cache_write_input_tokens: 111_991,
            reasoning_output_tokens: 119,
          })
        )
      );

      expect(event?.usage?.tokens).toStrictEqual({
        cacheRead: 0,
        cacheWrite: 111_991,
        cacheWrite1h: null,
        cacheWrite5m: null,
        inputFresh: 584,
        output: 395,
        reasoning: 119,
        total: 112_970,
      });
    })
  );
});

describe("codex incremental reads", () => {
  const full = sessionText(
    meta(0),
    turnStarted(1, OWN_TURN),
    turnContext(2, OWN_TURN),
    record(3, "resp_a", usage(100, 40, 10)),
    tokenCount(4, 110, usage(100, 40, 10)),
    record(5, "resp_b", usage(200, 100, 20)),
    tokenCount(6, 330, usage(200, 100, 20))
  );

  const cut = full.indexOf("\n", full.indexOf("resp_a")) + 1;
  const partial = `${full.slice(0, cut)}${full.slice(cut, cut + 40)}`;

  it.effect(
    "continues from the cursor and gives the same events as one read",
    () =>
      Effect.gen(function* incremental() {
        const first = yield* readText(partial);
        const whole = yield* readText(full);

        const rest = yield* Effect.gen(function* readRest() {
          const harness = yield* CodexHarness;

          return yield* harness.read(memoryRef(FILE, full), {
            ...readInput(),
            cursor: first.cursor,
          });
        }).pipe(
          Effect.provide(
            memoryHarness({ files: [{ path: FILE, text: full }], roots: [] })
          )
        );

        expect(
          first.events.filter((event) => event.kind === "ai.usage").length
        ).toBe(1);
        expect([
          ...usageIds(first.events),
          ...usageIds(rest.events),
        ]).toStrictEqual(usageIds(whole.events));
        expect(
          rest.events.find((event) => event.kind === "ai.usage")?.ai?.model
        ).toBe("gpt-5.6-luna");
      })
  );

  it.effect("returns nothing new when the file has not changed", () =>
    Effect.gen(function* unchanged() {
      const harness = yield* CodexHarness;
      const ref = memoryRef(FILE, full, 1000);
      const first = yield* harness.read(ref, readInput());

      const again = yield* harness.read(ref, {
        ...readInput(),
        cursor: first.cursor,
      });

      expect(again.events).toStrictEqual([]);
      expect(again.cursor).toStrictEqual(first.cursor);
    }).pipe(
      Effect.provide(
        memoryHarness({
          files: [{ mtimeMs: 1000, path: FILE, text: full }],
          roots: [],
        })
      )
    )
  );
});

describe("codex locate", () => {
  const longMeta = meta(0, { base_instructions: { text: "x".repeat(20_000) } });

  const OTHER = "01a0f719-aaaa-7000-8000-000000000002";

  const OTHER_FILE = `/home/user/.codex/sessions/2026/10/01/rollout-2026-10-01T12-55-00-${OTHER}.jsonl`;

  const codexOrderMeta = `{"timestamp":"${timestampAt(0)}","ordinal":0,"type":"session_meta","payload":{"session_id":"${OTHER}","id":"${OTHER}","timestamp":"${timestampAt(0)}","cwd":"/home/user/work/demo","originator":"codex_exec","cli_version":"0.159.3","source":"exec","model_provider":"openai","base_instructions":{"text":"${"x".repeat(20_000)}"},"git":{"branch":"main"}}}`;

  it.effect(
    "places a session by the folder in a first line longer than the head read",
    () =>
      Effect.gen(function* longHead() {
        const harness = yield* CodexHarness;

        const inside = yield* harness.locate({
          ...everywhere,
          worktrees: ["/home/user/work/demo"],
        });

        const outside = yield* harness.locate({
          ...everywhere,
          worktrees: ["/home/user/work/other"],
        });

        expect(
          inside.map((ref) => [ref.sessionId, ref.worktree])
        ).toStrictEqual([
          [THREAD, "/home/user/work/demo"],
          [OTHER, "/home/user/work/demo"],
        ]);
        expect(outside).toStrictEqual([]);
      }).pipe(
        Effect.provide(
          memoryHarness({
            files: [
              {
                path: FILE,
                text: sessionText(longMeta, turnStarted(1, OWN_TURN)),
              },
              {
                path: OTHER_FILE,
                text: sessionText(codexOrderMeta, turnStarted(1, OWN_TURN)),
              },
            ],
            roots: [],
          })
        )
      )
  );
});
