import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  claudeJsonlCollector,
  claudeJsonlDescriptor,
  probeClaudeJsonl,
} from "../../src/dx/collectors/claude/collector.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/b11/${name}`, import.meta.url));

const collect = (selectedInput: string | null) =>
  claudeJsonlCollector.collect({
    adapterId: "claude-jsonl",
    context: { ...emptyFlightContext, branch: "context-branch" },
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput,
  });

describe("claude-jsonl collector (B11)", () => {
  it.effect("collapses streamed rows per request and keeps source tokens", () =>
    Effect.gen(function* collapsesRows() {
      const batch = yield* collect(fixture("claude-session.jsonl"));
      yield* Schema.decodeEffect(EventBatchSchema)(batch);
      expect(batch.events).toHaveLength(2);
      const [first, second] = batch.events;
      expect(first?.identity.requestId).toBe("req_fixture_A");
      expect(first?.payload.tokens).toEqual({
        "cache-write": 2000,
        "cached-input": 15_000,
        input: 10,
        output: 120,
      });
      expect(first?.payload.toolCalls).toBe(1);
      expect(first?.payload.charge).toBeNull();
      expect(first?.payload.requestKey).toBe(
        "source:claude-jsonl:request:req_fixture_A"
      );
      expect(first?.context.branch).toBe("feature/fixture-flight");
      expect(first?.origin).toBe("fixture");
      expect(first?.evidence.ref).toBe(
        "claude-jsonl://claude-session.jsonl#lines:2-3"
      );
      expect(second?.payload.toolNames).toEqual({ Edit: 2 });
      expect(batch.coverage.state).toBe("complete");
      expect(batch.coverage.windowFrom).toBe("2026-09-30T09:00:05.000Z");
      expect(batch.coverage.gaps.map((gap) => gap.code)).toEqual([
        "charge-unavailable",
      ]);
      expect(JSON.stringify(batch)).not.toContain("redacted prompt");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("is deterministic across re-imports", () =>
    Effect.gen(function* deterministic() {
      const a = yield* collect(fixture("claude-session.jsonl"));
      const b = yield* collect(fixture("claude-session.jsonl"));
      expect(a.events.map((event) => event.eventId)).toEqual(
        b.events.map((event) => event.eventId)
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("keeps degraded rows visible and never invents values", () =>
    Effect.gen(function* degraded() {
      const batch = yield* collect(fixture("claude-degraded.jsonl"));
      expect(batch.coverage.state).toBe("partial");
      expect(batch.coverage.gaps.map((gap) => gap.code).toSorted()).toEqual([
        "charge-unavailable",
        "malformed-lines",
        "request-id-missing",
        "synthetic-rows",
        "usage-missing",
      ]);
      expect(batch.events).toHaveLength(2);
      const [priced, bare] = batch.events;
      expect(priced?.payload.tokens).toEqual({
        "cache-write": null,
        "cached-input": null,
        input: 50,
        output: 7,
      });
      expect(priced?.payload.listPriceEstimateUsd).toBe(0.0123);
      expect(priced?.payload.charge).toBeNull();
      expect(
        priced?.fieldSemantics.find(
          (entry) => entry.field === "listPriceEstimateUsd"
        )?.method
      ).toBe("estimated");
      expect(bare?.identity.requestId).toBeNull();
      expect(bare?.occurredAt).toBeNull();
      expect(bare?.occurredAtPrecision).toBe("unknown");
      expect(bare?.payload.tokens).toEqual({
        "cache-write": null,
        "cached-input": null,
        input: null,
        output: null,
      });
      expect(bare?.context.branch).toBe("context-branch");
      expect(bare?.payload.branchSource).toBe("collect-context");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("requires an explicitly selected file", () =>
    Effect.gen(function* requiresInput() {
      const missing = yield* Effect.flip(collect(null));
      expect(missing._tag).toBe("InvalidInput");

      const unreadable = yield* Effect.flip(
        collect(fixture("does-not-exist.jsonl"))
      );

      expect(unreadable._tag).toBe("SourceUnavailable");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("probes version without content", () =>
    Effect.gen(function* probes() {
      const receipt = yield* probeClaudeJsonl(fixture("claude-session.jsonl"));
      expect(receipt.present).toBe(true);
      expect(receipt.itemCount).toBe(2);
      expect(receipt.version).toBe("2.1.0");
      const absent = yield* probeClaudeJsonl(fixture("absent.jsonl"));
      expect(absent.readable).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it("publishes a truthful degraded descriptor", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      claudeJsonlDescriptor
    );

    expect(descriptor.readiness).toBe("degraded");
    expect(descriptor.gaps.map((gap) => gap.code)).toContain(
      "charge-unavailable"
    );
  });
});
