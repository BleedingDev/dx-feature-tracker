import { Context, Effect, Layer } from "effect";

import type { Harness } from "../contract.js";
import { pendingHarness } from "../pending.js";
import { OMP_CHANNELS } from "./meta.js";
import { OmpStore } from "./store.js";

export class OmpHarness extends Context.Service<OmpHarness, Harness>()(
  "dx/harness/omp/OmpHarness",
  {
    make: Effect.gen(function* makeOmpHarness() {
      const store = yield* OmpStore;

      return pendingHarness(
        {
          capabilities: {
            branchSources: [
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
          channels: OMP_CHANNELS,
          displayName: "OMP",
          id: "omp",
        },
        store
      );
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = this.layer.pipe(
    Layer.provide(OmpStore.memory({ files: [], roots: [] }))
  );
}
