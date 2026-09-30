import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";

export const GIT_OBSERVATION_ADAPTER_ID = "git-observation";

export type GitRunner = (
  cwd: string,
  args: readonly string[]
) => Effect.Effect<string, SourceUnavailable>;

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

const unavailable = (message: string): SourceUnavailable =>
  new SourceUnavailable({ adapterId: GIT_OBSERVATION_ADAPTER_ID, message });

export const makeSpawnerGitRunner =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): GitRunner =>
  (cwd, args) =>
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

        return { exitCode: Number(exitCode), stdout };
      })
    ).pipe(
      Effect.mapError((spawnFailure) =>
        unavailable(`git could not be executed: ${spawnFailure.message}`)
      ),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              unavailable(
                `git ${args[0] ?? ""} exited with code ${result.exitCode}`
              )
            )
      )
    );

export const spawnerGitRunner = Effect.gen(function* resolveGitRunner() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return makeSpawnerGitRunner(spawner);
});
