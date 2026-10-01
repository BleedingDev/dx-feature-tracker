import { describe, expect, it } from "@effect/vitest";

import { fakeManifest } from "../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import {
  computeCost,
  priceTableEstimateDefinition,
} from "../../src/dx/metrics/cost/metric.js";
import { priceBookOf } from "../../src/dx/metrics/cost/price-book/book.js";
import type { PriceSheet } from "../../src/dx/metrics/cost/price-book/sheet.js";
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

const estimateOf = (events: readonly DxEventEnvelope[]) =>
  computeCost(snapshotOf(events), {
    priceBook: BOOK,
    priceTable: null,
    subscription: null,
  }).results.find(
    (entry) => entry.metricId === priceTableEstimateDefinition.id
  );

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
        model: "deepseek-v4.1-flash",
        provider: "deepseek",
        tokens: { inputFresh: 1_000_000, output: 0 },
      }),
    ]);

    expect(estimate?.value).toBe(2);
    expect(estimate?.measurement).toBe("partial");
    expect([estimate?.numerator, estimate?.denominator]).toEqual([1, 2]);
    expect(estimate?.reason).toContain("model-not-in-table=1");
  });
});
