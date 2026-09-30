import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { providerUsageCollector } from "../../src/dx/collectors/provider-usage/collector.js";
import {
  PROVIDER_USAGE_FIXTURE_IDS,
  providerUsageDescriptor,
} from "../../src/dx/collectors/provider-usage/descriptor.js";
import { parseProviderUsage } from "../../src/dx/collectors/provider-usage/parse.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type { EventBatch } from "../../src/dx/model/event.js";

const fixturePath = (name: string): string =>
  new URL(`fixtures/b14/${name}`, import.meta.url).pathname;

const inputFor = (selectedInput: string | null): CollectInput => ({
  adapterId: "provider-usage",
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collectFixture = (name: string) =>
  providerUsageCollector
    .collect(inputFor(fixturePath(name)))
    .pipe(Effect.provide(NodeFileSystem.layer));

const payloadOf = (batch: EventBatch, index: number) =>
  batch.events[index]?.payload ?? {};

describe("b14 provider usage collector", () => {
  it("declares a valid degraded descriptor listing every fixture", () => {
    const decoded = Schema.decodeSync(ModuleDescriptorSchema)(
      providerUsageDescriptor
    );

    expect(decoded.readiness).toBe("degraded");
    expect(decoded.fixtureIds).toStrictEqual([...PROVIDER_USAGE_FIXTURE_IDS]);
    expect(decoded.gaps.map((gap) => gap.code)).toContain("no-auto-fetch");
  });

  it.effect(
    "imports OpenAI completions usage with cached input split out",
    () =>
      Effect.gen(function* importsOpenAiUsage() {
        const batch = yield* collectFixture("openai-usage.json");
        yield* Schema.decodeEffect(EventBatchSchema)(batch);
        expect(batch.events).toHaveLength(2);
        const first = payloadOf(batch, 0);
        expect(first.tokens).toStrictEqual({
          "cached-input": 8000,
          input: 4000,
          output: 3400,
        });
        expect(first.charge).toBeNull();
        expect(first.requests).toBe(42);
        expect(first.scope).toBe("provider-bucket");
        expect(batch.events[0]?.occurredAtPrecision).toBe("day");
        expect(batch.events[0]?.origin).toBe("fixture");
        expect(
          batch.events[0]?.fieldSemantics.find(
            (semantic) => semantic.field === "tokens.input"
          )?.method
        ).toBe("derived");
        expect(payloadOf(batch, 1).tokens).toStrictEqual({
          input: 500,
          output: 0,
        });
        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "pagination-incomplete"
        );
      })
  );

  it.effect("keeps a missing OpenAI cost amount unavailable, not zero", () =>
    Effect.gen(function* importsOpenAiCosts() {
      const batch = yield* collectFixture("openai-costs.json");
      expect(payloadOf(batch, 0).charge).toStrictEqual({
        currency: "USD",
        value: 1.25,
      });
      expect(payloadOf(batch, 0).tokens).toBeNull();
      expect(payloadOf(batch, 1).charge).toBeNull();
      expect(payloadOf(batch, 1).unavailable).toContainEqual({
        field: "charge",
        reason: "amount.value missing in export",
      });
      expect(batch.coverage.state).toBe("complete");
    })
  );

  it.effect("imports Anthropic usage report with derived cache writes", () =>
    Effect.gen(function* importsAnthropicUsage() {
      const batch = yield* collectFixture("anthropic-usage.json");
      expect(batch.events).toHaveLength(1);
      expect(payloadOf(batch, 0).tokens).toStrictEqual({
        "cache-write": 300,
        "cached-input": 4000,
        input: 900,
        output: 650,
      });
      expect(payloadOf(batch, 0).provider).toBe("anthropic");
      expect(payloadOf(batch, 0).requests).toBeNull();
      expect(batch.events[0]?.occurredAt).toBe("2026-09-30T09:00:00.000Z");
      expect(batch.events[0]?.occurredAtPrecision).toBe("minute");
    })
  );

  it.effect("rejects Anthropic cost reports as unsupported", () =>
    Effect.gen(function* rejectsAnthropicCost() {
      const error = yield* Effect.flip(collectFixture("anthropic-cost.json"));
      expect(error._tag).toBe("UnsupportedSource");
    })
  );

  it.effect("requires an explicit input and reports a missing file", () =>
    Effect.gen(function* requiresExplicitInput() {
      const noInput = yield* Effect.flip(
        providerUsageCollector
          .collect(inputFor(null))
          .pipe(Effect.provide(NodeFileSystem.layer))
      );

      expect(noInput._tag).toBe("InvalidInput");
      const missing = yield* Effect.flip(collectFixture("absent.json"));
      expect(missing._tag).toBe("SourceUnavailable");
    })
  );

  const meta = {
    context: emptyFlightContext,
    fileLabel: "inline.json",
    observedAt: "2026-09-30T12:00:00.000Z",
    origin: "fixture" as const,
  };

  const anthropicPage = JSON.stringify({
    data: [
      {
        ending_at: "2026-09-30T10:00:00Z",
        results: [{ output_tokens: 1, uncached_input_tokens: 2 }],
        starting_at: "2026-09-30T09:00:00Z",
      },
    ],
  });

  it("produces deterministic event IDs across re-imports", () => {
    const first = Result.getOrThrow(parseProviderUsage(anthropicPage, meta));

    const second = Result.getOrThrow(
      parseProviderUsage(anthropicPage, {
        ...meta,
        observedAt: "2026-09-30T13:00:00.000Z",
      })
    );

    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.eventId).toBe(second.events[0]?.eventId);
  });

  it("returns none coverage for an empty page", () => {
    const batch = Result.getOrThrow(
      parseProviderUsage(
        JSON.stringify({ data: [], has_more: false, object: "page" }),
        meta
      )
    );

    expect(batch.coverage.state).toBe("none");
  });

  it("rejects unrelated and malformed JSON", () => {
    expect(
      Result.isFailure(parseProviderUsage(JSON.stringify({ hello: 1 }), meta))
    ).toBe(true);
    expect(Result.isFailure(parseProviderUsage("{not json", meta))).toBe(true);
  });
});
