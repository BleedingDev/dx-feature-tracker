import { Context, Effect } from "effect";

import type { GitRunner } from "../../collectors/git-observation/git-runner.js";
import { spawnerGitRunner } from "../../collectors/git-observation/git-runner.js";
import type { DxEventEnvelope } from "../../model/event.js";
import {
  attributeHistoricalBranches,
  timelineWorktreesOf,
} from "./attribute.js";
import type { HistoricalAttributionResult } from "./attribute.js";
import { loadWorktreeTimeline } from "./git.js";
import type { LoadedTimeline } from "./git.js";
import { joinAccountRows } from "./session-join.js";
import { storedHeadHistory, withStoredHistory } from "./stored-moves.js";
import { DEFAULT_BRANCH_AT_OPTIONS } from "./timeline.js";
import type { BranchAtOptions } from "./timeline.js";
import { loadRepoMaps, placeEventsInWorktrees } from "./worktree.js";
import type { WorktreePlacement } from "./worktree.js";

export interface ReattributionResult extends HistoricalAttributionResult {
  readonly placements: readonly WorktreePlacement[];
}

export type TimelineLoader = (
  runGit: GitRunner,
  worktree: string
) => Effect.Effect<LoadedTimeline>;

export const WorktreeTimelines = Context.Reference<TimelineLoader>(
  "dx/correlation/branch-at-time/WorktreeTimelines",
  { defaultValue: () => loadWorktreeTimeline }
);

export const sharedTimelines = (): TimelineLoader => {
  const loaded = new Map<string, LoadedTimeline>();

  return (runGit, worktree) =>
    Effect.suspend(() => {
      const known = loaded.get(worktree);

      return known === undefined
        ? Effect.tap(loadWorktreeTimeline(runGit, worktree), (timeline) =>
            Effect.sync(() => loaded.set(worktree, timeline))
          )
        : Effect.succeed(known);
    });
};

const OBSERVATION_KIND = "git.observation";

export const worktreesOf = (
  events: readonly DxEventEnvelope[],
  extra: readonly string[] = []
): readonly string[] =>
  [
    ...new Set([
      ...extra,
      ...events.flatMap((e) =>
        e.context.worktreePath === null ? [] : [e.context.worktreePath]
      ),
    ]),
  ].map((path) => path.replace(/\/+$/u, ""));

export const reattributeWithRunner = (
  runGit: GitRunner,
  events: readonly DxEventEnvelope[],
  worktrees: readonly string[] = [],
  options: BranchAtOptions = DEFAULT_BRANCH_AT_OPTIONS
): Effect.Effect<ReattributionResult> =>
  Effect.gen(function* reattribute() {
    const maps = yield* loadRepoMaps(
      runGit,
      events.filter((event) => event.kind !== OBSERVATION_KIND)
    );

    const placed = placeEventsInWorktrees(maps, events);
    const joined = joinAccountRows(placed.events);
    const load = yield* WorktreeTimelines;

    const needed = new Set([
      ...worktreesOf([], worktrees),
      ...timelineWorktreesOf(joined, worktreesOf(joined, worktrees)),
    ]);

    const loaded = yield* Effect.forEach(
      needed,
      (worktree) => load(runGit, worktree),
      { concurrency: 2 }
    );

    const history = storedHeadHistory(events);

    const attributed = attributeHistoricalBranches(joined, {
      commitBranches: new Map(
        loaded.flatMap((l) => [...l.commitBranches.entries()])
      ),
      options,
      timelines: loaded.map((l) => withStoredHistory(l.timeline, history)),
    });

    return { ...attributed, placements: placed.placements };
  });

export const reattributeHistoricalBranches = (
  events: readonly DxEventEnvelope[],
  worktrees: readonly string[] = [],
  options: BranchAtOptions = DEFAULT_BRANCH_AT_OPTIONS
) =>
  Effect.gen(function* reattributeLive() {
    const runGit = yield* spawnerGitRunner;

    return yield* reattributeWithRunner(runGit, events, worktrees, options);
  });
