import { Context, Effect, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";

export class OpencodeStore extends Context.Service<
  OpencodeStore,
  HarnessStore
>()("dx/harness/opencode/OpencodeStore", {
  make: Effect.gen(function* makeOpencodeStore() {
    const home = yield* HarnessHome;
    const path = yield* Path.Path;

    return yield* liveFileStore({
      harness: "opencode",
      isSession: (relative) => relative.endsWith(".json"),
      roots: Effect.succeed([path.join(home.dirs.opencodeData, "storage")]),
      version: Effect.succeed(null),
    });
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: MemoryStoreInput
  ): Layer.Layer<OpencodeStore> =>
    Layer.succeed(this, memoryFileStore("opencode", input));
}
