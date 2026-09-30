import { DateTime, Effect, Option } from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import { GIT_IDENTITY_ADAPTER_ID } from "./git-runner.js";
import type { GitRun } from "./git-runner.js";

export type BaseSource = "origin-head" | "local-default" | "none";

export interface FieldGap {
  readonly field: string;
  readonly reason: string;
}

export interface GitIdentity {
  readonly aheadCount: number | null;
  readonly baseRef: string | null;
  readonly baseSha: string | null;
  readonly baseSource: BaseSource;
  readonly branch: string | null;
  readonly branchCreatedAt: string | null;
  readonly branchCreatedFrom: string | null;
  readonly detached: boolean;
  readonly dirtyEntries: number | null;
  readonly firstBranchCommitAt: string | null;
  readonly gaps: readonly FieldGap[];
  readonly gitDir: string;
  readonly gitVersion: string | null;
  readonly headSha: string | null;
  readonly isLinkedWorktree: boolean;
  readonly onBaseBranch: boolean;
  readonly repoCommonDir: string;
  readonly sameBranchWorktrees: number | null;
  readonly worktreeCount: number | null;
  readonly worktreePath: string;
}

interface BaseChoice {
  readonly baseRef: string | null;
  readonly baseSource: BaseSource;
}

interface BaseFacts {
  readonly aheadCount: number | null;
  readonly baseSha: string | null;
  readonly firstBranchCommitAt: string | null;
  readonly gaps: readonly FieldGap[];
}

export interface ReflogCreation {
  readonly createdAt: string | null;
  readonly createdFrom: string | null;
}

export interface WorktreeEntry {
  readonly branch: string | null;
  readonly path: string;
}

const LOCAL_DEFAULT_BRANCHES = ["main", "master", "trunk", "develop"];

const NO_BASE: BaseChoice = { baseRef: null, baseSource: "none" };

export const toIsoOrNull = (text: string): string | null =>
  Option.match(DateTime.make(text), {
    onNone: () => null,
    onSome: (value) => DateTime.formatIso(DateTime.toUtc(value)),
  });

const nonEmptyLines = (text: string): readonly string[] =>
  text.split("\n").filter((line) => line.trim() !== "");

const firstLine = (text: string): string | null =>
  nonEmptyLines(text)[0]?.trim() ?? null;

export const parseGitVersion = (text: string): string | null =>
  /git version (?<version>\S+)/u.exec(text)?.groups?.version ?? null;

export const parseBranchCreation = (text: string): ReflogCreation | null => {
  const last = nonEmptyLines(text).at(-1);

  if (last === undefined) {
    return null;
  }

  const [selector = "", subject = ""] = last.split("\t");

  const from = /^branch: Created from (?<from>.+)$/u.exec(subject.trim())
    ?.groups?.from;

  if (from === undefined) {
    return null;
  }

  const date = /@\{(?<date>.+)\}$/u.exec(selector)?.groups?.date;

  return {
    createdAt: date === undefined ? null : toIsoOrNull(date),
    createdFrom: from,
  };
};

