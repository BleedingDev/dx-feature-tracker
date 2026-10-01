import { tokenCategoriesOf } from "../metrics/ai-usage/typed.js";
import type { CostOptions } from "../metrics/cost/metric.js";
import type { PricedRequest } from "../metrics/cost/price-book/estimate.js";
import { priceReading } from "../metrics/cost/price-table.js";
import type { TokenCounts } from "../metrics/cost/readings.js";
import type { UsageFact } from "./fact.js";

export const pricedRequestOf = (fact: UsageFact): PricedRequest => ({
  ai:
    fact.harness === null || fact.channel === null
      ? null
      : {
          agentId: null,
          agentType: fact.agent,
          branchSource: fact.attribution,
          channel: fact.channel,
          cwd: null,
          effort: fact.effort,
          effortSource: null,
          harness: fact.harness,
          harnessVersion: fact.harnessVersion,
          model: fact.model,
          modelRaw: fact.modelRaw,
          parentSessionId: fact.parentSession,
          provider: fact.provider ?? "unknown",
          sessionId: fact.session,
          via: fact.via,
        },
  occurredAt: fact.occurredAt,
  usage: {
    premiumRequests: fact.premiumRequests,
    requestKey: fact.requestKey,
    serviceTier: fact.serviceTier,
    speed: fact.speed,
    tokens: fact.tokens,
    toolFigure: fact.toolFigure,
    webSearchRequests: fact.webSearchRequests,
  },
});

const tokenCountsOf = (fact: UsageFact): TokenCounts =>
  Object.fromEntries(tokenCategoriesOf(fact.tokens));

export type FactEstimator = (fact: UsageFact) => number | null;

export const factEstimator = (options: CostOptions | null): FactEstimator => {
  const book = options?.priceBook ?? null;
  const table = options?.priceTable ?? null;

  if (book !== null) {
    return (fact) => {
      const estimate = book.estimate(pricedRequestOf(fact));

      return estimate.kind === "priced" ? estimate.usd : null;
    };
  }

  if (table !== null) {
    return (fact) => {
      const outcome = priceReading(
        {
          adapterId: fact.harness ?? "unknown",
          branch: fact.branch,
          dedupeKey: fact.factId,
          eventId: fact.factId,
          model: fact.model ?? fact.modelRaw,
          occurredAt: fact.occurredAt,
          requests: fact.requests,
          sourceKind: null,
          tokens: tokenCountsOf(fact),
        },
        table
      );

      return outcome.kind === "priced" ? outcome.usd : null;
    };
  }

  return () => null;
};

export const estimateLabel = (options: CostOptions | null): string => {
  if (options?.priceBook !== null && options?.priceBook !== undefined) {
    return `price book ${options.priceBook.label}`;
  }

  return options?.priceTable === null || options?.priceTable === undefined
    ? "no prices"
    : `price table ${options.priceTable.id}@${options.priceTable.version}`;
};
