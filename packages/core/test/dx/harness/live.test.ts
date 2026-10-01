// @effect-diagnostics nodeBuiltinImport:off -- The live tier resolves the repository root once to scope Cursor discovery.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import { HARNESS_IDS } from "../../../src/dx/harness/ids.js";
import { HarnessRegistryLive } from "../../../src/dx/harness/registry.js";
import { harnessConformance } from "./conformance.js";

const repoRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  ".."
);

const liveRegistry = HarnessRegistryLive.pipe(
  Layer.provide(NodeServices.layer)
);

for (const id of HARNESS_IDS) {
  harnessConformance(id, liveRegistry, {
    maxSessions: 25,
    scope: { ...everywhere, worktrees: [repoRoot] },
    tier: "live",
  });
}
