import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitRunner } from "../../harness/git.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { repoLocator } from "./locator.js";
import type { RepoLocator } from "./locator.js";
import { attributeRepos } from "./repos.js";

export const ambientRepoLocator: Effect.Effect<Option.Option<RepoLocator>> =
  Effect.gen(function* ambientLocator() {
    const spawner = yield* Effect.serviceOption(
      ChildProcessSpawner.ChildProcessSpawner
    );

    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);

    if (Option.isNone(spawner) || Option.isNone(fs) || Option.isNone(path)) {
      return Option.none();
    }

    const git = yield* GitRunner.make.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        spawner.value
      ),
      Effect.provideService(FileSystem.FileSystem, fs.value),
      Effect.provideService(Path.Path, path.value)
    );

    return Option.some(
      yield* repoLocator.pipe(
        Effect.provideService(GitRunner, git),
        Effect.provideService(FileSystem.FileSystem, fs.value)
      )
    );
  });

export const attributeReposIfPossible = (
  events: readonly DxEventEnvelope[]
): Effect.Effect<readonly DxEventEnvelope[]> =>
  Effect.gen(function* attributeAmbient() {
    const locator = yield* ambientRepoLocator;

    return Option.isNone(locator)
      ? events
      : (yield* attributeRepos(locator.value, events)).events;
  });
