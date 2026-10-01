import { Context, Effect, Layer } from "effect";

import type { Harness } from "../contract.js";
import { pendingHarness } from "../pending.js";
import { CLAUDE_CODE_CHANNELS } from "./meta.js";
import { ClaudeCodeStore } from "./store.js";

export class ClaudeCodeHarness extends Context.Service<
  ClaudeCodeHarness,
  Harness
>()("dx/harness/claude-code/ClaudeCodeHarness", {
  make: Effect.gen(function* makeClaudeCodeHarness() {
    const store = yield* ClaudeCodeStore;

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
          storedFigure: "api-equivalent",
          subagents: true,
        },
        channels: CLAUDE_CODE_CHANNELS,
        displayName: "Claude Code",
        id: "claude-code",
      },
      store
    );
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = this.layer.pipe(
    Layer.provide(ClaudeCodeStore.memory({ files: [], roots: [] }))
  );
}
