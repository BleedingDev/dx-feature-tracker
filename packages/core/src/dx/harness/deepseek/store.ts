import { Context, Effect, FileSystem, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";
import { isGenerationFile } from "./format.js";
import { persistenceRootsIn } from "./roots.js";

const PROFILE_FILES = ["cordis.yml", "cordis.patch.yml"] as const;

export class DeepseekStore extends Context.Service<
  DeepseekStore,
  HarnessStore
>()("dx/harness/deepseek/DeepseekStore", {
  make: Effect.gen(function* makeDeepseekStore() {
    const home = yield* HarnessHome;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const dshHome = home.dirs.deepseek;
    const context = { dshHome, home: home.home, join: path.join };

    const profileRoots = Effect.gen(function* listProfileRoots() {
      const profiles = path.join(dshHome, "profiles");

      if (!(yield* fileSystem.exists(profiles))) {
        return [];
      }

      const names = yield* fileSystem.readDirectory(profiles);

      const files = names.flatMap((name) =>
        PROFILE_FILES.map((file) => path.join(profiles, name, file))
      );

      const texts = yield* Effect.forEach((file: string) =>
        fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
      )(files);

      return texts.flatMap((text) => persistenceRootsIn(text, context));
    }).pipe(Effect.orElseSucceed((): readonly string[] => []));

    const roots = profileRoots.pipe(
      Effect.map((extra) => [
        ...new Set([
          path.join(dshHome, "sessions"),
          ...extra.map((root) => path.resolve(root)),
        ]),
      ])
    );

    return yield* liveFileStore({
      harness: "deepseek",
      isSession: isGenerationFile,
      roots,
      version: Effect.succeed(null),
    });
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: MemoryStoreInput
  ): Layer.Layer<DeepseekStore> =>
    Layer.succeed(this, memoryFileStore("deepseek", input));
}
