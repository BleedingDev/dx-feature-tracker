import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  entireCheckpointsCollector,
  entireCheckpointsDescriptor,
} from "../../src/dx/collectors/entire/collector.js";
import {
  ENTIRE_ADAPTER_ID,
  parseEntireCheckpoints,
} from "../../src/dx/collectors/entire/parse.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/b46/${name}`, import.meta.url));

const inputFor = (selectedInput: string | null): CollectInput => ({
  adapterId: ENTIRE_ADAPTER_ID,
  context: { ...emptyFlightContext, worktreePath: "/work/repo" },
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collect = (input: CollectInput) =>
  entireCheckpointsCollector
    .collect(input)
    .pipe(Effect.provide(NodeServices.layer));

const TokensSchema = Schema.Struct({
  apiCallCount: Schema.NullOr(Schema.Finite),
  cacheWrite: Schema.NullOr(Schema.Finite),
  cachedInput: Schema.NullOr(Schema.Finite),
  input: Schema.NullOr(Schema.Finite),
  output: Schema.NullOr(Schema.Finite),
  total: Schema.Null,
});

const UsagePayloadSchema = Schema.Struct({
  allocation: Schema.Struct({ state: Schema.String }),
  attribution: Schema.NullOr(Schema.Struct({ state: Schema.String })),
  checkpointId: Schema.String,
  cost: Schema.Struct({ state: Schema.String, value: Schema.Null }),
  cumulativeVerified: Schema.Boolean,
  requestKey: Schema.NullOr(Schema.String),
  subagentTokens: Schema.NullOr(TokensSchema),
  supersededCheckpoints: Schema.Array(Schema.String),
  tokens: TokensSchema,
  windowKind: Schema.String,
});

const WindowPayloadSchema = Schema.Struct({
  tokensFromTranscript: Schema.Null,
  transcriptWindow: Schema.Struct({
    malformedLines: Schema.Finite,
    toolCalls: Schema.Finite,
    toolNames: Schema.Record(Schema.String, Schema.Finite),
    windowEndLine: Schema.Finite,
    windowStartLine: Schema.Finite,
  }),
  windowKind: Schema.String,
});

const RootPayloadSchema = Schema.Struct({
  checkpointId: Schema.String,
  rootTokenUsage: Schema.Struct({
    ledgerRole: Schema.String,
    summedIntoTotals: Schema.Boolean,
    tokens: TokensSchema,
  }),
});

const decodeUsage = Schema.decodeUnknownSync(UsagePayloadSchema);

const decodeWindow = Schema.decodeUnknownSync(WindowPayloadSchema);

const decodeRoot = Schema.decodeUnknownSync(RootPayloadSchema);

const ofKind = (events: readonly DxEventEnvelope[], kind: string) =>
  events.filter((event) => event.kind === kind);

const sumInput = (events: readonly DxEventEnvelope[]) =>
  ofKind(events, "ai.usage").reduce(
    (sum, event) => sum + (decodeUsage(event.payload).tokens.input ?? 0),
    0
  );

describe("entire checkpoints collector (B46)", () => {
  it("publishes a valid degraded descriptor naming the host gap", () => {
    expect(Schema.is(ModuleDescriptorSchema)(entireCheckpointsDescriptor)).toBe(
      true
    );
    expect(entireCheckpointsDescriptor.readiness).toBe("degraded");
    expect(entireCheckpointsDescriptor.gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining([
        "source-absent-on-host",
        "cost-unavailable",
        "attribution-source-heuristic",
      ])
    );
  });

  it.effect(
    "imports delta windows once each and keeps root usage as an unsummed alternative",
    () =>
      Effect.gen(function* importDelta() {
        const batch = yield* collect(inputFor(fixture("delta-windows")));
        const { events } = batch;

        expect(Schema.is(EventBatchSchema)(batch)).toBe(true);
        expect(batch.coverage.state).toBe("complete");
        expect(ofKind(events, "provenance.attestation")).toHaveLength(2);
        expect(ofKind(events, "ai.session")).toHaveLength(2);
        expect(ofKind(events, "ai.turn")).toHaveLength(2);
        expect(ofKind(events, "ai.usage")).toHaveLength(3);

        expect(sumInput(events)).toBe(1700);

        const roots = ofKind(events, "provenance.attestation").map((event) =>
          decodeRoot(event.payload)
        );

        const rootTotal = roots.reduce(
          (sum, root) => sum + (root.rootTokenUsage.tokens.input ?? 0),
          0
        );

        expect(rootTotal).toBe(1700);
        expect(
          roots.every(
            (root) =>
              root.rootTokenUsage.ledgerRole === "aggregate-alternative" &&
              !root.rootTokenUsage.summedIntoTotals
          )
        ).toBe(true);

        const usage = ofKind(events, "ai.usage").map((event) =>
          decodeUsage(event.payload)
        );

        const keys = usage.map((row) => row.requestKey);
        expect(new Set(keys).size).toBe(3);
        expect(keys).toContain(
          "source:entire:session:sess-1:turn:a1b2c3d4e5f6"
        );

        const second = usage.find(
          (row) =>
            row.checkpointId === "0f1e2d3c4b5a" && row.tokens.input === 600
        );

        expect(second?.windowKind).toBe("delta");
        expect(second?.subagentTokens?.input).toBe(100);
        expect(second?.cumulativeVerified).toBe(false);
        expect(
          usage.every(
            (row) =>
              row.cost.state === "unavailable" &&
              row.allocation.state === "provisional" &&
              row.tokens.total === null
          )
        ).toBe(true);
        expect(
          usage.find((row) => row.attribution !== null)?.attribution?.state
        ).toBe("provisional");

        const windows = ofKind(events, "ai.turn").map(
          (event) => decodeWindow(event.payload).transcriptWindow
        );

        expect(
          windows.map((window) => [
            window.windowStartLine,
            window.windowEndLine,
            window.toolCalls,
          ])
        ).toEqual(
          expect.arrayContaining([
            [0, 4, 2],
            [4, 8, 3],
          ])
        );
        expect(
          windows.find((window) => window.toolCalls === 3)?.toolNames
        ).toEqual({
          Bash: 1,
          Edit: 2,
        });

        expect(
          events.every(
            (event) =>
              event.context.branch === "feature/entire-demo" &&
              event.context.worktreePath === "/work/repo" &&
              event.origin === "fixture"
          )
        ).toBe(true);

        const again = yield* collect(inputFor(fixture("delta-windows")));
        expect(again.events.map((event) => event.eventId)).toEqual(
          events.map((event) => event.eventId)
        );
      })
  );

  it.effect(
    "collapses unverified cumulative checkpoints to the latest and reports partial coverage",
    () =>
      Effect.gen(function* importCumulative() {
        const batch = yield* collect(
          inputFor(fixture("cumulative-unverified"))
        );

        const usage = ofKind(batch.events, "ai.usage").map((event) =>
          decodeUsage(event.payload)
        );

        expect(usage).toHaveLength(1);
        expect(usage[0]?.tokens.input).toBe(900);
        expect(usage[0]?.windowKind).toBe("cumulative-unverified-latest");
        expect(usage[0]?.supersededCheckpoints).toEqual(["111111111111"]);
        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.gaps.map((gap) => gap.code)).toEqual(
          expect.arrayContaining([
            "cumulative-unverified-collapsed",
            "malformed-files",
          ])
        );
      })
  );

  it("skips repeated checkpoint/session records instead of double counting", () => {
    const text = JSON.stringify({
      checkpoint_id: "abcdefabcdef",
      session_id: "sess-x",
      token_usage: { input_tokens: 10 },
    });

    const result = parseEntireCheckpoints(
      [
        { relPath: "ab/cdefabcdef/0/metadata.json", text },
        { relPath: "copy/ab/cdefabcdef/0/metadata.json", text },
      ],
      {
        context: emptyFlightContext,
        evidenceName: "inline",
        observedAt: "2026-09-30T12:00:00.000Z",
        origin: "fixture",
      }
    );

    expect(result.duplicateSessionRecords).toBe(1);
    expect(sumInput(result.batch.events)).toBe(10);
    expect(result.batch.coverage.gaps.map((gap) => gap.code)).toContain(
      "duplicate-session-records"
    );
  });

  it.effect("rejects missing and unreadable inputs with typed errors", () =>
    Effect.gen(function* rejectInputs() {
      const missing = yield* Effect.flip(collect(inputFor(null)));

      const unreadable = yield* Effect.flip(
        collect(inputFor(fixture("does-not-exist")))
      );

      expect(missing._tag).toBe("InvalidInput");
      expect(unreadable._tag).toBe("SourceUnavailable");
    })
  );
});
