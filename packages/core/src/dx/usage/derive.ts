// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fact ids are sha256 digests of their member event ids.
import { createHash } from "node:crypto";

import { DateTime, Option, Schema } from "effect";

import type { BranchSource } from "../harness/ids.js";
import { harnessAdapterId } from "../harness/pending.js";
import { inferProvider, normalizeModel, viaFor } from "../harness/provider.js";
import {
  UNKNOWN_SOURCE_RANK,
  harnessChannelRank,
} from "../harness/source-kinds.js";
import {
  billedFigureOf,
  knownTokenTotal,
  toolOwnFigureOf,
} from "../metrics/ai-usage/typed.js";
import {
  AI_TOKEN_FIELDS,
  hasKnownTokens,
  unknownTokens,
} from "../model/attribution.js";
import type { DxEventEnvelope } from "../model/event.js";
import type {
  DerivedRow,
  DerivedRows,
  DerivedUsage,
  UsageDisagreement,
  UsageFact,
  UsageScope,
} from "./fact.js";
import { NO_REPO, USAGE_DERIVATION_VERSION } from "./fact.js";
import { UnionFind } from "./union-find.js";

const BRANCH_SOURCE_ORDER: readonly BranchSource[] = [
  "harness-recorded",
  "hook",
  "git-at-time",
  "session-recorded",
  "tool-calls",
  "cwd-inferred",
  "subagent-split",
  "unassigned",
];

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== "";

const rankOf = (event: DxEventEnvelope): number =>
  event.ai === null
    ? UNKNOWN_SOURCE_RANK
    : harnessChannelRank(event.ai.harness, event.ai.channel);

const channelLabel = (event: DxEventEnvelope): string =>
  event.ai === null
    ? event.adapterId
    : `${event.ai.harness}/${event.ai.channel}`;

const sessionOf = (event: DxEventEnvelope): string | null => {
  const session = event.ai?.sessionId ?? event.identity.sessionId;

  return present(session) ? session : null;
};

const isAccountBucket = (event: DxEventEnvelope): boolean => {
  if (event.payload.scope === "provider-bucket") {
    return true;
  }

  const keyless =
    !present(event.identity.requestId) &&
    !present(event.identity.generationId) &&
    !present(event.usage?.requestKey);

  return (
    keyless &&
    (event.ai === null ||
      (event.ai.channel === "usage-api" && sessionOf(event) === null))
  );
};

const SplitShareSchema = Schema.Struct({ splitOf: Schema.NonEmptyString });

const decodeSplitShare = Schema.decodeUnknownOption(SplitShareSchema);

const isSplitShare = (event: DxEventEnvelope): boolean =>
  Option.isSome(decodeSplitShare(event.payload.repoAttribution));

const SHARE_INDEX = /#split:(?<index>\d+)\/\d+$/u;

const PIECE_INDEX = /:split:(?<index>\d+)$/u;

interface RequestShare {
  readonly lead: boolean;
  readonly splitOf: string;
}

const shareOf = (event: DxEventEnvelope): RequestShare | null => {
  const share = decodeSplitShare(event.payload.repoAttribution);

  if (Option.isSome(share)) {
    return {
      lead: SHARE_INDEX.exec(event.eventId)?.groups?.index === "1",
      splitOf: share.value.splitOf,
    };
  }

  const piece = decodeSplitShare(event.payload);

  return Option.isSome(piece)
    ? {
        lead:
          PIECE_INDEX.exec(event.identity.requestId ?? "")?.groups?.index ===
          "0",
        splitOf: piece.value.splitOf,
      }
    : null;
};

const requestKeys = (event: DxEventEnvelope): string[] => {
  const { generationId, requestId } = event.identity;
  const session = sessionOf(event);
  const requestKey = event.usage?.requestKey ?? null;
  const keys: string[] = [];

  if (present(requestId)) {
    keys.push(`request:${requestId}`);
  }

  if (present(requestKey)) {
    keys.push(`key:${requestKey}`);
  }

  if (session !== null) {
    for (const id of [requestId, generationId]) {
      if (present(id)) {
        keys.push(`session:${session}:id:${id}`);
      }
    }
  }

  return keys;
};

const matchKeys = (event: DxEventEnvelope): string[] =>
  isSplitShare(event)
    ? [`share:${event.usage?.requestKey ?? event.eventId}`]
    : requestKeys(event);

