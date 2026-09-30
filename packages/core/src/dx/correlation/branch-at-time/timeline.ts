import { DateTime, Option } from "effect";

import type { AttributionState } from "../../model/common.js";

export type BranchAtMethod = "reflog" | "commit-graph" | "current" | "unknown";

export interface BranchAt {
  readonly attribution: AttributionState;
  readonly branch: string | null;
  readonly confidence: number;
  readonly detached: boolean;
  readonly method: BranchAtMethod;
  readonly reason: string;
}

export interface HeadMove {
  readonly atMs: number;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly owner?: string;
}

export type EvidencePointSource = "branch-reflog" | "commit";

export interface BranchEvidencePoint {
  readonly atMs: number;
  readonly branch: string;
  readonly source: EvidencePointSource;
}

export interface WorktreeTimeline {
  readonly currentBranch: string | null;
  readonly currentSinceMs: number | null;
  readonly moves: readonly HeadMove[];
  readonly points: readonly BranchEvidencePoint[];
  readonly reflogFromMs: number | null;
  readonly worktree: string;
}

export interface RawReflogEntry {
  readonly atMs: number;
  readonly subject: string;
}

export interface BranchAtOptions {
  readonly windowMs: number;
}

export const DEFAULT_BRANCH_AT_OPTIONS: BranchAtOptions = {
  windowMs: 24 * 60 * 60 * 1000,
};

export const REFLOG_CONFIDENCE = 0.95;

const SELECTOR_DATE = /@\{(?<date>[^}]+)\}$/u;

const CHECKOUT = /^checkout: moving from (?<from>\S+) to (?<to>\S+)$/u;

const RETURNING = /\(finish\): returning to refs\/heads\/(?<to>\S+)$/u;

const REBASE_START = /\(start\): checkout (?<to>\S+)$/u;

const BRANCH_ACTIVITY = /^(?:commit|merge|cherry-pick|revert)\b/u;

export const isoOf = (ms: number): string =>
  Option.match(DateTime.make(ms), {
    onNone: () => `${ms}ms`,
    onSome: DateTime.formatIso,
  });

const parseMs = (text: string): number | null => {
  const ms = Date.parse(text);

  return Number.isNaN(ms) ? null : ms;
};

export const parseReflogLines = (text: string): readonly RawReflogEntry[] =>
  text
    .split("\n")
    .flatMap((line) => {
      const [selector = "", subject = ""] = line.split("\u001F");
      const date = SELECTOR_DATE.exec(selector.trim())?.groups?.date;
      const atMs = date === undefined ? null : parseMs(date);

      return atMs === null ? [] : [{ atMs, subject: subject.trim() }];
    })
    .toReversed()
    .toSorted((a, b) => a.atMs - b.atMs);

interface Transition {
  readonly from: string | null;
  readonly returning?: boolean;
  readonly to: string | null;
}

const transitionOf = (subject: string): Transition | null => {
  const checkout = CHECKOUT.exec(subject)?.groups;

  if (checkout?.to !== undefined) {
    return { from: checkout.from ?? null, to: checkout.to };
  }

  const returning = RETURNING.exec(subject)?.groups?.to;

  if (returning !== undefined) {
    return { from: null, returning: true, to: returning };
  }

  const started = REBASE_START.exec(subject)?.groups?.to;

  return started === undefined ? null : { from: null, to: null };
};

const stateOf = (
  name: string | null,
  branches: ReadonlySet<string>
): { readonly branch: string | null; readonly detached: boolean } =>
  name !== null && branches.has(name)
    ? { branch: name, detached: false }
    : { branch: null, detached: true };

export const buildHeadMoves = (
  entries: readonly RawReflogEntry[],
  branches: ReadonlySet<string>,
  currentBranch: string | null
): readonly HeadMove[] => {
  const transitions = entries.map((entry) => ({
    atMs: entry.atMs,
    transition: transitionOf(entry.subject),
  }));

  const firstKnown = transitions.find((t) => t.transition !== null);

  const returnedTo =
    firstKnown?.transition?.to === null
      ? (transitions.find((t) => (t.transition?.to ?? null) !== null)
          ?.transition?.to ?? null)
      : null;

  const initialName =
    firstKnown === undefined
      ? currentBranch
      : (firstKnown.transition?.from ?? returnedTo);

  let state =
    initialName === null
      ? { branch: null, detached: false }
      : stateOf(initialName, branches);

  const moves: { move: HeadMove; returning: boolean }[] = [];

  for (const { atMs, transition } of transitions) {
    if (transition !== null) {
      state = stateOf(transition.to, branches);
    }

    const last = moves.at(-1)?.move;
    const known = state.branch !== null || state.detached;

    if (
      known &&
      (last === undefined ||
        last.branch !== state.branch ||
        last.detached !== state.detached)
    ) {
      moves.push({
        move: { atMs, ...state },
        returning: transition?.returning === true,
      });
    }
  }

  return moves.map(({ move }, index) => {
    if (!move.detached) {
      return move;
    }

    const next = moves[index + 1];

    const before = moves.slice(0, index).findLast((m) => m.move.branch !== null)
      ?.move.branch;

    const after = moves.slice(index + 1).find((m) => m.move.branch !== null)
      ?.move.branch;

    const owner =
      next?.returning === true && next.move.branch !== null
        ? next.move.branch
        : (before ?? after ?? null);

    return owner === null ? move : { ...move, owner };
  });
};

