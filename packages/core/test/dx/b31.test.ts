// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B31 fixture file from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { fakeManifest } from "../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import {
  chargeDefinition,
  computeCost,
  costByBranch,
  costDescriptor,
  costMetric,
  makeCostMetric,
  meteredDefinition,
  priceTableEstimateDefinition,
  sourceEstimateDefinition,
  subscriptionAllocationDefinition,
  unallocatedDefinition,
} from "../../src/dx/metrics/cost/metric.js";
import type { CostOptions } from "../../src/dx/metrics/cost/metric.js";
import {
  decodePriceTable,
  priceReading,
} from "../../src/dx/metrics/cost/price-table.js";
import { extractReadings } from "../../src/dx/metrics/cost/readings.js";
import type { TokenReading } from "../../src/dx/metrics/cost/readings.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
  EventKindSchema,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import type {
  MetricDefinitionRef,
  MetricResult,
} from "../../src/dx/model/metric.js";
import {
  isHonestMetric,
  MetricResultSchema,
} from "../../src/dx/model/metric.js";

const FixtureEventSchema = Schema.Struct({
  adapterId: Schema.String,
  branch: Schema.NullOr(Schema.String),
  id: Schema.String,
  kind: EventKindSchema,
  occurredAt: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});

const FixtureFileSchema = Schema.Struct({
  events: Schema.Struct({
    fixtureId: Schema.String,
    items: Schema.Array(FixtureEventSchema),
  }),
  origin: Schema.Literal("fixture"),
  priceTable: Schema.Struct({
    fixtureId: Schema.String,
    table: Schema.Unknown,
  }),
  subscription: Schema.Struct({
    fixtureId: Schema.String,
    plan: Schema.Struct({
      amountUsd: Schema.Finite,
      basis: Schema.Literals(["requests", "tokens"]),
      periodFrom: Schema.String,
      periodTo: Schema.String,
      periodUsageTotal: Schema.NullOr(Schema.Finite),
      planId: Schema.String,
    }),
  }),
});

const fixture = Schema.decodeUnknownSync(FixtureFileSchema)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures/b31/b31-scenarios.json"),
      "utf-8"
    )
  )
);

const priceTable = decodePriceTable(fixture.priceTable.table);

const fullOptions: CostOptions = {
  priceTable,
  subscription: fixture.subscription.plan,
};

const toEnvelope = (item: typeof FixtureEventSchema.Type): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: item.adapterId,
  adapterVersion: "fixture",
  ai: null,
  context: { ...emptyFlightContext, branch: item.branch },
  eventId: EventIdSchema.make(item.id),
  evidence: { bounded: true, hash: null, ref: `fixture:${item.id}` },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind: item.kind,
  observedAt: "2026-09-30T12:00:00Z",
  occurredAt: item.occurredAt,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: item.payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: item.id,
  usage: null,
});

const events: DxEventEnvelope[] = fixture.events.items.map(toEnvelope);

const snapshotOf = (branch: string | null = null): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: fakeManifest("b31", {
    branch,
    flightId: null,
    from: null,
    repoCommonDir: null,
    to: null,
  }),
});

const pick = (
  results: readonly MetricResult[],
  def: MetricDefinitionRef
): MetricResult => {
  const found = results.find((entry) => entry.metricId === def.id);

  if (found === undefined) {
    throw new Error(`missing metric ${def.id}`);
  }

  return found;
};

const decodeResult = Schema.decodeUnknownSync(MetricResultSchema);

