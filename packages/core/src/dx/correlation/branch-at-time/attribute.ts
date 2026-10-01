import { Option, Schema } from "effect";

import type {
  Correlation,
  CorrelationMapping,
  DxCorrelator,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { BranchSource } from "../../harness/ids.js";
import { rulesForEvent } from "../../harness/rules.js";
import { withBranchSource } from "../../model/attribution.js";
import type { AttributionState } from "../../model/common.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { DescriptorIdSchema, EvidenceIdSchema } from "../../model/ids.js";
import { branchNameOrNull } from "../attribution/branch-name.js";
import { repoMethodOf } from "../attribution/repos.js";
import { DEFAULT_BRANCH_AT_OPTIONS, branchAt } from "./timeline.js";
import type {
  BranchAtMethod,
  BranchAtOptions,
  WorktreeTimeline,
} from "./timeline.js";

export const BRANCH_AT_TIME_VERSION = "1.0.0";

export const BRANCH_AT_TIME_TARGET_KIND = "branch";

export type HistoricalBasis =
  | "tool-recorded"
  | "hook-turn"
  | "scored-commit"
  | "worktree-at-time"
  | "linked-request"
  | "live-capture"
  | "collected-context"
  | "unassigned";

export interface HistoricalAttribution {
  readonly attribution: AttributionState;
  readonly basis: HistoricalBasis;
  readonly branch: string | null;
  readonly collectedBranch: string | null;
  readonly confidence: number;
  readonly eventId: string;
  readonly method:
    | BranchAtMethod
    | "commit-hash"
    | "request-link"
    | "hook"
    | "collected";
  readonly reason: string;
}

export interface HistoricalAttributionInput {
  readonly commitBranches: ReadonlyMap<string, string>;
  readonly options?: BranchAtOptions;
  readonly timelines: readonly WorktreeTimeline[];
}

export interface HistoricalAttributionResult {
  readonly attributions: readonly HistoricalAttribution[];
  readonly events: readonly DxEventEnvelope[];
}

const LIVE_ACQUISITIONS = new Set(["hook", "command-capture"]);

const WORKSPACE_FIELDS = [
  "workspacePath",
  "worktreePath",
  "cwd",
  "workspaceRoot",
] as const;

const PayloadPathsSchema = Schema.Struct({
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  workspacePath: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceRoot: Schema.optional(Schema.NullOr(Schema.String)),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodePaths = Schema.decodeUnknownOption(PayloadPathsSchema);

const payloadPaths = (event: DxEventEnvelope): readonly string[] =>
  Option.match(decodePaths(event.payload), {
    onNone: () => [],
    onSome: (paths) =>
      WORKSPACE_FIELDS.flatMap((field) => {
        const value = paths[field] ?? null;

        return value === null || value === "" ? [] : [value];
      }),
  });

const isAiEvent = (event: DxEventEnvelope): boolean =>
  event.kind.startsWith("ai.") || event.kind === "provenance.attestation";

const normalizePath = (path: string): string => path.replace(/\/+$/u, "");

const within = (path: string, root: string): boolean => {
  const p = normalizePath(path);
  const r = normalizePath(root);

  return p === r || p.startsWith(`${r}/`);
};

const pathsOf = (event: DxEventEnvelope): readonly string[] => {
  const fromPayload = payloadPaths(event);

  return [
    ...(event.context.worktreePath === null
      ? []
      : [event.context.worktreePath]),
    ...fromPayload,
  ];
};

const timelineFor = (
  event: DxEventEnvelope,
  timelines: readonly WorktreeTimeline[]
): WorktreeTimeline | null => {
  const matches = pathsOf(event).flatMap((path) =>
    timelines.filter((t) => within(path, t.worktree))
  );

  return (
    matches.toSorted((a, b) => b.worktree.length - a.worktree.length)[0] ?? null
  );
};

const requestKeysOf = (event: DxEventEnvelope): readonly string[] => [
  ...(event.identity.requestId === null
    ? []
    : [`request:${event.identity.requestId}`]),
  ...(event.identity.generationId === null
    ? []
    : [`generation:${event.identity.generationId}`]),
];

const sessionKeyOf = (event: DxEventEnvelope): string | null =>
  event.identity.sessionId === null || event.identity.sessionId === ""
    ? null
    : `session:${event.identity.sessionId}`;

const timeOf = (event: DxEventEnvelope): number | null => {
  if (event.occurredAt === null) {
    return null;
  }

  const ms = Date.parse(event.occurredAt);

  return Number.isNaN(ms) ? null : ms;
};

const instantOf = (event: DxEventEnvelope): number | null => {
  const ms = Date.parse(event.occurredAt ?? event.observedAt);

  return Number.isNaN(ms) ? null : ms;
};

interface TimedAttribution {
  readonly at: number | null;
  readonly found: HistoricalAttribution;
}

const nearestSessionMatch = (
  candidates: readonly TimedAttribution[],
  event: DxEventEnvelope
): HistoricalAttribution | undefined => {
  const at = instantOf(event);
  let best: TimedAttribution | undefined;
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

  return best?.found;
};

type Resolver = (event: DxEventEnvelope) => HistoricalAttribution | null;

const base = (event: DxEventEnvelope) => ({
  collectedBranch: event.context.branch,
  eventId: event.eventId,
});

const byScoredCommit =
  (commitBranches: ReadonlyMap<string, string>): Resolver =>
  (event) => {
    const sha = event.identity.commitSha;
    const branch = sha === null ? undefined : commitBranches.get(sha);

    return branch === undefined || sha === null
      ? null
      : {
          ...base(event),
          attribution: "strong",
          basis: "scored-commit",
          branch,
          confidence: 0.9,
          method: "commit-hash",
          reason: `AI lines scored against commit ${sha.slice(0, 12)}, which is on ${branch} only`,
        };
  };

const isPlaced = (event: DxEventEnvelope): boolean =>
  event.payload.worktreePlacement !== undefined &&
  event.payload.worktreePlacement !== null;

const namedBranch = (event: DxEventEnvelope): string | null =>
  branchNameOrNull(event.context.branch);

const byToolRecorded: Resolver = (event) => {
  const branch = namedBranch(event);

  return event.ai?.branchSource === "harness-recorded" &&
    branch !== null &&
    !isPlaced(event)
    ? {
        ...base(event),
        attribution: "strong",
        basis: "tool-recorded",
        branch,
        confidence: 1,
        method: "collected",
        reason: `${event.ai.harness} recorded this branch on the request itself`,
      }
    : null;
};

const byLiveCapture: Resolver = (event) => {
  const branch = namedBranch(event);

  return LIVE_ACQUISITIONS.has(event.acquisition) &&
    branch !== null &&
    !isPlaced(event)
    ? {
        ...base(event),
        attribution: "strong",
        basis: "live-capture",
        branch,
        confidence: 1,
        method: "hook",
        reason: "captured live with the branch checked out at that moment",
      }
    : null;
};

export const HOOK_TURN_WINDOW_MS = 5 * 60 * 1000;

const isJoinedAccountRow = (event: DxEventEnvelope): boolean =>
  event.payload.sessionJoin !== undefined && event.payload.sessionJoin !== null;

const takesHookTurn = (event: DxEventEnvelope): boolean =>
  isJoinedAccountRow(event) || rulesForEvent(event).takesHookTurn(event);

const liveTurnsBySession = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, readonly DxEventEnvelope[]> => {
  const turns = new Map<string, DxEventEnvelope[]>();

  for (const event of events) {
    const sessionKey = sessionKeyOf(event);

    if (sessionKey !== null && byLiveCapture(event) !== null) {
      turns.set(sessionKey, [...(turns.get(sessionKey) ?? []), event]);
    }
  }

  return turns;
};

const byHookTurn =
  (turns: ReadonlyMap<string, readonly DxEventEnvelope[]>): Resolver =>
  (event) => {
    const sessionKey = sessionKeyOf(event);
    const at = timeOf(event);

    if (sessionKey === null || at === null || !takesHookTurn(event)) {
      return null;
    }

    let best: DxEventEnvelope | undefined;
    let bestGap = HOOK_TURN_WINDOW_MS;

    for (const turn of turns.get(sessionKey) ?? []) {
      const turnAt = instantOf(turn);

      const gap =
        turnAt === null ? Number.POSITIVE_INFINITY : Math.abs(turnAt - at);

      if (gap <= bestGap) {
        best = turn;
        bestGap = gap;
      }
    }

    const branch = best === undefined ? null : namedBranch(best);

    return best === undefined || branch === null
      ? null
      : {
          ...base(event),
          attribution: "strong",
          basis: "hook-turn",
          branch,
          confidence: 0.95,
          method: "hook",
          reason: `matches hook turn ${best.eventId} of the same conversation ${Math.round(bestGap / 1000)}s away, captured live on ${branch}`,
        };
  };

const byWorktreeAtTime =
  (
    timelines: readonly WorktreeTimeline[],
    options: BranchAtOptions
  ): Resolver =>
  (event) => {
    const at = timeOf(event);
    const timeline = timelineFor(event, timelines);

    if (at === null || timeline === null) {
      return null;
    }

    const resolved = branchAt(timeline, at, options);

    return resolved.method === "unknown"
      ? null
      : {
          ...base(event),
          attribution: resolved.attribution,
          basis: "worktree-at-time",
          branch: resolved.branch,
          confidence: resolved.confidence,
          method: resolved.method,
          reason: resolved.reason,
        };
  };

const byPlacedWorktree: Resolver = (event) =>
  isPlaced(event) && event.context.branch !== null
    ? {
        ...base(event),
        attribution: "provisional",
        basis: "worktree-at-time",
        branch: event.context.branch,
        confidence: 0.6,
        method: "collected",
        reason:
          "moved to the worktree its paths point to; no checkout history covers that time, so it takes the branch that worktree has now",
      }
    : null;

const untimedCollected = (
  event: DxEventEnvelope
): HistoricalAttribution | null => {
  const branch = namedBranch(event);

  return timeOf(event) === null && branch !== null
    ? {
        ...base(event),
        attribution: "provisional",
        basis: "collected-context",
        branch,
        confidence: 0.5,
        method: "collected",
        reason:
          "event has no timestamp; kept the branch its collector recorded",
      }
    : null;
};

const unassigned = (
  event: DxEventEnvelope,
  reason: string
): HistoricalAttribution => ({
  ...base(event),
  attribution: "unassigned",
  basis: "unassigned",
  branch: null,
  confidence: 0,
  method: "unknown",
  reason,
});

const BASIS_BRANCH_SOURCES: Readonly<
  Record<HistoricalBasis, BranchSource | null>
> = {
  "collected-context": "cwd-inferred",
  "hook-turn": "hook",
  "linked-request": null,
  "live-capture": null,
  "scored-commit": "git-at-time",
  "tool-recorded": "harness-recorded",
  unassigned: "unassigned",
  "worktree-at-time": "git-at-time",
};

const PLACED_BY_REPO_ATTRIBUTION: ReadonlySet<HistoricalBasis> = new Set([
  "worktree-at-time",
  "scored-commit",
  "collected-context",
  "linked-request",
  "unassigned",
]);

const repoLabel = (
  event: DxEventEnvelope,
  found: HistoricalAttribution
): BranchSource | null => {
  const method = repoMethodOf(event);

  return (method === "tool-calls" || method === "subagent-split") &&
    PLACED_BY_REPO_ATTRIBUTION.has(found.basis)
    ? method
    : null;
};

const attributedAi = (event: DxEventEnvelope, found: HistoricalAttribution) => {
  const source = repoLabel(event, found) ?? BASIS_BRANCH_SOURCES[found.basis];

  return source === null || event.ai === null
    ? event.ai
    : withBranchSource(event.ai, found.branch, source);
};

const inferredAttribution = (
  event: DxEventEnvelope,
  found: HistoricalAttribution
): HistoricalAttribution["attribution"] =>
  repoMethodOf(event) === "subagent-split" && found.attribution === "strong"
    ? "provisional"
    : found.attribution;

const withBranch = (
  event: DxEventEnvelope,
  found: HistoricalAttribution
): DxEventEnvelope => ({
  ...event,
  ai: attributedAi(event, found),
  context: { ...event.context, branch: found.branch },
  payload: {
    ...event.payload,
    historicalBranch: {
      attribution: inferredAttribution(event, found),
      basis: found.basis,
      collectedBranch: found.collectedBranch,
      confidence: found.confidence,
      method: found.method,
    },
  },
});

export const attributeHistoricalBranches = (
  events: readonly DxEventEnvelope[],
  input: HistoricalAttributionInput
): HistoricalAttributionResult => {
  const options = input.options ?? DEFAULT_BRANCH_AT_OPTIONS;

  const direct: readonly Resolver[] = [
    byToolRecorded,
    byLiveCapture,
    byHookTurn(liveTurnsBySession(events)),
    byScoredCommit(input.commitBranches),
    byWorktreeAtTime(input.timelines, options),
    byPlacedWorktree,
  ];

  const resolveDirect = (event: DxEventEnvelope) => {
    for (const resolve of direct) {
      const found = resolve(event);

      if (found !== null) {
        return found;
      }
    }

    return null;
  };

  const first = new Map<string, HistoricalAttribution | null>(
    events.flatMap((event) =>
      isAiEvent(event) ? [[event.eventId, resolveDirect(event)] as const] : []
    )
  );

  const linked = new Map<string, HistoricalAttribution>();
  const sessions = new Map<string, TimedAttribution[]>();

  for (const event of events) {
    const found = first.get(event.eventId);

    if (found?.branch !== null && found?.branch !== undefined) {
      for (const key of requestKeysOf(event)) {
        const prior = linked.get(key);

        if (prior === undefined || prior.confidence < found.confidence) {
          linked.set(key, found);
        }
      }

      const sessionKey = sessionKeyOf(event);

      if (sessionKey !== null) {
        sessions.set(sessionKey, [
          ...(sessions.get(sessionKey) ?? []),
          { at: instantOf(event), found },
        ]);
      }
    }
  }

  const linkFor = (event: DxEventEnvelope) => {
    const byRequest = requestKeysOf(event)
      .map((key) => linked.get(key))
      .find((a) => a !== undefined);

    if (byRequest !== undefined) {
      return { found: byRequest, via: "request" as const };
    }

    const sessionKey = sessionKeyOf(event);

    const bySession =
      sessionKey === null
        ? undefined
        : nearestSessionMatch(sessions.get(sessionKey) ?? [], event);

    return bySession === undefined
      ? undefined
      : { found: bySession, via: "session" as const };
  };

  const attributions: HistoricalAttribution[] = [];

  const rewritten = events.map((event) => {
    if (!isAiEvent(event)) {
      return event;
    }

    const own = first.get(event.eventId) ?? null;

    const link = own === null ? linkFor(event) : undefined;
    const viaLink = link?.found;

    const found =
      own ??
      (viaLink === undefined
        ? (untimedCollected(event) ??
          unassigned(
            event,
            timeOf(event) === null
              ? "event has no timestamp"
              : "no worktree path, scored commit or linked request/conversation id"
          ))
        : {
            ...base(event),
            attribution: "provisional" as const,
            basis: "linked-request" as const,
            branch: viaLink.branch,
            confidence: Math.min(viaLink.confidence, 0.8),
            method: "request-link" as const,
            reason:
              link?.via === "session"
                ? `nearest-in-time event of the same conversation, ${viaLink.eventId} (${viaLink.basis}); the conversation only gives repo and worktree, the branch comes from that nearest event`
                : `shares a request id with ${viaLink.eventId} (${viaLink.basis})`,
          });

    attributions.push(found);

    return withBranch(event, found);
  });

  return { attributions, events: rewritten };
};

export const historicalBranchDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["branch-at-time/scripted-checkouts"],
  gaps: [
    {
      code: "reflog-retention",
      message:
        "HEAD reflog entries expire (git default 90 days, 30 for unreachable); older instants fall back to provisional commit-graph evidence or stay unassigned.",
    },
    {
      code: "csv-without-workspace",
      message:
        "Usage CSV rows carry no workspace; they are attributed only through a local event with the same request/conversation id, else unassigned.",
    },
    {
      code: "commit-graph-exclusive-only",
      message:
        "Commit-graph evidence uses commits reachable from one local branch only; shared history and deleted branches give no evidence.",
    },
  ],
  id: DescriptorIdSchema.make("correlation/branch-at-time"),
  kind: "correlation",
  owner: "backfill",
  readiness: "degraded",
  requiredInputs: [
    "worktree HEAD reflog",
    "occurredAt",
    "context.worktreePath or payload workspace path",
  ],
  supportedFields: ["branch", "method", "confidence", "basis"],
  version: BRANCH_AT_TIME_VERSION,
};

export const makeHistoricalBranchCorrelator = (
  input: HistoricalAttributionInput
): DxCorrelator => ({
  correlate: (
    events: readonly DxEventEnvelope[],
    _mappings: readonly CorrelationMapping[]
  ): readonly Correlation[] =>
    attributeHistoricalBranches(events, input).attributions.map((a) => ({
      attribution: a.attribution,
      eventId: a.eventId,
      evidenceIds: [EvidenceIdSchema.make(a.eventId)],
      reason: `${a.basis}/${a.method} confidence ${a.confidence}: ${a.reason}`,
      target: a.branch,
      targetKind: BRANCH_AT_TIME_TARGET_KIND,
    })),
  descriptor: historicalBranchDescriptor,
});

export interface BranchAttributionSummary {
  readonly branch: string | null;
  readonly byBasis: ReadonlyMap<HistoricalBasis, number>;
  readonly byMethod: ReadonlyMap<HistoricalAttribution["method"], number>;
  readonly events: number;
  readonly movedFromCollectedBranch: number;
}

const tally = <K extends string>(items: readonly K[]) => {
  const counts = new Map<K, number>();

  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }

  return counts;
};

export const summarizeAttribution = (
  attributions: readonly HistoricalAttribution[]
): readonly BranchAttributionSummary[] => {
  const byBranch = new Map<string | null, HistoricalAttribution[]>();

  for (const a of attributions) {
    byBranch.set(a.branch, [...(byBranch.get(a.branch) ?? []), a]);
  }

  return [...byBranch.entries()]
    .toSorted(([a], [b]) => (a ?? "￿").localeCompare(b ?? "￿"))
    .map(([branch, members]) => ({
      branch,
      byBasis: tally(members.map((m) => m.basis)),
      byMethod: tally(members.map((m) => m.method)),
      events: members.length,
      movedFromCollectedBranch: members.filter(
        (m) => m.collectedBranch !== m.branch
      ).length,
    }));
};
