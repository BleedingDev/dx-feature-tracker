import { Context, Effect, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";

export class OmpStore extends Context.Service<OmpStore, HarnessStore>()(
  "dx/harness/omp/OmpStore",
  {
    make: Effect.gen(function* makeOmpStore() {
      const home = yield* HarnessHome;
      const path = yield* Path.Path;

      return yield* liveFileStore({
        harness: "omp",
        isSession: (relative) => relative.endsWith(".jsonl"),
        roots: Effect.succeed([path.join(home.dirs.omp, "sessions")]),
        version: Effect.succeed(null),
      });
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (input: MemoryStoreInput): Layer.Layer<OmpStore> =>
    Layer.succeed(this, memoryFileStore("omp", input));
}
