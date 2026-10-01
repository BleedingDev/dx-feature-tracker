import { Effect } from "effect";

import type { HarnessScope, RemovedWorktrees } from "../contract.js";
import { splitLines } from "./lines.js";
import { isInside, projectSlug } from "./paths.js";
import type { SessionFamily } from "./paths.js";
import { decodeClaudeLine } from "./rows.js";
import type { ClaudeCodeFiles } from "./store.js";

const HEAD_BYTES = 64 * 1024;

const COMMIT_OUTPUT = /\[[^[\]\n"\\]{1,200} (?<sha>[0-9a-f]{7,40})\]/gu;

const decoder = new TextDecoder();

interface StartedFamily {
  readonly cwd: string | null;
  readonly family: SessionFamily;
}

const parentSlugOf = (worktree: string): string =>
  `${projectSlug(worktree.replace(/\/[^/]*\/*$/u, ""))}-`;

export const firstCwd = (bytes: Uint8Array): string | null => {
  for (const line of splitLines(bytes, 0).complete) {
    const row = decodeClaudeLine(line.text);

    if ((row.kind === "assistant" || row.kind === "user") && row.cwd !== null) {
      return row.cwd;
    }
  }

  return null;
};

export const recordedCommits = (text: string): readonly string[] => [
  ...new Set(
    [...text.matchAll(COMMIT_OUTPUT)].flatMap((match) =>
      match.groups?.sha === undefined ? [] : [match.groups.sha]
    )
  ),
];

const startingFolder = (store: ClaudeCodeFiles, family: SessionFamily) => {
  const [first] = family.files;

  if (first === undefined) {
    return Effect.succeed(null);
  }

  return store.readHead(first.path, HEAD_BYTES).pipe(
    Effect.flatMap((head) => {
      const cwd = firstCwd(head);

      return cwd === null && head.byteLength >= HEAD_BYTES
        ? Effect.map(store.readFrom(first.path, 0), firstCwd)
        : Effect.succeed(cwd);
    }),
    Effect.orElseSucceed(() => null)
  );
};

const transcriptPointsIntoRepo = (
  store: ClaudeCodeFiles,
  family: SessionFamily,
  repoCommonDir: string | null,
  removed: RemovedWorktrees
) => {
  const [first] = family.files;

  if (first === undefined) {
    return Effect.succeed(false);
  }

  return store.readFrom(first.path, 0).pipe(
    Effect.map((bytes) => {
      const text = decoder.decode(bytes);

      return (
        (repoCommonDir !== null &&
          text.includes(`${repoCommonDir.replace(/\/+$/u, "")}/worktrees/`)) ||
        recordedCommits(text).some((sha) => removed.knowsCommit(sha))
      );
    }),
    Effect.orElseSucceed(() => false)
  );
};

const folderPointsIntoRepo = (
  store: ClaudeCodeFiles,
  scope: HarnessScope,
  removed: RemovedWorktrees,
  members: readonly StartedFamily[]
) =>
  Effect.gen(function* folderEvidence() {
    for (const { family } of members) {
      if (
        yield* transcriptPointsIntoRepo(
          store,
          family,
          scope.repoCommonDir,
          removed
        )
      ) {
        return true;
      }
    }

    return false;
  });

const byFolder = (
  started: readonly StartedFamily[]
): ReadonlyMap<string, readonly StartedFamily[]> => {
  const folders = new Map<string, StartedFamily[]>();

  for (const member of started) {
    const { cwd } = member;

    if (cwd !== null) {
      folders.set(cwd, [...(folders.get(cwd) ?? []), member]);
    }
  }

  return folders;
};

export const removedWorktreeFamilies = (
  store: ClaudeCodeFiles,
  scope: HarnessScope,
  families: readonly SessionFamily[]
): Effect.Effect<ReadonlyMap<string, string>> => {
  const { removed } = scope;

  if (removed === undefined || scope.worktrees.length === 0) {
    return Effect.succeed(new Map());
  }

  const own = new Set(scope.worktrees.map(projectSlug));
  const parents = [...new Set(scope.worktrees.map(parentSlugOf))];

  const candidates = families.filter(
    (family) =>
      !own.has(family.project) &&
      parents.some((parent) => family.project.startsWith(parent))
  );

  return Effect.gen(function* findRemovedWorktrees() {
    const started = yield* Effect.forEach((family: SessionFamily) =>
      Effect.map(startingFolder(store, family), (cwd) => ({ cwd, family }))
    )(candidates);

    const gone = started.filter(
      ({ cwd }) =>
        cwd !== null &&
        !scope.worktrees.some((worktree) => isInside(cwd, worktree)) &&
        removed.gone(cwd)
    );

    const kept = new Map<string, string>();

    for (const [folder, members] of byFolder(gone)) {
      if (yield* folderPointsIntoRepo(store, scope, removed, members)) {
        for (const { family } of members) {
          kept.set(family.path, folder);
        }
      }
    }

    return kept;
  });
};
