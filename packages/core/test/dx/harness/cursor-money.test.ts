// @effect-diagnostics nodeBuiltinImport:off -- This test reads committed C05, B31 and B43 fixture files from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { cursorDashboardResponseCollector } from "../../../src/dx/collectors/cursor-dashboard-response/collector.js";
import { toApiEvent } from "../../../src/dx/collectors/cursor-usage-api/collector.js";
import type { StoreSnapshot } from "../../../src/dx/contracts/services.js";
import { withCollectorBlocks } from "../../../src/dx/harness/collector-blocks.js";
import {
  accountAiUsage,
  accountAiUsageByBranch,
} from "../../../src/dx/metrics/ai-usage/ledger.js";
import type { AiUsageAccount } from "../../../src/dx/metrics/ai-usage/ledger.js";
import {
  billedFigureOf,
  toolOwnFigureOf,
} from "../../../src/dx/metrics/ai-usage/typed.js";
import {
  computeCost,
  costByBranch,
} from "../../../src/dx/metrics/cost/metric.js";
import type { CostOptions } from "../../../src/dx/metrics/cost/metric.js";
import { decodePriceTable } from "../../../src/dx/metrics/cost/price-table.js";
import { extractReadings } from "../../../src/dx/metrics/cost/readings.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import {
  DxEventEnvelopeSchema,
  emptyEventIdentity,
  emptyFlightContext,
  EventKindSchema,
} from "../../../src/dx/model/event.js";
import { EventIdSchema } from "../../../src/dx/model/ids.js";
import type { MetricResult } from "../../../src/dx/model/metric.js";
import { fakeManifest } from "../fakes.js";

const fixturePath = (relative: string) =>
  path.join(import.meta.dirname, "..", "fixtures", relative);

const readText = (relative: string): string =>
  readFileSync(fixturePath(relative), "utf-8");

const c05 = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Array(DxEventEnvelopeSchema))
  )
)(readText("c05/accounting-audit.json"));

const B31Schema = Schema.Struct({
  events: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        adapterId: Schema.String,
        branch: Schema.NullOr(Schema.String),
        id: Schema.String,
        kind: EventKindSchema,
        occurredAt: Schema.String,
        payload: Schema.Record(Schema.String, Schema.Unknown),
      })
    ),
  }),
  priceTable: Schema.Struct({ table: Schema.Unknown }),
  subscription: Schema.Struct({
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

const b31 = Schema.decodeSync(Schema.fromJsonString(B31Schema))(
  readText("b31/b31-scenarios.json")
);

const options: CostOptions = {
  priceTable: decodePriceTable(b31.priceTable.table),
  subscription: b31.subscription.plan,
};

const b31Events: readonly DxEventEnvelope[] = b31.events.items.map((item) =>
  withCollectorBlocks({
    acquisition: "file-import",
    adapterId: item.adapterId,
    adapterVersion: "fixture",
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
  })
);

const autoEvent = (
  template: DxEventEnvelope,
  id: string,
  listPriceUsd: number | null,
  model: string
): DxEventEnvelope =>
  withCollectorBlocks({
    ...template,
    context: { ...template.context, branch: "feature/auto" },
    eventId: EventIdSchema.make(id),
    identity: { ...template.identity, requestId: id },
    payload: {
      costLedger: listPriceUsd === null ? null : "metered",
      costRawField: listPriceUsd === null ? null : "tokenUsage.totalCents",
      costUsd: listPriceUsd,
      currency: listPriceUsd === null ? null : "USD",
      model,
      requestKey: id,
      sourceKind: "dashboard-json",
      tokens: { input: 1_000_000, output: 100_000 },
    },
  });

const legacyStopEvents = (): readonly DxEventEnvelope[] => {
  const template = (c05["c05/stop-db-entire-dashboard"] ?? []).find(
    (event) => event.adapterId === "cursor-hooks"
  );

  if (template === undefined) {
    throw new Error("C05 has no stop hook event");
  }

  const stop = (id: string, rawUsage: Readonly<Record<string, number>>) =>
    withCollectorBlocks({
      ...template,
      eventId: EventIdSchema.make(id),
      identity: { ...template.identity, generationId: id },
      payload: { rawUsage, semanticsVerified: false, sourceKind: "hooks-stop" },
    });

  return [
    stop("stop-full", {
      cache_read_tokens: 600,
      cache_write_tokens: 100,
      input_tokens: 1000,
      model_call_count: 3,
      output_tokens: 50,
    }),
    stop("stop-clamped", {
      cache_read_tokens: 900,
      cache_write_tokens: 200,
      input_tokens: 1000,
      output_tokens: 5,
    }),
    stop("stop-partial", { input_tokens: 70, output_tokens: 7 }),
  ];
};

const round = (value: number | null) =>
  value === null ? null : Math.round(value * 1e9) / 1e9;

const ledgerLines = (account: AiUsageAccount) =>
  account.totals.map(
    (row) =>
      `${row.ledger}/${row.category}/${row.currency ?? "-"}=${round(row.value)}`
  );

const resultLines = (results: readonly MetricResult[]) =>
  results.map(
    (row) => `${row.metricId}=${round(row.value)} ${row.measurement}`
  );

const snapshotOf = (events: readonly DxEventEnvelope[]): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: fakeManifest("cursor-money"),
});

