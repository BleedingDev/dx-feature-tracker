import { Option, Schema } from "effect";

import type { StoreSnapshot } from "../../contracts/services.js";
import {
  UNKNOWN_SOURCE_RANK,
  aiSourceRank,
} from "../../harness/source-kinds.js";
import { AiSourceKindSchema } from "../../model/ai.js";
import type { SourceCoverage } from "../../model/coverage.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { EvidenceId } from "../../model/ids.js";
import { EvidenceIdSchema } from "../../model/ids.js";
import type { Interval } from "../../model/interval.js";
import { matchKeysOf, sourceKindFrom } from "../ai-usage/normalize.js";

const isAiSourceKind = Schema.is(AiSourceKindSchema);

export const IDLE_GAP_MS = 30 * 60 * 1000;

export type BranchStartMethod =
  | "reflog-branch-created"
  | "first-branch-commit"
  | "reflog-oldest-entry"
  | "first-observed-activity";

export interface BranchStart {
  readonly atMs: number;
  readonly evidenceIds: readonly EvidenceId[];
  readonly method: BranchStartMethod;
}

export interface BranchEnd {
  readonly atMs: number;
  readonly evidenceIds: readonly EvidenceId[];
  readonly method: "merged" | "as-of";
}

export interface CommitPoint {
  readonly atMs: number | null;
  readonly evidenceId: EvidenceId;
  readonly sha: string;
}

export interface ToolCallTally {
  readonly collapsedReports: number;
  readonly evidenceIds: readonly EvidenceId[];
  readonly reports: number;
  readonly sessionAggregatesUsed: number;
  readonly total: number | null;
}

export interface FlightSignals {
  readonly activityPoints: readonly Interval[];
  readonly agentIntervals: readonly Interval[];
  readonly asOfMs: number | null;
  readonly branch: string | null;
  readonly commits: readonly CommitPoint[];
  readonly commitHistoryCollected: boolean;
  readonly coverage: readonly SourceCoverage[];
  readonly end: BranchEnd | null;
  readonly excludedOtherBranch: number;
  readonly start: BranchStart | null;
  readonly toolCalls: ToolCallTally;
}

const evidenceOf = (event: DxEventEnvelope): EvidenceId =>
  EvidenceIdSchema.make(event.eventId);

const toMs = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
};

const finite = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : value;

const TimeFieldsSchema = Schema.Struct({
  agentDurationMs: Schema.optional(Schema.NullOr(Schema.Finite)),
  authoredAt: Schema.optional(Schema.NullOr(Schema.String)),
  branchCreatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  committedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  durationMs: Schema.optional(Schema.NullOr(Schema.Finite)),
  firstBranchCommitAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reflogOldestAt: Schema.optional(Schema.NullOr(Schema.String)),
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  sourceKind: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  toolCall: Schema.optional(Schema.NullOr(Schema.Boolean)),
  toolCalls: Schema.optional(Schema.NullOr(Schema.Finite)),
});

type TimeFields = typeof TimeFieldsSchema.Type;

const decodeFields = Schema.decodeUnknownOption(TimeFieldsSchema);

const fieldsOf = (event: DxEventEnvelope): TimeFields =>
  Option.getOrElse(decodeFields(event.payload), () => ({}));

const ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "git.commit",
  "ai.request",
  "ai.turn",
  "ai.usage",
  "ai.tool-edit",
  "ai.session",
  "command.run",
  "test.result",
  "marker.start",
  "marker.stop",
  "marker.claim",
  "feedback.local",
]);

const isAiEvent = (event: DxEventEnvelope): boolean =>
  event.kind.startsWith("ai.") ||
  (event.kind === "other" && event.acquisition === "hook");

const targetBranch = (snapshot: StoreSnapshot): string | null => {
  if (snapshot.manifest.selector.branch !== null) {
    return snapshot.manifest.selector.branch;
  }

  const contexts = snapshot.events
    .filter((e) => e.kind === "git.context" && e.context.branch !== null)
    .toSorted((a, b) => b.observedAt.localeCompare(a.observedAt));

  const fromContext = contexts[0]?.context.branch ?? null;

  if (fromContext !== null) {
    return fromContext;
  }

  const branches = new Set(
    snapshot.events.flatMap((e) =>
      e.context.branch === null ? [] : [e.context.branch]
    )
  );

  return branches.size === 1 ? ([...branches][0] ?? null) : null;
};

const occurredMs = (event: DxEventEnvelope): number | null =>
  toMs(event.occurredAt);

