import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../../model/event.js";
import { buildHeadMoves, followRenames } from "./timeline.js";
import type { HeadMove, RawReflogEntry, WorktreeTimeline } from "./timeline.js";

const HeadMovesSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  detachedRefs: Schema.optional(Schema.Array(Schema.String)),
  localBranches: Schema.optional(Schema.Array(Schema.String)),
  observationKind: Schema.Literal("head-moves"),
  startedAt: Schema.String,
  transitions: Schema.Array(
    Schema.Struct({ at: Schema.String, subject: Schema.String })
  ),
});

const decodeHeadMoves = Schema.decodeUnknownOption(HeadMovesSchema);

export interface Incarnation {
  branch: string | null;
  readonly detachedRefs: Set<string>;
  latestMs: number;
  readonly localBranches: Set<string>;
  readonly startMs: number;
  readonly transitions: Map<string, RawReflogEntry>;
}

const trimmed = (path: string): string => path.replace(/\/+$/u, "");

const msOf = (iso: string): number | null => {
  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? null : ms;
};

export type StoredHeadHistory = ReadonlyMap<string, readonly Incarnation[]>;

export const storedHeadHistory = (
  events: readonly DxEventEnvelope[]
): StoredHeadHistory => {
  const byWorktree = new Map<string, Map<number, Incarnation>>();

  for (const event of events) {
    const worktree = event.context.worktreePath;
    const found = Option.getOrNull(decodeHeadMoves(event.payload));
    const startMs = found === null ? null : msOf(found.startedAt);

    if (
      event.kind === "git.observation" &&
      worktree !== null &&
      found !== null &&
      startMs !== null
    ) {
      const key = trimmed(worktree);
      const seenMs = msOf(event.observedAt) ?? 0;

      const incarnations =
        byWorktree.get(key) ?? new Map<number, Incarnation>();

      const incarnation: Incarnation = incarnations.get(startMs) ?? {
        branch: found.branch,
        detachedRefs: new Set(),
        latestMs: seenMs,
        localBranches: new Set(),
        startMs,
        transitions: new Map(),
      };

      if (seenMs >= incarnation.latestMs) {
        incarnation.branch = found.branch;
        incarnation.latestMs = seenMs;
      }

      for (const name of found.detachedRefs ?? []) {
        incarnation.detachedRefs.add(name);
      }

      for (const name of found.localBranches ?? []) {
        incarnation.localBranches.add(name);
      }

      for (const transition of found.transitions) {
        const atMs = msOf(transition.at);

        if (atMs !== null) {
          incarnation.transitions.set(`${atMs}\u0000${transition.subject}`, {
            atMs,
            subject: transition.subject,
          });
        }
      }

      incarnations.set(startMs, incarnation);
      byWorktree.set(key, incarnations);
    }
  }

  return new Map(
    [...byWorktree].map(([key, incarnations]) => [
      key,
      [...incarnations.values()].toSorted((a, b) => a.startMs - b.startMs),
    ])
  );
};

const movesOf = (incarnation: Incarnation): readonly HeadMove[] =>
  buildHeadMoves(
    [
      { atMs: incarnation.startMs, subject: "" },
      ...[...incarnation.transitions.values()].toSorted(
        (a, b) => a.atMs - b.atMs
      ),
    ],
    incarnation.localBranches,
    incarnation.branch,
    incarnation.detachedRefs
  );

export const withStoredHistory = (
  timeline: WorktreeTimeline,
  history: StoredHeadHistory
): WorktreeTimeline => {
  const liveFrom = timeline.reflogFromMs ?? Number.POSITIVE_INFINITY;

  const older = (history.get(trimmed(timeline.worktree)) ?? []).filter(
    (incarnation) => incarnation.startMs < liveFrom
  );

  const moves = older.flatMap((incarnation, index) => {
    const until = Math.min(older[index + 1]?.startMs ?? liveFrom, liveFrom);

    return movesOf(incarnation).filter((move) => move.atMs < until);
  });

  const [first] = moves;

  return first === undefined
    ? timeline
    : {
        ...timeline,
        moves: followRenames([...moves, ...timeline.moves]),
        reflogFromMs: first.atMs,
      };
};
