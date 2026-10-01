import { Effect } from "effect";

import type { GitRunner } from "../../collectors/git-observation/git-runner.js";
import type { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import {
  branchActivityPoints,
  buildHeadMoves,
  parseReflogLines,
} from "./timeline.js";
import type { BranchEvidencePoint, WorktreeTimeline } from "./timeline.js";

export const REFLOG_FORMAT = "--format=%gd%x1f%gs";

export const MAX_REFLOG_ENTRIES = 5000;

export const MAX_BRANCHES = 200;

export const MAX_COMMITS_PER_BRANCH = 2000;

const orEmpty = (effect: Effect.Effect<string, SourceUnavailable>) =>
  effect.pipe(Effect.orElseSucceed(() => ""));

export const reflogArgs = (ref: string): readonly string[] => [
  "log",
  "-g",
  "--date=iso-strict",
  REFLOG_FORMAT,
  "-n",
  String(MAX_REFLOG_ENTRIES),
  ref,
  "--",
];

export const parseCommitTimes = (
  branch: string,
  text: string
): readonly BranchEvidencePoint[] =>
  text.split("\n").flatMap((line) => {
    const [, seconds = ""] = line.trim().split("\u001F");
    const atMs = Number(seconds) * 1000;

    return seconds === "" || !Number.isFinite(atMs)
      ? []
      : [{ atMs, branch, source: "commit" as const }];
  });

export const commitBranchMap = (
  branch: string,
  text: string
): readonly (readonly [string, string])[] =>
  text.split("\n").flatMap((line) => {
    const [sha = ""] = line.trim().split("\u001F");

    return sha === "" ? [] : [[sha, branch] as const];
  });

export interface LoadedTimeline {
  readonly commitBranches: ReadonlyMap<string, string>;
  readonly timeline: WorktreeTimeline;
}

export const loadWorktreeTimeline = (
  runGit: GitRunner,
  worktree: string
): Effect.Effect<LoadedTimeline> =>
  Effect.gen(function* loadTimeline() {
    const current = (yield* orEmpty(
      runGit(worktree, ["symbolic-ref", "-q", "--short", "HEAD"])
    )).trim();

    const branches = (yield* orEmpty(
      runGit(worktree, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ])
    ))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(0, MAX_BRANCHES);

    const headEntries = parseReflogLines(
      yield* orEmpty(runGit(worktree, reflogArgs("HEAD")))
    );

    const currentBranch = current === "" ? null : current;
    const moves = buildHeadMoves(headEntries, new Set(branches), currentBranch);

    const perBranch = yield* Effect.forEach(
      branches,
      (branch) =>
        Effect.gen(function* loadBranch() {
          const reflog = parseReflogLines(
            yield* orEmpty(runGit(worktree, reflogArgs(`refs/heads/${branch}`)))
          );

          const exclusive = yield* orEmpty(
            runGit(worktree, [
              "log",
              "--format=%H%x1f%ct",
              "-n",
              String(MAX_COMMITS_PER_BRANCH),
              `refs/heads/${branch}`,
              "--not",
              `--exclude=${branch}`,
              "--branches",
              "--",
            ])
          );

          return {
            commits: commitBranchMap(branch, exclusive),
            points: [
              ...branchActivityPoints(branch, reflog),
              ...parseCommitTimes(branch, exclusive),
            ],
          };
        }),
      { concurrency: 4 }
    );

    const tip =
      currentBranch === null
        ? ""
        : yield* orEmpty(runGit(worktree, ["log", "-1", "--format=%ct"]));

    const tipSeconds = Number(tip.trim());

    return {
      commitBranches: new Map(perBranch.flatMap((b) => b.commits)),
      timeline: {
        currentBranch,
        currentSinceMs:
          tip.trim() === "" || !Number.isFinite(tipSeconds)
            ? null
            : tipSeconds * 1000,
        moves,
        points: perBranch
          .flatMap((b) => b.points)
          .toSorted((a, b) => a.atMs - b.atMs),
        reflogFromMs: moves[0]?.atMs ?? null,
        worktree,
      },
    };
  });
