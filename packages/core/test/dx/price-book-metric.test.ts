import { describe, expect, it } from "@effect/vitest";

import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import {
  computeCost,
  priceTableEstimateDefinition,
} from "../../src/dx/metrics/cost/metric.js";
import type { CostOptions } from "../../src/dx/metrics/cost/metric.js";
import { priceBookOf } from "../../src/dx/metrics/cost/price-book/book.js";
import type { PriceSheet } from "../../src/dx/metrics/cost/price-book/sheet.js";
import { cachedPriceProvider } from "../../src/dx/metrics/cost/price-catalog/provider.js";
import type {
  AiAttribution,
  AiTokens,
  ToolFigure,
} from "../../src/dx/model/attribution.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { deriveUsageFacts } from "../../src/dx/usage/derive.js";
import { factEstimator } from "../../src/dx/usage/estimate.js";
import { fakeManifest } from "./fakes.js";

const MAKER: PriceSheet = {
  id: "maker",
  models: {
    "claude-sonnet-5": [
      {
        effectiveFrom: null,
        rates: {
          "cache-write": 2.5,
          "cached-input": 0.2,
          input: 2,
          output: 10,
        },
      },
    ],
    "gpt-5.6-luna": [
      {
        effectiveFrom: null,
        rates: { "cached-input": 0.02, input: 0.2, output: 1.2 },
      },
    ],
  },
  source: "synthetic maker prices for tests",
  version: "2026-10-01",
};

const BOOK = priceBookOf([MAKER], "memory");

interface EventSpec {
  readonly figure?: ToolFigure;
  readonly harness: AiAttribution["harness"];
  readonly id: string;
  readonly model: string;
  readonly provider: AiAttribution["provider"];
  readonly tokens: Partial<AiTokens>;
  readonly via?: string;
}

const usageEvent = (spec: EventSpec): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: `harness.${spec.harness}`,
  adapterVersion: "test",
  ai: {
    agentId: null,
    agentType: null,
    branchSource: "harness-recorded",
    channel: "session-file",
    cwd: null,
    effort: null,
    effortSource: null,
    harness: spec.harness,
    harnessVersion: null,
    model: spec.model,
    modelRaw: spec.model,
    parentSessionId: null,
    provider: spec.provider,
    sessionId: "s1",
    via: spec.via ?? null,
  },
  context: { ...emptyFlightContext, branch: "main" },
  eventId: EventIdSchema.make(`event-${spec.id}`),
  evidence: { bounded: true, hash: null, ref: "test" },
  fieldSemantics: [],
  identity: { ...emptyEventIdentity, sessionId: "s1" },
  kind: "ai.usage",
  observedAt: "2026-10-01T10:00:00.000Z",
  occurredAt: "2026-10-01T10:00:00.000Z",
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: spec.id,
  usage: {
    premiumRequests: null,
    requestKey: `request:${spec.id}`,
    serviceTier: null,
    speed: null,
    tokens: { ...unknownTokens, ...spec.tokens },
    toolFigure: spec.figure ?? null,
  },
});

const snapshotOf = (events: readonly DxEventEnvelope[]): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: fakeManifest("price-book-metric", {
    branch: "main",
    flightId: null,
    from: null,
    repoCommonDir: null,
    to: null,
  }),
});

const estimateWith = (
  events: readonly DxEventEnvelope[],
  options: CostOptions
) =>
  computeCost(snapshotOf(events), options).results.find(
    (entry) => entry.metricId === priceTableEstimateDefinition.id
  );

const estimateOf = (events: readonly DxEventEnvelope[]) =>
  estimateWith(events, {
    priceBook: BOOK,
    priceTable: null,
    subscription: null,
  });

const offlineProvider = cachedPriceProvider("/nonexistent/dft-home");

const SHIPPED: CostOptions = {
  priceBook: offlineProvider.book,
  priceTable: offlineProvider.table,
  subscription: null,
};

const cursorEvent = (id: string, model: string) =>
  usageEvent({
    harness: "cursor",
    id,
    model,
    provider: "cursor",
    tokens: { inputFresh: 1_000_000, output: 1_000_000 },
  });

describe("cost metric over the PriceBook", () => {
  it("gives every tool's v2 usage one maker-price estimate", () => {
    const estimate = estimateOf([
      usageEvent({
        harness: "claude-code",
        id: "claude",
        model: "claude-sonnet-5",
        provider: "anthropic",
        tokens: { cacheRead: 1_000_000, inputFresh: 1_000_000, output: 0 },
      }),
      usageEvent({
        figure: { amount: 9, currency: "USD", kind: "api-equivalent" },
        harness: "pi",
        id: "pi",
        model: "cliproxy/gpt-5.6-luna",
        provider: "openai",
        tokens: { inputFresh: 1_000_000, output: 1_000_000 },
        via: "cliproxy",
      }),
    ]);

    expect(estimate?.value).toBe(3.6);
    expect(estimate?.measurement).toBe("estimated");
    expect(estimate?.reason).toContain(
      "method=price-book:maker@2026-10-01; estimate"
    );
  });

  it("counts an unknown model as unpriced instead of guessing", () => {
    const estimate = estimateOf([
      usageEvent({
        harness: "claude-code",
        id: "known",
        model: "claude-sonnet-5",
        provider: "anthropic",
        tokens: { inputFresh: 1_000_000, output: 0 },
      }),
      usageEvent({
        harness: "deepseek",
        id: "unknown",
        model: "deepseek-v9-preview",
        provider: "deepseek",
        tokens: { inputFresh: 1_000_000, output: 0 },
      }),
    ]);

    expect(estimate?.value).toBe(2);
    expect(estimate?.measurement).toBe("partial");
    expect([estimate?.numerator, estimate?.denominator]).toEqual([1, 2]);
    expect(estimate?.reason).toContain("model-not-in-table=1");
  });

  it("prices Cursor's own models from the Cursor table when the book has none", () => {
    const events = [
      cursorEvent("composer", "composer-2.5"),
      cursorEvent("muse", "muse-spark-1.3"),
    ];

    const estimate = estimateWith(events, SHIPPED);
    const estimator = factEstimator(SHIPPED);

    expect(estimate?.value).toBe(8.5);
    expect(estimate?.measurement).toBe("estimated");
    expect(estimate?.reason).toContain("price-table:cursor@2026-09");
    expect(
      Object.fromEntries(
        deriveUsageFacts(events).facts.map((fact) => [
          fact.model,
          estimator(fact),
        ])
      )
    ).toEqual({ "composer-2.5": 3, "muse-spark-1.3": 5.5 });
  });
});
