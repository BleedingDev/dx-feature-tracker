import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  CURSOR_EXTENSION_ADAPTER_ID,
  cursorExtensionCollector,
  cursorExtensionDescriptor,
} from "../../src/dx/collectors/cursor-extension/collector.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixturePath = fileURLToPath(
  new URL("fixtures/b09/activity.jsonl", import.meta.url)
);

const inputFor = (
  selectedInput: string | null,
  cursorValue: string | null = null
): CollectInput => ({
  adapterId: CURSOR_EXTENSION_ADAPTER_ID,
  context: emptyFlightContext,
  cursor:
    cursorValue === null
      ? null
      : { adapterId: CURSOR_EXTENSION_ADAPTER_ID, value: cursorValue },
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collect = (input: CollectInput) =>
  cursorExtensionCollector
    .collect(input)
    .pipe(Effect.provide(NodeServices.layer));

describe("cursor-extension collector (B09)", () => {
  it("publishes a truthful disabled descriptor with AI usage gaps", () => {
    expect(Schema.is(ModuleDescriptorSchema)(cursorExtensionDescriptor)).toBe(
      true
    );
    expect(cursorExtensionDescriptor.readiness).toBe("disabled");
    expect(cursorExtensionDescriptor.gaps.map((gap) => gap.code)).toEqual([
      "producer-not-installed",
      "no-ai-usage-via-extension-api",
      "no-ai-ownership",
    ]);
    expect(cursorExtensionDescriptor.supportedFields).not.toContain(
      "payload.tokens"
    );
  });

  it.effect("normalizes valid fixture records and reports rejects", () =>
    Effect.gen(function* collectFixture() {
      const batch = yield* collect(inputFor(fixturePath));

      expect(Schema.is(EventBatchSchema)(batch)).toBe(true);
      expect(batch.events.map((event) => event.payload.activity)).toEqual([
        "window-focus",
        "document-save",
        "branch-change",
        "window-blur",
      ]);
      expect(batch.events.map((event) => event.context.branch)).toEqual([
        "feature/fixture-flight",
        "feature/fixture-flight",
        "main",
        "main",
      ]);
      expect(batch.events.every((event) => event.origin === "fixture")).toBe(
        true
      );
      expect(batch.events.every((event) => event.kind === "other")).toBe(true);
      expect(batch.coverage).toMatchObject({
        expectedItems: 7,
        observedItems: 4,
        state: "partial",
        windowFrom: "2026-09-30T10:00:00.000Z",
        windowTo: "2026-09-30T10:20:00.000Z",
      });
      expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
        "rejected-records"
      );
      expect(JSON.stringify(batch)).not.toContain(
        "DFT_SYNTHETIC_SECRET_CANARY_7f3a9c"
      );
      expect(JSON.stringify(batch.events)).not.toMatch(/tokens|cost|charge/u);
    })
  );

  it.effect("derives stable event IDs across re-collection", () =>
    Effect.gen(function* recollect() {
      const first = yield* collect(inputFor(fixturePath));

      const second = yield* collect(inputFor(fixturePath));

      expect(second.events.map((event) => event.eventId)).toEqual(
        first.events.map((event) => event.eventId)
      );
      expect(first.events[0]?.eventId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    })
  );

  it.effect("resumes after the cursor line", () =>
    Effect.gen(function* resume() {
      const first = yield* collect(inputFor(fixturePath));

      const resumed = yield* collect(
        inputFor(fixturePath, first.cursor?.value ?? null)
      );

      expect(resumed.events).toHaveLength(0);
      expect(resumed.coverage.state).toBe("none");
    })
  );

  it.effect("fails without an explicitly selected input", () =>
    Effect.gen(function* noInput() {
      const error = yield* Effect.flip(collect(inputFor(null)));

      expect(error._tag).toBe("InvalidInput");
    })
  );

  it.effect("reports an unreadable selected input as unavailable", () =>
    Effect.gen(function* missingInput() {
      const error = yield* Effect.flip(
        collect(
          inputFor(
            fileURLToPath(new URL("fixtures/b09/absent.jsonl", import.meta.url))
          )
        )
      );

      expect(error._tag).toBe("SourceUnavailable");
    })
  );
});
