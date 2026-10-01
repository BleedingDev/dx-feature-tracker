import { knownTokenTotal } from "../metrics/ai-usage/typed.js";
import type { UsageFact } from "./fact.js";
import type { TimeBucket, ZoneClock } from "./time.js";

export const FILTER_DIMENSIONS = [
  "tool",
  "channel",
  "provider",
  "via",
  "model",
  "effort",
  "repo",
  "branch",
  "worktree",
  "session",
  "parentSession",
  "agent",
  "scope",
  "attribution",
] as const;

export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

export const TIME_DIMENSIONS = ["day", "week", "month"] as const;

export type TimeDimension = (typeof TIME_DIMENSIONS)[number];

export const USAGE_DIMENSIONS = [
  ...FILTER_DIMENSIONS,
  ...TIME_DIMENSIONS,
] as const;

export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export const USAGE_METRICS = [
  "tokens",
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "requests",
  "sessions",
  "estimate",
  "billed",
  "toolFigure",
] as const;

export type UsageMetric = (typeof USAGE_METRICS)[number];

export const DEFAULT_METRICS: readonly UsageMetric[] = [
  "tokens",
  "requests",
  "estimate",
  "billed",
  "toolFigure",
];

export const NONE_VALUE = "(none)";

export const OTHER_KEY = "(other)";

export const UNATTRIBUTED_KEY = "(unattributed)";

export type UsageFilters = Partial<
  Readonly<Record<FilterDimension, readonly string[]>>
>;

export interface UsageQuery {
  readonly bucket: TimeBucket;
  readonly filters: UsageFilters;
  readonly groupBy: UsageDimension | null;
  readonly limit: number;
  readonly metrics: readonly UsageMetric[];
  readonly sinceMs: number | null;
  readonly sortBy: UsageMetric;
  readonly stackBy: UsageDimension | null;
  readonly untilMs: number | null;
}

export type MetricValues = Readonly<Record<string, number | null>>;

export interface UsageRow {
  readonly facts: number;
  readonly key: string;
  readonly values: MetricValues;
}

export interface OtherRow extends UsageRow {
  readonly groups: number;
}

export interface SeriesPoint {
  readonly bucket: string;
  readonly stacks: readonly UsageRow[];
  readonly values: MetricValues;
}

export interface UsageQueryResult {
  readonly accountBuckets: UsageRow;
  readonly groups: readonly UsageRow[];
  readonly matched: number;
  readonly notes: readonly string[];
  readonly other: OtherRow | null;
  readonly series: readonly SeriesPoint[];
  readonly total: UsageRow;
  readonly unattributed: UsageRow | null;
  readonly unpricedInWindow: number;
  readonly withoutTime: number;
}

export interface PreparedFacts {
  readonly billedUsd: Float64Array;
  readonly estimateUsd: Float64Array;
  readonly facts: readonly UsageFact[];
  readonly foreignMoney: number;
  readonly tokenTotal: Float64Array;
  readonly toolFigureUsd: Float64Array;
}

const usdOf = (
  figure: { readonly amount: number; readonly currency: string } | null
): number =>
  figure !== null && figure.currency.toUpperCase() === "USD"
    ? figure.amount
    : Number.NaN;

const isForeign = (figure: { readonly currency: string } | null): boolean =>
  figure !== null && figure.currency.toUpperCase() !== "USD";

export const prepareFacts = (
  facts: readonly UsageFact[],
  estimate: (fact: UsageFact) => number | null
): PreparedFacts => {
  const size = facts.length;
  const tokenTotal = new Float64Array(size);
  const estimateUsd = new Float64Array(size);
  const billedUsd = new Float64Array(size);
  const toolFigureUsd = new Float64Array(size);
  let foreignMoney = 0;

  for (const [index, fact] of facts.entries()) {
    tokenTotal[index] = knownTokenTotal(fact.tokens) ?? Number.NaN;
    estimateUsd[index] = estimate(fact) ?? Number.NaN;
    billedUsd[index] = usdOf(fact.billed);
    toolFigureUsd[index] = usdOf(fact.toolFigure);
    foreignMoney +=
      isForeign(fact.billed) || isForeign(fact.toolFigure) ? 1 : 0;
  }

  return {
    billedUsd,
    estimateUsd,
    facts,
    foreignMoney,
    tokenTotal,
    toolFigureUsd,
  };
};