const commitPoints = (events: readonly DxEventEnvelope[]): CommitPoint[] => {
  const bySha = new Map<string, CommitPoint>();

  for (const event of events) {
    if (event.kind !== "git.commit") {
      continue;
    }

    const fields = fieldsOf(event);
    const sha = fields.sha ?? event.identity.commitSha;

    if (sha === null || sha === "" || bySha.has(sha)) {
      continue;
    }

    bySha.set(sha, {
      atMs:
        toMs(fields.authoredAt) ??
        toMs(fields.committedAt) ??
        occurredMs(event),
      evidenceId: evidenceOf(event),
      sha,
    });
  }

  return [...bySha.values()];
};

interface Candidate {
  readonly atMs: number;
  readonly evidenceId: EvidenceId;
}

const earliest = (candidates: readonly Candidate[]): Candidate | null => {
  let best: Candidate | null = null;

  for (const candidate of candidates) {
    if (best === null || candidate.atMs < best.atMs) {
      best = candidate;
    }
  }

  return best;
};

const reflogCandidates = (events: readonly DxEventEnvelope[]): Candidate[] =>
  events.flatMap((event) => {
    if (event.kind !== "git.context" && event.kind !== "git.observation") {
      return [];
    }

    const atMs = toMs(fieldsOf(event).branchCreatedAt);

    return atMs === null ? [] : [{ atMs, evidenceId: evidenceOf(event) }];
  });

const firstCommitCandidates = (
  events: readonly DxEventEnvelope[],
  commits: readonly CommitPoint[]
): Candidate[] => [
  ...commits.flatMap((c) =>
    c.atMs === null ? [] : [{ atMs: c.atMs, evidenceId: c.evidenceId }]
  ),
  ...events.flatMap((event) => {
    if (event.kind !== "git.context") {
      return [];
    }

    const atMs = toMs(fieldsOf(event).firstBranchCommitAt);

    return atMs === null ? [] : [{ atMs, evidenceId: evidenceOf(event) }];
  }),
];

const activityCandidates = (events: readonly DxEventEnvelope[]): Candidate[] =>
  events.flatMap((event) => {
    const atMs = ACTIVITY_KINDS.has(event.kind) ? occurredMs(event) : null;

    return atMs === null ? [] : [{ atMs, evidenceId: evidenceOf(event) }];
  });

const reflogOldestCandidates = (
  events: readonly DxEventEnvelope[]
): Candidate[] =>
  events.flatMap((event) => {
    if (event.kind !== "git.observation") {
      return [];
    }

    const atMs = toMs(fieldsOf(event).reflogOldestAt);

    return atMs === null ? [] : [{ atMs, evidenceId: evidenceOf(event) }];
  });

const branchStart = (
  events: readonly DxEventEnvelope[],
  commits: readonly CommitPoint[]
): BranchStart | null => {
  const reflog = earliest(reflogCandidates(events));

  if (reflog !== null) {
    return {
      atMs: reflog.atMs,
      evidenceIds: [reflog.evidenceId],
      method: "reflog-branch-created",
    };
  }

  const tiers: readonly (readonly [BranchStartMethod, Candidate | null])[] = [
    ["first-branch-commit", earliest(firstCommitCandidates(events, commits))],
    ["reflog-oldest-entry", earliest(reflogOldestCandidates(events))],
    ["first-observed-activity", earliest(activityCandidates(events))],
  ];

  let best: BranchStart | null = null;

  for (const [method, candidate] of tiers) {
    if (candidate !== null && (best === null || candidate.atMs < best.atMs)) {
      best = {
        atMs: candidate.atMs,
        evidenceIds: [candidate.evidenceId],
        method,
      };
    }
  }

  return best;
};

const branchEnd = (
  events: readonly DxEventEnvelope[],
  asOfMs: number | null
): BranchEnd | null => {
  const merges = events.flatMap((event) => {
    if (event.kind !== "pr.metadata") {
      return [];
    }

    const atMs = toMs(fieldsOf(event).mergedAt);

    return atMs === null ? [] : [{ atMs, evidenceId: evidenceOf(event) }];
  });

  const merged = earliest(merges);

  if (merged !== null) {
    return {
      atMs: merged.atMs,
      evidenceIds: [merged.evidenceId],
      method: "merged",
    };
  }

  return asOfMs === null
    ? null
    : { atMs: asOfMs, evidenceIds: [], method: "as-of" };
};

