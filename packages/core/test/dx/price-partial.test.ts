import { describe, expect, it } from "vitest";

import { priceReading } from "../../src/dx/metrics/cost/price-table.js";
import { cursorPriceTable202609 } from "../../src/dx/metrics/cost/price-tables/cursor-2026-09.js";
import type { TokenReading } from "../../src/dx/metrics/cost/readings.js";

const reading = (
  model: string,
  tokens: TokenReading["tokens"]
): TokenReading => ({
  adapterId: "test",
  branch: null,
  dedupeKey: "e",
  eventId: "e",
  model,
  occurredAt: "2026-09-20T00:00:00Z",
  requests: null,
  sourceKind: null,
  tokens,
});

describe("cursor price table", () => {
  it("prices grok-4.7-high-fast at Grok 4.7 Fast rates without expansion", () => {
    expect(
      priceReading(
        reading("grok-4.7-high-fast", { input: 1_000_000, output: 1_000_000 }),
        cursorPriceTable202609
      )
    ).toStrictEqual({ kind: "priced", unpricedCategories: [], usd: 16 });
  });

  it("prices the categories with rates and reports the rest", () => {
    expect(
      priceReading(
        reading("grok-4.7-fast", {
          "cache-write": 500,
          input: 1_000_000,
        }),
        cursorPriceTable202609
      )
    ).toStrictEqual({
      kind: "priced",
      unpricedCategories: ["cache-write"],
      usd: 4,
    });
  });

  it("keeps Auto unpriced", () => {
    expect(
      priceReading(reading("auto", { input: 10 }), cursorPriceTable202609)
    ).toStrictEqual({ kind: "unpriced", reason: "model-not-in-table" });
  });
});
