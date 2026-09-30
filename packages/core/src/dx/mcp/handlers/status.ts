import { Effect } from "effect";

import { EventStore } from "../../contracts/event-store.js";
import type { StoreFailure } from "../../contracts/services.js";
import { CONTRACT_DIGEST, CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { StatusReport } from "../../model/report.js";
import type { DxHandlerDeps } from "./deps.js";

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
  deps: DxHandlerDeps
): Effect.Effect<StatusReport, StoreFailure, EventStore> =>
  Effect.gen(function* statusHandler() {
    const store = yield* EventStore;
    const snapshotCount = yield* store.snapshotCount;

    return {
      contractDigest: CONTRACT_DIGEST,
      contractVersion: CONTRACT_VERSION,
      descriptors: sortedDescriptors(deps.descriptors),
      snapshotCount,
      storePath: store.storePath,
    };
  });
