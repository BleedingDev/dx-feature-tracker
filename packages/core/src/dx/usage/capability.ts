import { implement } from "@rat-stack/capability/define";
import { DateTime, Effect } from "effect";

import { InvalidInput } from "../contracts/error-invalid-input.js";
import type { EventStore } from "../contracts/event-store.js";
import type { StoreFailure } from "../contracts/services.js";
import { isoOf, parseSince } from "../history/compute.js";
import type { CostOptions } from "../metrics/cost/metric.js";
import { contextForRepo } from "../registry/runtime.js";
import type { DxUsageInputType, DxUsageOutputType } from "./contract.js";
import { USAGE_CONTRACT_VERSION, dxUsageContract } from "./contract.js";
import { estimateLabel, factEstimator } from "./estimate.js";
import { NO_REPO, USAGE_DERIVATION_VERSION } from "./fact.js";
import { usageFacts } from "./load.js";
import type { UsageFactsView } from "./load.js";
import {
  DEFAULT_METRICS,
  FILTER_DIMENSIONS,
  prepareFacts,
  queryUsage,
} from "./query.js";
import type {
  UsageFilters,
  UsageMetric,
  UsageQuery,
  UsageQueryResult,
} from "./query.js";
import { isTimeZone, systemTimeZone, zoneClock } from "./time.js";
import type { ZoneClock } from "./time.js";

export interface DxUsageDeps {
  readonly costOptions?: CostOptions;
  readonly resolveRepo?: (value: string) => string | null;
}

const DEFAULT_LIMIT = 10;

const pointOf = (
  field: "since" | "until",
  value: string | undefined,
  nowMs: number,
  clock: ZoneClock
): Effect.Effect<number | null, InvalidInput> => {
  if (value === undefined || value.trim() === "") {
    return Effect.succeed(null);
  }

  const midnight = clock.localMidnight(value.trim());

  if (midnight !== null) {
    return Effect.succeed(midnight);
  }

  const parsed = parseSince(value, nowMs);

  return parsed.ok
    ? Effect.succeed(parsed.ms)
    : Effect.fail(new InvalidInput({ field, message: parsed.message }));
};

const defaultResolveRepo = (value: string): string | null =>
  contextForRepo(value).repoCommonDir;

const repoValues = (
  values: readonly string[] | undefined,
  resolve: (value: string) => string | null
): readonly string[] | undefined =>
  values?.map((value) =>
    value === NO_REPO ? value : (resolve(value) ?? value)
  );

const filtersOf = (
  input: DxUsageInputType,
  resolve: (value: string) => string | null
): UsageFilters => {
  const filters: Partial<
    Record<(typeof FILTER_DIMENSIONS)[number], readonly string[]>
  > = {};

  for (const dimension of FILTER_DIMENSIONS) {
    const values =
      dimension === "repo" ? repoValues(input.repo, resolve) : input[dimension];

    if (values !== undefined && values.length > 0) {
      filters[dimension] = values;
    }
  }

  return filters;
};

const metricsOf = (input: DxUsageInputType) => {
  const metrics = [...new Set(input.metrics ?? DEFAULT_METRICS)];
  const sortBy: UsageMetric = input.sortBy ?? metrics[0] ?? "tokens";

  return {
    metrics: metrics.includes(sortBy) ? metrics : [...metrics, sortBy],
    sortBy,
  };
};

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

const notesOf = (
  result: UsageQueryResult,
  view: UsageFactsView,
  query: UsageQuery,
  costOptions: CostOptions | null,
  foreignMoney: number
): string[] => [
  `Estimate: tokens x the model maker's public price (${estimateLabel(costOptions)}). Billed and the tool's own figure are separate ledgers and are never added to it or to each other.`,
  ...result.notes,
  ...(result.unpricedInWindow > 0
    ? [
        `${plural(result.unpricedInWindow, "request")} have no price; the estimate leaves them out.`,
      ]
    : []),
  ...(result.accountBuckets.facts > 0
    ? [
        `${plural(result.accountBuckets.facts, "account-level usage row")} (usage exports without a request) are not added to requests; filter scope account-bucket to see them.`,
      ]
    : []),
  ...(result.withoutTime > 0
    ? [
        `${plural(result.withoutTime, "request")} without a time fall outside every time window.`,
      ]
    : []),
  ...(view.unresolved > 0
    ? [
        `${plural(view.unresolved, "report")} without a request id overlapped another channel of the same session and were left out.`,
      ]
    : []),
  ...(foreignMoney > 0
    ? [
        `${plural(foreignMoney, "request")} carry money in a currency other than USD; it is not summed.`,
      ]
    : []),
  ...(query.metrics.includes("sessions") && query.groupBy !== null
    ? [
        "A session that spans several groups counts in each of them, but only once in the total.",
      ]
    : []),
];

export const runUsageQuery = (
  input: DxUsageInputType,
  deps: DxUsageDeps = {}
): Effect.Effect<DxUsageOutputType, InvalidInput | StoreFailure, EventStore> =>
  Effect.gen(function* dxUsage() {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const requested = input.tz?.trim() ?? "";
    const tz = requested === "" ? systemTimeZone() : requested;

    if (!isTimeZone(tz)) {
      return yield* new InvalidInput({
        field: "tz",
        message: `${tz} is not an IANA time zone such as Europe/Prague or UTC`,
      });
    }

    const clock = zoneClock(tz);
    const sinceMs = yield* pointOf("since", input.since, nowMs, clock);
    const untilMs = yield* pointOf("until", input.until, nowMs, clock);

    if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) {
      return yield* new InvalidInput({
        field: "until",
        message: "until must be later than since",
      });
    }

    const { metrics, sortBy } = metricsOf(input);
    const costOptions = deps.costOptions ?? null;

    const query: UsageQuery = {
      bucket: input.bucket ?? "day",
      filters: filtersOf(input, deps.resolveRepo ?? defaultResolveRepo),
      groupBy: input.groupBy ?? null,
      limit: input.limit ?? DEFAULT_LIMIT,
      metrics,
      sinceMs,
      sortBy,
      stackBy: input.stackBy ?? "tool",
      untilMs,
    };

    const view = yield* usageFacts;

    const facts = yield* view.select({
      filters: query.filters,
      sinceMs,
      untilMs,
    });

    const prepared = prepareFacts(facts, factEstimator(costOptions));
    const result = queryUsage(prepared, query, clock);

    return {
      asOf: DateTime.formatIso(now),
      bucket: query.bucket,
      contractVersion: USAGE_CONTRACT_VERSION,
      coverage: {
        accountBuckets: result.accountBuckets,
        derivationVersion: USAGE_DERIVATION_VERSION,
        derivedAt: view.builtAt,
        disagreements: view.disagreements,
        facts: view.facts,
        matched: result.matched,
        tools: view.tools,
        unpriced: result.unpricedInWindow,
        unresolved: view.unresolved,
        withoutTime: result.withoutTime,
      },
      groupBy: query.groupBy,
      groups: result.groups,
      limit: query.limit,
      metrics: query.metrics,
      notes: notesOf(result, view, query, costOptions, prepared.foreignMoney),
      other: result.other,
      series: result.series,
      sortBy,
      stackBy: query.stackBy,
      total: result.total,
      unattributed: result.unattributed,
      window: {
        since: sinceMs === null ? null : isoOf(sinceMs),
        tz,
        until: untilMs === null ? null : isoOf(untilMs),
      },
    };
  });

export const makeDxUsageCapability = (deps: DxUsageDeps = {}) =>
  implement(dxUsageContract, (input) => runUsageQuery(input, deps));