const DIMENSION_READERS: Readonly<
  Record<FilterDimension, (fact: UsageFact) => string | null>
> = {
  agent: (fact) => fact.agent,
  attribution: (fact) => fact.attribution,
  branch: (fact) => fact.branch,
  channel: (fact) => fact.channel,
  effort: (fact) => fact.effort,
  model: (fact) => fact.model,
  parentSession: (fact) => fact.parentSession,
  provider: (fact) => fact.provider,
  repo: (fact) => fact.repo,
  scope: (fact) => fact.scope,
  session: (fact) => fact.session,
  tool: (fact) => fact.harness,
  via: (fact) => fact.via,
  worktree: (fact) => fact.worktree,
};

export const dimensionValue = (
  fact: UsageFact,
  dimension: FilterDimension
): string | null => DIMENSION_READERS[dimension](fact);

const SUMMED = [
  "tokens",
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "requests",
  "estimate",
  "billed",
  "toolFigure",
] as const;

type Summed = (typeof SUMMED)[number];

const SUMMED_COUNT = SUMMED.length;

const SLOT: Readonly<Record<Summed, number>> = {
  billed: 8,
  cacheRead: 2,
  cacheWrite: 3,
  estimate: 7,
  input: 1,
  output: 4,
  reasoning: 5,
  requests: 6,
  tokens: 0,
  toolFigure: 9,
};

const round = (value: number): number =>
  Math.round(value * 1_000_000_000) / 1_000_000_000;

class Accumulator {
  facts = 0;
  readonly known = new Uint8Array(SUMMED_COUNT);
  readonly sessions = new Set<string>();
  readonly sums = new Float64Array(SUMMED_COUNT);

  add(slot: number, value: number): void {
    if (!Number.isNaN(value)) {
      this.sums[slot] = (this.sums[slot] ?? 0) + value;
      this.known[slot] = 1;
    }
  }

  merge(other: Accumulator): void {
    this.facts += other.facts;

    for (let slot = 0; slot < SUMMED_COUNT; slot += 1) {
      if (other.known[slot] === 1) {
        this.add(slot, other.sums[slot] ?? 0);
      }
    }

    for (const session of other.sessions) {
      this.sessions.add(session);
    }
  }

  value(metric: UsageMetric): number | null {
    if (metric === "sessions") {
      return this.facts === 0 ? null : this.sessions.size;
    }

    const slot = SLOT[metric];

    return this.known[slot] === 1 ? round(this.sums[slot] ?? 0) : null;
  }
}

const orNaN = (value: number | null): number => value ?? Number.NaN;

const addFact = (
  acc: Accumulator,
  prepared: PreparedFacts,
  index: number
): void => {
  const fact = prepared.facts[index];

  if (fact === undefined) {
    return;
  }

  const { tokens } = fact;
  acc.facts += 1;
  acc.add(SLOT.tokens, prepared.tokenTotal[index] ?? Number.NaN);
  acc.add(SLOT.input, orNaN(tokens.inputFresh));
  acc.add(SLOT.cacheRead, orNaN(tokens.cacheRead));
  acc.add(
    SLOT.cacheWrite,
    tokens.cacheWrite5m === null && tokens.cacheWrite1h === null
      ? orNaN(tokens.cacheWrite)
      : Math.max(
          tokens.cacheWrite ?? 0,
          (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0)
        )
  );
  acc.add(SLOT.output, orNaN(tokens.output));
  acc.add(SLOT.reasoning, orNaN(tokens.reasoning));
  acc.add(SLOT.requests, fact.requests);
  acc.add(SLOT.estimate, prepared.estimateUsd[index] ?? Number.NaN);
  acc.add(SLOT.billed, prepared.billedUsd[index] ?? Number.NaN);
  acc.add(SLOT.toolFigure, prepared.toolFigureUsd[index] ?? Number.NaN);

  if (fact.session !== null) {
    acc.sessions.add(fact.session);
  }
};

