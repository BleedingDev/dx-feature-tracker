import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  CURSOR_SDK_ADAPTER_ID,
  cursorSdkCollector,
  cursorSdkDescriptor,
} from "../../src/dx/collectors/cursor-sdk/collector.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { normalizeAiUsage } from "../../src/dx/metrics/ai-usage/normalize.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const recordPath = fileURLToPath(
  new URL("fixtures/b44/flight-record.jsonl", import.meta.url)
);

const livePath = fileURLToPath(
  new URL(
    "fixtures/b44/live-sdk-1.0.34-unauthenticated-run.jsonl",
    import.meta.url
  )
);

const inputFor = (
  selectedInput: string | null,
  branch: string | null = null
): CollectInput => ({
  adapterId: CURSOR_SDK_ADAPTER_ID,
  context: { ...emptyFlightContext, branch },
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collect = (input: CollectInput) =>
  cursorSdkCollector.collect(input).pipe(Effect.provide(NodeServices.layer));

const byKey = (
  events: readonly DxEventEnvelope[],
  key: string
): DxEventEnvelope => {
  const found = events.find((event) => event.upstreamKey === key);

  if (found === undefined) {
    throw new Error(`missing event ${key}`);
  }

  return found;
};

describe("cursor-sdk collector (B44)", () => {
  it("publishes a truthful disabled descriptor", () => {
    expect(Schema.is(ModuleDescriptorSchema)(cursorSdkDescriptor)).toBe(true);
    expect(cursorSdkDescriptor.readiness).toBe("disabled");
  });

  it.effect("requires an explicitly selected flight record", () =>
    Effect.gen(function* requireInput() {
      const exit = yield* Effect.exit(collect(inputFor(null)));

      expect(Exit.isFailure(exit)).toBe(true);
    })
  );

  it.effect(
    "normalizes settled and unsettled runs without double counting",
    () =>
      Effect.gen(function* normalize() {
        const batch = yield* collect(inputFor(recordPath, "feat/sdk-demo"));

        expect(Schema.is(EventBatchSchema)(batch)).toBe(true);

        const { events } = batch;

        for (const event of events) {
          expect(event.context.branch).toBe("feat/sdk-demo");
        }

        const settled = byKey(events, "settlement:agent-a:uuid-a1");

        expect(settled.kind).toBe("ai.usage");
        expect(settled.payload.charge).toBe(0.11);
        expect(settled.payload.rawCostUsd).toBe(0.13);
        expect(settled.payload.tokens).toEqual({
          cacheRead: 500,
          cacheWrite: 50,
          input: 1000,
          output: 200,
          reasoning: 40,
        });

        const remainder = byKey(events, "settlement-remainder:agent-a");

        expect(remainder.payload.scope).toBe("provider-bucket");
        expect(remainder.payload.tokens).toMatchObject({
          input: 100,
          output: 20,
        });

        const settledResult = byKey(events, "result:agent-a:run-a1");

        expect(settledResult.kind).toBe("ai.request");
        expect(settledResult.payload.tokens).toBeUndefined();
        expect(settledResult.payload.agentDurationMs).toBe(5000);
        expect(settledResult.identity.requestId).toBe("req-a1");

        const unsettled = byKey(events, "result:agent-b:run-b1");

        expect(unsettled.kind).toBe("ai.usage");
        expect(unsettled.payload.charge).toBeNull();
        expect(unsettled.payload.runStatus).toBe("error");
        expect(unsettled.payload.tokens).toMatchObject({
          input: 300,
          output: 10,
        });

        const usage = normalizeAiUsage(events);

        const detailInput = usage.rows
          .filter((row) => row.scope === "detail" && row.category === "input")
          .reduce((sum, row) => sum + row.value, 0);

        expect(detailInput).toBe(1300);

        const tools = events.filter((event) => event.payload.toolCall === true);

        expect(
          tools
            .map((event) => String(event.payload.status))
            .toSorted((a, b) => a.localeCompare(b))
        ).toEqual(["failed", "ok"]);

        const codes = batch.coverage.gaps.map((gap) => gap.code);

        expect(codes).toEqual(
          expect.arrayContaining([
            "missing-flight-tag",
            "unsupported-schema-version",
            "malformed-json",
            "flight-tag-other-branch",
            "cost-unsettled",
            "settlement-unkeyed-remainder",
          ])
        );
        expect(JSON.stringify(batch)).not.toContain("SECRET");
      })
  );

  it.effect("is idempotent across re-imports", () =>
    Effect.gen(function* idempotent() {
      const first = yield* collect(inputFor(recordPath));
      const second = yield* collect(inputFor(recordPath));

      expect(second.events.map((event) => event.eventId)).toEqual(
        first.events.map((event) => event.eventId)
      );
    })
  );

  it.effect(
    "parses a real @cursor/sdk 1.0.34 run record without inventing usage",
    () =>
      Effect.gen(function* live() {
        const batch = yield* collect(inputFor(livePath, "feat/sdk-live"));

        expect(batch.events).toHaveLength(1);

        const [event] = batch.events;

        expect(event?.kind).toBe("ai.request");
        expect(event?.payload.runStatus).toBe("error");
        expect(event?.payload.agentDurationMs).toBe(16_365);
        expect(event?.payload.runTokens).toBeNull();
        expect(event?.payload.tokensReason).toBe("run reported no usage");
        expect(normalizeAiUsage(batch.events).rows).toHaveLength(0);
      })
  );
});