export const branchActivityPoints = (
  branch: string,
  entries: readonly RawReflogEntry[]
): readonly BranchEvidencePoint[] =>
  entries.flatMap((entry) =>
    BRANCH_ACTIVITY.test(entry.subject)
      ? [{ atMs: entry.atMs, branch, source: "branch-reflog" as const }]
      : []
  );

const unknown = (reason: string): BranchAt => ({
  attribution: "unassigned",
  branch: null,
  confidence: 0,
  detached: false,
  method: "unknown",
  reason,
});

const fromReflog = (
  timeline: WorktreeTimeline,
  instantMs: number
): BranchAt | null => {
  if (timeline.reflogFromMs === null || instantMs < timeline.reflogFromMs) {
    return null;
  }

  const move = timeline.moves.findLast((m) => m.atMs <= instantMs);

  if (move === undefined) {
    return null;
  }

  if (move.detached && move.owner !== undefined) {
    return {
      attribution: "provisional",
      branch: move.owner,
      confidence: 0.6,
      detached: true,
      method: "reflog",
      reason: `HEAD reflog: detached since ${isoOf(move.atMs)} (rebase, bisect or commit checkout); attributed to ${move.owner}, the branch checked out around it`,
    };
  }

  if (move.detached || move.branch === null) {
    return {
      attribution: "unassigned",
      branch: null,
      confidence: REFLOG_CONFIDENCE,
      detached: true,
      method: "reflog",
      reason: `HEAD reflog: detached since ${isoOf(move.atMs)}`,
    };
  }

  return {
    attribution: "strong",
    branch: move.branch,
    confidence: REFLOG_CONFIDENCE,
    detached: false,
    method: "reflog",
    reason: `HEAD reflog: on ${move.branch} since ${isoOf(move.atMs)}`,
  };
};

const nearest = (
  points: readonly BranchEvidencePoint[],
  instantMs: number,
  windowMs: number
) => {
  const [before] = points
    .filter((p) => p.atMs <= instantMs && instantMs - p.atMs <= windowMs)
    .toSorted((a, b) => b.atMs - a.atMs);

  const [after] = points
    .filter((p) => p.atMs > instantMs && p.atMs - instantMs <= windowMs)
    .toSorted((a, b) => a.atMs - b.atMs);

  return { after, before };
};

const pickNearer = (
  before: BranchEvidencePoint | undefined,
  after: BranchEvidencePoint | undefined,
  instantMs: number
): BranchEvidencePoint | undefined => {
  if (before === undefined || after === undefined) {
    return before ?? after;
  }

  return instantMs - before.atMs <= after.atMs - instantMs ? before : after;
};

const confidenceOf = (agree: boolean, conflict: boolean): number => {
  if (agree) {
    return 0.7;
  }

  return conflict ? 0.35 : 0.5;
};

const fromCommitGraph = (
  timeline: WorktreeTimeline,
  instantMs: number,
  options: BranchAtOptions
): BranchAt | null => {
  const { after, before } = nearest(
    timeline.points,
    instantMs,
    options.windowMs
  );

  const chosen = pickNearer(before, after, instantMs);

  if (chosen === undefined) {
    return null;
  }

  const both = before !== undefined && after !== undefined;
  const agree = both && before.branch === after.branch;
  const conflict = both && !agree;
  const confidence = confidenceOf(agree, conflict);
  const hours = Math.round(options.windowMs / 3_600_000);

  return {
    attribution: "provisional",
    branch: chosen.branch,
    confidence,
    detached: false,
    method: "commit-graph",
    reason: `provisional: nearest ${chosen.source} evidence on ${chosen.branch} at ${isoOf(chosen.atMs)} within ${hours}h${agree ? "; bracketed on both sides" : ""}${conflict ? "; neighbours disagree" : ""}`,
  };
};

const fromCurrent = (
  timeline: WorktreeTimeline,
  instantMs: number
): BranchAt | null =>
  timeline.moves.length === 0 &&
  timeline.currentBranch !== null &&
  timeline.currentSinceMs !== null &&
  instantMs >= timeline.currentSinceMs
    ? {
        attribution: "provisional",
        branch: timeline.currentBranch,
        confidence: 0.4,
        detached: false,
        method: "current",
        reason: `no HEAD reflog; instant is after the tip of the current branch ${timeline.currentBranch}`,
      }
    : null;

export const branchAt = (
  timeline: WorktreeTimeline,
  instantMs: number,
  options: BranchAtOptions = DEFAULT_BRANCH_AT_OPTIONS
): BranchAt => {
  if (!Number.isFinite(instantMs)) {
    return unknown("instant is not a finite time");
  }

  return (
    fromReflog(timeline, instantMs) ??
    fromCommitGraph(timeline, instantMs, options) ??
    fromCurrent(timeline, instantMs) ??
    unknown(
      timeline.reflogFromMs === null
        ? "no HEAD reflog and no commit evidence near the instant"
        : `instant is before HEAD reflog retention (${isoOf(timeline.reflogFromMs)}) and no commit evidence is near it`
    )
  );
};

export const segmentsOf = (
  timeline: WorktreeTimeline,
  untilMs: number
): readonly {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly fromMs: number;
  readonly toMs: number;
}[] =>
  timeline.moves.map((move, index) => ({
    branch: move.branch,
    detached: move.detached,
    fromMs: move.atMs,
    toMs: timeline.moves[index + 1]?.atMs ?? untilMs,
  }));
