import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { cursorDashboardResponseCollector } from "../../src/dx/collectors/cursor-dashboard-response/collector.js";
import { cursorDashboardResponseDescriptor } from "../../src/dx/collectors/cursor-dashboard-response/descriptor.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/b43/${name}`, import.meta.url));

const collect = (selectedInput: string | null) =>
  cursorDashboardResponseCollector.collect({
    adapterId: "cursor-dashboard-response",
    context: { ...emptyFlightContext, branch: "feature/should-not-leak" },
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput,
  });

const gapCodes = (gaps: readonly { readonly code: string }[]) =>
  gaps.map((gap) => gap.code);

describe("cursor-dashboard-response collector (B43)", () => {
  it.effect(
    "imports paged responses with keys, tokens, cost ledger and dedupe",
    () =>
      Effect.gen(function* completePaged() {
        const batch = yield* collect(fixture("dashboard-complete-paged.json"));
        yield* Schema.decodeEffect(EventBatchSchema)(batch);
        expect(batch.events).toHaveLength(3);
        const [included, billed, errored] = batch.events;

        expect(included?.identity.requestId).toBe("req-a");
        expect(included?.identity.sessionId).toBe("conv-1");
        expect(included?.context.branch).toBeNull();
        expect(included?.occurredAt).toBe("2026-09-30T08:40:00.000Z");
        expect(included?.payload.tokens).toEqual({
          "cache-write": 400,
          "cached-input": 9000,
          input: 1200,
          output: 300,
        });
        expect(included?.payload.costLedger).toBe("metered");
        expect(included?.payload.costUsd).toBe(0.0425);
        expect(included?.payload.charge).toBeNull();

        expect(billed?.payload.costLedger).toBe("charge");
        expect(billed?.payload.charge).toBe(0.125);
        expect(billed?.payload.requestUnits).toBe(2);
        expect(billed?.payload.costRawField).toBe("tokenUsage.totalCents");

        expect(errored?.payload.costLedger).toBe("not-charged");
        expect(errored?.payload.charge).toBeNull();
        expect(errored?.payload.tokens).toEqual({});
        expect(errored?.payload.requestKey).toBeNull();

        expect(batch.coverage.state).toBe("complete");
        expect(batch.coverage.expectedItems).toBe(3);
        expect(batch.coverage.observedItems).toBe(3);
        expect(gapCodes(batch.coverage.gaps)).toEqual(
          expect.arrayContaining(["duplicate-rows", "request-key-unavailable"])
        );
        expect(gapCodes(batch.coverage.gaps)).not.toContain(
          "pagination-incomplete"
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("reports missing pages and unzoned timestamps as partial", () =>
    Effect.gen(function* missingPage() {
      const batch = yield* collect(fixture("dashboard-missing-page.json"));
      expect(batch.events).toHaveLength(2);
      expect(batch.coverage.state).toBe("partial");
      expect(batch.coverage.expectedItems).toBe(5);

      const incomplete = batch.coverage.gaps.find(
        (gap) => gap.code === "pagination-incomplete"
      );

      expect(incomplete?.message).toContain("missing page(s) 2");
      expect(gapCodes(batch.coverage.gaps)).toContain("rejected-rows");
      expect(batch.events[1]?.payload.costUsd).toBe(0.07);
      expect(batch.events[1]?.payload.costLedger).toBe("unallocated");
      expect(batch.events[1]?.payload.charge).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("keeps completeness unknown when no total is declared", () =>
    Effect.gen(function* noTotal() {
      const batch = yield* collect(fixture("dashboard-single-no-total.json"));
      expect(batch.events).toHaveLength(1);
      expect(batch.coverage.state).toBe("partial");
      expect(batch.coverage.expectedItems).toBeNull();
      expect(gapCodes(batch.coverage.gaps)).toContain("pagination-unknown");
      expect(batch.events[0]?.payload.costUsd).toBeNull();
      expect(batch.events[0]?.payload.currency).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("refuses HAR captures and credential-bearing files", () =>
    Effect.gen(function* refused() {
      const har = yield* Effect.flip(
        collect(fixture("dashboard-har-refused.json"))
      );

      expect(har._tag).toBe("UnsupportedSource");
      expect(har.message).toContain("har-archive");

      const cookie = yield* Effect.flip(
        collect(fixture("dashboard-cookie-refused.json"))
      );

      expect(cookie._tag).toBe("UnsupportedSource");
      expect(cookie.message).toContain("credential-bearing");
      expect(cookie.message).not.toContain("REDACTED-FIXTURE");

      const missing = yield* Effect.flip(collect(null));
      expect(missing._tag).toBe("InvalidInput");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it("descriptor decodes and stays disabled until a real export is demonstrated", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      cursorDashboardResponseDescriptor
    );

    expect(descriptor.readiness).toBe("disabled");
    expect(gapCodes(descriptor.gaps)).toContain("not-demonstrated");
  });
});