const moneySummary = (events: readonly DxEventEnvelope[]) => {
  const account = accountAiUsage(events);
  const snapshot = snapshotOf(events);

  return {
    byBranch: [...accountAiUsageByBranch(events)].map(
      ([branch, entry]) => `${branch}: ${ledgerLines(entry).join(", ")}`
    ),
    cost: resultLines(computeCost(snapshot, options).results),
    costByBranch: costByBranch(snapshot, options).map(
      (entry) =>
        `${entry.branch ?? "-"}: ${resultLines(entry.results).join(", ")}`
    ),
    listPrices: [...extractReadings(events).listPrices].map(
      ([key, value]) => `${key}=${round(value)}`
    ),
    requests: account.requestCount,
    totals: ledgerLines(account),
    uncovered: account.uncovered.map(
      (entry) => `${entry.sourceKind ?? "-"}:${entry.fields.join(",")}`
    ),
  };
};

describe("Cursor money ledgers stay pinned", () => {
  it("keeps every C05 scenario's ledgers and cost results", () => {
    const summaries = Object.fromEntries(
      Object.entries(c05).map(([id, events]) => [id, moneySummary(events)])
    );

    expect(summaries).toMatchInlineSnapshot(`
      {
        "c05/absent-values": {
          "byBranch": [
            "feature/c05: ",
          ],
          "cost": [
            "dx.cost.charge.usd=null unavailable",
            "dx.cost.metered.usd=null unavailable",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [],
          "listPrices": [],
          "requests": 0,
          "totals": [],
          "uncovered": [],
        },
        "c05/cache-categories": {
          "byBranch": [
            "feature/c05: tokens/cache-write/-=50, tokens/cached-input/-=400, tokens/input/-=100, tokens/output/-=20, tokens/reasoning/-=7",
          ],
          "cost": [
            "dx.cost.charge.usd=null unavailable",
            "dx.cost.metered.usd=null unavailable",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [
            "feature/c05: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
          ],
          "listPrices": [],
          "requests": 1,
          "totals": [
            "tokens/cache-write/-=50",
            "tokens/cached-input/-=400",
            "tokens/input/-=100",
            "tokens/output/-=20",
            "tokens/reasoning/-=7",
          ],
          "uncovered": [],
        },
        "c05/duplicate-import-keyed": {
          "byBranch": [
            "feature/c05: metered/other/USD=0.02, tokens/input/-=10, tokens/output/-=4",
          ],
          "cost": [
            "dx.cost.charge.usd=null unavailable",
            "dx.cost.metered.usd=0.02 measured",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [
            "feature/c05: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=0.02 measured, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
          ],
          "listPrices": [],
          "requests": 1,
          "totals": [
            "metered/other/USD=0.02",
            "tokens/input/-=10",
            "tokens/output/-=4",
          ],
          "uncovered": [],
        },
        "c05/duplicate-import-unkeyed": {
          "byBranch": [
            "feature/c05: tokens/input/-=9, tokens/output/-=3",
          ],
          "cost": [
            "dx.cost.charge.usd=null unavailable",
            "dx.cost.metered.usd=null unavailable",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [
            "feature/c05: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
          ],
          "listPrices": [],
          "requests": 1,
          "totals": [
            "tokens/input/-=9",
            "tokens/output/-=3",
          ],
          "uncovered": [],
        },
        "c05/explicit-zero": {
          "byBranch": [
            "feature/c05: charge/other/USD=0, tokens/input/-=0, tokens/output/-=0",
          ],
          "cost": [
            "dx.cost.charge.usd=0 measured",
            "dx.cost.metered.usd=null unavailable",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [
            "feature/c05: dx.cost.charge.usd=0 measured, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
          ],
          "listPrices": [],
          "requests": 1,
          "totals": [
            "charge/other/USD=0",
            "tokens/input/-=0",
            "tokens/output/-=0",
          ],
          "uncovered": [],
        },
        "c05/keyed-csv-vs-sdk": {
          "byBranch": [
            "feature/c05: charge/other/USD=0.1, tokens/input/-=30, tokens/output/-=8",
          ],
          "cost": [
            "dx.cost.charge.usd=0.1 measured",
            "dx.cost.metered.usd=null unavailable",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [
            "feature/c05: dx.cost.charge.usd=0.1 measured, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
          ],
          "listPrices": [],
          "requests": 1,
          "totals": [
            "charge/other/USD=0.1",
            "tokens/input/-=30",
            "tokens/output/-=8",
          ],
          "uncovered": [],
        },
        "c05/mixed-branches": {
          "byBranch": [
            "(no branch): tokens/input/-=2",
            "feature/a: tokens/input/-=105, tokens/output/-=11",
          ],
          "cost": [
            "dx.cost.charge.usd=null unavailable",
            "dx.cost.metered.usd=null unavailable",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [
            "feature/a: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
            "-: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
          ],
          "listPrices": [],
          "requests": 3,
          "totals": [
            "tokens/input/-=107",
            "tokens/output/-=11",
          ],
          "uncovered": [],
        },
        "c05/stop-db-entire-dashboard": {
          "byBranch": [
            "feature/c05: charge/other/USD=0.3, tokens/input/-=500, tokens/output/-=60",
          ],
          "cost": [
            "dx.cost.charge.usd=0.3 measured",
            "dx.cost.metered.usd=null unavailable",
            "dx.cost.list-price-estimate.source.usd=null unavailable",
            "dx.cost.list-price-estimate.price-table.usd=null unavailable",
            "dx.cost.subscription-allocation.usd=null unavailable",
            "dx.cost.unallocated.usd=null unavailable",
          ],
          "costByBranch": [
            "feature/c05: dx.cost.charge.usd=0.3 measured, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=null unavailable, dx.cost.unallocated.usd=null unavailable",
          ],
          "listPrices": [],
          "requests": 1,
          "totals": [
            "charge/other/USD=0.3",
            "tokens/input/-=500",
            "tokens/output/-=60",
          ],
          "uncovered": [],
        },
      }
    `);
  });

  it("keeps the unverified stop-hook token rule", () => {
    expect(moneySummary(legacyStopEvents())).toMatchInlineSnapshot(`
      {
        "byBranch": [
          "feature/c05: tokens/cache-write/-=300, tokens/cached-input/-=1500, tokens/input/-=300, tokens/output/-=62",
        ],
        "cost": [
          "dx.cost.charge.usd=null unavailable",
          "dx.cost.metered.usd=null unavailable",
          "dx.cost.list-price-estimate.source.usd=null unavailable",
          "dx.cost.list-price-estimate.price-table.usd=null unavailable",
          "dx.cost.subscription-allocation.usd=null unavailable",
          "dx.cost.unallocated.usd=null unavailable",
        ],
        "costByBranch": [],
        "listPrices": [],
        "requests": 3,
        "totals": [
          "tokens/cache-write/-=300",
          "tokens/cached-input/-=1500",
          "tokens/input/-=300",
          "tokens/output/-=62",
        ],
        "uncovered": [
          "hooks-stop:model_call_count",
          "hooks-stop:input_tokens",
        ],
      }
    `);
  });

  it("keeps the B31 charge, metered, estimate and allocation totals", () => {
    expect(moneySummary(b31Events)).toMatchInlineSnapshot(`
      {
        "byBranch": [
          "(no branch): ",
          "feat/a: metered/other/USD=2.5, tokens/cached-input/-=800",
          "feat/b: list-price-estimate/other/USD=0.77, tokens/input/-=100, tokens/output/-=50",
        ],
        "cost": [
          "dx.cost.charge.usd=1.25 partial",
          "dx.cost.metered.usd=0.3 partial",
          "dx.cost.list-price-estimate.source.usd=0.77 estimated",
          "dx.cost.list-price-estimate.price-table.usd=0.00475 partial",
          "dx.cost.subscription-allocation.usd=20 estimated",
          "dx.cost.unallocated.usd=null unavailable",
        ],
        "costByBranch": [
          "feat/a: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=0.01255 estimated, dx.cost.subscription-allocation.usd=13.333333 estimated, dx.cost.unallocated.usd=null unavailable",
          "feat/b: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=0.77 estimated, dx.cost.list-price-estimate.price-table.usd=null unavailable, dx.cost.subscription-allocation.usd=0 estimated, dx.cost.unallocated.usd=null unavailable",
          "-: dx.cost.charge.usd=1.25 partial, dx.cost.metered.usd=0.3 partial, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=0.00475 estimated, dx.cost.subscription-allocation.usd=6.666667 estimated, dx.cost.unallocated.usd=null unavailable",
        ],
        "listPrices": [],
        "requests": 4,
        "totals": [
          "list-price-estimate/other/USD=0.77",
          "metered/other/USD=2.5",
          "tokens/cached-input/-=800",
        ],
        "uncovered": [],
      }
    `);
  });

  it.effect(
    "keeps the dashboard list price for Auto next to table-priced requests",
    () =>
      Effect.gen(function* dashboardAuto() {
        const batch = yield* cursorDashboardResponseCollector.collect({
          adapterId: "cursor-dashboard-response",
          context: { ...emptyFlightContext, branch: "feature/dashboard" },
          cursor: null,
          origin: "fixture",
          scratchDir: null,
          selectedInput: fixturePath("b43/dashboard-complete-paged.json"),
        });

        const [template] = batch.events;

        expect(template).toBeDefined();

        if (template === undefined) {
          return;
        }

        const events = [
          ...batch.events,
          autoEvent(template, "auto-priced", 0.42, "auto"),
          autoEvent(template, "auto-bare", null, "default"),
        ];

        expect(moneySummary(events)).toMatchInlineSnapshot(`
          {
            "byBranch": [
              "(no branch): ",
              "feature/auto: metered/other/USD=0.42, tokens/input/-=2000000, tokens/output/-=200000",
            ],
            "cost": [
              "dx.cost.charge.usd=0.125 partial",
              "dx.cost.metered.usd=0.42 partial",
              "dx.cost.list-price-estimate.source.usd=null unavailable",
              "dx.cost.list-price-estimate.price-table.usd=0.42 partial",
              "dx.cost.subscription-allocation.usd=20 estimated",
              "dx.cost.unallocated.usd=null unavailable",
            ],
            "costByBranch": [
              "feature/auto: dx.cost.charge.usd=null unavailable, dx.cost.metered.usd=0.42 measured, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=0.42 partial, dx.cost.subscription-allocation.usd=0 estimated, dx.cost.unallocated.usd=null unavailable",
              "-: dx.cost.charge.usd=0.125 partial, dx.cost.metered.usd=null unavailable, dx.cost.list-price-estimate.source.usd=null unavailable, dx.cost.list-price-estimate.price-table.usd=0.051125 estimated, dx.cost.subscription-allocation.usd=20 estimated, dx.cost.unallocated.usd=null unavailable",
            ],
            "listPrices": [
              "req-a=0.0425",
              "auto-priced=0.42",
            ],
            "requests": 2,
            "totals": [
              "metered/other/USD=0.42",
              "tokens/input/-=2000000",
              "tokens/output/-=200000",
            ],
            "uncovered": [
              "dashboard-response:",
              "dashboard-response:",
              "dashboard-response:",
            ],
          }
        `);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "bills what Cursor charged and keeps its list price out of billed and the estimate",
    () =>
      Effect.gen(function* chargedAuto() {
        const batch = yield* cursorDashboardResponseCollector.collect({
          adapterId: "cursor-dashboard-response",
          context: { ...emptyFlightContext, branch: "feature/charged" },
          cursor: null,
          origin: "fixture",
          scratchDir: null,
          selectedInput: fixturePath("b43/dashboard-complete-paged.json"),
        });

        const [template] = batch.events;

        expect(template).toBeDefined();

        if (template === undefined) {
          return;
        }

        const listed = withCollectorBlocks({
          ...template,
          eventId: EventIdSchema.make("auto-charged"),
          identity: { ...template.identity, requestId: "auto-charged" },
          payload: {
            charge: 0.08,
            costLedger: "charge",
            costRawField: "tokenUsage.totalCents",
            costUsd: 0.08,
            currency: "USD",
            model: "default",
            requestKey: "auto-charged",
            sourceKind: "dashboard-response",
            tokens: { input: 1000, output: 100 },
          },
        });

        const imported = toApiEvent(
          listed,
          new Map([["request:auto-charged", 4]])
        );

        const { results } = computeCost(snapshotOf([imported]), options);

        expect(imported.usage?.toolFigure).toStrictEqual({
          amount: 0.04,
          currency: "USD",
          kind: "charge",
        });
        expect(resultLines(results)).toContain(
          "dx.cost.charge.usd=0.04 measured"
        );
        expect(resultLines(results)).toContain(
          "dx.cost.list-price-estimate.price-table.usd=null unavailable"
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "keeps the list price of a plan-included request the account import marks as charged nothing",
    () =>
      Effect.gen(function* freeCreditAuto() {
        const batch = yield* cursorDashboardResponseCollector.collect({
          adapterId: "cursor-dashboard-response",
          context: { ...emptyFlightContext, branch: "feature/free" },
          cursor: null,
          origin: "fixture",
          scratchDir: null,
          selectedInput: fixturePath("b43/dashboard-complete-paged.json"),
        });

        const [template] = batch.events;

        expect(template).toBeDefined();

        if (template === undefined) {
          return;
        }

        const metered = withCollectorBlocks({
          ...template,
          eventId: EventIdSchema.make("auto-free-credit"),
          identity: { ...template.identity, requestId: "auto-free-credit" },
          payload: {
            charge: null,
            costLedger: "metered",
            costRawField: "tokenUsage.totalCents",
            costUsd: 0.42,
            currency: "USD",
            model: "grok-bot-default",
            rawCategory: "FREE_CREDIT",
            requestKey: "auto-free-credit",
            sourceKind: "dashboard-response",
            tokens: { input: 1000, output: 100 },
          },
        });

        const imported = toApiEvent(
          metered,
          new Map([["request:auto-free-credit", 0]])
        );

        const { results } = computeCost(snapshotOf([imported]), options);
        const lines = resultLines(results);

        expect(imported.payload.charge).toBe(0);
        expect(imported.usage?.toolFigure).toStrictEqual({
          amount: 0.42,
          currency: "USD",
          kind: "list-price",
        });
        expect(billedFigureOf(imported)).toBeNull();
        expect(toolOwnFigureOf(imported)?.amount).toBe(0.42);
        expect(lines).toContain("dx.cost.metered.usd=0.42 measured");
        expect(lines).toContain(
          "dx.cost.list-price-estimate.price-table.usd=0.42 estimated"
        );
        expect([...extractReadings([imported]).listPrices]).toStrictEqual([
          ["auto-free-credit", 0.42],
        ]);
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
