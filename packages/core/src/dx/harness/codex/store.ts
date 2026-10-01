import { Context, Effect, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";

export class CodexStore extends Context.Service<CodexStore, HarnessStore>()(
  "dx/harness/codex/CodexStore",
  {
    make: Effect.gen(function* makeCodexStore() {
      const home = yield* HarnessHome;
      const path = yield* Path.Path;

      return yield* liveFileStore({
        harness: "codex",
        isSession: (relative) =>
          path.basename(relative).startsWith("rollout-") &&
          relative.endsWith(".jsonl"),
        roots: Effect.succeed([
          path.join(home.dirs.codex, "sessions"),
          path.join(home.dirs.codex, "archived_sessions"),
        ]),
        version: Effect.succeed(null),
      });
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (input: MemoryStoreInput): Layer.Layer<CodexStore> =>
    Layer.succeed(this, memoryFileStore("codex", input));
}
