import { Effect, FileSystem } from "effect";

import { normalizePath } from "./path.js";
import { buildRepoMap } from "./worktree-map.js";
import type { RepoMap, WorktreeRecord } from "./worktree-map.js";

export interface GitLocation {
  readonly gitDir: string;
  readonly isLinkedWorktree: boolean;
  readonly repoCommonDir: string;
  readonly worktreePath: string;
}

const MAX_DEPTH = 256;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const parentOf = (path: string): string | null => {
  if (path === "/" || /^[A-Z]:\/$/u.test(path)) {
    return null;
  }

  const index = path.lastIndexOf("/");

  return index <= 0 ? "/" : path.slice(0, index);
};

const joinTo = (base: string, target: string): string | null =>
  target.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(target)
    ? normalizePath(target)
    : normalizePath(`${base}/${target}`);

const readTrimmed = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => null)
  );

const statType = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => info.type),
    Effect.orElseSucceed(() => null)
  );

const canonical = (fs: FileSystem.FileSystem, path: string) =>
  fs.realPath(path).pipe(
    Effect.map((real) => normalizePath(real) ?? path),
    Effect.orElseSucceed(() => path)
  );

const commonDirFor = Effect.fn("RepoCorrelation.commonDirFor")(
  function* commonDirFor(fs: FileSystem.FileSystem, gitDir: string) {
    const pointer = yield* readTrimmed(fs, `${gitDir}/commondir`);

    const target =
      pointer === null || pointer === "" ? gitDir : joinTo(gitDir, pointer);

    return target === null ? gitDir : yield* canonical(fs, target);
  }
);

export const discoverGitLocation = Effect.fn(
  "RepoCorrelation.discoverGitLocation"
)(function* discoverGitLocation(start: string) {
  const fs = yield* FileSystem.FileSystem;
  const normal = normalizePath(start);

  if (normal === null) {
    return null;
  }

  let current: string | null = yield* canonical(fs, normal);

  for (let depth = 0; current !== null && depth < MAX_DEPTH; depth += 1) {
    const dotGit = current === "/" ? "/.git" : `${current}/.git`;
    const type = yield* statType(fs, dotGit);

    if (type === "Directory") {
      const gitDir = yield* canonical(fs, dotGit);

      const location: GitLocation = {
        gitDir,
        isLinkedWorktree: false,
        repoCommonDir: yield* commonDirFor(fs, gitDir),
        worktreePath: current,
      };

      return location;
    }

    if (type === "File") {
      const content = (yield* readTrimmed(fs, dotGit)) ?? "";

      const pointer = content.startsWith("gitdir:")
        ? joinTo(current, content.slice("gitdir:".length).trim())
        : null;

      if (pointer === null) {
        return null;
      }

      const gitDir = yield* canonical(fs, pointer);
      const repoCommonDir = yield* commonDirFor(fs, gitDir);

      const location: GitLocation = {
        gitDir,
        isLinkedWorktree: repoCommonDir !== gitDir,
        repoCommonDir,
        worktreePath: current,
      };

      return location;
    }

    current = parentOf(current);
  }

  return null;
});

const resolveRef = Effect.fn("RepoCorrelation.resolveRef")(function* resolveRef(
  fs: FileSystem.FileSystem,
  commonDir: string,
  ref: string
) {
  const loose = yield* readTrimmed(fs, `${commonDir}/${ref}`);

  if (loose !== null && SHA.test(loose)) {
    return loose;
  }

  const packed = (yield* readTrimmed(fs, `${commonDir}/packed-refs`)) ?? "";

  const line = packed
    .split("\n")
    .find((entry) => entry.trim().endsWith(` ${ref}`));

  const sha = line?.trim().split(" ")[0] ?? null;

  return sha !== null && SHA.test(sha) ? sha : null;
});

const headOf = Effect.fn("RepoCorrelation.headOf")(function* headOf(
  fs: FileSystem.FileSystem,
  commonDir: string,
  gitDir: string
) {
  const head = (yield* readTrimmed(fs, `${gitDir}/HEAD`)) ?? "";

  if (head.startsWith("ref:")) {
    const ref = head.slice("ref:".length).trim();

    return {
      branch: ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref,
      detached: false,
      headSha: yield* resolveRef(fs, commonDir, ref),
    };
  }

  return {
    branch: null,
    detached: SHA.test(head),
    headSha: SHA.test(head) ? head : null,
  };
});

export const loadRepoMap = Effect.fn("RepoCorrelation.loadRepoMap")(
  function* loadRepoMap(repoCommonDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const commonDir = yield* canonical(fs, normalizePath(repoCommonDir) ?? "");
    const records: WorktreeRecord[] = [];

    if (commonDir.endsWith("/.git")) {
      const head = yield* headOf(fs, commonDir, commonDir);
      const mainPath = parentOf(commonDir);

      if (mainPath !== null) {
        records.push({ bare: false, path: mainPath, prunable: false, ...head });
      }
    }

    const names = yield* fs
      .readDirectory(`${commonDir}/worktrees`)
      .pipe(Effect.orElseSucceed((): readonly string[] => []));

    for (const name of names.toSorted((left, right) =>
      left.localeCompare(right)
    )) {
      const adminDir = `${commonDir}/worktrees/${name}`;
      const dotGitPointer = yield* readTrimmed(fs, `${adminDir}/gitdir`);

      const dotGitPath =
        dotGitPointer === null ? null : joinTo(adminDir, dotGitPointer);

      const worktreeRaw = dotGitPath === null ? null : parentOf(dotGitPath);

      if (worktreeRaw !== null) {
        const exists = yield* fs
          .exists(worktreeRaw)
          .pipe(Effect.orElseSucceed(() => false));

        const path = exists ? yield* canonical(fs, worktreeRaw) : worktreeRaw;
        const head = yield* headOf(fs, commonDir, adminDir);

        records.push({ bare: false, path, prunable: !exists, ...head });
      }
    }

    return buildRepoMap(commonDir, records);
  }
);

export const repoMapForPath = Effect.fn("RepoCorrelation.repoMapForPath")(
  function* repoMapForPath(start: string) {
    const location = yield* discoverGitLocation(start);

    if (location === null) {
      return null;
    }

    const map: RepoMap | null = yield* loadRepoMap(location.repoCommonDir);

    return map === null ? null : { location, map };
  }
);

export const canonicalizePath = Effect.fn("RepoCorrelation.canonicalizePath")(
  function* canonicalizePath(path: string) {
    const fs = yield* FileSystem.FileSystem;
    const normal = normalizePath(path);

    return normal === null ? null : yield* canonical(fs, normal);
  }
);
