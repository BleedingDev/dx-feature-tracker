import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";

export const GIT_IDENTITY_ADAPTER_ID = "git-identity";

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type GitRun = (
  args: readonly string[]
) => Effect.Effect<GitResult, SourceUnavailable>;

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

export const gitRunFor = Effect.fn("GitIdentity.gitRunFor")(function* gitRunFor(
  cwd: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: GitRun = (args) =>
    Effect.scoped(
      Effect.gen(function* collectGitOutput() {
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

        const result: GitResult = { exitCode: Number(exitCode), stdout };

        return result;
      })
    ).pipe(
      Effect.mapError(
        (failure) =>
          new SourceUnavailable({
            adapterId: GIT_IDENTITY_ADAPTER_ID,
            message: `git could not be executed: ${failure.message}`,
          })
      )
    );

  return run;
});
