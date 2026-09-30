import { DateTime, Option } from "effect";

import type { StoreSnapshot } from "../contracts/services.js";
import { timeMs } from "../correlation/flight/registry.js";
import { assignedBranches } from "../metrics/ai-usage/ledger.js";
import {
  computeAiUsage,
  requestsDefinition,
} from "../metrics/ai-usage/metric.js";
import {
  NO_COST_OPTIONS,
  chargeDefinition,
  costByBranch,
  meteredDefinition,
  priceTableEstimateDefinition,
  sourceEstimateDefinition,
} from "../metrics/cost/metric.js";
import type { CostOptions } from "../metrics/cost/metric.js";
import {
  activeDefinition,
  agentDefinition,
  branchAgeDefinition,
  computeFlightTime,
} from "../metrics/flight-time/metric.js";
import { commitsDefinition, computeGitChurn } from "../metrics/git/metric.js";
import { TokenCategorySchema } from "../model/ai.js";
import type { DxEventEnvelope } from "../model/event.js";
import { MetricIdSchema } from "../model/ids.js";
import type { MetricDefinitionRef, MetricResult } from "../model/metric.js";
import type {
  FlightHistoryRow,
  FlightStatusReport,
  HistoryMeasure,
} from "./contract.js";

export type BranchStatusResolver = (
  repoCommonDir: string,
  branch: string
) => FlightStatusReport;

export interface HistoryOptions {
  readonly allRepos: boolean;
  readonly asOf: string;
  readonly costOptions: CostOptions;
  readonly repoCommonDir: string | null;
  readonly resolveStatus: BranchStatusResolver;
  readonly sinceMs: number | null;
}

export interface HistoryResult {
  readonly notes: readonly string[];
  readonly rows: readonly FlightHistoryRow[];
}

export const unknownStatus = (reason: string): FlightStatusReport => ({
  reason,
  value: "unknown",
});

const DURATION = /^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>[dhmw])$/u;

const UNIT_MS = new Map([
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["w", 604_800_000],
]);

export type SinceParse =
  | { readonly ok: true; readonly ms: number }
  | { readonly message: string; readonly ok: false };

export const parseSince = (since: string, nowMs: number): SinceParse => {
  const trimmed = since.trim().toLowerCase();
  const match = DURATION.exec(trimmed);

  if (match !== null) {
    const amount = Number(match.groups?.amount);
    const unit = UNIT_MS.get(match.groups?.unit ?? "");

    return unit === undefined || !Number.isFinite(amount)
      ? { message: `unsupported duration "${since}"`, ok: false }
      : { ms: nowMs - amount * unit, ok: true };
  }

  const ms = timeMs(since.trim());

  return ms === null
    ? {
        message: `"${since}" is neither a duration (7d, 24h, 30m, 2w) nor an ISO timestamp`,
        ok: false,
      }
    : { ms, ok: true };
};

export const isoOf = (ms: number): string | null =>
  Option.match(DateTime.make(ms), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });

const unavailable = (
  def: MetricDefinitionRef,
  reason: string
): HistoryMeasure => ({
  measurement: "unavailable",
  method: "derived",
  metricId: def.id,
  reason,
  unit: def.unit,
  value: null,
});

const measureOf = (
  results: readonly MetricResult[],
  def: MetricDefinitionRef,
  missing: string
): HistoryMeasure => {
  const found = results.find((item) => item.metricId === def.id);

  return found === undefined
    ? unavailable(def, missing)
    : {
        measurement: found.measurement,
        method: found.method,
        metricId: found.metricId,
        reason: found.reason,
        unit: found.unit,
        value: found.value,
      };
};

const TOKEN_CATEGORIES = TokenCategorySchema.literals;

