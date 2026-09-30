import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../model/event.js";

export const ACCOUNT_DASHBOARD_ADAPTERS: ReadonlySet<string> = new Set([
  "cursor-dashboard-response",
  "cursor-usage-api",
]);

export const ACCOUNT_EXPORT_ADAPTERS: ReadonlySet<string> = new Set([
  "cursor-usage-export",
]);

export interface AccountUsageTotals {
  readonly billedUsd: number;
  readonly billedRows: number;
  readonly requests: number;
  readonly tokens: number;
}

export interface UnlinkedAccountUsage extends AccountUsageTotals {
  readonly conversations: number;
}

export interface AccountUsageWindow {
  readonly from: string | null;
  readonly since: string | null;
  readonly sources: readonly string[];
  readonly to: string | null;
}

export interface AccountUsageSummary {
  readonly linked: AccountUsageTotals;
  readonly unlinked: UnlinkedAccountUsage;
  readonly window: AccountUsageWindow;
}

export interface AccountUsageOptions {
  readonly since: string | null;
}

const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString);

const decodeNumber = Schema.decodeUnknownOption(Schema.Finite);

const TokensSchema = Schema.Record(Schema.String, Schema.Unknown);

const decodeTokens = Schema.decodeUnknownOption(TokensSchema);

const SUMMED_TOKEN_CATEGORIES = [
  "input",
  "output",
  "cached-input",
  "cache-write",
] as const;

const instantOf = (event: DxEventEnvelope): number | null => {
  const ms = Date.parse(event.occurredAt ?? "");

  return Number.isNaN(ms) ? null : ms;
};

const isAccountUsage = (event: DxEventEnvelope): boolean =>
  event.kind === "ai.usage" &&
  (ACCOUNT_DASHBOARD_ADAPTERS.has(event.adapterId) ||
    ACCOUNT_EXPORT_ADAPTERS.has(event.adapterId));

export const isLinkedAccountRow = (event: DxEventEnvelope): boolean =>
  event.context.branch !== null || event.context.repoCommonDir !== null;

export const tokensOfRow = (event: DxEventEnvelope): number => {
  const tokens = Option.getOrNull(decodeTokens(event.payload.tokens));

  if (tokens === null) {
    return 0;
  }

  const total = Option.getOrNull(decodeNumber(tokens.total));

  if (total !== null && total >= 0) {
    return total;
  }

  let sum = 0;

  for (const category of SUMMED_TOKEN_CATEGORIES) {
    const value = Option.getOrNull(decodeNumber(tokens[category]));

    if (value !== null && value >= 0) {
      sum += value;
    }
  }

  return sum;
};

export const billedUsdOfRow = (event: DxEventEnvelope): number | null =>
  Option.getOrNull(decodeNumber(event.payload.charge));

const dedupe = (
  events: readonly DxEventEnvelope[]
): readonly DxEventEnvelope[] => {
  const byId = new Map<string, DxEventEnvelope>();

  for (const event of events) {
    const kept = byId.get(event.eventId);

    if (
      kept === undefined ||
      (!isLinkedAccountRow(kept) && isLinkedAccountRow(event))
    ) {
      byId.set(event.eventId, event);
    }
  }

  return [...byId.values()];
};

const selectRows = (
  events: readonly DxEventEnvelope[],
  sinceMs: number | null
): readonly DxEventEnvelope[] => {
  const inWindow = dedupe(events.filter(isAccountUsage)).filter((event) => {
    const at = instantOf(event);

    return sinceMs === null || (at !== null && at >= sinceMs);
  });

  const dashboard = inWindow.filter((event) =>
    ACCOUNT_DASHBOARD_ADAPTERS.has(event.adapterId)
  );

  const dashboardTimes = dashboard.flatMap((event) => {
    const at = instantOf(event);

    return at === null ? [] : [at];
  });

  const dashboardFrom =
    dashboardTimes.length === 0 ? null : Math.min(...dashboardTimes);

  const exports = inWindow.filter((event) => {
    if (!ACCOUNT_EXPORT_ADAPTERS.has(event.adapterId)) {
      return false;
    }

    const at = instantOf(event);

    return dashboardFrom === null || (at !== null && at < dashboardFrom);
  });

  return [...dashboard, ...exports];
};

const emptyTotals = (): AccountUsageTotals => ({
  billedRows: 0,
  billedUsd: 0,
  requests: 0,
  tokens: 0,
});

const addRow = (
  totals: AccountUsageTotals,
  event: DxEventEnvelope
): AccountUsageTotals => {
  const billed = billedUsdOfRow(event);

  return {
    billedRows: totals.billedRows + (billed === null ? 0 : 1),
    billedUsd: totals.billedUsd + (billed ?? 0),
    requests: totals.requests + 1,
    tokens: totals.tokens + tokensOfRow(event),
  };
};

const roundUsd = (totals: AccountUsageTotals): AccountUsageTotals => ({
  ...totals,
  billedUsd: Math.round(totals.billedUsd * 1_000_000) / 1_000_000,
});

const conversationOf = (event: DxEventEnvelope): string | null =>
  Option.getOrNull(decodeText(event.identity.sessionId)) ??
  Option.getOrNull(decodeText(event.payload.conversationId));

const isoBounds = (rows: readonly DxEventEnvelope[]) => {
  const times = rows
    .flatMap((event) =>
      instantOf(event) === null ? [] : [event.occurredAt ?? ""]
    )
    .toSorted((left, right) => Date.parse(left) - Date.parse(right));

  return { from: times[0] ?? null, to: times.at(-1) ?? null };
};

export const accountUsageSummary = (
  events: readonly DxEventEnvelope[],
  options: AccountUsageOptions
): AccountUsageSummary => {
  const parsedSince = options.since === null ? null : Date.parse(options.since);

  const sinceMs =
    parsedSince === null || Number.isNaN(parsedSince) ? null : parsedSince;

  const rows = selectRows(events, sinceMs);
  let linked = emptyTotals();
  let unlinked = emptyTotals();
  const conversations = new Set<string>();

  for (const event of rows) {
    if (isLinkedAccountRow(event)) {
      linked = addRow(linked, event);
    } else {
      unlinked = addRow(unlinked, event);

      const conversation = conversationOf(event);

      if (conversation !== null) {
        conversations.add(conversation);
      }
    }
  }

  return {
    linked: roundUsd(linked),
    unlinked: { ...roundUsd(unlinked), conversations: conversations.size },
    window: {
      ...isoBounds(rows),
      since: options.since,
      sources: [...new Set(rows.map((event) => event.adapterId))].toSorted(),
    },
  };
};