const explicitInterval = (event: DxEventEnvelope): Interval | null => {
  const fields = fieldsOf(event);
  const duration = finite(fields.durationMs) ?? finite(fields.agentDurationMs);
  const started = toMs(fields.startedAt);
  const completed = toMs(fields.completedAt);
  const evidenceIds = [evidenceOf(event)];

  if (started !== null && (completed !== null || duration !== null)) {
    return {
      endMs: completed ?? started + (duration ?? 0),
      evidenceIds,
      label: `${event.adapterId}:explicit-start`,
      startMs: started,
    };
  }

  const at = occurredMs(event);

  if (duration === null || at === null) {
    return null;
  }

  return {
    endMs: at,
    evidenceIds,
    label: `${event.adapterId}:duration-ending-at-occurredAt`,
    startMs: at - duration,
  };
};

const burstIntervals = (
  points: readonly { readonly atMs: number; readonly evidenceId: EvidenceId }[],
  label: string
): Interval[] => {
  const sorted = points.toSorted((a, b) => a.atMs - b.atMs);
  const out: Interval[] = [];

  let current: { startMs: number; endMs: number; ids: EvidenceId[] } | null =
    null;

  for (const point of sorted) {
    if (current !== null && point.atMs - current.endMs <= IDLE_GAP_MS) {
      current.endMs = point.atMs;
      current.ids.push(point.evidenceId);
    } else {
      if (current !== null) {
        out.push({
          endMs: current.endMs,
          evidenceIds: current.ids,
          label,
          startMs: current.startMs,
        });
      }

      current = {
        endMs: point.atMs,
        ids: [point.evidenceId],
        startMs: point.atMs,
      };
    }
  }

  if (current !== null) {
    out.push({
      endMs: current.endMs,
      evidenceIds: current.ids,
      label,
      startMs: current.startMs,
    });
  }

  return out;
};

const agentIntervals = (events: readonly DxEventEnvelope[]): Interval[] => {
  const ai = events.filter(isAiEvent);

  const explicit = ai.flatMap((e) => {
    const interval = explicitInterval(e);

    return interval === null ? [] : [interval];
  });

  const sessions = new Map<string, Candidate[]>();

  for (const event of ai) {
    const at = occurredMs(event);
    const session = event.identity.sessionId;

    if (at === null || session === null || session === "") {
      continue;
    }

    const key = `${event.adapterId}\u0000${session}`;
    const list = sessions.get(key) ?? [];
    list.push({ atMs: at, evidenceId: evidenceOf(event) });
    sessions.set(key, list);
  }

  const spans = [...sessions.entries()].flatMap(([key, points]) =>
    burstIntervals(
      points,
      `session-span:${key.split("\u0000")[0] ?? ""}`
    ).filter(
      (span) =>
        span.startMs !== null &&
        span.endMs !== null &&
        span.endMs > span.startMs
    )
  );

  return [...explicit, ...spans];
};

const activityPoints = (events: readonly DxEventEnvelope[]): Interval[] =>
  burstIntervals(activityCandidates(events), "activity-burst");

const precedenceOf = (source: string): number =>
  isAiSourceKind(source) ? aiSourceRank(source) : UNKNOWN_SOURCE_RANK;

interface ToolReport {
  readonly count: number;
  readonly evidenceIds: EvidenceId[];
  readonly keys: readonly string[];
  readonly source: string;
}

const keysOf = (event: DxEventEnvelope): string[] => {
  const { sessionId, turnId } = event.identity;
  const keys = matchKeysOf(event);

  if (sessionId !== null && sessionId !== "") {
    keys.push(`session:${sessionId}`);
  }

  if (
    sessionId !== null &&
    sessionId !== "" &&
    turnId !== null &&
    turnId !== ""
  ) {
    keys.push(`session:${sessionId}:turn:${turnId}`);
  }

  return keys;
};

const sourceOf = (event: DxEventEnvelope, fields: TimeFields): string =>
  sourceKindFrom(fields.sourceKind, event.adapterId) ?? event.adapterId;

const find = (parent: number[], i: number): number => {
  let root = i;

  while (parent[root] !== root) {
    root = parent[root] ?? root;
  }

  return root;
};

const groupReports = (reports: readonly ToolReport[]): ToolReport[][] => {
  const parent = reports.map((_, i) => i);
  const owner = new Map<string, number>();

  for (const [i, report] of reports.entries()) {
    for (const key of report.keys) {
      const seen = owner.get(key);

      if (seen === undefined) {
        owner.set(key, i);
      } else {
        parent[find(parent, i)] = find(parent, seen);
      }
    }
  }

  const groups = new Map<number, ToolReport[]>();

  for (const [i, report] of reports.entries()) {
    const root = find(parent, i);
    groups.set(root, [...(groups.get(root) ?? []), report]);
  }

  return [...groups.values()];
};

