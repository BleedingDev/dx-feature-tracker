import { Context, Effect, Layer } from "effect";

import type { Harness } from "../contract.js";
import { pendingHarness } from "../pending.js";
import { OPENCODE_CHANNELS } from "./meta.js";
import { OpencodeStore } from "./store.js";

export class OpencodeHarness extends Context.Service<
  OpencodeHarness,
  Harness
>()("dx/harness/opencode/OpencodeHarness", {
  make: Effect.gen(function* makeOpencodeHarness() {
    const store = yield* OpencodeStore;

    return pendingHarness(
      {
        capabilities: {
          branchSources: [
            "git-at-time",
            "cwd-inferred",
            "tool-calls",
            "subagent-split",
            "unassigned",
          ],
          liveHooks: false,
          storedFigure: "api-equivalent",
          subagents: true,
        },
        channels: OPENCODE_CHANNELS,
        displayName: "OpenCode",
        id: "opencode",
      },
      store
    );
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = this.layer.pipe(
    Layer.provide(OpencodeStore.memory({ files: [], roots: [] }))
  );
}
