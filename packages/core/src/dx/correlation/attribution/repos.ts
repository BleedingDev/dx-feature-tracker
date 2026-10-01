import { Effect, Option, Schema } from "effect";

import type { BranchSource } from "../../harness/ids.js";
import type {
  AiAttribution,
  AiTokens,
  AiUsage,
} from "../../model/attribution.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import { isContained } from "../repo/path.js";
import type { RepoLocator } from "./locator.js";

export const NO_REPO_PROJECT = "(no repo)";

export const REPO_ATTRIBUTION_METHODS = [
  "cwd",
  "tool-calls",
  "parent",
  "subagent-split",
  "no-repo",
] as const;

export type RepoMethod = (typeof REPO_ATTRIBUTION_METHODS)[number];

export interface RepoPlace {
  readonly branch: string | null;
  readonly repoCommonDir: string;
  readonly worktreePath: string | null;
}

export interface RepoAttribution {
  readonly eventId: string;
  readonly method: RepoMethod;
  readonly repoCommonDir: string | null;
  readonly splitOf: string | null;
  readonly weight: number;
  readonly worktreePath: string | null;
}

export interface RepoAttributionResult {
  readonly attributions: readonly RepoAttribution[];
  readonly events: readonly DxEventEnvelope[];
}

const RepoAttributionPayloadSchema = Schema.Struct({
  method: Schema.Literals(REPO_ATTRIBUTION_METHODS),
});

const decodeRepoAttribution = Schema.decodeUnknownOption(
  RepoAttributionPayloadSchema
);

export const repoMethodOf = (event: DxEventEnvelope): RepoMethod | null =>
  Option.match(decodeRepoAttribution(event.payload.repoAttribution), {
    onNone: () => null,
    onSome: (found) => found.method,
  });

interface Located {
  readonly ai: AiAttribution;
  readonly cwd: string;
  readonly event: DxEventEnvelope;
}

interface Placement {
  readonly method: Exclude<RepoMethod, "no-repo" | "subagent-split">;
  readonly place: RepoPlace;
}

interface Share {
  readonly place: RepoPlace;
  readonly weight: number;
}

const isAiEvent = (event: DxEventEnvelope): boolean =>
  event.kind.startsWith("ai.") || event.kind === "provenance.attestation";

const sessionOf = (located: Located): string | null =>
  located.ai.sessionId ?? located.event.identity.sessionId;

const isNestedAgent = (ai: AiAttribution): boolean =>
  ai.agentId !== null &&
  (ai.parentSessionId === null || ai.parentSessionId === ai.sessionId);

const selfKeyOf = (located: Located): string => {
  const session = sessionOf(located);

  if (session === null) {
    return `event:${located.event.eventId}`;
  }

  return isNestedAgent(located.ai)
    ? `${session}#agent:${located.ai.agentId ?? ""}`
    : session;
};

const parentKeyOf = (located: Located): string | null => {
  const { ai } = located;

  if (ai.parentSessionId !== null && ai.parentSessionId !== ai.sessionId) {
    return ai.parentSessionId;
  }

  return isNestedAgent(ai) ? sessionOf(located) : null;
};

const turnKeyOf = (located: Located): string =>
  `${selfKeyOf(located)}\u0000${located.event.identity.turnId ?? located.event.eventId}`;

const instantOf = (event: DxEventEnvelope): number | null => {
  const ms = Date.parse(event.occurredAt ?? event.observedAt);

  return Number.isNaN(ms) ? null : ms;
};

const sameDir = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

const contextCovers = (located: Located): boolean => {
  const { worktreePath } = located.event.context;

  return worktreePath !== null && isContained(worktreePath, located.cwd);
};

const placeKey = (place: RepoPlace): string =>
  `${place.repoCommonDir}\u0000${place.worktreePath ?? ""}`;

const groupBy = <T>(
  items: readonly T[],
  key: (item: T) => string
): ReadonlyMap<string, readonly T[]> => {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }

  return groups;
};