const tokenMeasures = (results: readonly MetricResult[]) =>
  TOKEN_CATEGORIES.map((category) => {
    const id = `dx.ai-usage.tokens.${category}`;
    const found = results.find((item) => item.metricId === id);

    return {
      category,
      measure:
        found === undefined
          ? {
              measurement: "unavailable" as const,
              method: "derived" as const,
              metricId: id,
              reason: "ai-usage metric emitted no result for this category",
              unit: "tokens",
              value: null,
            }
          : {
              measurement: found.measurement,
              method: found.method,
              metricId: found.metricId,
              reason: found.reason,
              unit: found.unit,
              value: found.value,
            },
    };
  });

const isAiEvent = (event: DxEventEnvelope): boolean =>
  event.kind.startsWith("ai.");

const chatsDefinition: MetricDefinitionRef = {
  description:
    "Distinct AI chat sessions (session ids on ai.* events) observed on the branch.",
  id: MetricIdSchema.make("dx.history.chats"),
  unit: "chats",
  version: "1.0.0",
};

const chatsMeasure = (events: readonly DxEventEnvelope[]): HistoryMeasure => {
  const ai = events.filter(isAiEvent);

  if (ai.length === 0) {
    return unavailable(chatsDefinition, "no AI evidence on this branch");
  }

  const sessions = new Set(
    ai.flatMap((event) =>
      event.identity.sessionId === null ? [] : [event.identity.sessionId]
    )
  );

  if (sessions.size === 0) {
    return unavailable(
      chatsDefinition,
      "AI events on this branch carry no session id"
    );
  }

  const unkeyed = ai.filter((event) => event.identity.sessionId === null);

  return {
    measurement: unkeyed.length === 0 ? "measured" : "partial",
    method: "observed",
    metricId: chatsDefinition.id,
    reason:
      unkeyed.length === 0
        ? null
        : `${String(unkeyed.length)} AI event(s) without a session id not counted`,
    unit: chatsDefinition.unit,
    value: sessions.size,
  };
};

const activitySpan = (events: readonly DxEventEnvelope[]) => {
  const times = events.flatMap((event) => {
    const ms = timeMs(event.occurredAt);

    return ms === null ? [] : [ms];
  });

  return times.length === 0
    ? { first: null, last: null }
    : { first: Math.min(...times), last: Math.max(...times) };
};

const latestWorktree = (events: readonly DxEventEnvelope[]): string | null => {
  let best: { readonly at: string; readonly path: string } | null = null;

  for (const event of events) {
    const path = event.context.worktreePath;
    const at = event.occurredAt ?? event.observedAt;

    if (path !== null && (best === null || at > best.at)) {
      best = { at, path };
    }
  }

  return best?.path ?? null;
};

const repoKey = (repo: string | null): string => repo ?? "";

interface FlightGroup {
  readonly branch: string | null;
  readonly events: DxEventEnvelope[];
  readonly repoCommonDir: string | null;
}

