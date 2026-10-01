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

export interface PreparedFacts {
  readonly facts: readonly UsageFact[];
  readonly foreignMoney: number;
  readonly sessionIds: Int32Array;
  readonly values: Float64Array;
}

const usdOf = (
  figure: { readonly amount: number; readonly currency: string } | null
): number =>
  figure !== null && figure.currency.toUpperCase() === "USD"
    ? figure.amount
    : Number.NaN;

const isForeign = (figure: { readonly currency: string } | null): boolean =>
  figure !== null && figure.currency.toUpperCase() !== "USD";

const orNaN = (value: number | null): number => value ?? Number.NaN;

const cacheWriteOf = (fact: UsageFact): number => {
  const { tokens } = fact;

  return tokens.cacheWrite5m === null && tokens.cacheWrite1h === null
    ? orNaN(tokens.cacheWrite)
    : Math.max(
        tokens.cacheWrite ?? 0,
        (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0)
      );
};

const factValues = (
  fact: UsageFact,
  estimate: number | null
): Readonly<Record<Summed, number>> => ({
  billed: usdOf(fact.billed),
  cacheRead: orNaN(fact.tokens.cacheRead),
  cacheWrite: cacheWriteOf(fact),
  estimate: orNaN(estimate),
  input: orNaN(fact.tokens.inputFresh),
  output: orNaN(fact.tokens.output),
  reasoning: orNaN(fact.tokens.reasoning),
  requests: fact.requests,
  tokens: orNaN(knownTokenTotal(fact.tokens)),
  toolFigure: usdOf(fact.toolFigure),
});

