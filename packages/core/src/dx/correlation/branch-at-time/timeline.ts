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
  readonly renamedFrom?: string;
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

const RETURNING =
  /(?:\((?:finish|abort)\)|finished): returning to refs\/heads\/(?<to>\S+)$/u;

const REBASE_START = /\(start\): checkout (?<to>\S+)$/u;

const REBASE_CHECKOUT = /^(?:pull --)?rebase(?: -i)?: checkout (?<to>\S+)$/u;

const RENAMED =
  /^Branch: renamed refs\/heads\/(?<from>\S+) to refs\/heads\/(?<to>\S+)$/u;

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
  readonly rebase?: boolean;
  readonly renamed?: boolean;
  readonly returning?: boolean;
  readonly to: string | null;
}

const transitionOf = (subject: string): Transition | null => {
  const checkout = CHECKOUT.exec(subject)?.groups;

  if (checkout?.to !== undefined) {
    return { from: checkout.from ?? null, to: checkout.to };
  }

  const renamed = RENAMED.exec(subject)?.groups;

  if (renamed?.from !== undefined && renamed.to !== undefined) {
    return { from: renamed.from, renamed: true, to: renamed.to };
  }

  const returning = RETURNING.exec(subject)?.groups?.to;

  if (returning !== undefined) {
    return { from: null, returning: true, to: returning };
  }

  if (REBASE_START.test(subject)) {
    return { from: null, to: null };
  }

  const rebased = REBASE_CHECKOUT.exec(subject)?.groups?.to;

  return rebased === undefined
    ? null
    : { from: null, rebase: true, to: rebased };
};

export const isHeadTransition = (subject: string): boolean =>
  transitionOf(subject) !== null;

const DETACHED_NAME = /^(?:[0-9a-f]{7,64}|HEAD)$|[~^:@\s]|^refs\/(?!heads\/)/u;

const looksLikeBranch = (name: string): boolean =>
  name !== "" && !DETACHED_NAME.test(name);

interface HeadState {
  readonly branch: string | null;
  readonly detached: boolean;
}

const DETACHED: HeadState = { branch: null, detached: true };

