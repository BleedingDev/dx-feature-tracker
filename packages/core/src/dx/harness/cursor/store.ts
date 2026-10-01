import { Context, Effect, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";

export class CursorStore extends Context.Service<CursorStore, HarnessStore>()(
  "dx/harness/cursor/CursorStore",
  {
    make: Effect.gen(function* makeCursorStore() {
      const home = yield* HarnessHome;
      const path = yield* Path.Path;

      return yield* liveFileStore({
        harness: "cursor",
        isSession: (relative) =>
          relative.includes(`agent-transcripts${path.sep}`) &&
          (relative.endsWith(".jsonl") || relative.endsWith(".txt")),
        roots: Effect.succeed([path.join(home.dirs.cursor, "projects")]),
        version: Effect.succeed(null),
      });
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: MemoryStoreInput
  ): Layer.Layer<CursorStore> =>
    Layer.succeed(this, memoryFileStore("cursor", input));
}
