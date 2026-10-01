import { Effect, FileSystem, Option } from "effect";

import { GitRunner } from "../../harness/git.js";
import type { GitQueries } from "../../harness/git.js";
import { normalizePath } from "../repo/path.js";
import { branchNameOrNull } from "./branch-name.js";

export interface RepoLocation {
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly repoCommonDir: string;
  readonly worktreePath: string;
}

export type PathLocation =
  | { readonly kind: "repo"; readonly location: RepoLocation }
  | { readonly kind: "outside" }
  | { readonly kind: "missing" };

export type PathKind = "directory" | "file" | "missing";

export interface RepoLocator {
  readonly locate: (path: string) => Effect.Effect<PathLocation>;
}

const OUTSIDE: PathLocation = { kind: "outside" };

const MISSING: PathLocation = { kind: "missing" };

const parentOf = (path: string): string | null => {
  const index = path.lastIndexOf("/");

  if (index === -1 || path === "/" || /^[A-Z]:\/?$/u.test(path)) {
    return null;
  }

  return index === 0 ? "/" : path.slice(0, index);
};

const assumeDirectory = (): Effect.Effect<PathKind> =>
  Effect.succeed("directory");

export const makeRepoLocator = (
  git: GitQueries,
  kindOf: (path: string) => Effect.Effect<PathKind> = assumeDirectory
): RepoLocator => {
  const cache = new Map<string, PathLocation>();

  const fromGit = (path: string) =>
    Effect.map(git.at(path), (at): PathLocation | null =>
      at.repoCommonDir === null || at.worktreePath === null
        ? null
        : {
            kind: "repo",
            location: {
              branch: branchNameOrNull(at.branch),
              headSha: at.headSha,
              repoCommonDir: at.repoCommonDir,
              worktreePath: at.worktreePath,
            },
          }
    );

  const resolve = (path: string): Effect.Effect<PathLocation> =>
    Effect.gen(function* resolvePath() {
      const known = cache.get(path);

      if (known !== undefined) {
        return known;
      }

      const direct = yield* fromGit(path);
      const kind = direct === null ? yield* kindOf(path) : "directory";
      const parent = parentOf(path);
      const notInRepo = kind === "missing" ? MISSING : OUTSIDE;

      const viaParent =
        direct === null && kind !== "directory" && parent !== null
          ? yield* resolve(parent)
          : null;

      const found: PathLocation =
        direct ?? (viaParent?.kind === "repo" ? viaParent : notInRepo);

      cache.set(path, found);

      return found;
    });

  return {
    locate: (raw) => {
      const path = normalizePath(raw);

      return path === null ? Effect.succeed(MISSING) : resolve(path);
    },
  };
};

const statKind = (fs: FileSystem.FileSystem) => (path: string) =>
  fs.stat(path).pipe(
    Effect.map((info): PathKind =>
      info.type === "Directory" ? "directory" : "file"
    ),
    Effect.orElseSucceed((): PathKind => "missing")
  );

export const repoLocator: Effect.Effect<RepoLocator, never, GitRunner> =
  Effect.gen(function* makeLocator() {
    const git = yield* GitRunner;
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);

    return makeRepoLocator(
      git,
      Option.match(fs, { onNone: () => assumeDirectory, onSome: statKind })
    );
  });
