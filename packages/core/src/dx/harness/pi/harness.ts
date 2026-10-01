import { Context, Effect, Layer } from "effect";

import type { Harness } from "../contract.js";
import { pendingHarness } from "../pending.js";
import { PI_CHANNELS } from "./meta.js";
import { PiStore } from "./store.js";

export class PiHarness extends Context.Service<PiHarness, Harness>()(
  "dx/harness/pi/PiHarness",
  {
    make: Effect.gen(function* makePiHarness() {
      const store = yield* PiStore;

      return pendingHarness(
        {
          capabilities: {
            branchSources: [
              "hook",
              "git-at-time",
              "cwd-inferred",
              "unassigned",
            ],
            liveHooks: true,
            storedFigure: "api-equivalent",
            subagents: false,
          },
          channels: PI_CHANNELS,
          displayName: "Pi",
          id: "pi",
        },
        store
      );
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = this.layer.pipe(
    Layer.provide(PiStore.memory({ files: [], roots: [] }))
  );
}
