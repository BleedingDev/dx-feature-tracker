import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import { HarnessRegistryLive } from "../../../src/dx/harness/registry.js";
import { harnessConformance } from "./conformance.js";

harnessConformance(
  "omp",
  HarnessRegistryLive.pipe(Layer.provide(NodeServices.layer)),
  { maxSessions: 25, scope: everywhere, tier: "live" }
);
