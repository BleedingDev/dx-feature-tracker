import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CodexHarness } from "../../../src/dx/harness/codex/index.js";
import type { ReadInput } from "../../../src/dx/harness/contract.js";
import { MAX_TITLE_CHARS } from "../../../src/dx/harness/title.js";
import type { EventBatch } from "../../../src/dx/model/event.js";
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

const TURN = "01a0f719-9000-7000-8000-000000000001";

const CANARY = `CANARY-PROMPT please refactor the billing module and use the api key sk-test-CANARY ${"and keep every invoice line intact ".repeat(100)}`;

const userItem = (ordinal: number, text: string): string =>
  line(ordinal, "response_item", {
    content: [
      {
        text: "<environment_context>fixture</environment_context>",
        type: "input_text",
      },
      { text, type: "input_text" },
    ],
    role: "user",
    type: "message",
  });

const userEvent = (ordinal: number, message: string): string =>
  line(ordinal, "event_msg", { images: [], message, type: "user_message" });

const indexOf = (name: string): string =>
  `${JSON.stringify({ id: THREAD, thread_name: name, updated_at: "2026-10-01T10:30:00Z" })}\n`;

const opening = [meta(0), turnStarted(1, TURN), turnContext(2, TURN)];

const readWith = (text: string, name: string, input: ReadInput = readInput()) =>
  Effect.gen(function* readTitled() {
    const harness = yield* CodexHarness;

    return yield* harness.read(memoryRef(FILE, text), input);
  }).pipe(
    Effect.provide(
      memoryHarness({
        files: [{ path: FILE, text }],
        roots: [],
        sessionIndex: indexOf(name),
      })
    )
  );

const titleOf = (batch: EventBatch) =>
  batch.events.find((event) => event.kind === "ai.session")?.payload.title;

const after = (batch: EventBatch): ReadInput => ({
  ...readInput(),
  cursor: batch.cursor,
});

describe("codex session titles", () => {
  it.effect("drops a thread name that repeats the first prompt", () =>
    Effect.gen(function* promptEcho() {
      const batch = yield* readWith(
        sessionText(
          ...opening,
          userItem(3, CANARY),
          record(4, "resp_a", usage(10, 0, 5))
        ),
        `  ${CANARY.replaceAll(" ", "\n ")}  `
      );

      expect(titleOf(batch)).toBeNull();
      expect(JSON.stringify(batch)).not.toContain("CANARY-PROMPT");
    })
  );

  it.effect("drops a thread name that repeats a user_message event", () =>
    Effect.gen(function* eventEcho() {
      const batch = yield* readWith(
        sessionText(
          ...opening,
          userEvent(3, "fix the flaky test"),
          record(4, "resp_a", usage(10, 0, 5))
        ),
        "fix the flaky test"
      );

      expect(titleOf(batch)).toBeNull();
    })
  );

  it.effect("keeps a renamed title and caps it like every other tool", () =>
    Effect.gen(function* renamed() {
      const text = sessionText(
        ...opening,
        userItem(3, CANARY),
        record(4, "resp_a", usage(10, 0, 5))
      );

      const short = yield* readWith(text, "Billing refactor");
      const long = yield* readWith(text, "R".repeat(MAX_TITLE_CHARS * 3));

      expect(titleOf(short)).toBe("Billing refactor");
      expect(titleOf(long)).toBe("R".repeat(MAX_TITLE_CHARS));
    })
  );

  it.effect("remembers the prompt across resumed reads", () =>
    Effect.gen(function* resumed() {
      const first = sessionText(...opening, userItem(3, CANARY));
      const grown = `${first}${sessionText(record(4, "resp_a", usage(10, 0, 5)))}`;
      const before = yield* readWith(first, "Billing refactor");
      const echoed = yield* readWith(grown, CANARY, after(before));
      const renamed = yield* readWith(grown, "Billing refactor", after(before));

      expect(titleOf(echoed)).toBeNull();
      expect(titleOf(renamed)).toBe("Billing refactor");
    })
  );

  it.effect("drops the title when a resumed cursor never saw the prompts", () =>
    Effect.gen(function* legacy() {
      const first = sessionText(...opening, userItem(3, CANARY));
      const grown = `${first}${sessionText(record(4, "resp_a", usage(10, 0, 5)))}`;
      const before = yield* readWith(first, "Billing refactor");
      const cursor = before.cursor ?? { adapterId: "", value: "" };
      const older = cursor.value.replace(/"prompts":\[[^\]]*\],/u, "");

      expect(older).not.toContain('"prompts"');

      const batch = yield* readWith(grown, "Billing refactor", {
        ...readInput(),
        cursor: { ...cursor, value: older },
      });

      expect(batch.events.length).toBeGreaterThan(0);
      expect(titleOf(batch)).toBeNull();
    })
  );
});
