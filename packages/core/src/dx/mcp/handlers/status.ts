import { DateTime, Effect } from "effect";

import type { AgentFailure } from "../../contracts/agent.js";
import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import { EventStore } from "../../contracts/event-store.js";
import type { StoreFailure } from "../../contracts/services.js";
import { CONTRACT_DIGEST, CONTRACT_VERSION } from "../../contracts/version.js";
import type { AgentRequest } from "../../model/agent-common.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { StatusReport } from "../../model/report.js";
import type { DxHandlerDeps } from "./deps.js";
import { handleAgentStatus } from "./status-agent.js";

const byId = (a: ModuleDescriptor, b: ModuleDescriptor): number =>
  a.id.localeCompare(b.id) || a.version.localeCompare(b.version);

export const sortedDescriptors = (
  descriptors: readonly ModuleDescriptor[]
): readonly ModuleDescriptor[] => {
  const seen = new Map<string, ModuleDescriptor>();

  for (const descriptor of descriptors) {
    const key = `${descriptor.id}@${descriptor.version}`;

    if (!seen.has(key)) {
      seen.set(key, descriptor);
    }
  }

  return [...seen.values()].toSorted(byId);
};

export const handleStatus = (
  deps: DxHandlerDeps,
  input: {
    readonly agentQuery?: AgentRequest | undefined;
    readonly detail?: "summary" | "detailed" | undefined;
  } = {}
): Effect.Effect<
  StatusReport,
  StoreFailure | AgentFailure | InvalidInput,
  EventStore
> =>
  Effect.gen(function* statusHandler() {
    const started = DateTime.toEpochMillis(yield* DateTime.now);
    const store = yield* EventStore;
    const snapshotCount = yield* store.snapshotCount;

    const base: StatusReport = {
      contractDigest: CONTRACT_DIGEST,
      contractVersion: CONTRACT_VERSION,
      descriptors: sortedDescriptors(
        yield* deps.resolveDescriptors?.() ?? Effect.succeed(deps.descriptors)
      ),
      snapshotCount,
      storePath: store.storePath,
    };

    return input.agentQuery === undefined
      ? base
      : yield* handleAgentStatus(deps, base, input.agentQuery, started);
  });