const singlePlace = (places: readonly RepoPlace[]): RepoPlace | null => {
  const repos = new Set(places.map((place) => place.repoCommonDir));
  const [repo] = [...repos];

  if (repos.size !== 1 || repo === undefined) {
    return null;
  }

  const worktrees = [...groupBy(places, placeKey).values()];
  const [only] = worktrees.length === 1 ? (worktrees[0] ?? []) : [];

  return only ?? { branch: null, repoCommonDir: repo, worktreePath: null };
};

const tokenWeight = (usage: AiUsage | null): number => {
  if (usage === null) {
    return 0;
  }

  const { tokens } = usage;

  if (tokens.total !== null) {
    return tokens.total;
  }

  const cacheWrite =
    tokens.cacheWrite ??
    (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0);

  return (
    (tokens.inputFresh ?? 0) +
    (tokens.cacheRead ?? 0) +
    cacheWrite +
    (tokens.output ?? 0)
  );
};

const nearest = <T extends { readonly at: number | null }>(
  candidates: readonly T[],
  at: number | null
): T | undefined => {
  let best: T | undefined;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const gap =
      at === null || candidate.at === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(candidate.at - at);

    if (best === undefined || gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }

  return best;
};

const scale = (value: number | null, weight: number): number | null =>
  value === null ? null : value * weight;

const scaledTokens = (tokens: AiTokens, weight: number): AiTokens => ({
  cacheRead: scale(tokens.cacheRead, weight),
  cacheWrite: scale(tokens.cacheWrite, weight),
  cacheWrite1h: scale(tokens.cacheWrite1h, weight),
  cacheWrite5m: scale(tokens.cacheWrite5m, weight),
  inputFresh: scale(tokens.inputFresh, weight),
  output: scale(tokens.output, weight),
  reasoning: scale(tokens.reasoning, weight),
  total: scale(tokens.total, weight),
});

const scaledUsage = (
  usage: AiUsage | null,
  weight: number,
  suffix: string
): AiUsage | null =>
  usage === null
    ? null
    : {
        ...usage,
        premiumRequests: scale(usage.premiumRequests, weight),
        requestKey:
          usage.requestKey === null ? null : `${usage.requestKey}${suffix}`,
        tokens: scaledTokens(usage.tokens, weight),
        toolFigure:
          usage.toolFigure === null
            ? null
            : { ...usage.toolFigure, amount: usage.toolFigure.amount * weight },
      };

interface Relocation {
  readonly method: RepoMethod;
  readonly place: RepoPlace | null;
  readonly splitOf: string | null;
  readonly weight: number;
}

const METHOD_LABELS: Readonly<Record<RepoMethod, BranchSource | null>> = {
  cwd: null,
  "no-repo": "unassigned",
  parent: null,
  "subagent-split": "subagent-split",
  "tool-calls": "tool-calls",
};

const relocate = (
  event: DxEventEnvelope,
  move: Relocation
): DxEventEnvelope => {
  const { context } = event;
  const repoCommonDir = move.place?.repoCommonDir ?? null;
  const worktreePath = move.place?.worktreePath ?? null;
  const sameRepo = sameDir(context.repoCommonDir, repoCommonDir);
  const sameWorktree = sameRepo && sameDir(context.worktreePath, worktreePath);
  const recorded = event.ai?.branchSource === "harness-recorded";
  const keepsBranch = sameWorktree || (move.method === "cwd" && recorded);
  const branch = keepsBranch ? context.branch : (move.place?.branch ?? null);
  const label = METHOD_LABELS[move.method];

  return {
    ...event,
    ai:
      event.ai === null || label === null
        ? event.ai
        : { ...event.ai, branchSource: label },
    context: {
      branch,
      flightId: sameWorktree ? context.flightId : null,
      headSha: sameWorktree ? context.headSha : null,
      repoCommonDir,
      worktreePath,
    },
    payload: {
      ...event.payload,
      repoAttribution: {
        fromRepoCommonDir: context.repoCommonDir,
        fromWorktree: context.worktreePath,
        inferred: move.method === "subagent-split",
        method: move.method,
        project: repoCommonDir ?? NO_REPO_PROJECT,
        splitOf: move.splitOf,
        weight: move.weight,
      },
    },
  };
};

