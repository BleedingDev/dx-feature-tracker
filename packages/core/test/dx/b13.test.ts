// @effect-diagnostics-next-line nodeBuiltinImport:off -- Recomputes the frozen sha256 event ID formula independently of the collector.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  OPENCODE_ADAPTER_ID,
  opencodeCollector,
  opencodeDescriptor,
} from "../../src/dx/collectors/opencode/collector.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/b13/${name}`, import.meta.url));

const inputFor = (selectedInput: string | null): CollectInput => ({
  adapterId: OPENCODE_ADAPTER_ID,
  context: { ...emptyFlightContext, branch: "feature/fixture-flight" },
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collect = (input: CollectInput) =>
  opencodeCollector.collect(input).pipe(Effect.provide(NodeServices.layer));

const payloadOf = (batch: typeof EventBatchSchema.Type, index: number) =>
  batch.events[index]?.payload ?? {};

describe("opencode collector (B13)", () => {
  it("publishes a valid degraded descriptor with honest gaps", () => {
    expect(Schema.is(ModuleDescriptorSchema)(opencodeDescriptor)).toBe(true);
    expect(opencodeDescriptor.readiness).toBe("degraded");
    expect(opencodeDescriptor.gaps.map((gap) => gap.code)).toContain(
      "cost-is-list-price-estimate"
    );
    expect(opencodeDescriptor.gaps.map((gap) => gap.code)).toContain(
      "v2-export-shape-unverified"
    );
  });

  it.effect("imports session, tokens, list-price cost and tool calls", () =>
    Effect.gen(function* importFixture() {
      const batch = yield* collect(
        inputFor(fixture("opencode-session-export.json"))
      );

      expect(Schema.is(EventBatchSchema)(batch)).toBe(true);
      expect(batch.events.map((event) => event.kind)).toEqual([
        "ai.session",
        "ai.usage",
        "ai.usage",
      ]);
      expect(batch.coverage.state).toBe("complete");
      expect(batch.coverage.expectedItems).toBe(2);

      const [, first] = batch.events;
      expect(first?.eventId).toBe(
        `sha256:${createHash("sha256")
          .update(`opencode\u0000${first?.upstreamKey}\u0000ai.usage`)
          .digest("hex")}`
      );
      expect(first?.context.branch).toBe("feature/fixture-flight");
      expect(first?.identity.sessionId).toBe("ses_fixture0001");
      expect(first?.occurredAt).toBe("2026-09-30T09:00:01.000Z");
      expect(first?.origin).toBe("fixture");

      const usage = payloadOf(batch, 1);
      expect(usage.tokens).toEqual({
        cacheRead: 800,
        cacheWrite: 0,
        input: 1200,
        output: 300,
        reasoning: 40,
        total: null,
      });
      expect(usage.cost).toEqual({
        currency: "USD",
        ledger: "list-price-estimate",
        method: "estimated",
        value: 0.0125,
      });
      expect(usage.toolCalls).toBe(3);
      expect(usage.toolNames).toEqual({ bash: 2, edit: 1 });
      expect(usage.durationMs).toBe(30_000);
      expect(usage.requestKey).toBe(
        "source:opencode:session:ses_fixture0001:turn:msg_fixture0002"
      );
      expect(JSON.stringify(batch.events)).not.toContain("[redacted]");

      const session = payloadOf(batch, 0);
      expect(session.messageCount).toBe(3);
      expect(session.assistantMessageCount).toBe(2);
    })
  );

  it.effect("is idempotent: same export yields identical event IDs", () =>
    Effect.gen(function* repeatImport() {
      const input = inputFor(fixture("opencode-session-export.json"));
      const a = yield* collect(input);
      const b = yield* collect(input);

      expect(a.events.map((event) => event.eventId)).toEqual(
        b.events.map((event) => event.eventId)
      );
    })
  );

  it.effect("keeps missing tokens, cost and tool calls unavailable", () =>
    Effect.gen(function* partialImport() {
      const batch = yield* collect(
        inputFor(fixture("opencode-partial-export.json"))
      );

      const usage = payloadOf(batch, 1);

      expect(batch.coverage.state).toBe("partial");
      expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
        "missing-usage-fields"
      );
      expect(usage.tokens).toEqual({
        cacheRead: null,
        cacheWrite: null,
        input: 90,
        output: 10,
        reasoning: null,
        total: null,
      });
      expect(usage.cost).toMatchObject({ currency: null, value: null });
      expect(usage.toolCalls).toBeNull();
      expect(batch.events[1]?.occurredAt).toBeNull();
      expect(batch.events[1]?.occurredAtPrecision).toBe("unknown");
    })
  );

  it.effect("rejects missing, unreadable, invalid and foreign inputs", () =>
    Effect.gen(function* rejectInputs() {
      const missing = yield* Effect.flip(collect(inputFor(null)));

      const unreadable = yield* Effect.flip(
        collect(inputFor(fixture("does-not-exist.json")))
      );

      const foreign = yield* Effect.flip(
        collect(inputFor(fixture("opencode-wrong-shape.json")))
      );

      expect(missing._tag).toBe("InvalidInput");
      expect(unreadable._tag).toBe("SourceUnavailable");
      expect(foreign._tag).toBe("UnsupportedSource");
    })
  );
});
