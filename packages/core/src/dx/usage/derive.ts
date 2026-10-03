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
import type { AiAttribution } from "../model/attribution.js";
import type { DxEventEnvelope } from "../model/event.js";
import { EventIdSchema } from "../model/ids.js";
import type {
  AccountAllocation,
  AccountAssociation,
  AccountAssociationCandidate,
  AgentDerivedUsageRows,
  DerivedRow,
  DerivedRows,
  DerivedUsage,
  UsageDisagreement,
  UsageExplanation,
  UsageExplanationValue,
  UsageFact,
  UsageFieldExplanation,
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

const ACCOUNT_PAIRING_WINDOW_MS = 60_000;

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

type ServedModel = Pick<AiAttribution, "provider" | "via">;

type ServedModels = ReadonlyMap<string, ServedModel>;

const sessionParents = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, string> => {
  const parents = new Map<string, string>();

  for (const event of events) {
    const key = harnessSessionKey(event);
    const parent = event.ai?.parentSessionId ?? null;

    if (key !== null && event.ai !== null && present(parent)) {
      const parentKey = `${event.ai.harness}|${parent}`;

      if (parentKey !== key && !parents.has(key)) {
        parents.set(key, parentKey);
      }
    }
  }

  return parents;
};

const lineageOf = (
  key: string,
  parents: ReadonlyMap<string, string>
): readonly string[] => {
  const seen = new Set<string>();
  let current: string | undefined = key;

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current);
  }

  return [...seen];
};

const servedModelsBySession = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, ServedModels> => {
  const parents = sessionParents(events);
  const served = new Map<string, Map<string, ServedModel>>();

  for (const event of events) {
    const key = harnessSessionKey(event);
    const { ai } = event;

    if (key !== null && ai !== null && usageBearing(event)) {
      const names = new Set(
        [ai.model, ai.modelRaw].flatMap((name) => {
          const model = normalizeModel(name);

          return model === null ? [] : [model];
        })
      );

      for (const session of lineageOf(key, parents)) {
        const models = served.get(session) ?? new Map<string, ServedModel>();

        for (const name of names) {
          if (!models.has(name)) {
            models.set(name, { provider: ai.provider, via: ai.via });
          }
        }

        served.set(session, models);
      }
    }
  }

  return served;
};