interface SplitPart {
  readonly event: DxEventEnvelope;
  readonly eventId: string;
  readonly context: DxEventEnvelope["context"];
  readonly weight: number;
}

const splitInto = (
  event: DxEventEnvelope,
  shares: readonly Share[]
): readonly SplitPart[] =>
  shares.map((share, index) => {
    const suffix = `#split:${String(index + 1)}/${String(shares.length)}`;

    const moved = relocate(event, {
      method: "subagent-split",
      place: share.place,
      splitOf: event.eventId,
      weight: share.weight,
    });

    const part: DxEventEnvelope = {
      ...moved,
      eventId: EventIdSchema.make(`${event.eventId}${suffix}`),
      upstreamKey: `${event.upstreamKey}${suffix}`,
      usage: scaledUsage(event.usage, share.weight, suffix),
    };

    return {
      context: part.context,
      event: part,
      eventId: part.eventId,
      weight: share.weight,
    };
  });

const isCandidate = (event: DxEventEnvelope): boolean =>
  isAiEvent(event) &&
  event.ai !== null &&
  event.ai.cwd !== null &&
  event.ai.cwd !== "" &&
  repoMethodOf(event) === null;

const locatedOf = (event: DxEventEnvelope): Located[] =>
  event.ai === null || event.ai.cwd === null
    ? []
    : [{ ai: event.ai, cwd: event.ai.cwd, event }];

const MAX_PARENT_DEPTH = 8;

