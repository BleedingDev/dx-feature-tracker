import { Context, Effect, Layer } from "effect";

import type { Harness } from "../contract.js";
import { pendingHarness } from "../pending.js";
import { DEEPSEEK_CHANNELS } from "./meta.js";
import { DeepseekStore } from "./store.js";

export class DeepseekHarness extends Context.Service<
  DeepseekHarness,
  Harness
>()("dx/harness/deepseek/DeepseekHarness", {
  make: Effect.gen(function* makeDeepseekHarness() {
    const store = yield* DeepseekStore;

    return pendingHarness(
      {
        capabilities: {
          branchSources: [
            "git-at-time",
            "cwd-inferred",
            "subagent-split",
            "unassigned",
          ],
          liveHooks: false,
          storedFigure: null,
          subagents: true,
        },
        channels: DEEPSEEK_CHANNELS,
        displayName: "DeepSeek Harness",
        id: "deepseek",
      },
      store
    );
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = this.layer.pipe(
    Layer.provide(DeepseekStore.memory({ files: [], roots: [] }))
  );
}
