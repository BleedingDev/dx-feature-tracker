import type { Effect } from "effect";

import type { AgentFailure } from "../../contracts/agent.js";
import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { QueryFailure } from "../../contracts/errors.js";
import type { DxMetric } from "../../contracts/services.js";
import type { AgentScope } from "../../model/agent-common.js";
import type {
  AgentQueryInput,
  AgentQueryOutput,
} from "../../model/agent-query.js";
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
  readonly resolveDescriptors?: () => Effect.Effect<
    readonly ModuleDescriptor[]
  >;
  readonly metrics: readonly DxMetric[];
  readonly resolveSelector?: SelectorResolver;
  readonly persistSnapshots?: boolean;
  readonly resolveMetrics?: () => readonly DxMetric[];
  readonly agentQuery?: (
    input: AgentQueryInput
  ) => Effect.Effect<AgentQueryOutput, QueryFailure | AgentFailure>;
  readonly resolveScope?: () => AgentScope;
}