const valuesOf = (
  acc: Accumulator,
  metrics: readonly UsageMetric[]
): MetricValues =>
  Object.fromEntries(metrics.map((metric) => [metric, acc.value(metric)]));

const rowOf = (
  key: string,
  acc: Accumulator,
  metrics: readonly UsageMetric[]
): UsageRow => ({ facts: acc.facts, key, values: valuesOf(acc, metrics) });

const isTimeDimension = (
  dimension: UsageDimension
): dimension is TimeDimension =>
  dimension === "day" || dimension === "week" || dimension === "month";

const keyOf = (
  fact: UsageFact,
  dimension: UsageDimension,
  clock: ZoneClock
): string | null => {
  if (isTimeDimension(dimension)) {
    return fact.occurredMs === null
      ? null
      : clock.bucketOf(fact.occurredMs, dimension);
  }

  return dimensionValue(fact, dimension);
};

const filterSets = (filters: UsageFilters) =>
  FILTER_DIMENSIONS.flatMap((dimension) => {
    const wanted = filters[dimension];

    return wanted === undefined || wanted.length === 0
      ? []
      : [[dimension, new Set(wanted)] as const];
  });

const sortValue = (acc: Accumulator, metric: UsageMetric): number =>
  acc.value(metric) ?? Number.NEGATIVE_INFINITY;

const ranked = (
  entries: readonly (readonly [string, Accumulator])[],
  metric: UsageMetric,
  chronological: boolean
) =>
  entries.toSorted(([keyA, a], [keyB, b]) =>
    chronological
      ? keyA.localeCompare(keyB)
      : sortValue(b, metric) - sortValue(a, metric) || keyA.localeCompare(keyB)
  );

interface Grouped {
  readonly other: OtherRow | null;
  readonly rows: readonly UsageRow[];
  readonly top: ReadonlySet<string>;
}

const limitGroups = (
  groups: ReadonlyMap<string, Accumulator>,
  query: UsageQuery,
  chronological: boolean
): Grouped => {
  const order = ranked([...groups], query.sortBy, chronological);
  const keep = chronological ? order : order.slice(0, query.limit);
  const rest = chronological ? [] : order.slice(query.limit);
  const other = new Accumulator();

  for (const [, acc] of rest) {
    other.merge(acc);
  }

  return {
    other:
      rest.length === 0
        ? null
        : { ...rowOf(OTHER_KEY, other, query.metrics), groups: rest.length },
    rows: keep.map(([key, acc]) => rowOf(key, acc, query.metrics)),
    top: new Set(keep.map(([key]) => key)),
  };
};

interface SeriesBuilder {
  readonly add: (index: number, fact: UsageFact) => void;
  readonly build: () => readonly SeriesPoint[];
}

