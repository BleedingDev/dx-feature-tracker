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

export interface RemovedFamily {
  readonly gone: string;
  readonly movesInto: readonly string[];
}

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const cwdPattern = (worktree: string): RegExp =>
  new RegExp(
    `"cwd"\\s*:\\s*"${escapeRegExp(JSON.stringify(worktree.replace(/\/+$/u, "")).slice(1, -1))}(?:"|/)`,
    "u"
  );

interface StartedFamily {
  readonly cwd: string | null;
  readonly family: SessionFamily;
}

const parentOf = (folder: string): string => folder.replace(/\/[^/]*\/*$/u, "");

const parentSlugOf = (worktree: string): string =>
  `${projectSlug(parentOf(worktree))}-`;

const trimmed = (folder: string): string => folder.replace(/\/+$/u, "");

const outermostStart = (starts: readonly string[], folder: string): string => {
  let outer = folder;

  for (const start of starts) {
    if (start.length < outer.length && isInside(folder, start)) {
      outer = start;
    }
  }

  return outer;
};

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

const rowPointsIntoRepo = (
  text: string,
  folder: string,
  worktreesDir: string | null,
  removed: RemovedWorktrees
): boolean => {
  const mentionsWorktrees =
    worktreesDir !== null && text.includes(worktreesDir);

  const commits = recordedCommits(text);

  if (!mentionsWorktrees && commits.length === 0) {
    return false;
  }

  const row = decodeClaudeLine(text);

  return (
    (row.kind === "assistant" || row.kind === "user") &&
    isInside(row.cwd, folder) &&
    (mentionsWorktrees || commits.some((sha) => removed.knowsCommit(sha)))
  );
};

const fileTextPointsIntoRepo = (
  bytes: Uint8Array,
  folder: string,
  worktreesDir: string | null,
  removed: RemovedWorktrees
): boolean =>
  splitLines(bytes, 0).complete.some((line) =>
    rowPointsIntoRepo(line.text, folder, worktreesDir, removed)
  );

const folderPointsIntoRepo = (
  store: ClaudeCodeFiles,
  scope: HarnessScope,
  removed: RemovedWorktrees,
  folder: string,
  members: readonly StartedFamily[]
) =>
  Effect.gen(function* folderEvidence() {
    const worktreesDir =
      scope.repoCommonDir === null
        ? null
        : `${scope.repoCommonDir.replace(/\/+$/u, "")}/worktrees/`;

    for (const { family } of members) {
      for (const file of family.files) {
        const points = yield* store.readFrom(file.path, 0).pipe(
          Effect.map((bytes) =>
            fileTextPointsIntoRepo(bytes, folder, worktreesDir, removed)
          ),
          Effect.orElseSucceed(() => false)
        );

        if (points) {
          return true;
        }
      }
    }

    return false;
  });

const byRemovedRoot = (
  started: readonly StartedFamily[]
): ReadonlyMap<string, readonly StartedFamily[]> => {
  const folders = new Map<string, StartedFamily[]>();

  const starts = started.flatMap(({ cwd }) =>
    cwd === null ? [] : [trimmed(cwd)]
  );

  for (const member of started) {
    const { cwd } = member;

    if (cwd !== null) {
      const root = outermostStart(starts, trimmed(cwd));

      folders.set(root, [...(folders.get(root) ?? []), member]);
    }
  }

  return folders;
};

const liveWorktreesEntered = (
  store: ClaudeCodeFiles,
  worktrees: readonly string[],
  family: SessionFamily
) =>
  Effect.gen(function* enteredWorktrees() {
    const patterns = worktrees.map((worktree) => ({
      pattern: cwdPattern(worktree),
      worktree,
    }));

    const entered = new Set<string>();

    for (const file of family.files) {
      const text = yield* store.readFrom(file.path, 0).pipe(
        Effect.map((bytes) => decoder.decode(bytes)),
        Effect.orElseSucceed(() => "")
      );

      for (const { pattern, worktree } of patterns) {
        if (pattern.test(text)) {
          entered.add(worktree);
        }
      }
    }

    return worktrees.filter((worktree) => entered.has(worktree));
  });

export const removedWorktreeFamilies = (
  store: ClaudeCodeFiles,
  scope: HarnessScope,
  families: readonly SessionFamily[]
): Effect.Effect<ReadonlyMap<string, RemovedFamily>> => {
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

    const kept = new Map<string, RemovedFamily>();

    for (const [folder, members] of byRemovedRoot(gone)) {
      if (yield* folderPointsIntoRepo(store, scope, removed, folder, members)) {
        for (const { family } of members) {
          kept.set(family.path, {
            gone: folder,
            movesInto: yield* liveWorktreesEntered(
              store,
              scope.worktrees,
              family
            ),
          });
        }
      }
    }

    return kept;
  });
};
