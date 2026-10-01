import { Context, Effect, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";

export class DeepseekStore extends Context.Service<
  DeepseekStore,
  HarnessStore
>()("dx/harness/deepseek/DeepseekStore", {
  make: Effect.gen(function* makeDeepseekStore() {
    const home = yield* HarnessHome;
    const path = yield* Path.Path;

    return yield* liveFileStore({
      harness: "deepseek",
      isSession: (relative) =>
        relative.endsWith(".jsonl.zstd") || relative.endsWith(".jsonl"),
      roots: Effect.succeed([path.join(home.dirs.deepseek, "sessions")]),
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
