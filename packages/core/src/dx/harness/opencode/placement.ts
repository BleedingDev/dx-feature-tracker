import type { GitAt } from "../git.js";
import { notARepo } from "../git.js";
import type { BranchSource } from "../ids.js";
import type { OcRequest, OcSessionView } from "./sessions.js";

export interface Placement {
  readonly branchSource: BranchSource;
  readonly git: GitAt;
  readonly share: number;
}

export type GitLookup = (path: string) => GitAt;

const isRepo = (git: GitAt): boolean => git.worktreePath !== null;

const parentDir = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");

  return index <= 0 ? "/" : trimmed.slice(0, index);
};

export const pathCandidates = (path: string): readonly string[] => [
  path,
  parentDir(path),
];

export const gitOfPath = (lookup: GitLookup, path: string): GitAt => {
  for (const candidate of pathCandidates(path)) {
    const git = lookup(candidate);

    if (isRepo(git)) {
      return git;
    }
  }

  return notARepo;
};

const whole = (git: GitAt, source: BranchSource): Placement => ({
  branchSource: git.branch === null ? "unassigned" : source,
  git,
  share: 1,
});

const unplaced: Placement = {
  branchSource: "unassigned",
  git: notARepo,
  share: 1,
};

const tokenWeight = (request: OcRequest): number =>
  request.tokens === null
    ? 0
    : request.tokens.input +
      request.tokens.output +
      request.tokens.reasoning +
      request.tokens.cacheRead +
      request.tokens.cacheWrite;

const turnKey = (request: OcRequest): string =>
  request.turnId ?? `request:${request.message.id}`;

const toolWorktrees = (
  lookup: GitLookup,
  requests: readonly OcRequest[]
): ReadonlyMap<string, GitAt> => {
  const found = new Map<string, GitAt>();

  for (const request of requests) {
    for (const path of request.message.paths) {
      const git = gitOfPath(lookup, path);

      if (git.worktreePath !== null) {
        found.set(git.worktreePath, git);
      }
    }
  }

  return found;
};

export const toolPathsToResolve = (
  views: readonly OcSessionView[],
  lookup: GitLookup
): readonly string[] =>
  views.flatMap((view) =>
    view.requests.flatMap((request) =>
      isRepo(lookup(request.cwd))
        ? []
        : request.message.paths.flatMap(pathCandidates)
    )
  );

export interface SessionPlacement {
  readonly requests: ReadonlyMap<string, readonly Placement[]>;
  readonly session: Placement;
}

interface OwnPlacement {
  readonly placed: Map<string, Placement>;
  readonly weights: Map<string, { git: GitAt; weight: number }>;
}

const ownPlacement = (view: OcSessionView, lookup: GitLookup): OwnPlacement => {
  const placed = new Map<string, Placement>();
  const weights = new Map<string, { git: GitAt; weight: number }>();
  const byTurn = new Map<string, OcRequest[]>();

  for (const request of view.requests) {
    byTurn.set(turnKey(request), [
      ...(byTurn.get(turnKey(request)) ?? []),
      request,
    ]);
  }

  const record = (request: OcRequest, placement: Placement) => {
    placed.set(request.message.id, placement);

    const worktree = placement.git.worktreePath;

    if (worktree !== null) {
      const prior = weights.get(worktree);
      weights.set(worktree, {
        git: placement.git,
        weight: (prior?.weight ?? 0) + tokenWeight(request),
      });
    }
  };

  for (const request of view.requests) {
    const own = lookup(request.cwd);

    if (isRepo(own)) {
      record(request, whole(own, "cwd-inferred"));
    } else {
      const touched = toolWorktrees(lookup, byTurn.get(turnKey(request)) ?? []);
      const [only] = [...touched.values()];

      if (touched.size === 1 && only !== undefined) {
        record(request, whole(only, "tool-calls"));
      }
    }
  }

  return { placed, weights };
};

const splitAcross = (
  weights: readonly { git: GitAt; weight: number }[]
): readonly Placement[] => {
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);

  if (total <= 0) {
    return [];
  }

  return weights
    .toSorted(
      (a, b) =>
        b.weight - a.weight ||
        (a.git.worktreePath ?? "").localeCompare(b.git.worktreePath ?? "")
    )
    .map((entry) => ({
      branchSource:
        entry.git.branch === null
          ? ("unassigned" as const)
          : ("subagent-split" as const),
      git: entry.git,
      share: entry.weight / total,
    }));
};

const childWeights = (
  view: OcSessionView,
  children: readonly OcSessionView[],
  own: ReadonlyMap<string, OwnPlacement>
) => {
  const merged = new Map<string, { git: GitAt; weight: number }>();

  for (const child of children) {
    for (const [worktree, entry] of own.get(child.session.id)?.weights ?? []) {
      const prior = merged.get(worktree);
      merged.set(worktree, {
        git: entry.git,
        weight: (prior?.weight ?? 0) + entry.weight,
      });
    }
  }

  return view.session.parentId === null ? [...merged.values()] : [];
};

export const placeSessions = (
  views: readonly OcSessionView[],
  lookup: GitLookup
): ReadonlyMap<string, SessionPlacement> => {
  const own = new Map(
    views.map((view) => [view.session.id, ownPlacement(view, lookup)] as const)
  );

  const byId = new Map(views.map((view) => [view.session.id, view] as const));
  const result = new Map<string, SessionPlacement>();

  for (const view of views) {
    const mine = own.get(view.session.id);
    const sessionGit = lookup(view.cwd);

    const parent =
      view.session.parentId === null
        ? undefined
        : byId.get(view.session.parentId);

    const parentGit = parent === undefined ? notARepo : lookup(parent.cwd);

    const children = views.filter(
      (other) => other.session.parentId === view.session.id
    );

    const split = splitAcross(childWeights(view, children, own));

    const inherited: readonly Placement[] = isRepo(parentGit)
      ? [whole(parentGit, "cwd-inferred")]
      : split;

    const fallback = inherited.length === 0 ? [unplaced] : inherited;

    const requests = new Map<string, readonly Placement[]>();

    for (const request of view.requests) {
      const placed = mine?.placed.get(request.message.id);

      requests.set(
        request.message.id,
        placed === undefined ? fallback : [placed]
      );
    }

    const [firstPlaced] = [...requests.values()].flat();

    result.set(view.session.id, {
      requests,
      session: isRepo(sessionGit)
        ? whole(sessionGit, "cwd-inferred")
        : (firstPlaced ?? unplaced),
    });
  }

  return result;
};
