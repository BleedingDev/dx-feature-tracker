import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

import { EventStore } from "../../../src/dx/contracts/event-store.js";
import {
  CodexHarness,
  TURN_IDLE_MS,
} from "../../../src/dx/harness/codex/index.js";
import type { Harness, SessionRef } from "../../../src/dx/harness/contract.js";
import { HarnessRegistry } from "../../../src/dx/harness/registry.js";
import type { CollectCursor } from "../../../src/dx/model/coverage.js";
import type {
  DxEventEnvelope,
  EventBatch,
} from "../../../src/dx/model/event.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { runPlannedStep } from "../../../src/dx/registry/sync.js";
import { HarnessCursors } from "../../../src/dx/storage/harness-cursors.js";
import { FakeEventStoreLayer } from "../fakes.js";
import {
  THREAD,
  line,
  memoryHarness,
  memoryRef,
  meta,
  readInput,
  record,
  sessionText,
  turnContext,
  turnStarted,
  usage,
} from "./codex-support.js";

const FILE = `/home/user/.codex/sessions/2026/10/01/rollout-2026-10-01T12-54-00-${THREAD}.jsonl`;

const CRASHED = "01a0f719-9000-7000-8000-000000000001";

const RESUMED = "01a0f719-9000-7000-8000-000000000002";

const EMPTY = "01a0f719-9000-7000-8000-000000000003";

const WRITTEN_AT = 1000;

const COMPLETED_AT = "2026-09-21T14:15:00.000Z";

const taskComplete = (ordinal: number, turnId: string): string =>
  line(ordinal, "event_msg", {
    completed_at: 1_790_000_100,
    duration_ms: 4000,
    started_at: 1_790_000_096,
    turn_id: turnId,
    type: "task_complete",
  });

const crashed = sessionText(
  meta(0),
  turnStarted(1, CRASHED),
  turnContext(2, CRASHED),
  record(3, "resp_a", usage(100, 40, 10), THREAD, CRASHED),
  record(4, "resp_b", usage(200, 100, 20), THREAD, CRASHED)
);

const resumed = `${crashed}${sessionText(
  turnStarted(5, RESUMED),
  turnContext(6, RESUMED),
  record(7, "resp_c", usage(300, 200, 30), THREAD, RESUMED),
  taskComplete(8, RESUMED)
)}`;

const finished = `${crashed}${sessionText(taskComplete(5, CRASHED))}`;

const turnsOf = (events: readonly DxEventEnvelope[]) =>
  events.filter((event) => event.kind === "ai.turn");

const statusOf = (event: DxEventEnvelope | undefined) => ({
  completedAt: event?.payload.completedAt,
  requests: event?.payload.requests,
  status: event?.payload.status,
  turnId: event?.identity.turnId,
});

const readAt = (
  text: string,
  cursor: CollectCursor | null,
  mtimeMs: number = WRITTEN_AT
) =>
  Effect.gen(function* readCodexAt() {
    const harness = yield* CodexHarness;

    return yield* harness.read(memoryRef(FILE, text, mtimeMs), {
      ...readInput(),
      cursor,
    });
  }).pipe(
    Effect.provide(
      memoryHarness({ files: [{ mtimeMs, path: FILE, text }], roots: [] })
    )
  );

const quietUntilIdle = TestClock.setTime(WRITTEN_AT + TURN_IDLE_MS);

const gapCodes = (batch: EventBatch) =>
  batch.coverage.gaps.map((gap) => gap.code);