export const prepareFacts = (
  facts: readonly UsageFact[],
  estimate: (fact: UsageFact) => number | null
): PreparedFacts => {
  const values = new Float64Array(facts.length * SUMMED_COUNT);
  const sessionIds = new Int32Array(facts.length);
  const sessions = new Map<string, number>();
  let foreignMoney = 0;

  for (const [index, fact] of facts.entries()) {
    const row = factValues(fact, estimate(fact));

    for (const name of SUMMED) {
      values[index * SUMMED_COUNT + SLOT[name]] = row[name];
    }

    const { session } = fact;

    if (session === null) {
      sessionIds[index] = -1;
    } else {
      const known = sessions.get(session);
      const id = known ?? sessions.size;

      sessions.set(session, id);
      sessionIds[index] = id;
    }

    foreignMoney +=
      isForeign(fact.billed) || isForeign(fact.toolFigure) ? 1 : 0;
  }

  return { facts, foreignMoney, sessionIds, values };
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

const round = (value: number): number =>
  Math.round(value * 1_000_000_000) / 1_000_000_000;

class Accumulator {
  facts = 0;
  readonly known = new Uint8Array(SUMMED_COUNT);
  readonly sessions = new Set<number>();
  readonly sums = new Float64Array(SUMMED_COUNT);

  addRow(prepared: PreparedFacts, index: number): void {
    const base = index * SUMMED_COUNT;
    const { values } = prepared;

    this.facts += 1;

    for (let slot = 0; slot < SUMMED_COUNT; slot += 1) {
      const value = values[base + slot] ?? Number.NaN;

      if (!Number.isNaN(value)) {
        this.sums[slot] = (this.sums[slot] ?? 0) + value;
        this.known[slot] = 1;
      }
    }

    const session = prepared.sessionIds[index] ?? -1;

    if (session >= 0) {
      this.sessions.add(session);
    }
  }

  merge(other: Accumulator): void {
    this.facts += other.facts;

    for (let slot = 0; slot < SUMMED_COUNT; slot += 1) {
      if (other.known[slot] === 1) {
        this.sums[slot] = (this.sums[slot] ?? 0) + (other.sums[slot] ?? 0);
        this.known[slot] = 1;
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

const accumulate = (
  into: Map<string, Accumulator>,
  key: string,
  prepared: PreparedFacts,
  index: number
): void => {
  let acc = into.get(key);

  if (acc === undefined) {
    acc = new Accumulator();
    into.set(key, acc);
  }

  acc.addRow(prepared, index);
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

const foldStacks = (
  perBucket: ReadonlyMap<string, Accumulator>,
  top: ReadonlySet<string>
): Map<string, Accumulator> => {
  const folded = new Map<string, Accumulator>();

  for (const [key, acc] of perBucket) {
    const target = key === UNATTRIBUTED_KEY || top.has(key) ? key : OTHER_KEY;
    const into = folded.get(target) ?? new Accumulator();

    into.merge(acc);
    folded.set(target, into);
  }

  return folded;
};

const buildSeries = (
  cells: ReadonlyMap<string, Map<string, Accumulator>>,
  query: UsageQuery
): readonly SeriesPoint[] => {
  const stackTotals = new Map<string, Accumulator>();

  for (const perBucket of cells.values()) {
    for (const [key, acc] of perBucket) {
      if (key !== UNATTRIBUTED_KEY) {
        const total = stackTotals.get(key) ?? new Accumulator();

        total.merge(acc);
        stackTotals.set(key, total);
      }
    }
  }

  const { top } = limitGroups(stackTotals, query, false);

  return [...cells]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([bucket, perBucket]) => {
      const total = new Accumulator();

      for (const acc of perBucket.values()) {
        total.merge(acc);
      }

      return {
        bucket,
        stacks:
          query.stackBy === null
            ? []
            : [...foldStacks(perBucket, top)]
                .toSorted(([a], [b]) => a.localeCompare(b))
                .map(([key, acc]) => rowOf(key, acc, query.metrics)),
        values: valuesOf(total, query.metrics),
      };
    });
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

const matchesFilters = (
  fact: UsageFact,
  filters: ReturnType<typeof filterSets>
): boolean => {
  for (const [dimension, wanted] of filters) {
    if (!wanted.has(dimensionValue(fact, dimension) ?? NONE_VALUE)) {
      return false;
    }
  }

  return true;
};

const STACK_TOTAL = "(all)";

const addToSeries = (
  cells: Map<string, Map<string, Accumulator>>,
  prepared: PreparedFacts,
  index: number,
  query: UsageQuery,
  clock: ZoneClock
): void => {
  const fact = prepared.facts[index];

  if (fact === undefined || fact.occurredMs === null) {
    return;
  }

  const bucket = clock.bucketOf(fact.occurredMs, query.bucket);

  const stack =
    query.stackBy === null
      ? STACK_TOTAL
      : (keyOf(fact, query.stackBy, clock) ?? UNATTRIBUTED_KEY);

  let perBucket = cells.get(bucket);

  if (perBucket === undefined) {
    perBucket = new Map<string, Accumulator>();
    cells.set(bucket, perBucket);
  }

  accumulate(perBucket, stack, prepared, index);
};

const unpriced = (prepared: PreparedFacts, index: number): boolean =>
  (prepared.facts[index]?.requests ?? 0) > 0 &&
  Number.isNaN(
    prepared.values[index * SUMMED_COUNT + SLOT.estimate] ?? Number.NaN
  );

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
  const cells = new Map<string, Map<string, Accumulator>>();
  const { facts } = prepared;
  const { groupBy } = query;
  let withoutTime = 0;
  let unpricedInWindow = 0;
  let matched = 0;

  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];

    if (fact === undefined) {
      continue;
    }

    if (!inWindow(fact, query)) {
      withoutTime += fact.occurredMs === null ? 1 : 0;
      continue;
    }

    if (filters.length > 0 && !matchesFilters(fact, filters)) {
      continue;
    }

    if (fact.scope === "account-bucket" && !wantBuckets) {
      accountBuckets.addRow(prepared, index);
      continue;
    }

    matched += 1;
    total.addRow(prepared, index);

    unpricedInWindow += unpriced(prepared, index) ? 1 : 0;
    addToSeries(cells, prepared, index, query, clock);

    if (groupBy !== null) {
      const key = keyOf(fact, groupBy, clock);

      if (key === null) {
        unattributed.addRow(prepared, index);
      } else {
        accumulate(groups, key, prepared, index);
      }
    }
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
    series: buildSeries(cells, query),
    total: rowOf("total", total, query.metrics),
    unattributed:
      unattributed.facts === 0
        ? null
        : rowOf(UNATTRIBUTED_KEY, unattributed, query.metrics),
    unpricedInWindow,
    withoutTime,
  };
};
