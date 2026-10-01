import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import { EventStore } from "../../src/dx/contracts/event-store.js";
import { FakeEventStoreLayer } from "../../src/dx/contracts/fakes.js";
import type {
  Harness,
  ReadInput,
  SessionRef,
} from "../../src/dx/harness/contract.js";
import { fileCursorOf, readFileCursor } from "../../src/dx/harness/contract.js";
import { emptyHarnessBatch } from "../../src/dx/harness/pending.js";
import { HarnessRegistry } from "../../src/dx/harness/registry.js";
import type { CollectCursor } from "../../src/dx/model/coverage.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import { runPlannedStep } from "../../src/dx/registry/sync.js";
import type { PlannedSource } from "../../src/dx/registry/sync.js";
import { HarnessCursors } from "../../src/dx/storage/harness-cursors.js";

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
