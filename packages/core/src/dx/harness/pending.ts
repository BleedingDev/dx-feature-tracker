import { Effect } from "effect";

import type { EventBatch } from "../model/event.js";
import type { HarnessCapabilities, Harness, HarnessStore } from "./contract.js";
import type { Channel, HarnessId } from "./ids.js";

export interface HarnessSpec {
  readonly capabilities: HarnessCapabilities;
  readonly channels: readonly Channel[];
  readonly displayName: string;
  readonly id: HarnessId;
}

export const harnessAdapterId = (harness: HarnessId): string =>
  `harness.${harness}`;

export const emptyHarnessBatch = (
  harness: HarnessId,
  reason: string
): EventBatch => ({
  coverage: {
    adapterId: harnessAdapterId(harness),
    expectedItems: null,
    gaps: [{ code: "harness-not-implemented", message: reason }],
    observedItems: 0,
    state: "unsupported",
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events: [],
});

export const pendingHarness = (
  spec: HarnessSpec,
  store: HarnessStore
): Harness => {
  const reason = `dft does not read ${spec.displayName} sessions yet`;

  return {
    ...spec,
    discover: store.roots.pipe(
      Effect.map((roots) => ({
        harness: spec.id,
        present: false,
        reason,
        roots,
        sessions: 0,
        version: null,
      }))
    ),
    locate: () => Effect.succeed([]),
    read: () => Effect.succeed(emptyHarnessBatch(spec.id, reason)),
  };
};
