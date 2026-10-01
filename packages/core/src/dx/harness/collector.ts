import type { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { InvalidInput } from "../contracts/error-invalid-input.js";
import type { CollectInput, DxCollector } from "../contracts/services.js";
import { CONTRACT_VERSION } from "../contracts/version.js";
import type { ModuleDescriptor } from "../model/descriptor.js";
import { DescriptorIdSchema } from "../model/ids.js";
import type { Harness, SessionRef } from "./contract.js";
import type { HarnessId } from "./ids.js";
import { harnessAdapterId } from "./pending.js";
import { HARNESS_META } from "./precedence.js";
import { HarnessRegistry, HarnessRegistryLive } from "./registry.js";

export const HARNESS_COLLECTOR_VERSION = "0.2.0" as const;

export const harnessDescriptor = (id: HarnessId): ModuleDescriptor => {
  const { readiness } = HARNESS_META[id];

  return {
    contractVersion: CONTRACT_VERSION,
    fixtureIds: [],
    gaps:
      readiness === "unsupported"
        ? [
            {
              code: "harness-not-implemented",
              message: `the ${id} harness is a placeholder; it finds no sessions yet`,
            },
          ]
        : [],
    id: DescriptorIdSchema.make(`collector/${harnessAdapterId(id)}`),
    kind: "collector",
    owner: `harness/${id}`,
    readiness,
    requiredInputs: ["one session file path (--input)"],
    supportedFields: ["ai", "usage"],
    version: HARNESS_COLLECTOR_VERSION,
  };
};

export const refForPath = (harness: Harness, path: string): SessionRef => ({
  channel: harness.channels[0] ?? "session-file",
  harness: harness.id,
  id: path,
  mtimeMs: null,
  path,
  sessionId: null,
  size: null,
  source: harnessAdapterId(harness.id),
  worktree: null,
});

const collectFrom = (id: HarnessId) => (input: CollectInput) =>
  Effect.gen(function* collectHarness() {
    const registry = yield* HarnessRegistry;
    const harness = registry.get(id);

    if (harness === null || input.selectedInput === null) {
      return yield* new InvalidInput({
        field: "input",
        message: `pick one ${id} session file with --input, or run dft sync to locate sessions`,
      });
    }

    return yield* harness.read(refForPath(harness, input.selectedInput), {
      context: input.context,
      cursor: input.cursor,
      origin: input.origin,
    });
  }).pipe(Effect.provide(HarnessRegistryLive));

export const toCollector = (
  id: HarnessId
): DxCollector<NodeServices.NodeServices> => ({
  collect: collectFrom(id),
  descriptor: harnessDescriptor(id),
});

export const HARNESS_COLLECTOR_IDS: readonly HarnessId[] = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
  "omp",
  "deepseek",
];

export const harnessCollectors: readonly DxCollector<NodeServices.NodeServices>[] =
  HARNESS_COLLECTOR_IDS.map(toCollector);
