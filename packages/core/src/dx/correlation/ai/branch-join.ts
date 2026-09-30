import type { CorrelationMapping } from "../../contracts/services.js";
import type { AttributionState } from "../../model/common.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { EvidenceId } from "../../model/ids.js";
import { EvidenceIdSchema } from "../../model/ids.js";
import { payloadView } from "./claim.js";
import type { AiClaim } from "./claim.js";

export const DEFAULT_WINDOW_PAD_MS = 5 * 60_000;

export interface BranchAttribution {
  readonly attribution: AttributionState;
  readonly branch: string | null;
  readonly evidenceIds: readonly EvidenceId[];
  readonly reason: string;
}

interface BranchWindow {
  readonly branch: string;
  readonly endMs: number;
  readonly evidenceIds: readonly EvidenceId[];
  readonly startMs: number;
}

export interface BranchIndex {
  readonly mapped: ReadonlyMap<string, string>;
  readonly sessionBranches: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly EvidenceId[]>
  >;
  readonly windows: readonly BranchWindow[];
}

const SESSION_PREFIX = "session:";

const directBranch = (event: DxEventEnvelope): string | null =>
  event.context.branch !== null &&
  event.context.branch !== "" &&
  event.context.worktreePath !== null &&
  event.context.headSha !== null
    ? event.context.branch
    : null;

export const buildBranchIndex = (
  events: readonly DxEventEnvelope[],
  mappings: readonly CorrelationMapping[]
): BranchIndex => {
  const mapped = new Map(
    mappings.flatMap((mapping): [string, string][] =>
      mapping.key.startsWith(SESSION_PREFIX)
        ? [[mapping.key.slice(SESSION_PREFIX.length), mapping.value]]
        : []
    )
  );

  const sessionBranches = new Map<string, Map<string, EvidenceId[]>>();

  const spans = new Map<
    string,
    { start: number; end: number; ids: EvidenceId[] }
  >();

  for (const event of events) {
    const { branch } = event.context;
    const { sessionId } = event.identity;
    const evidenceId = EvidenceIdSchema.make(event.eventId);

    if (
      branch !== null &&
      branch !== "" &&
      sessionId !== null &&
      sessionId !== ""
    ) {
      const byBranch =
        sessionBranches.get(sessionId) ?? new Map<string, EvidenceId[]>();

      byBranch.set(branch, [...(byBranch.get(branch) ?? []), evidenceId]);
      sessionBranches.set(sessionId, byBranch);
    }

    const direct = directBranch(event);

    const ms =
      event.occurredAt === null ? Number.NaN : Date.parse(event.occurredAt);

    if (
      direct !== null &&
      !Number.isNaN(ms) &&
      payloadView(event).aggregate !== true
    ) {
      const span = spans.get(direct);
      spans.set(
        direct,
        span === undefined
          ? { end: ms, ids: [evidenceId], start: ms }
          : {
              end: Math.max(span.end, ms),
              ids: [...span.ids, evidenceId],
              start: Math.min(span.start, ms),
            }
      );
    }
  }

  return {
    mapped,
    sessionBranches,
    windows: [...spans.entries()].map(([branch, span]) => ({
      branch,
      endMs: span.end,
      evidenceIds: span.ids,
      startMs: span.start,
    })),
  };
};

const unassigned = (reason: string): BranchAttribution => ({
  attribution: "unassigned",
  branch: null,
  evidenceIds: [],
  reason,
});

const byTimeWindow = (
  claim: AiClaim,
  index: BranchIndex,
  padMs: number
): BranchAttribution => {
  const at = claim.occurredMs;

  if (at === null) {
    return unassigned("no branch context, session join or timestamp");
  }

  const hits = index.windows.filter(
    (window) => at >= window.startMs - padMs && at <= window.endMs + padMs
  );

  const [only] = hits;

  if (hits.length === 1 && only !== undefined) {
    return {
      attribution: "provisional",
      branch: only.branch,
      evidenceIds: only.evidenceIds,
      reason: `time-window only: inside the observed activity window of ${only.branch}`,
    };
  }

  return unassigned(
    hits.length === 0
      ? "no branch context and outside every observed branch activity window"
      : `ambiguous time window: overlaps ${hits.map((hit) => hit.branch).join(",")}`
  );
};

export const attributeBranch = (
  claim: AiClaim,
  index: BranchIndex,
  padMs: number = DEFAULT_WINDOW_PAD_MS
): BranchAttribution => {
  if (claim.aggregate) {
    return unassigned(
      `${claim.sourceKind} is an aggregate ledger spanning branches; not allocated`
    );
  }

  const { context, identity } = claim.event;
  const { sessionId } = identity;

  const mappedBranch =
    sessionId === null ? undefined : index.mapped.get(sessionId);

  if (mappedBranch !== undefined) {
    return {
      attribution: "strong",
      branch: mappedBranch,
      evidenceIds: [claim.evidenceId],
      reason: `explicit session mapping session:${sessionId ?? ""}`,
    };
  }

  if (context.branch !== null && context.branch !== "") {
    const complete = context.worktreePath !== null && context.headSha !== null;

    return {
      attribution: complete ? "strong" : "provisional",
      branch: context.branch,
      evidenceIds: [claim.evidenceId],
      reason: complete
        ? "captured with branch, worktree and head"
        : "branch name captured without worktree/head; branch names can be shared across worktrees",
    };
  }

  const sessionBranches =
    sessionId === null ? undefined : index.sessionBranches.get(sessionId);

  if (sessionBranches !== undefined && sessionBranches.size > 0) {
    const entries = [...sessionBranches.entries()];
    const [first] = entries;

    if (entries.length === 1 && first !== undefined) {
      return {
        attribution: "provisional",
        branch: first[0],
        evidenceIds: first[1],
        reason: `joined via conversation ${sessionId ?? ""}, whose branch-bearing events all name ${first[0]}`,
      };
    }

    return unassigned(
      `conversation ${sessionId ?? ""} spans branches ${entries.map(([name]) => name).join(",")}`
    );
  }

  return byTimeWindow(claim, index, padMs);
};