const worktreeEntry = (lines: readonly string[]): WorktreeEntry[] => {
  const pathLine = lines.find((line) => line.startsWith("worktree "));
  const branchLine = lines.find((line) => line.startsWith("branch "));

  if (pathLine === undefined) {
    return [];
  }

  return [
    {
      branch:
        branchLine === undefined
          ? null
          : branchLine.slice("branch ".length).replace(/^refs\/heads\//u, ""),
      path: pathLine.slice("worktree ".length),
    },
  ];
};

export const parseWorktreeList = (text: string): readonly WorktreeEntry[] =>
  text
    .split("\n\n")
    .map((block) => nonEmptyLines(block))
    .filter((lines) => lines.length > 0)
    .flatMap(worktreeEntry);

const optionalLine = (run: GitRun, args: readonly string[]) =>
  run(args).pipe(
    Effect.map((result) =>
      result.exitCode === 0 ? firstLine(result.stdout) : null
    )
  );

const resolveBase = Effect.fn("GitIdentity.resolveBase")(function* resolveBase(
  run: GitRun
) {
  const originHead = yield* optionalLine(run, [
    "symbolic-ref",
    "-q",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);

  if (originHead !== null) {
    const choice: BaseChoice = {
      baseRef: originHead,
      baseSource: "origin-head",
    };

    return choice;
  }

  for (const name of LOCAL_DEFAULT_BRANCHES) {
    const sha = yield* optionalLine(run, [
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${name}`,
    ]);

    if (sha !== null) {
      const choice: BaseChoice = { baseRef: name, baseSource: "local-default" };

      return choice;
    }
  }

  return NO_BASE;
});

const resolveBaseFacts = Effect.fn("GitIdentity.resolveBaseFacts")(
  function* resolveBaseFacts(
    run: GitRun,
    baseRef: string | null,
    headSha: string | null
  ) {
    const empty: BaseFacts = {
      aheadCount: null,
      baseSha: null,
      firstBranchCommitAt: null,
      gaps: [],
    };

    if (baseRef === null) {
      return {
        ...empty,
        gaps: [
          {
            field: "baseSha",
            reason:
              "no origin/HEAD and no local main/master/trunk/develop branch to derive a base",
          },
        ],
      };
    }

    if (headSha === null) {
      return empty;
    }

    const baseSha = yield* optionalLine(run, ["merge-base", "HEAD", baseRef]);

    if (baseSha === null) {
      return {
        ...empty,
        gaps: [
          {
            field: "baseSha",
            reason: `HEAD shares no merge-base with ${baseRef}`,
          },
        ],
      };
    }

    const count = yield* optionalLine(run, [
      "rev-list",
      "--count",
      `${baseSha}..HEAD`,
    ]);

    const first = yield* optionalLine(run, [
      "log",
      "--reverse",
      "--format=%aI",
      `${baseSha}..HEAD`,
    ]);

    return {
      aheadCount: count === null ? null : Math.trunc(Number(count)),
      baseSha,
      firstBranchCommitAt: first === null ? null : toIsoOrNull(first),
      gaps: [],
    };
  }
);

const resolveBranchCreation = Effect.fn("GitIdentity.resolveBranchCreation")(
  function* resolveBranchCreation(run: GitRun, branch: string) {
    const reflog = yield* run([
      "reflog",
      "show",
      "--date=iso-strict",
      "--format=%gd%x09%gs",
      `refs/heads/${branch}`,
      "--",
    ]);

    return reflog.exitCode === 0 ? parseBranchCreation(reflog.stdout) : null;
  }
);

const locateRepository = Effect.fn("GitIdentity.locate")(function* locate(
  run: GitRun
) {
  const located = yield* run([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--absolute-git-dir",
    "--show-toplevel",
  ]);

  const [repoCommonDir, gitDir, worktreePath] = nonEmptyLines(located.stdout);

  if (
    located.exitCode !== 0 ||
    repoCommonDir === undefined ||
    gitDir === undefined ||
    worktreePath === undefined
  ) {
    return yield* new SourceUnavailable({
      adapterId: GIT_IDENTITY_ADAPTER_ID,
      message:
        "selected input is not inside a Git working tree (bare repositories are unsupported)",
    });
  }

  return { gitDir, repoCommonDir, worktreePath };
});

const countLines = (run: GitRun, args: readonly string[]) =>
  run(args).pipe(
    Effect.map((result) =>
      result.exitCode === 0 ? nonEmptyLines(result.stdout).length : null
    )
  );

const listWorktrees = (run: GitRun) =>
  run(["worktree", "list", "--porcelain"]).pipe(
    Effect.map((result) =>
      result.exitCode === 0 ? parseWorktreeList(result.stdout) : null
    )
  );

const headGaps = (
  headSha: string | null,
  branch: string | null
): FieldGap[] => [
  ...(headSha === null
    ? [{ field: "headSha", reason: "HEAD has no commit yet" }]
    : []),
  ...(branch === null
    ? [
        {
          field: "branch",
          reason: "HEAD is detached; branch attribution stays unassigned",
        },
      ]
    : []),
];

const baseBranchName = (baseRef: string): string =>
  baseRef.replace(/^origin\//u, "");

const creationGap: FieldGap = {
  field: "branchCreatedAt",
  reason:
    "branch reflog has no creation entry (expired, cloned or reflog disabled)",
};

export const resolveGitIdentity = Effect.fn("GitIdentity.resolve")(
  function* resolveGitIdentity(run: GitRun) {
    const version = yield* run(["--version"]);
    const location = yield* locateRepository(run);

    const headSha = yield* optionalLine(run, [
      "rev-parse",
      "--verify",
      "-q",
      "HEAD",
    ]);

    const branch = yield* optionalLine(run, [
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);

    const { baseRef, baseSource } = yield* resolveBase(run);

    const onBaseBranch =
      branch !== null && baseRef !== null && baseBranchName(baseRef) === branch;

    const base = yield* resolveBaseFacts(run, baseRef, headSha);

    const creation =
      branch === null || onBaseBranch
        ? null
        : yield* resolveBranchCreation(run, branch);

    const creationGaps =
      creation === null && branch !== null && !onBaseBranch
        ? [creationGap]
        : [];

    const dirtyEntries = yield* countLines(run, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);

    const dirtyGaps =
      dirtyEntries === null
        ? [{ field: "dirtyEntries", reason: "git status failed" }]
        : [];

    const worktrees = yield* listWorktrees(run);

    const identity: GitIdentity = {
      aheadCount: base.aheadCount,
      baseRef,
      baseSha: base.baseSha,
      baseSource,
      branch,
      branchCreatedAt: creation?.createdAt ?? null,
      branchCreatedFrom: creation?.createdFrom ?? null,
      detached: branch === null,
      dirtyEntries,
      firstBranchCommitAt: base.firstBranchCommitAt,
      gaps: [
        ...headGaps(headSha, branch),
        ...base.gaps,
        ...creationGaps,
        ...dirtyGaps,
      ],
      gitDir: location.gitDir,
      gitVersion: parseGitVersion(version.stdout),
      headSha,
      isLinkedWorktree: location.gitDir !== location.repoCommonDir,
      onBaseBranch,
      repoCommonDir: location.repoCommonDir,
      sameBranchWorktrees:
        worktrees === null || branch === null
          ? null
          : worktrees.filter((entry) => entry.branch === branch).length,
      worktreeCount: worktrees === null ? null : worktrees.length,
      worktreePath: location.worktreePath,
    };

    return identity;
  }
);
