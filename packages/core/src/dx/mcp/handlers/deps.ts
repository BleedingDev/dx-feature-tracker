import type { Effect } from "effect";

import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { DxMetric } from "../../contracts/services.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { SnapshotSelector } from "../../model/snapshot.js";

export interface SelectorInput {
  readonly flight: string | null;
  readonly repo: string | null;
}

export type SelectorResolver = (
  input: SelectorInput
) => Effect.Effect<SnapshotSelector, InvalidInput>;

export interface DxHandlerDeps {
  readonly descriptors: readonly ModuleDescriptor[];
  readonly metrics: readonly DxMetric[];
  readonly resolveSelector?: SelectorResolver;
}