const groupByRepo = (events: readonly DxEventEnvelope[]) => {
  const groups = new Map<string, DxEventEnvelope[]>();

  for (const event of events) {
    const key = repoKey(event.context.repoCommonDir);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return groups;
};

const flightsOfRepo = (
  repoCommonDir: string | null,
  events: readonly DxEventEnvelope[]
): FlightGroup[] => {
  const assigned = assignedBranches(events);
  const byBranch = new Map<string | null, DxEventEnvelope[]>();

  for (const event of events) {
    const branch = assigned.has(event.eventId)
      ? (assigned.get(event.eventId) ?? null)
      : event.context.branch;

    byBranch.set(branch, [...(byBranch.get(branch) ?? []), event]);
  }

  return [...byBranch.entries()].map(([branch, members]) => ({
    branch,
    events: members,
    repoCommonDir,
  }));
};

const subSnapshot = (
  base: StoreSnapshot,
  flight: FlightGroup,
  asOf: string
): StoreSnapshot => ({
  coverage: base.coverage,
  events: flight.events,
  manifest: {
    ...base.manifest,
    createdAt: asOf,
    selector: {
      ...base.manifest.selector,
      branch: flight.branch,
      repoCommonDir: flight.repoCommonDir,
    },
  },
});

const statusOf = (
  flight: FlightGroup,
  resolve: BranchStatusResolver
): FlightStatusReport => {
  if (flight.branch === null) {
    return unknownStatus(
      "evidence not attributed to a branch (for example usage exports)"
    );
  }

  if (flight.repoCommonDir === null) {
    return unknownStatus("no repository recorded for this evidence");
  }

  return resolve(flight.repoCommonDir, flight.branch);
};

const buildRow = (
  base: StoreSnapshot,
  flight: FlightGroup,
  cost: readonly MetricResult[] | undefined,
  options: HistoryOptions
): FlightHistoryRow => {
  const snapshot = subSnapshot(base, flight, options.asOf);
  const usage = computeAiUsage(snapshot).results;
  const time = computeFlightTime(snapshot).results;
  const git = computeGitChurn(snapshot).results;
  const money = cost ?? [];
  const span = activitySpan(flight.events);
  const noCost = "cost metric produced no result for this branch";
  const noTime = "branch time metric produced no result for this branch";

  return {
    activeTime: measureOf(time, activeDefinition, noTime),
    agentTime: measureOf(time, agentDefinition, noTime),
    branch: flight.branch,
    branchAge: measureOf(time, branchAgeDefinition, noTime),
    chats: chatsMeasure(flight.events),
    commits: measureOf(
      git,
      commitsDefinition,
      "git metric produced no result for this branch"
    ),
    events: flight.events.length,
    firstActivityAt: span.first === null ? null : isoOf(span.first),
    lastActivityAt: span.last === null ? null : isoOf(span.last),
    money: {
      billed: measureOf(money, chargeDefinition, noCost),
      estimatedPriceTable: measureOf(
        money,
        priceTableEstimateDefinition,
        noCost
      ),
      estimatedSource: measureOf(money, sourceEstimateDefinition, noCost),
      metered: measureOf(money, meteredDefinition, noCost),
    },
    repoCommonDir: flight.repoCommonDir,
    requests: measureOf(
      usage,
      requestsDefinition,
      "ai-usage metric produced no result for this branch"
    ),
    status: statusOf(flight, options.resolveStatus),
    tokens: tokenMeasures(usage),
    worktree: latestWorktree(flight.events),
    worktrees: [
      ...new Set(
        flight.events.flatMap((event) =>
          event.context.worktreePath === null
            ? []
            : [event.context.worktreePath]
        )
      ),
    ].toSorted(),
  };
};

const byRecency = (a: FlightHistoryRow, b: FlightHistoryRow): number =>
  (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") ||
  (a.repoCommonDir ?? "").localeCompare(b.repoCommonDir ?? "") ||
  (a.branch ?? "").localeCompare(b.branch ?? "");

export const computeHistory = (
  snapshot: StoreSnapshot,
  options: HistoryOptions
): HistoryResult => {
  const notes: string[] = [];
  const repos = groupByRepo(snapshot.events);
  const rows: FlightHistoryRow[] = [];

  for (const [key, events] of repos) {
    const repo = key === "" ? null : key;

    if (!options.allRepos && repo !== options.repoCommonDir) {
      continue;
    }

    const repoSnapshot: StoreSnapshot = { ...snapshot, events };

    const cost = new Map(
      costByBranch(repoSnapshot, options.costOptions).map((entry) => [
        entry.branch,
        entry.results,
      ])
    );

    for (const flight of flightsOfRepo(repo, events)) {
      const row = buildRow(snapshot, flight, cost.get(flight.branch), options);
      const last = timeMs(row.lastActivityAt);

      if (
        options.sinceMs !== null &&
        (last === null || last < options.sinceMs)
      ) {
        continue;
      }

      rows.push(row);
    }
  }

  if (!options.allRepos) {
    notes.push(
      "evidence without a repository (for example usage exports) is listed only with allRepos"
    );
  }

  if (options.costOptions.priceTable === null) {
    notes.push(
      "no price table configured: the price-table estimate ledger is unavailable"
    );
  }

  return { notes, rows: rows.toSorted(byRecency) };
};

export const defaultHistoryCostOptions: CostOptions = NO_COST_OPTIONS;