describe("codex turns without task_complete", () => {
  it.effect("holds a live turn and closes it once the file is quiet", () =>
    Effect.gen(function* crashedTurn() {
      yield* TestClock.setTime(WRITTEN_AT + 60_000);

      const live = yield* readAt(crashed, null);

      yield* TestClock.setTime(WRITTEN_AT + TURN_IDLE_MS - 1);

      const almost = yield* readAt(crashed, live.cursor);

      yield* quietUntilIdle;

      const settled = yield* readAt(crashed, almost.cursor);
      const after = yield* readAt(crashed, settled.cursor);

      expect(turnsOf(live.events)).toStrictEqual([]);
      expect(live.unsettled).toBe(true);
      expect(almost.events).toStrictEqual([]);
      expect(almost.unsettled).toBe(true);
      expect(turnsOf(settled.events).map(statusOf)).toStrictEqual([
        {
          completedAt: null,
          requests: 2,
          status: "unfinished",
          turnId: CRASHED,
        },
      ]);
      expect(settled.unsettled).not.toBe(true);
      expect(gapCodes(settled)).toContain("turn-unfinished");
      expect(
        settled.events.filter((event) => event.kind === "ai.usage")
      ).toStrictEqual([]);
      expect(after.events).toStrictEqual([]);
      expect(after.unsettled).not.toBe(true);
    })
  );

  it.effect("gives the same turn id whether read once or bit by bit", () =>
    Effect.gen(function* sameIds() {
      yield* TestClock.setTime(WRITTEN_AT + 60_000);

      const live = yield* readAt(crashed, null);

      yield* quietUntilIdle;

      const settled = yield* readAt(crashed, live.cursor);
      const once = yield* readAt(crashed, null);

      expect(turnsOf(settled.events).map((event) => event.eventId)).toEqual(
        turnsOf(once.events).map((event) => event.eventId)
      );
      expect(turnsOf(once.events)).toHaveLength(1);
      expect(
        once.events.filter((event) => event.kind === "ai.usage")
      ).toHaveLength(2);
    })
  );

  it.effect("keeps the closed turn closed when the session resumes", () =>
    Effect.gen(function* resumeAfterCrash() {
      yield* quietUntilIdle;

      const settled = yield* readAt(crashed, null);

      yield* TestClock.setTime(WRITTEN_AT * 2 + TURN_IDLE_MS);

      const later = yield* readAt(
        resumed,
        settled.cursor,
        WRITTEN_AT + TURN_IDLE_MS
      );

      const late = yield* readAt(
        `${resumed}${sessionText(
          turnContext(9, CRASHED),
          taskComplete(10, CRASHED)
        )}`,
        later.cursor,
        WRITTEN_AT + TURN_IDLE_MS
      );

      expect(turnsOf(settled.events).map(statusOf)).toStrictEqual([
        {
          completedAt: null,
          requests: 2,
          status: "unfinished",
          turnId: CRASHED,
        },
      ]);
      expect(turnsOf(later.events).map(statusOf)).toStrictEqual([
        {
          completedAt: COMPLETED_AT,
          requests: 1,
          status: "completed",
          turnId: RESUMED,
        },
      ]);
      expect(
        later.events
          .filter((event) => event.kind === "ai.usage")
          .map((event) => event.identity.turnId)
      ).toStrictEqual([RESUMED]);
      expect(turnsOf(late.events)).toStrictEqual([]);
      expect(late.unsettled).not.toBe(true);
    })
  );

  it.effect("closes a crashed turn as soon as the next turn starts", () =>
    Effect.gen(function* resumeWhileFresh() {
      yield* TestClock.setTime(WRITTEN_AT + 60_000);

      const batch = yield* readAt(resumed, null);

      expect(turnsOf(batch.events).map(statusOf)).toStrictEqual([
        {
          completedAt: null,
          requests: 2,
          status: "unfinished",
          turnId: CRASHED,
        },
        {
          completedAt: COMPLETED_AT,
          requests: 1,
          status: "completed",
          turnId: RESUMED,
        },
      ]);
      expect(batch.unsettled).not.toBe(true);
      expect(gapCodes(batch)).not.toContain("turn-unfinished");
    })
  );

  it.effect("reports a finished turn at once and never holds it", () =>
    Effect.gen(function* normalEnd() {
      yield* TestClock.setTime(WRITTEN_AT + 60_000);

      const batch = yield* readAt(finished, null);

      yield* quietUntilIdle;

      const later = yield* readAt(finished, batch.cursor);

      expect(turnsOf(batch.events).map(statusOf)).toStrictEqual([
        {
          completedAt: COMPLETED_AT,
          requests: 2,
          status: "completed",
          turnId: CRASHED,
        },
      ]);
      expect(batch.unsettled).not.toBe(true);
      expect(later.events).toStrictEqual([]);
    })
  );

  it.effect("emits no turn for a quiet turn that never sent a request", () =>
    Effect.gen(function* emptyTurn() {
      const text = sessionText(
        meta(0),
        turnStarted(1, EMPTY),
        turnContext(2, EMPTY)
      );

      yield* TestClock.setTime(WRITTEN_AT + 60_000);

      const live = yield* readAt(text, null);

      yield* quietUntilIdle;

      const quiet = yield* readAt(text, null);

      expect(live.unsettled).not.toBe(true);
      expect(turnsOf(quiet.events)).toStrictEqual([]);
      expect(quiet.unsettled).not.toBe(true);
    })
  );

  it.effect(
    "completes a turn whose first request comes after a quiet spell",
    () =>
      Effect.gen(function* slowFirstRequest() {
        const waiting = sessionText(
          meta(0),
          turnStarted(1, EMPTY),
          turnContext(2, EMPTY)
        );

        yield* TestClock.setTime(WRITTEN_AT + TURN_IDLE_MS + 5);

        const quiet = yield* readAt(waiting, null);

        const done = yield* readAt(
          `${waiting}${sessionText(
            record(3, "resp_slow", usage(100, 40, 10), THREAD, EMPTY),
            taskComplete(4, EMPTY)
          )}`,
          quiet.cursor,
          WRITTEN_AT + TURN_IDLE_MS + 5
        );

        expect(turnsOf(quiet.events)).toStrictEqual([]);
        expect(turnsOf(done.events).map(statusOf)).toStrictEqual([
          {
            completedAt: COMPLETED_AT,
            requests: 1,
            status: "completed",
            turnId: EMPTY,
          },
        ]);
      })
  );
});

