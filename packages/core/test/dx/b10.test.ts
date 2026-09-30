import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  CURSOR_CLI_ADAPTER_ID,
  cursorCliCollector,
  cursorCliDescriptor,
} from "../../src/dx/collectors/cursor-cli/collector.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/b10/${name}`, import.meta.url));

const inputFor = (selectedInput: string | null): CollectInput => ({
  adapterId: CURSOR_CLI_ADAPTER_ID,
  context: { ...emptyFlightContext, branch: "feature/b10-demo" },
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collect = (input: CollectInput) =>
  cursorCliCollector.collect(input).pipe(Effect.provide(NodeServices.layer));

describe("cursor-cli collector (B10)", () => {
  it("publishes a valid degraded descriptor with honest gaps", () => {
    expect(Schema.is(ModuleDescriptorSchema)(cursorCliDescriptor)).toBe(true);
    expect(cursorCliDescriptor.readiness).toBe("degraded");
    const codes = cursorCliDescriptor.gaps.map((gap) => gap.code);

    expect(codes).toContain("no-cost-in-cli-output");
    expect(codes).toContain("cli-store-db-unsupported");
    expect(codes).toContain("no-live-capture");
  });

  it.effect("decodes stream-json runs into ai.usage events", () =>
    Effect.gen(function* decodeStream() {
      const batch = yield* collect(inputFor(fixture("stream.jsonl")));

      expect(Schema.is(EventBatchSchema)(batch)).toBe(true);
      expect(batch.events).toHaveLength(2);
      const [first, second] = batch.events;

      expect(first?.kind).toBe("ai.usage");
      expect(first?.identity.sessionId).toBe("sess-fixture-1");
      expect(first?.identity.requestId).toBe("req-fixture-1");
      expect(first?.context.branch).toBe("feature/b10-demo");
      expect(first?.context.worktreePath).toBe("/fixture/demo-repo");
      expect(first?.occurredAt).toBe("2026-09-21T14:13:23.000Z");
      expect(first?.payload).toMatchObject({
        charge: null,
        durationMs: 5400,
        listPriceEstimateUsd: null,
        model: "Fixture Model",
        requestKey: "source:cursor-cli:request:req-fixture-1",
        tokens: {
          "cache-write": 150,
          "cached-input": 8000,
          input: 1200,
          output: 340,
          reasoning: null,
          total: null,
        },
        toolCalls: 2,
        toolNames: { editToolCall: 1, shellToolCall: 1 },
      });
      expect(second?.payload.tokens).toBeNull();
      expect(second?.payload.toolCalls).toBe(0);
      expect(second?.occurredAtPrecision).toBe("unknown");
      expect(
        second?.fieldSemantics.some((f) => f.field.startsWith("tokens."))
      ).toBe(false);
      expect(batch.coverage.state).toBe("partial");
      const codes = batch.coverage.gaps.map((gap) => gap.code);

      expect(codes).toContain("rejected-lines");
      expect(codes).toContain("result-without-usage");
      expect(JSON.stringify(batch)).not.toContain("SECRET_CANARY");
    })
  );

  it.effect("is idempotent: same input yields identical event IDs", () =>
    Effect.gen(function* repeat() {
      const a = yield* collect(inputFor(fixture("stream.jsonl")));
      const b = yield* collect(inputFor(fixture("stream.jsonl")));

      expect(a.events.map((e) => e.eventId)).toEqual(
        b.events.map((e) => e.eventId)
      );
    })
  );

  it.effect("decodes single-object json output format", () =>
    Effect.gen(function* decodeJson() {
      const batch = yield* collect(inputFor(fixture("result.json")));

      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.payload.tokens).toMatchObject({
        input: 10,
        output: 0,
      });
      expect(batch.events[0]?.payload.model).toBeNull();
      expect(JSON.stringify(batch)).not.toContain("SECRET_CANARY");
    })
  );

  it.effect("reports CLI SQLite chat stores as an unsupported layout", () =>
    Effect.gen(function* decodeStore() {
      const batch = yield* collect(inputFor(fixture("store.db")));

      expect(batch.events).toHaveLength(0);
      expect(batch.coverage.state).toBe("unsupported");
      expect(batch.coverage.gaps[0]?.code).toBe("cli-store-db-unsupported");
    })
  );

  it.effect("rejects missing and unreadable inputs with typed errors", () =>
    Effect.gen(function* errors() {
      const missing = yield* Effect.exit(collect(inputFor(null)));

      const unreadable = yield* Effect.exit(
        collect(inputFor(fixture("does-not-exist.jsonl")))
      );

      expect(Exit.isFailure(missing)).toBe(true);
      expect(JSON.stringify(missing)).toContain("InvalidInput");
      expect(Exit.isFailure(unreadable)).toBe(true);
      expect(JSON.stringify(unreadable)).toContain("SourceUnavailable");
    })
  );
});