const byModel = (
  whole: UsageFact,
  event: DxEventEnvelope,
  served: ServedModels | undefined
): UsageFact[] => {
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

  const parts = costs.map(([raw, cost]) => {
    const model = normalizeModel(raw);

    return {
      cost,
      model,
      raw,
      request: model === null ? undefined : served?.get(model),
    };
  });

  if (
    served !== undefined &&
    parts.some((part) => part.request === undefined)
  ) {
    return [whole];
  }

  const providerFor = (
    raw: string,
    request: ServedModel | undefined
  ): UsageFact["provider"] => {
    if (whole.provider !== null && whole.provider !== "unknown") {
      return whole.provider;
    }

    return request === undefined || request.provider === "unknown"
      ? inferProvider(raw)
      : request.provider;
  };

  return parts.map(({ cost, model, raw, request }) => ({
    ...whole,
    factId: digestId(`${whole.factId}\n${raw}`),
    model,
    modelRaw: raw,
    provider: providerFor(raw, request),
    toolFigure: { ...figure, amount: cost },
    via:
      whole.via ??
      (request === undefined ? viaFor(raw, null) : (request.via ?? null)),
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

  const served = servedModelsBySession(events);

  return largest.flatMap((event) => {
    const whole: UsageFact = {
      ...factOf([event]),
      requests: 0,
      tokens: unknownTokens,
    };

    const key = harnessSessionKey(event);

    return byModel(
      whole,
      event,
      key === null ? undefined : served.get(key)
    ).map((fact) => ({
      fact,
      sources: [event.eventId],
    }));
  });
};

const decodeKey = Schema.decodeUnknownOption(Schema.NonEmptyString);

const SplitReadingSchema = Schema.Struct({
  splitGeneration: Schema.optional(Schema.NonEmptyString),
  splitOf: Schema.NonEmptyString,
});

const decodeSplitReading = Schema.decodeUnknownOption(SplitReadingSchema);

const replacedKeyOf = (event: DxEventEnvelope): Option.Option<string> =>
  Option.orElse(decodeKey(event.payload.replacesRequestKey), () =>
    Option.map(decodeSplitReading(event.payload), (piece) => piece.splitOf)
  );

const replacedKeys = (events: readonly DxEventEnvelope[]): Set<string> =>
  new Set(events.flatMap((event) => Option.toArray(replacedKeyOf(event))));

const SHARE_SUFFIX = /#split:\d+\/\d+$/u;

const instantOf = (iso: string): number => {
  const at = Date.parse(iso);

  return Number.isNaN(at) ? 0 : at;
};

const newestSplits = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, string> => {
  const newest = new Map<string, { at: number; generation: string }>();

  for (const event of events) {
    for (const piece of Option.toArray(decodeSplitReading(event.payload))) {
      const generation = piece.splitGeneration;
      const at = instantOf(event.observedAt);
      const best = newest.get(piece.splitOf);

      if (
        generation !== undefined &&
        (best === undefined ||
          at > best.at ||
          (at === best.at && generation > best.generation))
      ) {
        newest.set(piece.splitOf, { at, generation });
      }
    }
  }

  return new Map(
    [...newest].map(([splitOf, { generation }]) => [splitOf, generation])
  );
};

const sourceIdOf = (event: DxEventEnvelope): string =>
  event.eventId.replace(SHARE_SUFFIX, "");

const ownKeyOf = (event: DxEventEnvelope): string | null =>
  event.usage?.requestKey?.replace(SHARE_SUFFIX, "") ?? null;

const rereadOf = (event: DxEventEnvelope): Option.Option<string> =>
  Option.isSome(decodeSplitReading(event.payload))
    ? Option.none()
    : decodeKey(event.payload.replacesRequestKey);

const latestRereads = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, string> => {
  const latest = new Map<string, { at: number; source: string }>();

  for (const event of events) {
    for (const replaced of Option.toArray(rereadOf(event))) {
      const best = latest.get(replaced);
      const at = instantOf(event.observedAt);

      if (best === undefined || at >= best.at) {
        latest.set(replaced, { at, source: sourceIdOf(event) });
      }
    }
  }

  return new Map([...latest].map(([key, { source }]) => [key, source]));
};

interface Replacements {
  readonly latest: ReadonlyMap<string, string>;
  readonly newest: ReadonlyMap<string, string>;
  readonly replaced: ReadonlySet<string>;
}

const replacementsOf = (events: readonly DxEventEnvelope[]): Replacements => ({
  latest: latestRereads(events),
  newest: newestSplits(events),
  replaced: replacedKeys(events),
});

const isStaleReread = (
  event: DxEventEnvelope,
  latest: ReadonlyMap<string, string>
): boolean =>
  Option.match(rereadOf(event), {
    onNone: () => false,
    onSome: (replaced) => {
      const winner = latest.get(replaced);

      return winner !== undefined && winner !== sourceIdOf(event);
    },
  });

const isOlderSplit = (
  event: DxEventEnvelope,
  newest: ReadonlyMap<string, string>
): boolean =>
  Option.match(decodeSplitReading(event.payload), {
    onNone: () => false,
    onSome: (piece) => {
      const winner = newest.get(piece.splitOf);

      return winner !== undefined && piece.splitGeneration !== winner;
    },
  });

const isSuperseded = (
  event: DxEventEnvelope,
  { latest, newest, replaced }: Replacements
): boolean => {
  const key = ownKeyOf(event);

  return (
    (key !== null &&
      replaced.has(key) &&
      !Option.contains(replacedKeyOf(event), key)) ||
    isStaleReread(event, latest) ||
    isOlderSplit(event, newest)
  );
};

export const withoutReplacedRequests = (
  events: readonly DxEventEnvelope[]
): readonly DxEventEnvelope[] => {
  const replacements = replacementsOf(events);

  return replacements.replaced.size === 0
    ? events
    : events.filter((event) => !isSuperseded(event, replacements));
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

const DurationSchema = Schema.Struct({ durationMs: Schema.Finite });

const decodeDuration = Schema.decodeUnknownOption(DurationSchema);

const instantMs = (event: DxEventEnvelope): number | null => {
  const ms = Date.parse(event.occurredAt ?? "");

  return Number.isNaN(ms) ? null : ms;
};

const isUnkeyedAccountRow = (event: DxEventEnvelope): boolean =>
  event.ai?.channel === "usage-api" &&
  sessionOf(event) !== null &&
  !present(event.identity.requestId) &&
  !present(event.identity.generationId) &&
  !isAccountBucket(event) &&
  !isSplitShare(event);

const pairsWithAccountRow = (event: DxEventEnvelope): boolean =>
  event.ai !== null && event.ai.channel !== "usage-api" && !isSplitShare(event);

interface TurnWindow {
  readonly end: number;
  readonly start: number;
}

const turnWindowOf = (group: readonly DxEventEnvelope[]): TurnWindow | null => {
  const spans = group.flatMap((member) => {
    const at = instantMs(member);

    if (at === null) {
      return [];
    }

    const lasted = Option.match(decodeDuration(member.payload), {
      onNone: () => 0,
      onSome: ({ durationMs }) => Math.max(0, durationMs),
    });

    return [{ end: at, start: at - lasted }];
  });

  return spans.length === 0
    ? null
    : {
        end: Math.max(...spans.map((span) => span.end)),
        start: Math.min(...spans.map((span) => span.start)),
      };
};

const gapToWindow = (at: number, window: TurnWindow): number =>
  Math.max(0, window.start - at, at - window.end);

interface AccountPairing {
  readonly account: number;
  readonly distance: number;
  readonly gap: number;
  readonly turn: number;
}

const sessionGroupKey = (group: readonly DxEventEnvelope[]): string | null => {
  const keys = new Set(group.map(harnessSessionKey));

  return keys.size === 1 ? ([...keys][0] ?? null) : null;
};

const accountPairings = (
  groups: readonly (readonly DxEventEnvelope[])[]
): AccountPairing[] => {
  const accounts = groups.flatMap((group, index) => {
    if (!group.every(isUnkeyedAccountRow)) {
      return [];
    }

    const key = sessionGroupKey(group);
    const at = first(group, instantMs);

    return key !== null && at !== null ? [{ at, index, key }] : [];
  });

  if (accounts.length === 0) {
    return [];
  }

  const turnsBySession = new Map<
    string,
    { readonly index: number; readonly window: TurnWindow }[]
  >();

  const sessions = new Set(accounts.map((account) => account.key));

  for (const [index, group] of groups.entries()) {
    const key = sessionGroupKey(group);

    const window =
      key !== null && sessions.has(key) && group.every(pairsWithAccountRow)
        ? turnWindowOf(group)
        : null;

    if (key !== null && window !== null) {
      turnsBySession.set(key, [
        ...(turnsBySession.get(key) ?? []),
        { index, window },
      ]);
    }
  }

  return accounts.flatMap((account) =>
    (turnsBySession.get(account.key) ?? []).flatMap((turn) => {
      const gap = gapToWindow(account.at, turn.window);

      return gap <= ACCOUNT_PAIRING_WINDOW_MS
        ? [
            {
              account: account.index,
              distance: Math.abs(account.at - turn.window.end),
              gap,
              turn: turn.index,
            },
          ]
        : [];
    })
  );
};

interface PairedGroups {
  readonly groups: readonly DxEventEnvelope[][];
  readonly joins: ReadonlyMap<string, string>;
}

const pairAccountRows = (
  groups: readonly DxEventEnvelope[][]
): PairedGroups => {
  const ranked = accountPairings(groups).toSorted(
    (a, b) =>
      a.gap - b.gap ||
      a.distance - b.distance ||
      a.account - b.account ||
      a.turn - b.turn
  );

  const joinedTo = new Map<number, number>();
  const taken = new Set<number>();

  for (const pairing of ranked) {
    if (!joinedTo.has(pairing.account) && !taken.has(pairing.turn)) {
      joinedTo.set(pairing.account, pairing.turn);
      taken.add(pairing.turn);
    }
  }

  const merged = groups.map((group) => [...group]);
  const joins = new Map<string, string>();

  for (const [account, turn] of joinedTo) {
    const members = merged[turn] ?? [];
    members.push(...(groups[account] ?? []));
    const key = `turn:${factIdOf(groups[turn] ?? [])}`;

    for (const member of members) {
      joins.set(member.eventId, key);
    }
  }

  return {
    groups: merged.filter((_, index) => !joinedTo.has(index)),
    joins,
  };
};

interface RequestGrouping extends PairedGroups {
  readonly unkeyed: readonly DxEventEnvelope[];
}

const requestGrouping = (
  events: readonly DxEventEnvelope[],
  pairAccounts = true
): RequestGrouping => {
  const replacements = replacementsOf(events);

  const bearing = [
    ...new Map(
      events.flatMap((event) =>
        usageBearing(event) && !isSuperseded(event, replacements)
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

  if (!pairAccounts) {
    const accounts = unique.filter(
      (event) => isAccountBucket(event) || isUnkeyedAccountRow(event)
    );

    const accountIds = new Set(accounts.map((event) => event.eventId));

    const grouped = groupRequests(
      unique.filter((event) => !accountIds.has(event.eventId))
    );

    const accountGroups = groupRequests(accounts);

    return {
      groups: [
        ...grouped.groups,
        ...accountGroups.groups,
        ...accountGroups.unkeyed.map((event) => [event]),
      ]
        .map((group) => group.toSorted(byPrecedence))
        .toSorted((a, b) => factIdOf(a).localeCompare(factIdOf(b))),
      joins: new Map(),
      unkeyed: grouped.unkeyed,
    };
  }

  const { groups, unkeyed } = groupRequests(unique);

  return { ...pairAccountRows(groups), unkeyed };
};

export const accountRowJoins = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, string> => requestGrouping(events).joins;

const hasSessionPlacement = (event: DxEventEnvelope): boolean =>
  event.payload.sessionJoin !== null && event.payload.sessionJoin !== undefined;

const agentAccountFact = (
  fact: UsageFact,
  group: readonly DxEventEnvelope[]
): UsageFact => ({
  ...fact,
  ...placementOf(
    group.filter((event) => !hasSessionPlacement(event)).toSorted(byPrecedence)
  ),
  requests: 0,
  scope: "account-bucket",
});

const usageRowsFromGrouping = (
  events: readonly DxEventEnvelope[],
  { groups, unkeyed }: RequestGrouping,
  agent = false
): DerivedRows => {
  const readings = keyedReadings(groups);
  const sessionRows = sessionFigureFacts(events);
  const onSessionLedger = sessionLedger(sessionRows);
  const rows: DerivedRow[] = [];
  const disagreements: UsageDisagreement[] = [];
  const unresolved: string[] = [];

  for (const group of groups) {
    const reconciled = onSessionLedger(factOf(group));

    const fact =
      agent &&
      group.every(
        (event) => isAccountBucket(event) || isUnkeyedAccountRow(event)
      )
        ? agentAccountFact(reconciled, group)
        : reconciled;

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

  return agent
    ? {
        disagreements: disagreements.toSorted(
          (a, b) =>
            a.factId.localeCompare(b.factId) || a.field.localeCompare(b.field)
        ),
        rows: rows
          .map((row) => ({ ...row, sources: row.sources.toSorted() }))
          .toSorted((a, b) => a.fact.factId.localeCompare(b.fact.factId)),
        unresolved: unresolved.toSorted(),
      }
    : { disagreements, rows, unresolved };
};

export const deriveUsageRows = (
  events: readonly DxEventEnvelope[]
): DerivedRows => usageRowsFromGrouping(events, requestGrouping(events));

type ExplanationReader = (
  event: DxEventEnvelope
) => UsageExplanationValue | undefined;

const FIELD_PRECEDENCE_RULE =
  "first-present-by-harness-channel-rank-then-token-total-descending-then-event-id";

const TOKEN_PRECEDENCE_RULE =
  "whole-token-object-by-harness-channel-rank-then-token-total-descending-then-event-id";

const explanationSemantics = (
  field: string,
  value: UsageExplanationValue,
  winner: DxEventEnvelope | null,
  known: number
): UsageFieldExplanation["semantics"] => {
  if (value === null || winner === null) {
    return "unavailable";
  }

  if (
    hasSessionPlacement(winner) &&
    ["attribution", "branch", "repo", "worktree"].includes(field)
  ) {
    return "provisional";
  }

  return known > 1 ? "reconciled" : "observed";
};

const fieldExplanation = (
  field: string,
  read: ExplanationReader,
  value: UsageExplanationValue,
  winner: DxEventEnvelope | null,
  members: readonly DxEventEnvelope[],
  rule: string
): UsageFieldExplanation => {
  const candidates = members.map((member) => ({
    channel: channelLabel(member),
    eventId: member.eventId,
    value: read(member) ?? null,
  }));

  const known = candidates.filter((candidate) => candidate.value !== null);

  return {
    candidates,
    disagreement: new Set(known.map((candidate) => candidate.value)).size > 1,
    field,
    rule,
    semantics: explanationSemantics(field, value, winner, known.length),
    value,
    winnerEventId: winner?.eventId ?? null,
  };
};

const firstReporting = (
  members: readonly DxEventEnvelope[],
  read: ExplanationReader
): DxEventEnvelope | null =>
  members.find((member) => {
    const value = read(member);

    return value !== null && value !== undefined;
  }) ?? null;

const EXPLANATION_READERS: readonly (readonly [
  string,
  ExplanationReader,
  (fact: UsageFact) => UsageExplanationValue,
])[] = [
  ["model", (event) => event.ai?.model, (fact) => fact.model],
  ["modelRaw", (event) => event.ai?.modelRaw, (fact) => fact.modelRaw],
  ["effort", (event) => event.ai?.effort, (fact) => fact.effort],
  ["harness", (event) => event.ai?.harness, (fact) => fact.harness],
  [
    "harnessVersion",
    (event) => event.ai?.harnessVersion,
    (fact) => fact.harnessVersion,
  ],
  [
    "agent",
    (event) => event.ai?.agentType ?? event.ai?.agentId,
    (fact) => fact.agent,
  ],
  [
    "parentSession",
    (event) => event.ai?.parentSessionId,
    (fact) => fact.parentSession,
  ],
  ["session", sessionOf, (fact) => fact.session],
  ["via", (event) => event.ai?.via, (fact) => fact.via],
  ["occurredAt", (event) => event.occurredAt, (fact) => fact.occurredAt],
  [
    "requestKey",
    (event) => event.usage?.requestKey ?? event.identity.requestId,
    (fact) => fact.requestKey,
  ],
  [
    "serviceTier",
    (event) => event.usage?.serviceTier,
    (fact) => fact.serviceTier,
  ],
  ["speed", (event) => event.usage?.speed, (fact) => fact.speed],
  [
    "premiumRequests",
    (event) => event.usage?.premiumRequests,
    (fact) => fact.premiumRequests,
  ],
  [
    "webSearchRequests",
    (event) => event.usage?.webSearchRequests,
    (fact) => fact.webSearchRequests,
  ],
];

const placementExplanations = (
  fact: UsageFact,
  ordered: readonly DxEventEnvelope[]
): UsageFieldExplanation[] => {
  const placementMembers =
    fact.scope === "account-bucket"
      ? ordered.filter((event) => !hasSessionPlacement(event))
      : ordered;

  const placed = branchMember(placementMembers);

  const fields = [
    fieldExplanation(
      "attribution",
      (event) =>
        event.context.branch === null
          ? null
          : (event.ai?.branchSource ?? "cwd-inferred"),
      fact.attribution,
      placed,
      ordered,
      "branch-source-order"
    ),
  ];

  for (const [field, read, value] of [
    ["branch", (event: DxEventEnvelope) => event.context.branch, fact.branch],
    [
      "repo",
      (event: DxEventEnvelope) => event.context.repoCommonDir,
      fact.repo,
    ],
    [
      "worktree",
      (event: DxEventEnvelope) => event.context.worktreePath,
      fact.worktree,
    ],
  ] as const) {
    const winner =
      field === "branch" || (placed !== null && read(placed) !== null)
        ? placed
        : firstReporting(placementMembers, read);

    fields.push(
      fieldExplanation(
        field,
        read,
        value,
        winner,
        ordered,
        "branch-source-order-then-first-present-placement"
      )
    );
  }

  return fields;
};

const moneyExplanations = (
  fact: UsageFact,
  ordered: readonly DxEventEnvelope[]
): UsageFieldExplanation[] => {
  const fields: UsageFieldExplanation[] = [];

  for (const [field, read, value] of [
    [
      "billed.amount",
      (event: DxEventEnvelope) => billedFigureOf(event)?.amount,
      fact.billed?.amount ?? null,
    ],
    [
      "billed.currency",
      (event: DxEventEnvelope) => billedFigureOf(event)?.currency,
      fact.billed?.currency ?? null,
    ],
    [
      "billed.kind",
      (event: DxEventEnvelope) => billedFigureOf(event)?.kind,
      fact.billed?.kind ?? null,
    ],
    [
      "toolFigure.amount",
      (event: DxEventEnvelope) => toolOwnFigureOf(event)?.amount,
      fact.toolFigure?.amount ?? null,
    ],
    [
      "toolFigure.currency",
      (event: DxEventEnvelope) => toolOwnFigureOf(event)?.currency,
      fact.toolFigure?.currency ?? null,
    ],
    [
      "toolFigure.kind",
      (event: DxEventEnvelope) => toolOwnFigureOf(event)?.kind,
      fact.toolFigure?.kind ?? null,
    ],
  ] as const) {
    fields.push(
      fieldExplanation(
        field,
        read,
        value,
        value === null ? null : firstReporting(ordered, read),
        ordered,
        "separate-observed-money-ledgers-by-source-precedence"
      )
    );
  }

  return fields;
};

const providerRead = (event: DxEventEnvelope) =>
  event.ai === null || event.ai.provider === "unknown"
    ? null
    : event.ai.provider;

const channelRead = (event: DxEventEnvelope) => event.ai?.channel;

const sessionExplanations = (
  fact: UsageFact,
  members: readonly DxEventEnvelope[],
  fields: readonly UsageFieldExplanation[]
): readonly UsageFieldExplanation[] => {
  const [event] = members;

  if (members.length !== 1 || event?.kind !== "ai.session") {
    return fields;
  }

  const cost = modelCosts(event)?.find(([raw]) => raw === fact.modelRaw);
  const split = cost !== undefined && fact.factId !== factOf([event]).factId;

  return fields.map((field) => {
    if (field.field.startsWith("tokens.")) {
      return {
        ...field,
        rule: "session-money-ledger-excludes-request-tokens",
        winnerEventId: null,
      };
    }

    if (!split || cost === undefined) {
      return field;
    }

    const [raw, amount] = cost;

    if (
      field.field === "model" ||
      field.field === "modelRaw" ||
      field.field === "toolFigure.amount"
    ) {
      const sourceValue = field.field === "toolFigure.amount" ? amount : raw;

      return {
        ...field,
        candidates: [
          {
            channel: channelLabel(event),
            eventId: event.eventId,
            value: sourceValue,
          },
        ],
        disagreement: false,
        rule: "validated-session-model-cost-breakdown-with-model-normalization",
        semantics: "reconciled" as const,
        winnerEventId: event.eventId,
      };
    }

    if (
      (field.field === "provider" || field.field === "via") &&
      field.value !== null &&
      field.winnerEventId === null
    ) {
      return {
        ...field,
        rule: "served-model-context-or-inference-from-session-model-name",
        semantics: "reconciled" as const,
        winnerEventId: event.eventId,
      };
    }

    return field;
  });
};

const explanationOf = (
  row: DerivedRow,
  members: readonly DxEventEnvelope[]
): UsageExplanation => {
  const ordered = members.toSorted(byPrecedence);
  const { fact } = row;

  const fields = EXPLANATION_READERS.map(([field, read, readFact]) =>
    fieldExplanation(
      field,
      read,
      readFact(fact),
      firstReporting(ordered, read),
      ordered,
      FIELD_PRECEDENCE_RULE
    )
  );

  const tokenSource =
    ordered.find(
      (member) => member.usage !== null && hasKnownTokens(member.usage.tokens)
    ) ?? null;

  for (const field of AI_TOKEN_FIELDS) {
    fields.push(
      fieldExplanation(
        `tokens.${field}`,
        (event) => event.usage?.tokens[field],
        fact.tokens[field],
        tokenSource,
        ordered,
        TOKEN_PRECEDENCE_RULE
      )
    );
  }

  fields.push(
    fieldExplanation(
      "channel",
      channelRead,
      fact.channel,
      tokenSource?.ai?.channel !== null &&
        tokenSource?.ai?.channel !== undefined
        ? tokenSource
        : firstReporting(ordered, channelRead),
      ordered,
      "token-object-source-channel-then-first-present-channel"
    ),
    fieldExplanation(
      "provider",
      providerRead,
      fact.provider,
      firstReporting(ordered, providerRead),
      ordered,
      "first-known-provider-by-source-precedence"
    ),
    ...placementExplanations(fact, ordered),
    ...moneyExplanations(fact, ordered)
  );

  return {
    factId: fact.factId,
    fields: sessionExplanations(fact, ordered, fields),
    sources: row.sources.toSorted(),
  };
};

const isObservedAccount = (event: DxEventEnvelope): boolean =>
  event.ai?.channel === "usage-api" || isAccountBucket(event);

interface AccountAssociationDetails {
  readonly allocated: readonly AccountAllocation[];
  readonly associations: readonly AccountAssociation[];
}

const associationReason = (
  ambiguous: boolean,
  selected: boolean,
  candidates: number
): string => {
  if (ambiguous) {
    return "Equally near local turns leave this account observation unallocated.";
  }

  if (selected) {
    return "Timing reconstructs a provisional share; it does not establish request identity.";
  }

  return candidates > 0
    ? "Candidate turns were assigned to other account observations."
    : "No local turn in the same harness and session falls within the 60000 ms window.";
};

const associationDetails = (
  groups: readonly (readonly DxEventEnvelope[])[]
): AccountAssociationDetails => {
  const pairings = accountPairings(groups).toSorted(
    (a, b) =>
      a.gap - b.gap ||
      a.distance - b.distance ||
      a.account - b.account ||
      a.turn - b.turn
  );

  const byAccount = new Map<number, AccountPairing[]>();

  for (const pairing of pairings) {
    byAccount.set(pairing.account, [
      ...(byAccount.get(pairing.account) ?? []),
      pairing,
    ]);
  }

  const ambiguous = new Set(
    [...byAccount].flatMap(([account, candidates]) => {
      const [firstCandidate, next] = candidates;

      return firstCandidate !== undefined &&
        next !== undefined &&
        firstCandidate.gap === next.gap &&
        firstCandidate.distance === next.distance
        ? [account]
        : [];
    })
  );

  const selected = new Map<number, number>();
  const taken = new Set<number>();

  for (const pairing of pairings) {
    if (
      !ambiguous.has(pairing.account) &&
      !selected.has(pairing.account) &&
      !taken.has(pairing.turn)
    ) {
      selected.set(pairing.account, pairing.turn);
      taken.add(pairing.turn);
    }
  }

  const associations: AccountAssociation[] = [];
  const allocated: AccountAllocation[] = [];

  for (const [account, group] of groups.entries()) {
    if (
      !group.every(
        (event) => isUnkeyedAccountRow(event) || isAccountBucket(event)
      )
    ) {
      continue;
    }

    const selectedTurn = selected.get(account);
    const accountEventIds = group.map((event) => event.eventId).toSorted();

    const candidates: AccountAssociationCandidate[] = (
      byAccount.get(account) ?? []
    ).flatMap((pairing) => {
      const turn = groups[pairing.turn];
      const window = turn === undefined ? null : turnWindowOf(turn);

      return turn === undefined || window === null
        ? []
        : [
            {
              distanceMs: pairing.distance,
              endMs: window.end,
              eventIds: turn.map((event) => event.eventId).toSorted(),
              gapMs: pairing.gap,
              selected: selectedTurn === pairing.turn,
              startMs: window.start,
              turnFactId: factIdOf(turn),
            },
          ];
    });

    const turn = selectedTurn === undefined ? undefined : groups[selectedTurn];

    associations.push({
      accountEventIds,
      accountFactId: factIdOf(group),
      candidates,
      method: "same-harness-session-window",
      reason: associationReason(
        ambiguous.has(account),
        turn !== undefined,
        candidates.length
      ),
      selectedTurnFactId: turn === undefined ? null : factIdOf(turn),
      semantics: "provisional",
    });

    if (turn !== undefined) {
      const fact = factOf(turn);

      allocated.push({
        accountEventIds,
        branch: fact.branch,
        method: "same-harness-session-window",
        repo: fact.repo,
        semantics: "provisional",
        turnEventIds: turn.map((event) => event.eventId).toSorted(),
        turnFactId: fact.factId,
        worktree: fact.worktree,
      });
    }
  }

  return { allocated, associations };
};

export const deriveAgentUsageRows = (
  events: readonly DxEventEnvelope[]
): AgentDerivedUsageRows => {
  const unique = [
    ...new Map(events.map((event) => [event.eventId, event])).values(),
  ].toSorted((a, b) => a.eventId.localeCompare(b.eventId));

  const grouping = requestGrouping(unique, false);
  const derived = usageRowsFromGrouping(unique, grouping, true);
  const { associations, allocated } = associationDetails(grouping.groups);

  const exactAllocations = grouping.groups.flatMap(
    (group): AccountAllocation[] => {
      const accounts = group.filter(isObservedAccount);
      const turns = group.filter((event) => !isObservedAccount(event));

      if (accounts.length === 0 || turns.length === 0) {
        return [];
      }

      const fact = factOf(group);

      return [
        {
          accountEventIds: accounts.map((event) => event.eventId).toSorted(),
          branch: fact.branch,
          method: "request-identity",
          repo: fact.repo,
          semantics: "reconciled",
          turnEventIds: turns.map((event) => event.eventId).toSorted(),
          turnFactId: fact.factId,
          worktree: fact.worktree,
        },
      ];
    }
  );

  const allAllocations = [...exactAllocations, ...allocated];

  const assigned = new Set(
    allAllocations.flatMap((allocation) => allocation.accountEventIds)
  );

  const active = [...grouping.groups.flat(), ...grouping.unkeyed];

  const observed = active
    .filter(isObservedAccount)
    .toSorted((a, b) => a.eventId.localeCompare(b.eventId));

  const byId = new Map(unique.map((event) => [event.eventId, event]));

  return {
    accountLedger: {
      allocated: allAllocations,
      observed,
      remainder: observed.filter((event) => !assigned.has(event.eventId)),
    },
    associations,
    derived,
    explanations: derived.rows.map((row) =>
      explanationOf(
        row,
        row.sources.flatMap((id) => {
          const event = byId.get(EventIdSchema.make(id));

          return event === undefined ? [] : [event];
        })
      )
    ),
  };
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
