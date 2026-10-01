import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { parseWorktreePorcelain } from "../correlation/repo/worktree-map.js";

export interface GitAt {
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly repoCommonDir: string | null;
  readonly worktreePath: string | null;
}

export interface GitWorktree {
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly path: string;
}

export interface GitQueries {
  readonly at: (path: string) => Effect.Effect<GitAt>;
  readonly worktrees: (path: string) => Effect.Effect<readonly GitWorktree[]>;
}

export const notARepo: GitAt = {
  branch: null,
  headSha: null,
  repoCommonDir: null,
  worktreePath: null,
};

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

const GIT_TIMEOUT = "3 seconds";

const lines = (text: string | null): readonly string[] =>
  text === null
    ? []
    : text
        .trim()
        .split("\n")
        .map((line) => line.trim());

export interface MemoryRepo {
  readonly repoCommonDir: string;
  readonly worktrees: readonly GitWorktree[];
}

const within = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

export const memoryGitAt = (
  repos: readonly MemoryRepo[],
  target: string
): GitAt => {
  for (const repo of repos) {
    const [worktree] = repo.worktrees
      .filter((candidate) => within(candidate.path, target))
      .toSorted((a, b) => b.path.length - a.path.length);

    if (worktree !== undefined) {
      return {
        branch: worktree.branch,
        headSha: worktree.headSha,
        repoCommonDir: repo.repoCommonDir,
        worktreePath: worktree.path,
      };
    }
  }

  return notARepo;
};

export class GitRunner extends Context.Service<GitRunner, GitQueries>()(
  "dx/harness/GitRunner",
  {
    make: Effect.gen(function* makeGitRunner() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const run = (cwd: string, args: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* runGit() {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", ["-C", cwd, ...args], {
                env: GIT_ENV,
                extendEnv: true,
                stderr: "ignore",
                stdin: "ignore",
              })
            );

            const [stdout, exitCode] = yield* Effect.all(
              [
                handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
                handle.exitCode,
              ],
              { concurrency: 2 }
            );

            return Number(exitCode) === 0 ? stdout : null;
          })
        ).pipe(
          Effect.timeoutOption(GIT_TIMEOUT),
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null)
        );

      const canonical = (target: string) =>
        fileSystem
          .realPath(target)
          .pipe(Effect.orElseSucceed(() => path.resolve(target)));

      const at = Effect.fn("GitRunner.at")(function* at(target: string) {
        const [topLevel, commonDir] = lines(
          yield* run(target, [
            "rev-parse",
            "--show-toplevel",
            "--git-common-dir",
          ])
        );

        if (topLevel === undefined || commonDir === undefined) {
          return notARepo;
        }

        const [branch] = lines(
          yield* run(target, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        );

        const [headSha] = lines(yield* run(target, ["rev-parse", "HEAD"]));

        return {
          branch: branch === undefined || branch === "" ? null : branch,
          headSha: headSha === undefined || headSha === "" ? null : headSha,
          repoCommonDir: yield* canonical(
            path.isAbsolute(commonDir)
              ? commonDir
              : path.join(target, commonDir)
          ),
          worktreePath: yield* canonical(topLevel),
        };
      });

      const worktrees = Effect.fn("GitRunner.worktrees")(function* worktrees(
        target: string
      ) {
        const text = yield* run(target, ["worktree", "list", "--porcelain"]);

        const records = parseWorktreePorcelain(text ?? "").filter(
          (record) => !record.bare && !record.prunable
        );

        return yield* Effect.forEach((record: (typeof records)[number]) =>
          canonical(record.path).pipe(
            Effect.map((resolved) => ({
              branch: record.detached ? null : record.branch,
              headSha: record.headSha,
              path: resolved,
            }))
          )
        )(records);
      });

      return { at, worktrees };
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    repos: readonly MemoryRepo[]
  ): Layer.Layer<GitRunner> =>
    Layer.succeed(this, {
      at: (target) => Effect.succeed(memoryGitAt(repos, target)),
      worktrees: (target) => {
        const repo = repos.find((candidate) =>
          candidate.worktrees.some((worktree) => within(worktree.path, target))
        );

        return Effect.succeed(repo?.worktrees ?? []);
      },
    });
}