const splitRequestKeys = (events: readonly DxEventEnvelope[]): Set<string> =>
  new Set(events.filter(isSplitShare).flatMap(requestKeys));

const sessionlessIds = (event: DxEventEnvelope): string[] =>
  sessionOf(event) === null && present(event.identity.requestId)
    ? [event.identity.requestId]
    : [];

const sessionKeyIndex = (events: readonly DxEventEnvelope[]) => {
  const byId = new Map<string, Set<string>>();

  for (const event of events) {
    for (const key of matchKeys(event)) {
      const id = /^session:.+:id:(?<id>.+)$/u.exec(key)?.groups?.id;

      if (id !== undefined) {
        byId.set(id, (byId.get(id) ?? new Set<string>()).add(key));
      }
    }
  }

  return byId;
};

interface Grouping {
  readonly groups: readonly DxEventEnvelope[][];
  readonly unkeyed: readonly DxEventEnvelope[];
}

const groupRequests = (events: readonly DxEventEnvelope[]): Grouping => {
  const index = sessionKeyIndex(events);
  const sets = new UnionFind();
  const keyed: DxEventEnvelope[] = [];
  const unkeyed: DxEventEnvelope[] = [];

  for (const event of events) {
    const aliases = sessionlessIds(event).flatMap((id) => [
      ...(index.get(id) ?? []),
    ]);

    const keys = [
      ...matchKeys(event),
      ...(aliases.length === 1 ? aliases : []),
    ];

    if (keys.length === 0) {
      unkeyed.push(event);
      continue;
    }

    const node = `event:${event.eventId}`;
    sets.add(node);
    keyed.push(event);

    for (const key of keys) {
      sets.add(key);
      sets.union(node, key);
    }
  }

  const groups = new Map<string, DxEventEnvelope[]>();

  for (const event of keyed) {
    const root = sets.find(`event:${event.eventId}`);
    const group = groups.get(root);

    if (group === undefined) {
      groups.set(root, [event]);
    } else {
      group.push(event);
    }
  }

  return { groups: [...groups.values()], unkeyed };
};

const byPrecedence = (a: DxEventEnvelope, b: DxEventEnvelope): number =>
  rankOf(a) - rankOf(b) ||
  (knownTokenTotal(b.usage?.tokens ?? unknownTokens) ?? -1) -
    (knownTokenTotal(a.usage?.tokens ?? unknownTokens) ?? -1) ||
  a.eventId.localeCompare(b.eventId);

const first = <A>(
  members: readonly DxEventEnvelope[],
  read: (event: DxEventEnvelope) => A | null | undefined
): A | null => {
  for (const member of members) {
    const value = read(member);

    if (value !== null && value !== undefined) {
      return value;
    }
  }

  return null;
};

const sourceOrder = (event: DxEventEnvelope): number => {
  const source: BranchSource =
    event.ai?.branchSource ??
    (event.context.branch === null ? "unassigned" : "cwd-inferred");

  return BRANCH_SOURCE_ORDER.indexOf(source);
};

const branchMember = (
  members: readonly DxEventEnvelope[]
): DxEventEnvelope | null =>
  members
    .filter((member) => member.context.branch !== null)
    .toSorted((a, b) => sourceOrder(a) - sourceOrder(b))[0] ?? null;

