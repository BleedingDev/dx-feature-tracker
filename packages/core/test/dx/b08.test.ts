import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  cursorUsageExportCollector,
  probeCursorUsageExport,
} from "../../src/dx/collectors/cursor-usage-export/collector.js";
import { cursorUsageExportDescriptor } from "../../src/dx/collectors/cursor-usage-export/descriptor.js";
import { readCost } from "../../src/dx/collectors/cursor-usage-export/parse.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/b08/${name}`, import.meta.url));

const collect = (selectedInput: string | null) =>
  cursorUsageExportCollector.collect({
    adapterId: "cursor-usage-export",
    context: { ...emptyFlightContext, branch: "feature/should-not-leak" },
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput,
  });

describe("cursor-usage-export collector (B08)", () => {
  it.effect("imports kind/cache-split variant with raw cost semantics", () =>
    Effect.gen(function* kindVariant() {
      const batch = yield* collect(fixture("usage-kind-cache-split.csv"));
      yield* Schema.decodeEffect(EventBatchSchema)(batch);
      expect(batch.events).toHaveLength(5);
      const [included, billed, errored, dupA, dupB] = batch.events;
      expect(included?.payload.tokens).toEqual({
        "cache-write": 1200,
        "cached-input": 15_000,
        input: 300,
        output: 800,
        total: 17_300,
      });
      expect(included?.payload.rawTokens).toMatchObject({
        "input (w/ cache write)": 1200,
      });
      expect(included?.payload.costLedger).toBe("metered");
      expect(included?.payload.costUsd).toBeNull();
      expect(included?.payload.charge).toBeNull();
      expect(included?.occurredAtPrecision).toBe("exact");
      expect(billed?.payload.costLedger).toBe("charge");
      expect(billed?.payload.charge).toBe(0.42);
      expect(billed?.payload.maxMode).toBe("Yes");
      expect(errored?.payload.rawCategory).toBe("Errored, Not Charged");
      expect(errored?.payload.costLedger).toBe("not-charged");
      expect(errored?.payload.charge).toBeNull();
      expect(dupA?.payload.tokens).toMatchObject({ input: 1000 });
      expect(dupA?.eventId).not.toBe(dupB?.eventId);

      for (const event of batch.events) {
        expect(event.context.branch).toBeNull();
        expect(event.payload.attribution).toBe("unassigned");
        expect(event.payload.requestKey).toBeNull();
        expect(event.payload.sourceKind).toBe("usage-csv");
        expect(event.payload.batchId).toBe(batch.coverage.watermark);
        expect(event.kind).toBe("ai.usage");
        expect(event.origin).toBe("fixture");
      }

      expect(batch.coverage.state).toBe("partial");
      expect(batch.coverage.expectedItems).toBe(8);
      expect(batch.coverage.observedItems).toBe(5);
      expect(batch.coverage.windowFrom).toBe("2026-09-29T10:00:01.000Z");

      const rejected = batch.coverage.gaps.find(
        (gap) => gap.code === "rejected-rows"
      );

      expect(rejected?.message).toContain("7:unparseable-date");
      expect(rejected?.message).toContain("8:column-count-mismatch");
      expect(rejected?.message).toContain("9:non-numeric-token-cell");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("event ids are stable across re-import", () =>
    Effect.gen(function* stableIds() {
      const first = yield* collect(fixture("usage-kind-cache-split.csv"));
      const second = yield* collect(fixture("usage-kind-cache-split.csv"));
      expect(second.events.map((event) => event.eventId)).toEqual(
        first.events.map((event) => event.eventId)
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "imports legacy flat variant with unknown ledger and ambiguous time",
    () =>
      Effect.gen(function* legacyVariant() {
        const batch = yield* collect(fixture("usage-legacy-flat.csv"));
        yield* Schema.decodeEffect(EventBatchSchema)(batch);
        expect(batch.events).toHaveLength(2);
        const [first, second] = batch.events;
        expect(first?.occurredAtPrecision).toBe("day");
        expect(first?.payload.costLedger).toBe("unallocated");
        expect(first?.payload.costUsd).toBe(0.01);
        expect(first?.payload.charge).toBeNull();
        expect(first?.payload.requestUnits).toBe(1);
        expect(second?.payload.costUsd).toBeNull();
        expect(second?.occurredAtPrecision).toBe("unknown");
        expect(batch.coverage.state).toBe("partial");
        expect(
          batch.coverage.gaps.some((gap) => gap.code === "timezone-unspecified")
        ).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("drops user/email columns from team exports", () =>
    Effect.gen(function* teamVariant() {
      const batch = yield* collect(fixture("usage-team-user.csv"));
      expect(batch.events).toHaveLength(1);
      expect(JSON.stringify(batch)).not.toContain("example.invalid");
      expect(batch.events[0]?.payload.charge).toBe(1.5);
      expect(batch.events[0]?.payload.tokens).toEqual({ total: 1234 });
      expect(batch.coverage.state).toBe("complete");
      expect(
        batch.coverage.gaps.some(
          (gap) => gap.code === "identity-columns-dropped"
        )
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("rejects unrecognized layouts and missing selection", () =>
    Effect.gen(function* failures() {
      const unsupported = yield* Effect.flip(
        collect(fixture("usage-unsupported.csv"))
      );

      expect(unsupported._tag).toBe("UnsupportedSource");
      const missing = yield* Effect.flip(collect(null));
      expect(missing._tag).toBe("InvalidInput");
      const absent = yield* Effect.flip(collect(fixture("absent.csv")));
      expect(absent._tag).toBe("SourceUnavailable");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("probe reports layout without content", () =>
    Effect.gen(function* probe() {
      const receipt = yield* probeCursorUsageExport(
        fixture("usage-kind-cache-split.csv")
      );

      expect(receipt.layout).toBe("cursor-usage-csv/kind/cache-split");
      expect(receipt.itemCount).toBe(5);

      const bad = yield* probeCursorUsageExport(
        fixture("usage-unsupported.csv")
      );

      expect(bad.readable).toBe(true);
      expect(bad.layout).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it("descriptor decodes and stays degraded", () => {
    const decoded = Schema.decodeSync(ModuleDescriptorSchema)(
      cursorUsageExportDescriptor
    );

    expect(decoded.readiness).toBe("degraded");
    expect(readCost("$2.00", "On-Demand").ledger).toBe("charge");
  });
});
