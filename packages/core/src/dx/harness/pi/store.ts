import { Context, Effect, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";

export class PiStore extends Context.Service<PiStore, HarnessStore>()(
  "dx/harness/pi/PiStore",
  {
    make: Effect.gen(function* makePiStore() {
      const home = yield* HarnessHome;
      const path = yield* Path.Path;

      return yield* liveFileStore({
        harness: "pi",
        isSession: (relative) => relative.endsWith(".jsonl"),
        roots: Effect.succeed([path.join(home.dirs.pi, "sessions")]),
        version: Effect.succeed(null),
      });
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (input: MemoryStoreInput): Layer.Layer<PiStore> =>
    Layer.succeed(this, memoryFileStore("pi", input));
}
