import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

import { EventStore } from "../../src/dx/contracts/event-store.js";
import {
  ClaudeCodeHarness,
  ClaudeCodeStore,
  QUIET_MS,
} from "../../src/dx/harness/claude-code/index.js";
import type {
  Harness,
  ReadInput,
  SessionRef,
} from "../../src/dx/harness/contract.js";
import {
  everywhere,
  fileCursorOf,
  readFileCursor,
} from "../../src/dx/harness/contract.js";
import { emptyHarnessBatch } from "../../src/dx/harness/pending.js";
import { HarnessRegistry } from "../../src/dx/harness/registry.js";
import type { CollectCursor } from "../../src/dx/model/coverage.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import { runPlannedStep } from "../../src/dx/registry/sync.js";
import type { PlannedSource } from "../../src/dx/registry/sync.js";
import { HarnessCursors } from "../../src/dx/storage/harness-cursors.js";
import { FakeEventStoreLayer } from "./fakes.js";

const ref = (size: number, mtimeMs: number): SessionRef => ({
  channel: "session-file",
  harness: "pi",
  id: "/home/user/.pi/agent/sessions/one.jsonl",
  mtimeMs,
  path: "/home/user/.pi/agent/sessions/one.jsonl",
  sessionId: "one",
  size,
  source: "harness.pi",
  worktree: "/home/user/app",
});

const step = (session: SessionRef): PlannedSource => ({
  context: emptyFlightContext,
  harness: "pi",
  input: session.path,
  ref: session,
  source: session.source,
  unavailable: null,
});

const countingHarness = (
  reads: Ref.Ref<readonly (CollectCursor | null)[]>
): Harness => ({
  capabilities: {
    branchSources: ["cwd-inferred"],
    liveHooks: false,
    storedFigure: null,
    subagents: false,
  },
  channels: ["session-file"],
  discover: Effect.succeed({
    harness: "pi",
    present: true,
    reason: null,
    roots: [],
    sessions: 1,
    version: null,
  }),
  displayName: "Pi",
  id: "pi",
  locate: () => Effect.succeed([]),
  read: (session: SessionRef, input: ReadInput) =>
    Ref.update(reads, (seen) => [...seen, input.cursor]).pipe(
      Effect.as({
        ...emptyHarnessBatch("pi", "fixture"),
        cursor: fileCursorOf("harness.pi", {
          mtimeMs: session.mtimeMs,
          offset: session.size ?? 0,
          path: session.path,
          size: session.size,
        }),
      })
    ),
});

describe("sync file cursors", () => {
  it.effect(
    "skips an unchanged session and hands the stored cursor to an appended one",
    () =>
      Effect.gen(function* cursors() {
        const reads = yield* Ref.make<readonly (CollectCursor | null)[]>([]);
        const store = yield* EventStore;
        const env = { store, storePath: "/home/user/.dft/dft.db" };

        const sync = (session: SessionRef) =>
          runPlannedStep(env, [], step(session)).pipe(
            Effect.provide(
              HarnessRegistry.fromHarnesses([countingHarness(reads)])
            )
          );

        const first = yield* sync(ref(100, 1));
        const again = yield* sync(ref(100, 1));
        const grown = yield* sync(ref(250, 2));
        const seen = yield* Ref.get(reads);

        expect([first.status, again.status, grown.status]).toEqual([
          "synced",
          "synced",
          "synced",
        ]);
        expect(seen).toHaveLength(2);
        expect(seen[0]).toBeNull();
        expect(readFileCursor(seen[1] ?? null, ref(250, 2))).toEqual({
          mtimeMs: 1,
          offset: 100,
          path: "/home/user/.pi/agent/sessions/one.jsonl",
          size: 100,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            FakeEventStoreLayer,
            HarnessCursors.memory,
            NodeServices.layer
          )
        )
      )
  );
});

const CLAUDE_ROOT = "/home/user/.claude/projects";

const claudeRow = (messageId: string, output: number): string =>
  JSON.stringify({
    cwd: "/home/user/app",
    gitBranch: "feature/a",
    message: {
      content: [{ text: "synthetic", type: "text" }],
      id: messageId,
      model: "claude-sonnet-5",
      role: "assistant",
      stop_reason: "end_turn",
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 2,
        output_tokens: output,
      },
    },
    requestId: `req-${messageId}`,
    sessionId: "s1",
    timestamp: "1970-01-01T00:00:00.000Z",
    type: "assistant",
    uuid: `u-${messageId}`,
  });

const claudeLayer = Layer.fresh(ClaudeCodeHarness.layer).pipe(
  Layer.provide(
    ClaudeCodeStore.memory({
      files: [
        {
          mtimeMs: 0,
          path: `${CLAUDE_ROOT}/-home-user-app/s1.jsonl`,
          text: `${[claudeRow("m1", 40), claudeRow("m2", 8)].join("\n")}\n`,
        },
      ],
      roots: [CLAUDE_ROOT],
    })
  )
);

describe("sync of a request held back until quiet", () => {
  it.effect(
    "reads an unchanged session again once its last request goes quiet",
    () =>
      Effect.gen(function* quiet() {
        const harness = yield* ClaudeCodeHarness;
        const [located] = yield* harness.locate(everywhere);
        const session = yield* Effect.fromNullishOr(located);
        const store = yield* EventStore;
        const env = { store, storePath: "/home/user/.dft/dft.db" };

        const read = yield* Ref.make<readonly (number | null)[]>([]);

        const recording: Harness = {
          ...harness,
          read: (target, readInput) =>
            harness
              .read(target, readInput)
              .pipe(
                Effect.tap((batch) =>
                  Ref.update(read, (seen) => [
                    ...seen,
                    ...batch.events.flatMap((event) =>
                      event.kind === "ai.usage"
                        ? [event.usage?.tokens.output ?? null]
                        : []
                    ),
                  ])
                )
              ),
        };

        const sync = runPlannedStep(env, [], {
          context: emptyFlightContext,
          harness: "claude-code",
          input: session.path,
          ref: session,
          source: session.source,
          unavailable: null,
        }).pipe(Effect.provide(HarnessRegistry.fromHarnesses([recording])));

        yield* sync;
        const fresh = yield* Ref.get(read);

        yield* TestClock.adjust(QUIET_MS);
        yield* sync;
        yield* sync;
        const settled = yield* Ref.get(read);

        expect(fresh).toStrictEqual([40]);
        expect(settled).toStrictEqual([40, 8]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            claudeLayer,
            FakeEventStoreLayer,
            HarnessCursors.memory,
            NodeServices.layer
          )
        )
      )
  );
});
