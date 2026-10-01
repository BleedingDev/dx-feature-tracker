import { Effect } from "effect";

import type { FlightContext } from "../../model/event.js";
import type { BranchSource } from "../ids.js";
import type { Placement } from "./events.js";
import { dirsBetween, isInside, isStrictAncestor } from "./paths.js";
import { recordedBranch } from "./rows.js";
import type { RequestPick } from "./scan.js";

export interface PlacedPick {
  readonly pick: RequestPick;
  readonly placement: Placement;
}

const atBranch = (
  context: FlightContext,
  branch: string | null,
  source: BranchSource
): Placement => ({
  branchSource: branch === null ? "unassigned" : source,
  context: {
    ...context,
    branch,
    headSha: branch === context.branch ? context.headSha : null,
  },
});

const insideWorktree = (
  context: FlightContext,
  pick: RequestPick
): Placement => {
  const recorded = recordedBranch(pick.row);

  return recorded === null
    ? atBranch(context, context.branch, "cwd-inferred")
    : atBranch(context, recorded, "harness-recorded");
};

const outsideWorktree = (pick: RequestPick): Placement => {
  const recorded = recordedBranch(pick.row);

  return atBranch(
    {
      branch: null,
      flightId: null,
      headSha: null,
      repoCommonDir: null,
      worktreePath: null,
    },
    recorded,
    "harness-recorded"
  );
};

const placeEverywhere = (
  context: FlightContext,
  picks: readonly RequestPick[]
): readonly PlacedPick[] =>
  picks.map((pick) => ({
    pick,
    placement:
      context.worktreePath !== null &&
      (pick.row.cwd === null || isInside(pick.row.cwd, context.worktreePath))
        ? insideWorktree(context, pick)
        : outsideWorktree(pick),
  }));

export const placePicks = (
  worktree: string | null,
  context: FlightContext,
  picks: readonly RequestPick[],
  isRepoRoot: (dir: string) => Effect.Effect<boolean>
): Effect.Effect<readonly PlacedPick[]> => {
  if (worktree === null) {
    return Effect.succeed(placeEverywhere(context, picks));
  }

  return Effect.gen(function* placeInWorktree() {
    const roots = new Map<string, boolean>();

    const nested = Effect.fnUntraced(function* nestedRepo(cwd: string) {
      for (const dir of dirsBetween(worktree, cwd)) {
        const known = roots.get(dir);
        const isRoot = known ?? (yield* isRepoRoot(dir));

        roots.set(dir, isRoot);

        if (isRoot) {
          return true;
        }
      }

      return false;
    });

    const own = new Set<RequestPick>();

    for (const pick of picks) {
      const { cwd } = pick.row;

      if (cwd !== null && isInside(cwd, worktree) && !(yield* nested(cwd))) {
        own.add(pick);
      }
    }

    const elsewhere = picks.some(
      (pick) =>
        pick.row.cwd !== null &&
        !own.has(pick) &&
        !isStrictAncestor(pick.row.cwd, worktree)
    );

    const orchestrated = own.size > 0 && !elsewhere;

    return picks.map((pick): PlacedPick => {
      if (own.has(pick)) {
        return { pick, placement: insideWorktree(context, pick) };
      }

      return orchestrated && isStrictAncestor(pick.row.cwd, worktree)
        ? { pick, placement: atBranch(context, context.branch, "tool-calls") }
        : { pick, placement: outsideWorktree(pick) };
    });
  });
};
