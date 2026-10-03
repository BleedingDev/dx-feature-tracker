import { Effect, Predicate, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcess } from "effect/unstable/process";

export interface GitOperationResponse {
  readonly exitCode?: number;
  readonly stderr?: readonly string[];
  readonly stdout: readonly string[];
  readonly wait?: Effect.Effect<void>;
}

export interface GitOperationScript extends GitOperationResponse {
  readonly args: readonly string[];
}

export type GitOperationRouter = (
  args: readonly string[]
) => GitOperationResponse | undefined;

export interface GitOperationObservation {
  readonly args: readonly string[];
  readonly command: string;
  readonly options: ChildProcess.CommandOptions;
  cleanupKills: number;
  exitObserved: boolean;
  finalized: boolean;
  killCalls: number;
  killed: boolean;
  stderrBytes: number;
  stderrChunks: number;
  stderrClosed: boolean;
  stderrComplete: boolean;
  stdoutBytes: number;
  stdoutChunks: number;
  stdoutClosed: boolean;
  stdoutComplete: boolean;
}

export interface GitOperationFixture {
  readonly assertComplete: Effect.Effect<void>;
  readonly observations: readonly GitOperationObservation[];
  readonly pendingScripts: () => number;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

const outputStream = (
  chunks: readonly string[],
  observation: GitOperationObservation,
  stream: "stdout" | "stderr",
  wait: Effect.Effect<void> = Effect.void
): Stream.Stream<Uint8Array> => {
  const encoder = new TextEncoder();

  const output = Stream.fromIterable(chunks, { chunkSize: 1 }).pipe(
    Stream.map((chunk) => encoder.encode(chunk)),
    Stream.tap((chunk) =>
      Effect.sync(() => {
        if (stream === "stdout") {
          observation.stdoutBytes += chunk.byteLength;
          observation.stdoutChunks += 1;
        } else {
          observation.stderrBytes += chunk.byteLength;
          observation.stderrChunks += 1;
        }
      })
    )
  );

  const complete = Stream.fromEffectDrain(
    Effect.sync(() => {
      if (stream === "stdout") {
        observation.stdoutComplete = true;
      } else {
        observation.stderrComplete = true;
      }
    })
  );

  return Stream.fromEffectDrain(wait).pipe(
    Stream.concat(output),
    Stream.concat(complete),
    Stream.ensuring(
      Effect.sync(() => {
        if (stream === "stdout") {
          observation.stdoutClosed = true;
        } else {
          observation.stderrClosed = true;
        }
      })
    )
  );
};

export const makeGitOperationFixture = (
  scripts: readonly GitOperationScript[] | GitOperationRouter
): Effect.Effect<GitOperationFixture> =>
  Effect.sync(() => {
    const observations: GitOperationObservation[] = [];
    const state = { next: 0 };

    const spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] =
      Effect.fn("S03.GitOperationFixture.spawn")(function* spawn(command) {
        if (
          !Predicate.isTagged(command, "StandardCommand") ||
          command.command !== "git"
        ) {
          return yield* Effect.die(
            new Error(
              `Unexpected synthetic Git process ${JSON.stringify(command)}`
            )
          );
        }

        const script = Predicate.isFunction(scripts)
          ? scripts(command.args)
          : scripts[state.next];

        const expectedArgs = Predicate.isFunction(scripts)
          ? null
          : scripts[state.next]?.args;

        if (
          script === undefined ||
          (expectedArgs !== null &&
            JSON.stringify(command.args) !== JSON.stringify(expectedArgs))
        ) {
          return yield* Effect.die(
            new Error(
              `Unexpected synthetic Git command ${JSON.stringify(command.args)}; expected ${JSON.stringify(expectedArgs)}`
            )
          );
        }

        state.next += 1;

        const observation: GitOperationObservation = {
          args: [...command.args],
          cleanupKills: 0,
          command: command.command,
          exitObserved: false,
          finalized: false,
          killCalls: 0,
          killed: false,
          options: command.options,
          stderrBytes: 0,
          stderrChunks: 0,
          stderrClosed: false,
          stderrComplete: false,
          stdoutBytes: 0,
          stdoutChunks: 0,
          stdoutClosed: false,
          stdoutComplete: false,
        };

        observations.push(observation);

        const stdout = outputStream(
          script.stdout,
          observation,
          "stdout",
          script.wait
        );

        const stderr = outputStream(script.stderr ?? [], observation, "stderr");

        return yield* Effect.acquireRelease(
          Effect.sync(() =>
            ChildProcessSpawner.makeHandle({
              all: Stream.merge(stdout, stderr),
              exitCode: (script.wait ?? Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    observation.exitObserved = true;

                    return ChildProcessSpawner.ExitCode(script.exitCode ?? 0);
                  })
                )
              ),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              isRunning: Effect.sync(
                () => !observation.exitObserved && !observation.killed
              ),
              kill: () =>
                Effect.sync(() => {
                  observation.killCalls += 1;
                  observation.killed = true;
                }),
              pid: ChildProcessSpawner.ProcessId(state.next),
              stderr,
              stdin: Sink.drain,
              stdout,
              unref: Effect.succeed(Effect.void),
            })
          ),
          () =>
            Effect.sync(() => {
              observation.finalized = true;

              if (!observation.exitObserved && !observation.killed) {
                observation.cleanupKills += 1;
                observation.killed = true;
              }
            })
        );
      });

    const pendingScripts = () =>
      Predicate.isFunction(scripts) ? 0 : scripts.length - state.next;

    const assertComplete = Effect.suspend(() =>
      pendingScripts() === 0
        ? Effect.void
        : Effect.die(
            new Error(
              `Synthetic Git fixture left ${pendingScripts()} command scripts unused`
            )
          )
    );

    return {
      assertComplete,
      observations,
      pendingScripts,
      spawner: ChildProcessSpawner.make(spawn),
    };
  });