const detailReports = (events: readonly DxEventEnvelope[]): ToolReport[] => {
  const perCall = new Map<string, ToolReport>();
  const reports: ToolReport[] = [];

  for (const event of events) {
    if (event.kind === "ai.session") {
      continue;
    }

    const fields = fieldsOf(event);
    const source = sourceOf(event, fields);
    const keys = keysOf(event);

    if (fields.toolCall === true) {
      const bucket = keys[0] === undefined ? event.eventId : keys.join("|");
      const slot = `${source}\u0000${bucket}`;
      const prior = perCall.get(slot);

      perCall.set(slot, {
        count: (prior?.count ?? 0) + 1,
        evidenceIds: [...(prior?.evidenceIds ?? []), evidenceOf(event)],
        keys,
        source,
      });
    } else {
      const count = finite(fields.toolCalls);

      if (count !== null) {
        reports.push({ count, evidenceIds: [evidenceOf(event)], keys, source });
      }
    }
  }

  return [...reports, ...perCall.values()];
};

const tallyToolCalls = (events: readonly DxEventEnvelope[]): ToolCallTally => {
  const unique = [...new Map(events.map((e) => [e.eventId, e])).values()];
  const detail = detailReports(unique);
  const groups = groupReports(detail);
  const evidenceIds: EvidenceId[] = [];
  let total = 0;
  let collapsed = 0;

  for (const group of groups) {
    const best = Math.min(...group.map((r) => precedenceOf(r.source)));
    const chosen = group.filter((r) => precedenceOf(r.source) === best);

    total += chosen.reduce((acc, r) => acc + r.count, 0);
    collapsed += group.length - chosen.length;
    evidenceIds.push(...chosen.flatMap((r) => r.evidenceIds));
  }

  const detailSessions = new Set(
    unique.flatMap((e) => {
      const fields = fieldsOf(e);

      const counted =
        e.kind !== "ai.session" &&
        (fields.toolCall === true || finite(fields.toolCalls) !== null);

      return counted && e.identity.sessionId !== null
        ? [e.identity.sessionId]
        : [];
    })
  );

  const aggregates = unique.filter((e) => {
    const count = finite(fieldsOf(e).toolCalls);

    return (
      e.kind === "ai.session" &&
      count !== null &&
      e.identity.sessionId !== null &&
      !detailSessions.has(e.identity.sessionId)
    );
  });

  const aggregateBySession = new Map<string, DxEventEnvelope>();

  for (const event of aggregates) {
    const session = event.identity.sessionId ?? "";
    const prior = aggregateBySession.get(session);
    const count = finite(fieldsOf(event).toolCalls) ?? 0;

    if (
      prior === undefined ||
      (finite(fieldsOf(prior).toolCalls) ?? 0) < count
    ) {
      aggregateBySession.set(session, event);
    }
  }

  for (const event of aggregateBySession.values()) {
    total += finite(fieldsOf(event).toolCalls) ?? 0;
    evidenceIds.push(evidenceOf(event));
  }

  const reports = detail.length + aggregateBySession.size;

  return {
    collapsedReports: collapsed + aggregates.length - aggregateBySession.size,
    evidenceIds,
    reports,
    sessionAggregatesUsed: aggregateBySession.size,
    total: reports === 0 ? null : total,
  };
};

export const collectFlightSignals = (
  snapshot: StoreSnapshot
): FlightSignals => {
  const branch = targetBranch(snapshot);

  const events =
    branch === null
      ? snapshot.events
      : snapshot.events.filter((e) => e.context.branch === branch);

  const excludedOtherBranch = snapshot.events.length - events.length;
  const asOfMs = toMs(snapshot.manifest.createdAt);
  const commits = commitPoints(events);
  const adapters = new Set(events.map((e) => e.adapterId));

  return {
    activityPoints: activityPoints(events),
    agentIntervals: agentIntervals(events),
    asOfMs,
    branch,
    commitHistoryCollected: snapshot.coverage.some(
      (c) => c.adapterId === "git-history" && c.state === "complete"
    ),
    commits,
    coverage: snapshot.coverage.filter((c) => adapters.has(c.adapterId)),
    end: branchEnd(events, asOfMs),
    excludedOtherBranch,
    start: branchStart(events, commits),
    toolCalls: tallyToolCalls(events),
  };
};
