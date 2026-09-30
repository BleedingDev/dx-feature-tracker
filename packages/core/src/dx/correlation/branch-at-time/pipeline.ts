import { Effect } from "effect";

import type { GitRunner } from "../../collectors/git-observation/git-runner.js";
import { spawnerGitRunner } from "../../collectors/git-observation/git-runner.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { attributeHistoricalBranches } from "./attribute.js";
import type { HistoricalAttributionResult } from "./attribute.js";
import { loadWorktreeTimeline } from "./git.js";
import { joinAccountRows } from "./session-join.js";
import { DEFAULT_BRANCH_AT_OPTIONS } from "./timeline.js";
import type { BranchAtOptions } from "./timeline.js";
import { loadRepoMaps, placeEventsInWorktrees } from "./worktree.js";
import type { WorktreePlacement } from "./worktree.js";

export interface ReattributionResult extends HistoricalAttributionResult {
  readonly placements: readonly WorktreePlacement[];
}

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
    const maps = yield* loadRepoMaps(runGit, events);
    const placed = placeEventsInWorktrees(maps, events);
    const joined = joinAccountRows(placed.events);

    const loaded = yield* Effect.forEach(
      [...new Set(worktreesOf(joined, worktrees))],
      (worktree) => loadWorktreeTimeline(runGit, worktree),
      { concurrency: 2 }
    );

    const attributed = attributeHistoricalBranches(joined, {
      commitBranches: new Map(
        loaded.flatMap((l) => [...l.commitBranches.entries()])
      ),
      options,
      timelines: loaded.map((l) => l.timeline),
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
