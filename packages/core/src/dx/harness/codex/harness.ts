import { Context, Effect, Layer } from "effect";

import type { Harness } from "../contract.js";
import { pendingHarness } from "../pending.js";
import { CODEX_CHANNELS } from "./meta.js";
import { CodexStore } from "./store.js";

export class CodexHarness extends Context.Service<CodexHarness, Harness>()(
  "dx/harness/codex/CodexHarness",
  {
    make: Effect.gen(function* makeCodexHarness() {
      const store = yield* CodexStore;

      return pendingHarness(
        {
          capabilities: {
            branchSources: [
              "harness-recorded",
              "hook",
              "git-at-time",
              "cwd-inferred",
              "subagent-split",
              "unassigned",
            ],
            liveHooks: true,
            storedFigure: null,
            subagents: true,
          },
          channels: CODEX_CHANNELS,
          displayName: "Codex",
          id: "codex",
        },
        store
      );
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = this.layer.pipe(
    Layer.provide(CodexStore.memory({ files: [], roots: [] }))
  );
}