const syncedTurns = (
  harness: Harness,
  ref: SessionRef,
  seen: Ref.Ref<readonly DxEventEnvelope[]>
) =>
  Effect.gen(function* syncOnce() {
    const store = yield* EventStore;

    const recording: Harness = {
      ...harness,
      read: (target, input) =>
        harness
          .read(target, input)
          .pipe(
            Effect.tap((batch) =>
              Ref.update(seen, (events) => [
                ...events,
                ...turnsOf(batch.events),
              ])
            )
          ),
    };

    return yield* runPlannedStep(
      { store, storePath: "/home/user/.dft/dft.db" },
      [],
      {
        context: emptyFlightContext,
        harness: "codex",
        input: ref.path,
        ref,
        source: ref.source,
        unavailable: null,
      }
    ).pipe(Effect.provide(HarnessRegistry.fromHarnesses([recording])));
  });

describe("codex crashed turns through sync", () => {
  it.effect("reads an unchanged file again until its last turn closes", () =>
    Effect.gen(function* syncSettles() {
      const harness = yield* CodexHarness;
      const seen = yield* Ref.make<readonly DxEventEnvelope[]>([]);
      const ref = memoryRef(FILE, crashed, WRITTEN_AT);

      yield* TestClock.setTime(WRITTEN_AT + 60_000);
      yield* syncedTurns(harness, ref, seen);
      const fresh = yield* Ref.get(seen);

      yield* quietUntilIdle;
      yield* syncedTurns(harness, ref, seen);
      yield* syncedTurns(harness, ref, seen);
      const settled = yield* Ref.get(seen);

      expect(fresh).toStrictEqual([]);
      expect(settled.map(statusOf)).toStrictEqual([
        {
          completedAt: null,
          requests: 2,
          status: "unfinished",
          turnId: CRASHED,
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          memoryHarness({
            files: [{ mtimeMs: WRITTEN_AT, path: FILE, text: crashed }],
            roots: [],
          }),
          FakeEventStoreLayer,
          HarnessCursors.memory,
          NodeServices.layer
        )
      )
    )
  );
});
