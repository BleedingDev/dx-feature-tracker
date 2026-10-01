// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fact ids are sha256 digests of their member event ids.
import { createHash } from "node:crypto";

import { DateTime } from "effect";

import type { BranchSource } from "../harness/ids.js";
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
  DerivedUsage,
  UsageDisagreement,
  UsageFact,
  UsageScope,
} from "./fact.js";
import { NO_REPO, USAGE_DERIVATION_VERSION } from "./fact.js";

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

const matchKeys = (event: DxEventEnvelope): string[] => {
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

const sessionlessIds = (event: DxEventEnvelope): string[] =>
  sessionOf(event) === null && present(event.identity.requestId)
    ? [event.identity.requestId]
    : [];

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
    }
  }

  find(key: string): string {
    let root = key;

    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) ?? root;
    }

    let node = key;

    while (node !== root) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }

    return root;
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

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
    groups.set(root, [...(groups.get(root) ?? []), event]);
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

const factIdOf = (members: readonly DxEventEnvelope[]): string =>
  `uf_${createHash("sha256")
    .update(
      members
        .map((member) => member.eventId)
        .toSorted()
        .join("\n")
    )
    .digest("hex")
    .slice(0, 24)}`;

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
    requests: 1,
    scope: scopeOf(members),
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
  event.kind.startsWith("ai.") && event.usage !== null;

const harnessSessionKey = (event: DxEventEnvelope): string | null => {
  const session = sessionOf(event);

  return event.ai === null || session === null
    ? null
    : `${event.ai.harness}|${session}`;
};

export const deriveUsageFacts = (
  events: readonly DxEventEnvelope[]
): DerivedUsage => {
  const unique = [
    ...new Map(
      events.flatMap((event) =>
        usageBearing(event) ? [[event.eventId, event] as const] : []
      )
    ).values(),
  ];

  const { groups, unkeyed } = groupRequests(unique);
  const keyedChannels = new Map<string, Set<string>>();

  for (const group of groups) {
    for (const member of group) {
      const key = harnessSessionKey(member);

      if (key !== null && member.ai !== null) {
        keyedChannels.set(
          key,
          (keyedChannels.get(key) ?? new Set<string>()).add(member.ai.channel)
        );
      }
    }
  }

  const facts: UsageFact[] = [];
  const disagreements: UsageDisagreement[] = [];
  let unresolved = 0;

  for (const group of groups) {
    const fact = factOf(group);
    facts.push(fact);
    disagreements.push(...disagreementsOf(fact, group));
  }

  for (const event of unkeyed) {
    const key = harnessSessionKey(event);
    const channels = key === null ? undefined : keyedChannels.get(key);

    const overlaps =
      !isAccountBucket(event) &&
      channels !== undefined &&
      [...channels].some((channel) => channel !== event.ai?.channel);

    if (overlaps) {
      unresolved += 1;
    } else {
      facts.push(factOf([event]));
    }
  }

  return {
    disagreements,
    facts: facts.toSorted(
      (a, b) =>
        (a.occurredMs ?? 0) - (b.occurredMs ?? 0) ||
        a.factId.localeCompare(b.factId)
    ),
    unresolved,
  };
};
