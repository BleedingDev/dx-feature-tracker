import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  cursorTranscriptCollector,
  cursorTranscriptDescriptor,
  probeCursorTranscript,
  sessionFromPath,
} from "../../src/dx/collectors/cursor-transcripts/collector.js";
import { mapUsage } from "../../src/dx/collectors/cursor-transcripts/usage.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/b07/${name}`, import.meta.url));

const MAIN = "projects/demo/agent-transcripts/comp-A/comp-A.jsonl";

const SUB = "projects/demo/agent-transcripts/comp-A/subagents/agent-7.jsonl";

const TXT = "projects/demo/agent-transcripts/comp-T.txt";

const collect = (selectedInput: string | null) =>
  cursorTranscriptCollector.collect({
    adapterId: "cursor-transcripts",
    context: { ...emptyFlightContext, branch: "feature/b07" },
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput,
  });

const gapCodes = (batch: {
  readonly coverage: { readonly gaps: readonly { readonly code: string }[] };
}) => batch.coverage.gaps.map((gap) => gap.code);

describe("cursor-transcripts collector (B07)", () => {
  it.effect("splits role/content JSONL into turns with tool counts", () =>
    Effect.gen(function* transcriptTurns() {
      const batch = yield* collect(fixture(MAIN));
      yield* Schema.decodeEffect(EventBatchSchema)(batch);
      expect(batch.events).toHaveLength(2);
      const [first, second] = batch.events;
      expect(first?.identity.sessionId).toBe("comp-A");
      expect(first?.identity.turnId).toBe("comp-A:0");
      expect(first?.payload.toolCalls).toBe(3);
      expect(first?.payload.toolNames).toEqual({ ReadFile: 2, Shell: 1 });
      expect(first?.payload.usageState).toBe("unavailable");
      expect(first?.payload.tokens).toMatchObject({
        input: null,
        output: null,
      });
      expect(first?.payload.estimates).toEqual({
        method: "estimated",
        visibleTextTokens: 5,
      });
      expect(first?.payload.requestKey).toBe(
        "source:transcript-estimate:session:comp-A:turn:0"
      );
      expect(first?.payload.charge).toBeNull();
      expect(first?.payload.branchSource).toBe("collect-context");
      expect(first?.occurredAt).toBeNull();
      expect(second?.payload.usageState).toBe("partial");
      expect(second?.payload.tokens).toEqual({
        "cache-write": null,
        "cached-input": 800,
        input: 1200,
        output: 300,
        reasoning: null,
        total: null,
      });
      expect(second?.payload.unmappedUsage).toEqual({
        contextWindowTokens: 200_000,
      });
      expect(second?.payload.model).toBe("fixture-model");
      expect(JSON.stringify(batch.events)).not.toContain("fixture prompt");
      expect(batch.coverage.state).toBe("partial");
      expect(gapCodes(batch)).toEqual([
        "charge-unavailable",
        "partial-tail",
        "usage-unavailable",
        "usage-unmapped",
        "timestamps-absent",
      ]);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("gives subagent transcripts a child identity", () =>
    Effect.gen(function* subagent() {
      const batch = yield* collect(fixture(SUB));
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.identity.sessionId).toBe("agent-7");
      expect(batch.events[0]?.payload.parentSessionId).toBe("comp-A");
      expect(sessionFromPath("/x/comp-B.jsonl")).toEqual({
        parentSessionId: null,
        sessionHint: "comp-B",
      });
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("parses the TXT transcript layout without tool arguments", () =>
    Effect.gen(function* txtLayout() {
      const batch = yield* collect(fixture(TXT));

      yield* Schema.decodeEffect(EventBatchSchema)(batch);
      expect(batch.events).toHaveLength(1);
      const [event] = batch.events;

      expect(event?.identity.sessionId).toBe("comp-T");
      expect(event?.payload.transcriptLayout).toBe("cursor-transcript-txt");
      expect(event?.payload.assistantMessages).toBe(2);
      expect(event?.payload.toolNames).toEqual({ Shell: 1, StrReplace: 1 });
      expect(event?.payload.estimates).toEqual({
        method: "estimated",
        visibleTextTokens: 5,
      });
      expect(event?.payload.usageState).toBe("unavailable");
      expect(JSON.stringify(batch.events)).not.toContain("pnpm test");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("reports unrecognized layouts as unsupported with no events", () =>
    Effect.gen(function* unrecognized() {
      const batch = yield* collect(fixture("unrecognized.jsonl"));
      expect(batch.events).toHaveLength(0);
      expect(batch.coverage.state).toBe("unsupported");
      expect(gapCodes(batch)).toContain("layout-unrecognized");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("is deterministic across re-imports", () =>
    Effect.gen(function* deterministic() {
      const a = yield* collect(fixture(MAIN));
      const b = yield* collect(fixture(MAIN));
      expect(a.events.map((e) => e.eventId)).toEqual(
        b.events.map((e) => e.eventId)
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("requires an explicit readable input", () =>
    Effect.gen(function* explicitInput() {
      const missing = yield* Effect.flip(collect(null));
      expect(missing._tag).toBe("InvalidInput");
      const unreadable = yield* Effect.flip(collect(fixture("absent.jsonl")));
      expect(unreadable._tag).toBe("SourceUnavailable");
      const probe = yield* probeCursorTranscript(fixture(MAIN));

      expect(probe.layout).toBe("cursor-transcript-jsonl");
      expect(probe.itemCount).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it("keeps unknown usage keys raw and validates the descriptor", () => {
    expect(mapUsage({ foo: 3 }, "usage").state).toBe("unmapped");
    expect(mapUsage({ inputTokens: 1, total_tokens: 2 }, "u").state).toBe(
      "mapped"
    );
    expect(mapUsage(null, "usage").state).toBe("unavailable");
    expect(
      Schema.decodeSync(ModuleDescriptorSchema)(cursorTranscriptDescriptor)
        .readiness
    ).toBe("degraded");
  });
});
