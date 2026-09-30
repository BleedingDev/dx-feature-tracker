// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B22 fixture files from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  buildManualBatch,
  manualCollector,
  manualDescriptor,
  toMarkerLogLine,
} from "../../src/dx/collectors/manual/collector.js";
import { pairMarkerIntervals } from "../../src/dx/collectors/manual/intervals.js";
import {
  MAX_LABEL_CHARS,
  buildMarkerEvent,
} from "../../src/dx/collectors/manual/marker.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  DxEventEnvelopeSchema,
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { FlightIdSchema } from "../../src/dx/model/ids.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "b22");

const BASIC = path.join(fixtureDir, "marker-log-basic.jsonl");

const ANOMALIES = path.join(fixtureDir, "marker-log-anomalies.jsonl");

const OBSERVED = "2026-09-30T12:00:00.000Z";

const context = { ...emptyFlightContext, branch: "feature/cart" };

const input = (selectedInput: string | null): CollectInput => ({
  adapterId: "manual",
  context,
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const liveOptions = {
  acquisition: "manual" as const,
  context,
  observedAt: OBSERVED,
  origin: "live" as const,
};

describe("b22 manual markers", () => {
  it("descriptor decodes and is ready", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      manualDescriptor
    );

    expect(descriptor.readiness).toBe("ready");
    expect(descriptor.fixtureIds).toEqual([
      "b22-marker-log-basic",
      "b22-marker-log-anomalies",
    ]);
  });

  it.effect("live start marker is valid, deterministic and branch scoped", () =>
    Effect.gen(function* case1() {
      const request = { kind: "start", occurredAt: "2026-09-30T10:00:00Z" };
      const first = yield* buildMarkerEvent(request, liveOptions);
      const second = yield* buildMarkerEvent(request, liveOptions);

      yield* Schema.decodeEffect(DxEventEnvelopeSchema)(first);
      expect(first.eventId).toBe(second.eventId);
      expect(first.kind).toBe("marker.start");
      expect(first.acquisition).toBe("manual");
      expect(first.occurredAt).toBe("2026-09-30T10:00:00.000Z");
      expect(first.context.flightId).toBe("branch:feature/cart");
      expect(
        first.fieldSemantics.find((item) => item.field === "occurredAt")?.method
      ).toBe("observed");
      expect(first.payload.method).toBe("user-claimed");
    })
  );

  it.effect("claim is labelled user-claimed and requires a label", () =>
    Effect.gen(function* case2() {
      const claim = yield* buildMarkerEvent(
        {
          flight: "flight-x",
          kind: "claim",
          label: "  hand-written parser ",
          occurredAt: "2026-09-30T10:00:00Z",
        },
        liveOptions
      );

      expect(claim.kind).toBe("marker.claim");
      expect(claim.context.flightId).toBe(FlightIdSchema.make("flight-x"));
      expect(claim.payload.label).toBe("hand-written parser");
      expect(claim.payload.claim).toBe(true);
      expect(
        claim.fieldSemantics.find((item) => item.field === "payload.label")
          ?.method
      ).toBe("user-claimed");

      const missing = yield* Effect.flip(
        buildMarkerEvent(
          { kind: "claim", occurredAt: "2026-09-30T10:00:00Z" },
          liveOptions
        )
      );

      expect(missing.field).toBe("label");
    })
  );

  it.effect("rejects bad kind, time, oversized label and missing flight", () =>
    Effect.gen(function* case3() {
      const badKind = yield* Effect.flip(
        buildMarkerEvent(
          { kind: "pause", occurredAt: "2026-09-30T10:00:00Z" },
          liveOptions
        )
      );

      const badTime = yield* Effect.flip(
        buildMarkerEvent({ kind: "stop", occurredAt: "soon" }, liveOptions)
      );

      const longLabel = yield* Effect.flip(
        buildMarkerEvent(
          {
            kind: "start",
            label: "x".repeat(MAX_LABEL_CHARS + 1),
            occurredAt: "2026-09-30T10:00:00Z",
          },
          liveOptions
        )
      );

      const noFlight = yield* Effect.flip(
        buildMarkerEvent(
          { kind: "start", occurredAt: "2026-09-30T10:00:00Z" },
          { ...liveOptions, context: emptyFlightContext }
        )
      );

      expect([
        badKind.field,
        badTime.field,
        longLabel.field,
        noFlight.field,
      ]).toEqual(["kind", "occurredAt", "label", "flight"]);
    })
  );

  it.effect(
    "imports basic marker log and pairs active and waiting intervals",
    () =>
      Effect.gen(function* case4() {
        const batch = yield* manualCollector.collect(input(BASIC));

        yield* Schema.decodeEffect(EventBatchSchema)(batch);
        expect(batch.coverage.state).toBe("complete");
        expect(batch.coverage.observedItems).toBe(5);
        expect(batch.events.map((event) => event.kind)).toEqual([
          "marker.start",
          "marker.wait-start",
          "marker.wait-stop",
          "marker.claim",
          "marker.stop",
        ]);
        expect(batch.events.every((e) => e.acquisition === "file-import")).toBe(
          true
        );
        expect(
          batch.events[0]?.fieldSemantics.find((f) => f.field === "occurredAt")
            ?.method
        ).toBe("user-claimed");

        const [flight] = pairMarkerIntervals(batch.events);

        expect(flight?.flightId).toBe("branch:feature/cart");
        expect(flight?.anomalies).toEqual([]);
        expect(flight?.claims).toHaveLength(1);
        expect(
          flight?.active.map((i) => (i.endMs ?? 0) - (i.startMs ?? 0))
        ).toEqual([3_600_000]);
        expect(
          flight?.waiting.map((i) => (i.endMs ?? 0) - (i.startMs ?? 0))
        ).toEqual([300_000]);
        expect(flight?.active[0]?.evidenceIds).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("anomalous log keeps gaps visible and censors open intervals", () =>
    Effect.gen(function* case5() {
      const content = readFileSync(ANOMALIES, "utf-8");

      const batch = yield* buildManualBatch(
        content,
        input(ANOMALIES),
        OBSERVED
      );

      expect(batch.coverage.state).toBe("partial");
      expect(batch.coverage.expectedItems).toBe(9);
      expect(batch.coverage.observedItems).toBe(3);
      expect(batch.coverage.gaps.map((gap) => gap.code)).toEqual([
        "line-unparseable",
        "line-unparseable",
        "line-invalid",
        "line-invalid",
        "line-invalid",
      ]);

      const [flight] = pairMarkerIntervals(batch.events);

      expect(flight?.flightId).toBe("flight-a");
      expect(flight?.active).toEqual([
        expect.objectContaining({ startMs: null }),
        expect.objectContaining({ endMs: null }),
      ]);
      expect(flight?.waiting).toEqual([
        expect.objectContaining({ endMs: null }),
      ]);
      expect(flight?.anomalies.map((gap) => gap.code)).toEqual([
        "marker-unopened-close",
        "marker-still-open",
        "marker-still-open",
      ]);
    })
  );

  it.effect("missing and unreadable inputs fail with typed errors", () =>
    Effect.gen(function* case6() {
      const missing = yield* Effect.flip(manualCollector.collect(input(null)));

      const unreadable = yield* Effect.flip(
        manualCollector.collect(input(path.join(fixtureDir, "nope.jsonl")))
      );

      expect(missing._tag).toBe("InvalidInput");
      expect(unreadable._tag).toBe("SourceUnavailable");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("marker log line round-trips through import", () =>
    Effect.gen(function* case7() {
      const line = toMarkerLogLine(
        {
          kind: "wait-start",
          note: "agent running",
          occurredAt: "2026-09-30T10:00:00.000Z",
        },
        "feature/cart"
      );

      const batch = yield* buildManualBatch(line, input(null), OBSERVED);

      expect(batch.events[0]?.kind).toBe("marker.wait-start");
      expect(batch.events[0]?.payload.note).toBe("agent running");
      expect(batch.events[0]?.context.branch).toBe("feature/cart");
    })
  );
});