const digestId = (text: string): string =>
  `uf_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;

const factIdOf = (members: readonly DxEventEnvelope[]): string =>
  digestId(
    members
      .map((member) => member.eventId)
      .toSorted()
      .join("\n")
  );

const utcOf = (iso: string | null): { at: string; ms: number } | null => {
  if (iso === null) {
    return null;
  }

  const ms = Date.parse(iso);

  return Number.isNaN(ms)
    ? null
    : { at: DateTime.formatIso(DateTime.makeUnsafe(ms)), ms };
};

const scopeOf = (members: readonly DxEventEnvelope[]): UsageScope =>
  members.every(isAccountBucket) ? "account-bucket" : "request";

type FactPart<K extends keyof UsageFact> = Pick<UsageFact, K>;

const placementOf = (
  members: readonly DxEventEnvelope[]
): FactPart<"attribution" | "branch" | "repo" | "worktree"> => {
  const placed = branchMember(members);

  return {
    attribution:
      placed === null
        ? "unassigned"
        : (placed.ai?.branchSource ?? "cwd-inferred"),
    branch: placed?.context.branch ?? null,
    repo:
      placed?.context.repoCommonDir ??
      first(members, (member) => member.context.repoCommonDir) ??
      NO_REPO,
    worktree:
      placed?.context.worktreePath ??
      first(members, (member) => member.context.worktreePath),
  };
};

const providerOf = (members: readonly DxEventEnvelope[]) =>
  first(members, (member) =>
    member.ai === null || member.ai.provider === "unknown"
      ? null
      : member.ai.provider
  ) ?? (members.some((member) => member.ai !== null) ? "unknown" : null);

const modelOf = (
  members: readonly DxEventEnvelope[]
): FactPart<
  | "agent"
  | "effort"
  | "harness"
  | "harnessVersion"
  | "model"
  | "modelRaw"
  | "parentSession"
  | "provider"
  | "session"
  | "via"
> => ({
  agent: first(members, (member) => member.ai?.agentType ?? member.ai?.agentId),
  effort: first(members, (member) => member.ai?.effort),
  harness: first(members, (member) => member.ai?.harness),
  harnessVersion: first(members, (member) => member.ai?.harnessVersion),
  model: first(members, (member) => member.ai?.model),
  modelRaw: first(members, (member) => member.ai?.modelRaw),
  parentSession: first(members, (member) => member.ai?.parentSessionId),
  provider: providerOf(members),
  session: first(members, sessionOf),
  via: first(members, (member) => member.ai?.via),
});

const usageOf = (
  members: readonly DxEventEnvelope[]
): FactPart<
  | "billed"
  | "channel"
  | "premiumRequests"
  | "requestKey"
  | "serviceTier"
  | "speed"
  | "tokens"
  | "toolFigure"
  | "webSearchRequests"
> => {
  const tokenSource =
    members.find(
      (member) => member.usage !== null && hasKnownTokens(member.usage.tokens)
    ) ?? null;

  return {
    billed: first(members, billedFigureOf),
    channel: tokenSource?.ai?.channel ?? first(members, (m) => m.ai?.channel),
    premiumRequests: first(members, (member) => member.usage?.premiumRequests),
    requestKey: first(
      members,
      (member) => member.usage?.requestKey ?? member.identity.requestId
    ),
    serviceTier: first(members, (member) => member.usage?.serviceTier),
    speed: first(members, (member) => member.usage?.speed),
    tokens: tokenSource?.usage?.tokens ?? unknownTokens,
    toolFigure: first(members, toolOwnFigureOf),
    webSearchRequests: first(
      members,
      (member) => member.usage?.webSearchRequests
    ),
  };
};

export const factOf = (group: readonly DxEventEnvelope[]): UsageFact => {
  const members = group.toSorted(byPrecedence);
  const time = utcOf(first(members, (member) => member.occurredAt));
  const share = first(members, shareOf);

  return {
    ...placementOf(members),
    ...modelOf(members),
    ...usageOf(members),
    channels: [...new Set(members.map(channelLabel))].toSorted(),
    derivationVersion: USAGE_DERIVATION_VERSION,
    factId: factIdOf(members),
    members: members.length,
    occurredAt: time?.at ?? null,
    occurredMs: time?.ms ?? null,
    requests: share === null || share.lead ? 1 : 0,
    scope: scopeOf(members),
    splitOf: share?.splitOf ?? null,
  };
};

const reported = (
  members: readonly DxEventEnvelope[],
  read: (event: DxEventEnvelope) => string | number | null | undefined
) => {
  const byChannel = new Map<string, string>();

  for (const member of members.toSorted(byPrecedence)) {
    const value = read(member);
    const channel = channelLabel(member);

    if (value !== null && value !== undefined && !byChannel.has(channel)) {
      byChannel.set(channel, String(value));
    }
  }

  return [...byChannel].map(([channel, value]) => ({ channel, value }));
};

const FIELD_READERS: readonly (readonly [
  string,
  (event: DxEventEnvelope) => string | number | null | undefined,
])[] = [
  ["model", (event) => event.ai?.model],
  ["effort", (event) => event.ai?.effort],
  ["branch", (event) => event.context.branch],
  ...AI_TOKEN_FIELDS.map(
    (field) =>
      [
        `tokens.${field}`,
        (event: DxEventEnvelope) => event.usage?.tokens[field],
      ] as const
  ),
];

export const disagreementsOf = (
  fact: UsageFact,
  members: readonly DxEventEnvelope[]
): UsageDisagreement[] => {
  if (members.length < 2) {
    return [];
  }

  return FIELD_READERS.flatMap(([field, read]) => {
    const values = reported(members, read);

    return new Set(values.map((entry) => entry.value)).size > 1
      ? [{ factId: fact.factId, field, harness: fact.harness, values }]
      : [];
  });
};

const usageBearing = (event: DxEventEnvelope): boolean =>
  event.kind.startsWith("ai.") &&
  event.kind !== "ai.session" &&
  event.usage !== null;

const harnessSessionKey = (event: DxEventEnvelope): string | null => {
  const session = sessionOf(event);

  return event.ai === null || session === null
    ? null
    : `${event.ai.harness}|${session}`;
};

const figureAmount = (event: DxEventEnvelope): number =>
  event.usage?.toolFigure?.amount ?? Number.NEGATIVE_INFINITY;

const CostModelsSchema = Schema.Struct({
  costState: Schema.Struct({
    models: Schema.Record(
      Schema.String,
      Schema.Struct({ costUsd: Schema.NullOr(Schema.Finite) })
    ),
  }),
});

const decodeCostModels = Schema.decodeUnknownOption(CostModelsSchema);

const FIGURE_TOLERANCE = 1e-6;

const modelCosts = (
  event: DxEventEnvelope
): readonly (readonly [string, number])[] | null =>
  Option.match(decodeCostModels(event.payload), {
    onNone: () => null,
    onSome: (decoded) => {
      const costs = Object.entries(decoded.costState.models).flatMap(
        ([model, usage]) =>
          usage.costUsd === null ? [] : [[model, usage.costUsd] as const]
      );

      return costs.length === 0 ||
        costs.length < Object.keys(decoded.costState.models).length
        ? null
        : costs;
    },
  });

const addsUpTo = (
  costs: readonly (readonly [string, number])[],
  amount: number
): boolean =>
  Math.abs(costs.reduce((total, [, cost]) => total + cost, 0) - amount) <=
  FIGURE_TOLERANCE * Math.max(1, amount);

const byModel = (whole: UsageFact, event: DxEventEnvelope): UsageFact[] => {
  const figure = whole.toolFigure;
  const costs = modelCosts(event);

  if (
    figure === null ||
    whole.model !== null ||
    costs === null ||
    !addsUpTo(costs, figure.amount)
  ) {
    return [whole];
  }

  return costs.map(([raw, cost]) => ({
    ...whole,
    factId: digestId(`${whole.factId}\n${raw}`),
    model: normalizeModel(raw),
    modelRaw: raw,
    provider:
      whole.provider === null || whole.provider === "unknown"
        ? inferProvider(raw)
        : whole.provider,
    toolFigure: { ...figure, amount: cost },
    via: whole.via ?? viaFor(raw, null),
  }));
};

const readingOf = (event: DxEventEnvelope): string =>
  Option.match(decodeSplitShare(event.payload.repoAttribution), {
    onNone: () => event.eventId,
    onSome: (share) => share.splitOf,
  });

const readingAmount = (shares: readonly DxEventEnvelope[]): number =>
  shares.reduce((total, share) => total + figureAmount(share), 0);

const sessionFigureFacts = (
  events: readonly DxEventEnvelope[]
): DerivedRow[] => {
  const readings = new Map<string, Map<string, DxEventEnvelope[]>>();

  for (const event of events) {
    const key = harnessSessionKey(event);

    if (
      event.kind !== "ai.session" ||
      event.usage?.toolFigure === null ||
      event.usage?.toolFigure === undefined ||
      key === null
    ) {
      continue;
    }

    const bySession = readings.get(key) ?? new Map<string, DxEventEnvelope[]>();

    const reading = readingOf(event);

    bySession.set(reading, [...(bySession.get(reading) ?? []), event]);
    readings.set(key, bySession);
  }

  const largest = [...readings.values()].flatMap((bySession) => {
    const ranked = [...bySession.values()].toSorted(
      (a, b) => readingAmount(b) - readingAmount(a)
    );

    return ranked[0] ?? [];
  });

  return largest.flatMap((event) => {
    const whole: UsageFact = {
      ...factOf([event]),
      requests: 0,
      tokens: unknownTokens,
    };

    return byModel(whole, event).map((fact) => ({
      fact,
      sources: [event.eventId],
    }));
  });
};

const decodeKey = Schema.decodeUnknownOption(Schema.NonEmptyString);

const replacedKeyOf = (event: DxEventEnvelope): Option.Option<string> =>
  decodeKey(event.payload.replacesRequestKey);

const replacedKeys = (events: readonly DxEventEnvelope[]): Set<string> =>
  new Set(events.flatMap((event) => Option.toArray(replacedKeyOf(event))));

const isSuperseded = (
  event: DxEventEnvelope,
  replaced: ReadonlySet<string>
): boolean => {
  const key = event.usage?.requestKey ?? null;

  return (
    key !== null &&
    replaced.has(key) &&
    !Option.contains(replacedKeyOf(event), key)
  );
};

interface Readings {
  readonly adapters: Set<string>;
  readonly channels: Set<string>;
}

const keyedReadings = (
  groups: readonly (readonly DxEventEnvelope[])[]
): ReadonlyMap<string, Readings> => {
  const readings = new Map<string, Readings>();

  for (const member of groups.flat()) {
    const key = harnessSessionKey(member);

    if (key !== null && member.ai !== null) {
      const seen = readings.get(key) ?? {
        adapters: new Set<string>(),
        channels: new Set<string>(),
      };

      seen.adapters.add(member.adapterId);
      seen.channels.add(member.ai.channel);
      readings.set(key, seen);
    }
  }

  return readings;
};

const overlapsKeyed = (
  event: DxEventEnvelope,
  readings: ReadonlyMap<string, Readings>
): boolean => {
  const key = harnessSessionKey(event);
  const seen = key === null ? undefined : readings.get(key);

  if (event.ai === null || seen === undefined || isAccountBucket(event)) {
    return false;
  }

  const { channel, harness } = event.ai;
  const harnessReading = harnessAdapterId(harness);

  return (
    [...seen.channels].some((other) => other !== channel) ||
    (event.adapterId !== harnessReading && seen.adapters.has(harnessReading))
  );
};

const factSessionKey = (fact: UsageFact): string | null =>
  fact.harness === null || fact.session === null
    ? null
    : `${fact.harness}|${fact.session}`;

const sessionLedger = (
  sessionRows: readonly DerivedRow[]
): ((fact: UsageFact) => UsageFact) => {
  const ledgered = new Set(
    sessionRows.flatMap((row) => {
      const key = factSessionKey(row.fact);

      return key === null ? [] : [key];
    })
  );

  return (fact) => {
    const key = factSessionKey(fact);

    return fact.toolFigure !== null && key !== null && ledgered.has(key)
      ? { ...fact, toolFigure: null }
      : fact;
  };
};

export const deriveUsageRows = (
  events: readonly DxEventEnvelope[]
): DerivedRows => {
  const replaced = replacedKeys(events);

  const bearing = [
    ...new Map(
      events.flatMap((event) =>
        usageBearing(event) && !isSuperseded(event, replaced)
          ? [[event.eventId, event] as const]
          : []
      )
    ).values(),
  ];

  const split = splitRequestKeys(bearing);

  const unique = bearing.filter(
    (event) =>
      isSplitShare(event) || !requestKeys(event).some((key) => split.has(key))
  );

  const { groups, unkeyed } = groupRequests(unique);
  const readings = keyedReadings(groups);
  const sessionRows = sessionFigureFacts(events);
  const onSessionLedger = sessionLedger(sessionRows);
  const rows: DerivedRow[] = [];
  const disagreements: UsageDisagreement[] = [];
  const unresolved: string[] = [];

  for (const group of groups) {
    const fact = onSessionLedger(factOf(group));
    rows.push({ fact, sources: group.map((member) => member.eventId) });
    disagreements.push(...disagreementsOf(fact, group));
  }

  rows.push(...sessionRows);

  for (const event of unkeyed) {
    if (overlapsKeyed(event, readings)) {
      unresolved.push(event.eventId);
    } else {
      rows.push({
        fact: onSessionLedger(factOf([event])),
        sources: [event.eventId],
      });
    }
  }

  return { disagreements, rows, unresolved };
};

export const usageOfRows = (derived: DerivedRows): DerivedUsage => ({
  disagreements: derived.disagreements,
  facts: derived.rows
    .map((row) => row.fact)
    .toSorted(
      (a, b) =>
        (a.occurredMs ?? 0) - (b.occurredMs ?? 0) ||
        a.factId.localeCompare(b.factId)
    ),
  unresolved: derived.unresolved.length,
});

export const deriveUsageFacts = (
  events: readonly DxEventEnvelope[]
): DerivedUsage => usageOfRows(deriveUsageRows(events));