const seriesBuilder = (
  prepared: PreparedFacts,
  query: UsageQuery,
  clock: ZoneClock
): SeriesBuilder => {
  const buckets = new Map<string, Accumulator>();
  const stacks = new Map<string, Map<string, Accumulator>>();
  const stackTotals = new Map<string, Accumulator>();
  const { stackBy } = query;

  return {
    add: (index, fact) => {
      if (fact.occurredMs === null) {
        return;
      }

      const bucket = clock.bucketOf(fact.occurredMs, query.bucket);
      const total = buckets.get(bucket) ?? new Accumulator();
      addFact(total, prepared, index);
      buckets.set(bucket, total);

      if (stackBy === null) {
        return;
      }

      const stack = keyOf(fact, stackBy, clock) ?? UNATTRIBUTED_KEY;
      const perBucket = stacks.get(bucket) ?? new Map<string, Accumulator>();
      const acc = perBucket.get(stack) ?? new Accumulator();
      addFact(acc, prepared, index);
      perBucket.set(stack, acc);
      stacks.set(bucket, perBucket);

      const overall = stackTotals.get(stack) ?? new Accumulator();
      addFact(overall, prepared, index);
      stackTotals.set(stack, overall);
    },
    build: () => {
      const named = new Map(
        [...stackTotals].filter(([key]) => key !== UNATTRIBUTED_KEY)
      );

      const { top } = limitGroups(named, query, false);

      return [...buckets]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([bucket, acc]) => {
          const folded = new Map<string, Accumulator>();

          for (const [key, stackAcc] of stacks.get(bucket) ?? []) {
            const target =
              key === UNATTRIBUTED_KEY || top.has(key) ? key : OTHER_KEY;

            const into = folded.get(target) ?? new Accumulator();
            into.merge(stackAcc);
            folded.set(target, into);
          }

          return {
            bucket,
            stacks: [...folded]
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([key, stackAcc]) => rowOf(key, stackAcc, query.metrics)),
            values: valuesOf(acc, query.metrics),
          };
        });
    },
  };
};

const inWindow = (fact: UsageFact, query: UsageQuery): boolean => {
  if (query.sinceMs === null && query.untilMs === null) {
    return true;
  }

  const at = fact.occurredMs;

  return (
    at !== null &&
    (query.sinceMs === null || at >= query.sinceMs) &&
    (query.untilMs === null || at < query.untilMs)
  );
};

export const queryUsage = (
  prepared: PreparedFacts,
  query: UsageQuery,
  clock: ZoneClock
): UsageQueryResult => {
  const filters = filterSets(query.filters);
  const wantBuckets = query.filters.scope?.includes("account-bucket") ?? false;
  const total = new Accumulator();
  const accountBuckets = new Accumulator();
  const unattributed = new Accumulator();
  const groups = new Map<string, Accumulator>();
  const series = seriesBuilder(prepared, query, clock);
  const { groupBy } = query;
  let withoutTime = 0;
  let unpricedInWindow = 0;
  let matched = 0;

  for (const [index, fact] of prepared.facts.entries()) {
    if (!inWindow(fact, query)) {
      withoutTime += fact.occurredMs === null ? 1 : 0;
      continue;
    }

    let keep = true;

    for (const [dimension, wanted] of filters) {
      if (!wanted.has(dimensionValue(fact, dimension) ?? NONE_VALUE)) {
        keep = false;
        break;
      }
    }

    if (!keep) {
      continue;
    }

    if (fact.scope === "account-bucket" && !wantBuckets) {
      addFact(accountBuckets, prepared, index);
      continue;
    }

    matched += 1;
    addFact(total, prepared, index);
    series.add(index, fact);

    if (Number.isNaN(prepared.estimateUsd[index] ?? Number.NaN)) {
      unpricedInWindow += 1;
    }

    if (groupBy === null) {
      continue;
    }

    const key = keyOf(fact, groupBy, clock);

    if (key === null) {
      addFact(unattributed, prepared, index);
      continue;
    }

    const acc = groups.get(key) ?? new Accumulator();
    addFact(acc, prepared, index);
    groups.set(key, acc);
  }

  const grouped =
    groupBy === null
      ? { other: null, rows: [], top: new Set<string>() }
      : limitGroups(groups, query, isTimeDimension(groupBy));

  return {
    accountBuckets: rowOf("account-bucket", accountBuckets, query.metrics),
    groups: grouped.rows,
    matched,
    notes: [],
    other: grouped.other,
    series: series.build(),
    total: rowOf("total", total, query.metrics),
    unattributed:
      unattributed.facts === 0
        ? null
        : rowOf(UNATTRIBUTED_KEY, unattributed, query.metrics),
    unpricedInWindow,
    withoutTime,
  };
};
