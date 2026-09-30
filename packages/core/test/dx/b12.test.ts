import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { codexSessionCollector } from "../../src/dx/collectors/codex/collector.js";
import { canonicalRequestKey } from "../../src/dx/model/ai.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../src/dx/model/event.js";

const fixture = (name: string) => `${import.meta.dirname}/fixtures/b12/${name}`;

const flight: FlightContext = {
  ...emptyFlightContext,
  branch: "feature/fixture",
  worktreePath: "/fixture/worktree",
};

const collect = (file: string, context: FlightContext = flight) =>
  codexSessionCollector.collect({
    adapterId: "codex-session",
    context,
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput: file,
  });

const TokensSchema = Schema.Struct({
  cachedInput: Schema.NullOr(Schema.Finite),
  input: Schema.NullOr(Schema.Finite),
  output: Schema.NullOr(Schema.Finite),
  total: Schema.NullOr(Schema.Finite),
});

const UsagePayloadSchema = Schema.Struct({
  allocation: Schema.Struct({ reason: Schema.String, state: Schema.String }),
  cost: Schema.Struct({ state: Schema.String, value: Schema.Null }),
  requestKey: Schema.NullOr(Schema.String),
  tokens: TokensSchema,
});

const TurnPayloadSchema = Schema.Struct({
  allocation: Schema.Struct({ state: Schema.String }),
  durationMs: Schema.NullOr(Schema.Finite),
  status: Schema.String,
  toolCalls: Schema.Int,
  toolNames: Schema.Record(Schema.String, Schema.Int),
});

const usagePayload = (event: DxEventEnvelope) =>
  Schema.decodeUnknownSync(UsagePayloadSchema)(event.payload);

const turnPayload = (event: DxEventEnvelope) =>
  Schema.decodeUnknownSync(TurnPayloadSchema)(event.payload);

const ofKind = (events: readonly DxEventEnvelope[], kind: string) =>
  events.filter((event) => event.kind === kind);

it("b12 descriptor exposes a schema-valid degraded descriptor with explicit gaps", () => {
  const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
    codexSessionCollector.descriptor
  );

  expect(descriptor.readiness).toBe("degraded");
  expect(descriptor.gaps.map((gap) => gap.code)).toContain("cost-unavailable");
});

it.layer(NodeServices.layer)("b12 codex session collector", (test) => {
  test.effect(
    "imports per-response usage once and keeps cost unavailable",
    () =>
      Effect.gen(function* importV2() {
        const batch = yield* collect(fixture("codex-rollout-v2.jsonl"));
        const decoded = yield* Schema.decodeEffect(EventBatchSchema)(batch);
        const usage = ofKind(decoded.events, "ai.usage");

        expect(usage.map((event) => event.identity.requestId)).toStrictEqual([
          "resp-1",
          "resp-2",
          "resp-3",
        ]);
        expect(
          usage.map((event) => usagePayload(event).tokens.total)
        ).toStrictEqual([1200, 1800, 900]);
        expect(usage.map(usagePayload)[0]?.requestKey).toBe(
          canonicalRequestKey({
            generationId: null,
            requestId: "resp-1",
            sessionId: "fixture-session-v2",
            sourceKind: "codex-session",
            turnIndex: null,
          })
        );
        expect(
          usage.every(
            (event) => usagePayload(event).cost.state === "unavailable"
          )
        ).toBe(true);
        expect(new Set(decoded.events.map((event) => event.eventId)).size).toBe(
          decoded.events.length
        );
        expect(decoded.coverage.state).toBe("partial");
        expect(decoded.coverage.gaps.map((gap) => gap.code)).toContain(
          "malformed-lines"
        );
        expect(
          decoded.events.every((event) => event.origin === "fixture")
        ).toBe(true);
      })
  );

  test.effect("allocates by working directory and never claims strong", () =>
    Effect.gen(function* allocation() {
      const batch = yield* collect(fixture("codex-rollout-v2.jsonl"));
      const usage = ofKind(batch.events, "ai.usage");
      const states = usage.map((event) => usagePayload(event).allocation.state);

      expect(states).toStrictEqual([
        "provisional",
        "provisional",
        "unassigned",
      ]);
      expect(usage[0]?.context.branch).toBe("feature/fixture");
      expect(usage[2]?.context.branch).toBeNull();

      const unselected = yield* collect(
        fixture("codex-rollout-v2.jsonl"),
        emptyFlightContext
      );

      expect(
        ofKind(unselected.events, "ai.usage").map(
          (event) => usagePayload(event).allocation.state
        )
      ).toStrictEqual(["unassigned", "unassigned", "unassigned"]);
    })
  );

  test.effect("summarizes turns with tool calls and aborted status", () =>
    Effect.gen(function* turns() {
      const batch = yield* collect(fixture("codex-rollout-v2.jsonl"));
      const [first, second] = ofKind(batch.events, "ai.turn").map(turnPayload);

      expect(first).toMatchObject({
        durationMs: 12_000,
        status: "completed",
        toolCalls: 3,
        toolNames: { apply_patch: 1, exec_command: 2 },
      });
      expect(second).toMatchObject({ status: "aborted", toolCalls: 0 });
    })
  );

  test.effect(
    "falls back to deduplicated token_count deltas for legacy rollouts",
    () =>
      Effect.gen(function* legacy() {
        const batch = yield* collect(fixture("codex-rollout-legacy.jsonl"));
        const usage = ofKind(batch.events, "ai.usage");

        expect(
          usage.map((event) => usagePayload(event).tokens.total)
        ).toStrictEqual([550, 740]);
        expect(
          usage.every((event) => usagePayload(event).requestKey === null)
        ).toBe(true);
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "legacy-token-count"
        );
        expect(usage[0]?.sourceVersion).toBe("0.60.1");

        const otherBranch = yield* collect(
          fixture("codex-rollout-legacy.jsonl"),
          {
            ...flight,
            branch: "main",
          }
        );

        expect(
          ofKind(otherBranch.events, "ai.usage").map(
            (event) => usagePayload(event).allocation.state
          )
        ).toStrictEqual(["unassigned", "unassigned"]);
      })
  );

  test.effect("rejects missing, non-jsonl, unreadable and foreign inputs", () =>
    Effect.gen(function* rejects() {
      const exits = yield* Effect.forEach(
        [
          "",
          fixture("codex-rollout-v2.json"),
          fixture("missing.jsonl"),
          fixture("not-codex.jsonl"),
        ],
        (file) => Effect.exit(collect(file))
      );

      const tags = exits.map((exit) =>
        Exit.isFailure(exit) ? exit.cause.toString() : "success"
      );

      expect(tags[0]).toContain("InvalidInput");
      expect(tags[1]).toContain("InvalidInput");
      expect(tags[2]).toContain("SourceUnavailable");
      expect(tags[3]).toContain("InvalidInput");
    })
  );
});
