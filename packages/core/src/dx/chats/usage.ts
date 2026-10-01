import { cacheWritesOf, knownTokenTotal } from "../metrics/ai-usage/typed.js";
import type { ToolFigure } from "../model/attribution.js";
import type { DxEventEnvelope } from "../model/event.js";
import { deriveUsageFacts } from "../usage/derive.js";
import type { FactEstimator } from "../usage/estimate.js";
import type { UsageFact } from "../usage/fact.js";
import { NONE_VALUE, dimensionValue } from "../usage/query.js";
import { CHAT_FILTERS } from "./contract.js";
import type { ChatFilters, ChatUsage } from "./contract.js";

type Slot =
  | "billed"
  | "cacheRead"
  | "cacheWrite"
  | "estimate"
  | "input"
  | "output"
  | "reasoning"
  | "toolFigure"
  | "total";

class UsageSum {
  requests = 0;
  unpriced = 0;
  readonly sums = new Map<Slot, number>();

  add(slot: Slot, value: number | null): void {
    if (value !== null && Number.isFinite(value)) {
      this.sums.set(slot, (this.sums.get(slot) ?? 0) + value);
    }
  }

  merge(other: UsageSum): void {
    this.requests += other.requests;
    this.unpriced += other.unpriced;

    for (const [slot, value] of other.sums) {
      this.add(slot, value);
    }
  }

  value(slot: Slot): number | null {
    const sum = this.sums.get(slot);

    return sum === undefined ? null : Math.round(sum * 1e9) / 1e9;
  }

  toUsage(): ChatUsage {
    return {
      billed: this.value("billed"),
      estimate: this.value("estimate"),
      requests: this.requests,
      tokens: {
        cacheRead: this.value("cacheRead"),
        cacheWrite: this.value("cacheWrite"),
        input: this.value("input"),
        output: this.value("output"),
        reasoning: this.value("reasoning"),
        total: this.value("total"),
      },
      toolFigure: this.value("toolFigure"),
      unpriced: this.unpriced,
    };
  }
}

const usd = (figure: ToolFigure | null): number | null =>
  figure !== null && figure.currency.toUpperCase() === "USD"
    ? figure.amount
    : null;

const activeFilters = (filters: ChatFilters) =>
  CHAT_FILTERS.flatMap((name) => {
    const values = filters[name];

    return values === undefined || values.length === 0
      ? []
      : [[name, new Set(values)] as const];
  });

export const factMatches = (fact: UsageFact, filters: ChatFilters): boolean =>
  activeFilters(filters).every(([name, wanted]) =>
    wanted.has(dimensionValue(fact, name) ?? NONE_VALUE)
  );

export const hasFactFilters = (filters: ChatFilters): boolean =>
  activeFilters(filters).some(([name]) => name !== "tool");

const addFact = (
  into: UsageSum,
  fact: UsageFact,
  estimate: number | null
): void => {
  const { tokens } = fact;

  into.requests += fact.requests;
  into.unpriced += fact.requests > 0 && estimate === null ? 1 : 0;
  into.add("input", tokens.inputFresh);
  into.add("cacheRead", tokens.cacheRead);
  into.add("cacheWrite", cacheWritesOf(tokens));
  into.add("output", tokens.output);
  into.add("reasoning", tokens.reasoning);
  into.add("total", knownTokenTotal(tokens));
  into.add("estimate", estimate);
  into.add("billed", usd(fact.billed));
  into.add("toolFigure", usd(fact.toolFigure));
};

export interface SessionUsage {
  readonly matched: ReadonlySet<string>;
  readonly of: (sessionId: string) => ChatUsage;
  readonly total: (sessionIds: Iterable<string>) => ChatUsage;
}

export const sessionUsage = (
  events: readonly DxEventEnvelope[],
  filters: ChatFilters,
  estimate: FactEstimator
): SessionUsage => {
  const bySession = new Map<string, UsageSum>();

  for (const fact of deriveUsageFacts(events).facts) {
    if (
      fact.scope === "request" &&
      fact.session !== null &&
      factMatches(fact, filters)
    ) {
      const sum = bySession.get(fact.session) ?? new UsageSum();

      addFact(sum, fact, estimate(fact));
      bySession.set(fact.session, sum);
    }
  }

  const empty = new UsageSum();

  return {
    matched: new Set(bySession.keys()),
    of: (sessionId) => (bySession.get(sessionId) ?? empty).toUsage(),
    total: (sessionIds) => {
      const total = new UsageSum();

      for (const id of sessionIds) {
        const sum = bySession.get(id);

        if (sum !== undefined) {
          total.merge(sum);
        }
      }

      return total.toUsage();
    },
  };
};
