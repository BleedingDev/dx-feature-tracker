import { Context, Effect, Layer, Path } from "effect";

import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";

export class ClaudeCodeStore extends Context.Service<
  ClaudeCodeStore,
  HarnessStore
>()("dx/harness/claude-code/ClaudeCodeStore", {
  make: Effect.gen(function* makeClaudeCodeStore() {
    const home = yield* HarnessHome;
    const path = yield* Path.Path;

    return yield* liveFileStore({
      harness: "claude-code",
      isSession: (relative) => relative.endsWith(".jsonl"),
      roots: Effect.succeed([path.join(home.dirs.claudeCode, "projects")]),
      version: Effect.succeed(null),
    });
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: MemoryStoreInput
  ): Layer.Layer<ClaudeCodeStore> =>
    Layer.succeed(this, memoryFileStore("claude-code", input));
}