export const attributeRepos = (
  locator: RepoLocator,
  events: readonly DxEventEnvelope[]
): Effect.Effect<RepoAttributionResult> =>
  Effect.gen(function* attributeRepoPlaces() {
    const candidates = events.filter(isCandidate).flatMap(locatedOf);

    if (candidates.length === 0) {
      return { attributions: [], events };
    }

    const placements = new Map<string, Placement>();
    const kept = new Set<string>();
    const open: Located[] = [];

    for (const located of candidates) {
      const at = yield* locator.locate(located.cwd);

      if (at.kind === "repo") {
        placements.set(located.event.eventId, {
          method: "cwd",
          place: {
            branch: at.location.branch,
            repoCommonDir: at.location.repoCommonDir,
            worktreePath: at.location.worktreePath,
          },
        });
      } else if (at.kind === "missing" || contextCovers(located)) {
        kept.add(located.event.eventId);
      } else {
        open.push(located);
      }
    }

    const turns = groupBy(candidates, turnKeyOf);

    for (const [key, members] of turns) {
      const pending = open.filter((located) => turnKeyOf(located) === key);

      if (pending.length > 0) {
        const touched = [
          ...new Set(members.flatMap((m) => m.ai.touchedPaths ?? [])),
        ];

        const places: RepoPlace[] = members.flatMap((m) => {
          const found = placements.get(m.event.eventId);

          return found?.method === "cwd" ? [found.place] : [];
        });

        for (const path of touched) {
          const at = yield* locator.locate(path);

          if (at.kind === "repo") {
            places.push({
              branch: at.location.branch,
              repoCommonDir: at.location.repoCommonDir,
              worktreePath: at.location.worktreePath,
            });
          }
        }

        const place = singlePlace(places);

        if (place !== null) {
          for (const located of pending) {
            placements.set(located.event.eventId, {
              method: "tool-calls",
              place,
            });
          }
        }
      }
    }

    const placedBySelf = () =>
      groupBy(
        candidates.flatMap((located) => {
          const found = placements.get(located.event.eventId);

          return found === undefined
            ? []
            : [
                {
                  at: instantOf(located.event),
                  found,
                  key: selfKeyOf(located),
                },
              ];
        }),
        (entry) => entry.key
      );

    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
      const bySelf = placedBySelf();
      let changed = false;

      for (const located of open) {
        const parent = parentKeyOf(located);

        if (parent !== null && !placements.has(located.event.eventId)) {
          const near = nearest(
            bySelf.get(parent) ?? [],
            instantOf(located.event)
          );

          if (near !== undefined) {
            placements.set(located.event.eventId, {
              method: "parent",
              place: near.found.place,
            });
            changed = true;
          }
        }
      }

      if (!changed) {
        break;
      }
    }

    const children = groupBy(
      candidates.filter(
        (located) =>
          parentKeyOf(located) !== null && placements.has(located.event.eventId)
      ),
      (located) => parentKeyOf(located) ?? ""
    );

    const sharesFor = (located: Located): readonly Share[] => {
      const kids = children.get(selfKeyOf(located)) ?? [];
      const turn = turns.get(turnKeyOf(located)) ?? [located];

      const times = turn.flatMap((m) => {
        const at = instantOf(m.event);

        return at === null ? [] : [at];
      });

      const from = Math.min(...times);
      const to = Math.max(...times);

      const inTurn = kids.filter((kid) => {
        const at = instantOf(kid.event);

        return at !== null && at >= from && at <= to;
      });

      const chosen = inTurn.length > 0 ? inTurn : kids;

      const weighed = chosen.flatMap((kid) => {
        const found = placements.get(kid.event.eventId);

        return found === undefined
          ? []
          : [{ place: found.place, tokens: tokenWeight(kid.event.usage) }];
      });

      const byPlace = [...groupBy(weighed, (w) => placeKey(w.place)).values()];
      const total = weighed.reduce((sum, w) => sum + w.tokens, 0);

      return byPlace
        .flatMap((group) => {
          const [first] = group;

          return first === undefined
            ? []
            : [
                {
                  place: first.place,
                  weight:
                    total > 0
                      ? group.reduce((sum, w) => sum + w.tokens, 0) / total
                      : group.length / weighed.length,
                },
              ];
        })
        .filter((share) => share.weight > 0)
        .toSorted((a, b) => placeKey(a.place).localeCompare(placeKey(b.place)));
    };

    const openIds = new Set(open.map((located) => located.event.eventId));
    const byId = new Map(candidates.map((l) => [l.event.eventId, l] as const));
    const attributions: RepoAttribution[] = [];

    const rewritten = events.flatMap((event): readonly DxEventEnvelope[] => {
      const located = byId.get(event.eventId);

      if (located === undefined || kept.has(event.eventId)) {
        return [event];
      }

      const found = placements.get(event.eventId);

      if (found !== undefined) {
        attributions.push({
          eventId: event.eventId,
          method: found.method,
          repoCommonDir: found.place.repoCommonDir,
          splitOf: null,
          weight: 1,
          worktreePath: found.place.worktreePath,
        });

        const unchanged =
          found.method === "cwd" &&
          sameDir(event.context.repoCommonDir, found.place.repoCommonDir) &&
          sameDir(event.context.worktreePath, found.place.worktreePath);

        return unchanged
          ? [event]
          : [
              relocate(event, {
                method: found.method,
                place: found.place,
                splitOf: null,
                weight: 1,
              }),
            ];
      }

      const shares = openIds.has(event.eventId) ? sharesFor(located) : [];

      if (shares.length > 0) {
        const split = splitInto(event, shares);

        for (const part of split) {
          attributions.push({
            eventId: part.eventId,
            method: "subagent-split",
            repoCommonDir: part.context.repoCommonDir,
            splitOf: event.eventId,
            weight: part.weight,
            worktreePath: part.context.worktreePath,
          });
        }

        return split.map((part) => part.event);
      }

      attributions.push({
        eventId: event.eventId,
        method: "no-repo",
        repoCommonDir: null,
        splitOf: null,
        weight: 1,
        worktreePath: null,
      });

      return [
        relocate(event, {
          method: "no-repo",
          place: null,
          splitOf: null,
          weight: 1,
        }),
      ];
    });

    return { attributions, events: rewritten };
  });