const stateOf = (
  name: string | null,
  branches: ReadonlySet<string>
): HeadState =>
  name !== null && (branches.has(name) || looksLikeBranch(name))
    ? { branch: name.replace(/^refs\/heads\//u, ""), detached: false }
    : DETACHED;

const nameGitLeft = (transition: Transition): string | null =>
  transition.returning === true ? transition.to : transition.from;

interface Leaving {
  readonly interrupted: boolean;
  readonly next: Transition | undefined;
  readonly stopped: boolean;
}

const stoppedRebases = (
  transitions: readonly (Transition | null)[]
): readonly boolean[] => {
  let stopped = false;

  return transitions.map((transition) => {
    const during = stopped;

    if (transition?.to === null) {
      stopped = true;
    } else if (transition?.returning === true) {
      stopped = false;
    }

    return during;
  });
};

const nextLeaving = (
  transitions: readonly (Transition | null)[]
): readonly Leaving[] => {
  const stopped = stoppedRebases(transitions);
  const leaving: Leaving[] = [];
  let next: Transition | undefined;
  let interrupted = false;

  for (const [index, transition] of [...transitions.entries()].toReversed()) {
    leaving[index] = {
      interrupted,
      next,
      stopped: stopped[index] ?? false,
    };

    if (transition !== null) {
      interrupted = transition.to === null;
      next = transition.to === null ? next : transition;
    }
  }

  return leaving;
};

const leftByName = (
  name: string,
  { interrupted, next, stopped }: Leaving,
  currentBranch: string | null,
  local: boolean
): boolean | null => {
  if (next === undefined) {
    if (interrupted) {
      return null;
    }

    return currentBranch === null ? false : currentBranch === name || null;
  }

  const left = nameGitLeft(next);

  if (left === name) {
    return true;
  }

  if (next.returning === true && !interrupted && !stopped) {
    return false;
  }

  return (!interrupted || !local) && left !== null && DETACHED_NAME.test(left)
    ? false
    : null;
};

interface CheckoutRefs {
  readonly branches: ReadonlySet<string>;
  readonly detachedRefs: ReadonlySet<string>;
}

const NOT_LEFT: Leaving = {
  interrupted: false,
  next: undefined,
  stopped: false,
};

const checkoutStateOf = (
  transition: Transition,
  { branches, detachedRefs }: CheckoutRefs,
  currentBranch: string | null,
  leaving: Leaving = NOT_LEFT
): HeadState => {
  const name = transition.to;

  if (
    name === null ||
    transition.renamed === true ||
    transition.returning === true ||
    (!branches.has(name) && !looksLikeBranch(name))
  ) {
    return stateOf(name, branches);
  }

  const byName = leftByName(name, leaving, currentBranch, branches.has(name));

  if (byName !== null) {
    return byName ? { branch: name, detached: false } : DETACHED;
  }

  if (transition.rebase === true && leaving.next?.returning === true) {
    return DETACHED;
  }

  return detachedRefs.has(name) && !branches.has(name)
    ? DETACHED
    : stateOf(name, branches);
};

const REF_PREFIXES = ["refs/", "refs/tags/", "refs/remotes/"] as const;

const namesOf = (
  entries: readonly RawReflogEntry[],
  sides: (transition: Transition) => readonly (string | null)[]
): ReadonlySet<string> =>
  new Set(
    entries.flatMap((entry) => {
      const transition = transitionOf(entry.subject);

      return transition === null
        ? []
        : sides(transition).flatMap((name) => (name === null ? [] : [name]));
    })
  );

export const detachedRefsOf = (
  entries: readonly RawReflogEntry[],
  refnames: readonly string[],
  remotes: readonly string[] = []
): readonly string[] => {
  const refs = new Set(refnames);

  return [...namesOf(entries, (transition) => [transition.to])]
    .filter(
      (name) =>
        looksLikeBranch(name) &&
        !refs.has(`refs/heads/${name}`) &&
        (REF_PREFIXES.some((prefix) => refs.has(`${prefix}${name}`)) ||
          refs.has(`refs/remotes/${name}/HEAD`) ||
          remotes.some((remote) => name.startsWith(`${remote}/`)))
    )
    .toSorted();
};

export const localBranchesOf = (
  entries: readonly RawReflogEntry[],
  refnames: readonly string[]
): readonly string[] => {
  const refs = new Set(refnames);

  return [...namesOf(entries, (transition) => [transition.from, transition.to])]
    .filter((name) => refs.has(`refs/heads/${name}`))
    .toSorted();
};

const renamedMove = (move: HeadMove, from: string, to: string): HeadMove => {
  const renamed: HeadMove = {
    ...move,
    branch: move.branch === from ? to : move.branch,
  };

  return move.owner === from ? { ...renamed, owner: to } : renamed;
};

export const followRenames = (
  moves: readonly HeadMove[]
): readonly HeadMove[] => {
  const followed = [...moves];

  for (const [index, rename] of moves.entries()) {
    const from = rename.renamedFrom;
    const to = rename.branch;

    if (from !== undefined && to !== null) {
      for (const [earlier, move] of followed.slice(0, index).entries()) {
        followed[earlier] = renamedMove(move, from, to);
      }
    }
  }

  return followed;
};

const moveAt = (
  atMs: number,
  state: { readonly branch: string | null; readonly detached: boolean },
  transition: Transition | null
): HeadMove =>
  transition?.renamed === true && transition.from !== null
    ? { atMs, ...state, renamedFrom: transition.from }
    : { atMs, ...state };

const initialNameOf = (
  transitions: readonly { readonly transition: Transition | null }[],
  currentBranch: string | null
): string | null => {
  const firstKnown = transitions.find((t) => t.transition !== null);

  const returnedTo =
    firstKnown?.transition?.to === null
      ? (transitions.find((t) => (t.transition?.to ?? null) !== null)
          ?.transition?.to ?? null)
      : null;

  return firstKnown === undefined
    ? currentBranch
    : (firstKnown.transition?.from ?? returnedTo);
};

export const buildHeadMoves = (
  entries: readonly RawReflogEntry[],
  branches: ReadonlySet<string>,
  currentBranch: string | null,
  detachedRefs: ReadonlySet<string> = new Set()
): readonly HeadMove[] => {
  const transitions = entries.map((entry) => ({
    atMs: entry.atMs,
    transition: transitionOf(entry.subject),
  }));

  const initialName = initialNameOf(transitions, currentBranch);

  let state =
    initialName === null
      ? { branch: null, detached: false }
      : stateOf(initialName, branches);

  const moves: { move: HeadMove; returning: boolean }[] = [];

  const leaving = nextLeaving(transitions.map((t) => t.transition));

  for (const [index, { atMs, transition }] of transitions.entries()) {
    if (transition !== null) {
      state = checkoutStateOf(
        transition,
        { branches, detachedRefs },
        currentBranch,
        leaving[index]
      );
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
        move: moveAt(atMs, state, transition),
        returning: transition?.returning === true,
      });
    }
  }

  const owned = moves.map(({ move }, index) => {
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

  return followRenames(owned);
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