describe("B31 cost ledgers", () => {
  it("keeps charge, metered, estimates, allocation and unallocated as separate honest results", () => {
    const { results } = computeCost(snapshotOf(), fullOptions);

    expect(results).toHaveLength(6);

    for (const result of results) {
      expect(decodeResult(result)).toStrictEqual(result);
      expect(isHonestMetric(result)).toBe(true);
    }

    const charge = pick(results, chargeDefinition);

    expect(charge.value).toBe(1.25);
    expect(charge.method).toBe("source-reported");
    expect(charge.measurement).toBe("partial");
    expect(charge.attribution).toBe("unassigned");
    expect(charge.evidenceIds).toStrictEqual(["csv-charge"]);

    const metered = pick(results, meteredDefinition);

    expect(metered.value).toBe(0.3);
    expect(metered.reason).toContain("local-db");

    const sourceEstimate = pick(results, sourceEstimateDefinition);

    expect(sourceEstimate.value).toBe(0.77);
    expect(sourceEstimate.method).toBe("estimated");
    expect(sourceEstimate.measurement).toBe("estimated");

    const tableEstimate = pick(results, priceTableEstimateDefinition);

    expect(tableEstimate.value).toBeCloseTo(0.00475, 8);
    expect(tableEstimate.method).toBe("estimated");
    expect(tableEstimate.reason).toContain(
      "method=price-table:fixture-prices@2026-09-01"
    );

    const allocation = pick(results, subscriptionAllocationDefinition);

    expect(allocation.value).toBe(20);
    expect(allocation.method).toBe("derived");
    expect(allocation.measurement).toBe("estimated");

    const unallocated = pick(results, unallocatedDefinition);

    expect(unallocated.value).toBeNull();
    expect(unallocated.measurement).toBe("unavailable");
  });

  it("reports per-branch money, estimates and allocation without summing overlapping sources", () => {
    const branches = costByBranch(snapshotOf(), fullOptions);

    expect(branches.map((entry) => entry.branch)).toStrictEqual([
      "feat/a",
      "feat/b",
      null,
    ]);

    const resultsFor = (branch: string | null) =>
      branches.find((entry) => entry.branch === branch)?.results ?? [];

    const featA = resultsFor("feat/a");
    const featB = resultsFor("feat/b");
    const unassigned = resultsFor(null);

    expect(pick(featA, chargeDefinition).value).toBeNull();
    expect(pick(featA, meteredDefinition).value).toBeNull();
    expect(pick(featA, meteredDefinition).reason).toContain("local-db");
    expect(pick(unassigned, meteredDefinition).value).toBe(0.3);
    expect(pick(featA, priceTableEstimateDefinition).value).toBeCloseTo(
      0.01255,
      8
    );
    expect(pick(featA, priceTableEstimateDefinition).reason).toContain(
      "local-db"
    );
    expect(pick(featA, subscriptionAllocationDefinition).value).toBeCloseTo(
      13.333333,
      5
    );
    expect(pick(featA, subscriptionAllocationDefinition).denominator).toBe(12);

    const featBCharge = pick(featB, chargeDefinition);

    expect(featBCharge.value).toBeNull();
    expect(featBCharge.reason).toContain("1 money row(s) excluded");
    expect(pick(featB, sourceEstimateDefinition).value).toBe(0.77);

    const featBTable = pick(featB, priceTableEstimateDefinition);

    expect(featBTable.value).toBeNull();
    expect(featBTable.measurement).toBe("unavailable");
    expect(featBTable.reason).toContain("model-not-in-table=1");
    expect(featBTable.numerator).toBe(0);
    expect(featBTable.denominator).toBe(1);

    expect(pick(unassigned, chargeDefinition).value).toBe(1.25);
    expect(
      pick(unassigned, subscriptionAllocationDefinition).value
    ).toBeCloseTo(6.666667, 5);
  });

  it("sums the estimate across tools that share a branch", () => {
    const usageOn = (
      id: string,
      sourceKind: string,
      tokens: Record<string, number>
    ): DxEventEnvelope =>
      toEnvelope({
        adapterId: sourceKind,
        branch: "feat/two-tools",
        id,
        kind: "ai.usage",
        occurredAt: "2026-09-15T00:00:00Z",
        payload: { model: "gpt-5", sourceKind, tokens },
      });

    const twoTools: StoreSnapshot = {
      ...snapshotOf("feat/two-tools"),
      events: [
        usageOn("claude-turn", "claude-jsonl", { input: 1_000_000 }),
        usageOn("codex-turn", "codex-session", { output: 100_000 }),
      ],
    };

    const estimate = pick(
      computeCost(twoTools, fullOptions).results,
      priceTableEstimateDefinition
    );

    expect(estimate.value).toBeCloseTo(2.25, 8);
    expect(estimate.numerator).toBe(2);
    expect(estimate.reason).not.toContain("Alternative overlapping");
  });

  it("collapses duplicate request keys and ignores non-AI events", () => {
    const readings = extractReadings(events);

    expect(readings.collapsedDuplicates).toBe(1);
    expect(readings.money.map((entry) => entry.eventId)).not.toContain(
      "git-noise"
    );
    expect(
      readings.rejections.map((entry) => entry.reason).toSorted()
    ).toStrictEqual(["cost-ledger-not-charged", "non-usd-currency"]);
  });

  it("stays unavailable without a price table or plan, and without whole-period usage on a branch snapshot", () => {
    const defaults = costMetric.compute(snapshotOf()).results;

    expect(pick(defaults, priceTableEstimateDefinition).value).toBeNull();
    expect(pick(defaults, priceTableEstimateDefinition).reason).toContain(
      "No versioned price table"
    );
    expect(pick(defaults, subscriptionAllocationDefinition).value).toBeNull();

    const scoped = makeCostMetric(fullOptions).compute(
      snapshotOf("feat/a")
    ).results;

    expect(pick(scoped, subscriptionAllocationDefinition).value).toBeNull();
    expect(pick(scoped, subscriptionAllocationDefinition).reason).toContain(
      "periodUsageTotal"
    );

    const withTotal = makeCostMetric({
      ...fullOptions,
      subscription: { ...fixture.subscription.plan, periodUsageTotal: 40 },
    }).compute(snapshotOf("feat/a")).results;

    expect(pick(withTotal, subscriptionAllocationDefinition).value).toBe(2);
  });

  it("never prices totals, missing rates or readings before the table takes effect", () => {
    const base: TokenReading = {
      adapterId: "fixture",
      branch: "feat/a",
      dedupeKey: "k",
      eventId: "e",
      model: "gpt-5",
      occurredAt: "2026-09-15T00:00:00Z",
      requests: null,
      sourceKind: "sdk",
      tokens: { input: 1_000_000 },
    };

    expect(priceReading(base, priceTable)).toStrictEqual({
      kind: "priced",
      unpricedCategories: [],
      usd: 1.25,
    });
    expect(
      priceReading({ ...base, occurredAt: "2026-08-01T00:00:00Z" }, priceTable)
    ).toStrictEqual({ kind: "unpriced", reason: "before-effective-date" });
    expect(
      priceReading({ ...base, tokens: { input: 10, reasoning: 5 } }, priceTable)
    ).toStrictEqual({
      kind: "priced",
      unpricedCategories: ["reasoning"],
      usd: 1.25e-5,
    });
    expect(
      priceReading({ ...base, tokens: { reasoning: 5 } }, priceTable)
    ).toStrictEqual({ kind: "unpriced", reason: "missing-rate" });
    expect(
      priceReading({ ...base, tokens: { total: 500 } }, priceTable)
    ).toStrictEqual({ kind: "unpriced", reason: "total-only" });
    expect(priceReading({ ...base, model: null }, priceTable)).toStrictEqual({
      kind: "unpriced",
      reason: "model-unknown",
    });
  });

  it("publishes a degraded descriptor listing every cost metric and fixture", () => {
    expect(
      Schema.decodeSync(ModuleDescriptorSchema)(costDescriptor)
    ).toStrictEqual(costDescriptor);
    expect(costDescriptor.readiness).toBe("degraded");
    expect(costDescriptor.fixtureIds).toStrictEqual([
      fixture.events.fixtureId,
      fixture.priceTable.fixtureId,
      fixture.subscription.fixtureId,
    ]);
    expect(costDescriptor.supportedFields).toHaveLength(6);
  });
});
