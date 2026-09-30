import type { FlightContext } from "../../model/event.js";
import { normalizePath, relativeWithin } from "./path.js";

export interface WorktreeRecord {
  readonly bare: boolean;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly headSha: string | null;
  readonly path: string;
  readonly prunable: boolean;
}

export interface RepoMap {
  readonly repoCommonDir: string;
  readonly worktrees: readonly WorktreeRecord[];
}

const BRANCH_PREFIX = "refs/heads/";

const valueAfter = (lines: readonly string[], key: string): string | null => {
  const line = lines.find((entry) => entry.startsWith(`${key} `));

  return line === undefined ? null : line.slice(key.length + 1);
};

const branchLabel = (ref: string | null): string | null => {
  if (ref === null) {
    return null;
  }

  return ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref;
};

const recordFrom = (lines: readonly string[]): WorktreeRecord[] => {
  const rawPath = valueAfter(lines, "worktree");
  const path = rawPath === null ? null : normalizePath(rawPath);

  if (path === null) {
    return [];
  }

  const ref = valueAfter(lines, "branch");

  return [
    {
      bare: lines.includes("bare"),
      branch: branchLabel(ref),
      detached: lines.includes("detached"),
      headSha: valueAfter(lines, "HEAD"),
      path,
      prunable: lines.some(
        (line) => line === "prunable" || line.startsWith("prunable ")
      ),
    },
  ];
};

export const parseWorktreePorcelain = (
  text: string
): readonly WorktreeRecord[] =>
  text
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
    .filter((lines) => lines.length > 0)
    .flatMap(recordFrom);

export const buildRepoMap = (
  repoCommonDir: string,
  worktrees: readonly WorktreeRecord[]
): RepoMap | null => {
  const commonDir = normalizePath(repoCommonDir);

  return commonDir === null
    ? null
    : {
        repoCommonDir: commonDir,
        worktrees: worktrees.filter((entry) => !entry.bare),
      };
};

export type PathResolution =
  | {
      readonly relativePath: string;
      readonly repoCommonDir: string;
      readonly status: "matched";
      readonly worktree: WorktreeRecord;
    }
  | {
      readonly reason: string;
      readonly status: "ambiguous" | "invalid" | "outside";
    };

export const resolvePath = (
  maps: readonly RepoMap[],
  rawPath: string
): PathResolution => {
  const path = normalizePath(rawPath);

  if (path === null) {
    return { reason: "path is empty or not absolute", status: "invalid" };
  }

  const candidates = maps.flatMap((map) =>
    relativeWithin(map.repoCommonDir, path) === null
      ? map.worktrees.flatMap((worktree) => {
          const relativePath = relativeWithin(worktree.path, path);

          return relativePath === null ? [] : [{ map, relativePath, worktree }];
        })
      : []
  );

  if (candidates.length === 0) {
    return {
      reason: "path is outside every known worktree",
      status: "outside",
    };
  }

  const depth = Math.max(...candidates.map((c) => c.worktree.path.length));
  const deepest = candidates.filter((c) => c.worktree.path.length === depth);
  const [only] = deepest;

  if (deepest.length !== 1 || only === undefined) {
    return {
      reason:
        "the same worktree path is registered by more than one repository",
      status: "ambiguous",
    };
  }

  return {
    relativePath: only.relativePath,
    repoCommonDir: only.map.repoCommonDir,
    status: "matched",
    worktree: only.worktree,
  };
};

export type ContextAssignment =
  | "assigned"
  | "conflict"
  | "detached"
  | "multi-root"
  | "unassigned";

export interface ContextCorrelation {
  readonly assignment: ContextAssignment;
  readonly context: FlightContext;
  readonly reason: string;
  readonly relativePaths: readonly string[];
}

export const correlateContext = (
  maps: readonly RepoMap[],
  context: FlightContext,
  observedPaths: readonly string[]
): ContextCorrelation => {
  const resolutions = observedPaths.map((path) => resolvePath(maps, path));

  const matched = resolutions.flatMap((r) =>
    r.status === "matched" ? [r] : []
  );

  if (matched.length === 0) {
    return {
      assignment: "unassigned",
      context,
      reason:
        observedPaths.length === 0
          ? "no observed paths"
          : "no observed path is inside a known worktree",
      relativePaths: [],
    };
  }

  const worktreeRoots = new Set(matched.map((m) => m.worktree.path));

  if (worktreeRoots.size > 1) {
    return {
      assignment: "multi-root",
      context,
      reason: "observed paths span more than one worktree",
      relativePaths: [],
    };
  }

  const [first] = matched;

  if (first === undefined) {
    return {
      assignment: "unassigned",
      context,
      reason: "unreachable",
      relativePaths: [],
    };
  }

  const { repoCommonDir, worktree } = first;

  const existingCommon =
    context.repoCommonDir === null
      ? null
      : normalizePath(context.repoCommonDir);

  const existingWorktree =
    context.worktreePath === null ? null : normalizePath(context.worktreePath);

  if (
    (existingCommon !== null && existingCommon !== repoCommonDir) ||
    (existingWorktree !== null && existingWorktree !== worktree.path)
  ) {
    return {
      assignment: "conflict",
      context,
      reason: "event context names a different repository or worktree",
      relativePaths: [],
    };
  }

  const detached = worktree.detached || worktree.branch === null;

  const next: FlightContext = {
    branch: context.branch ?? (detached ? null : worktree.branch),
    flightId: context.flightId,
    headSha: context.headSha ?? worktree.headSha,
    repoCommonDir,
    worktreePath: worktree.path,
  };

  return {
    assignment: detached && context.branch === null ? "detached" : "assigned",
    context: next,
    reason: detached
      ? "worktree is detached; repository mapped, branch left unassigned"
      : "all observed paths are inside one worktree",
    relativePaths: matched.map((m) => m.relativePath),
  };
};
