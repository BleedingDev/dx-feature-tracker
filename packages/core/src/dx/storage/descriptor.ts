import { CONTRACT_VERSION } from "../contracts/version.js";
import type { ModuleDescriptor } from "../model/descriptor.js";
import { DescriptorIdSchema } from "../model/ids.js";

export const EVENT_STORE_DESCRIPTOR_ID = "service/event-store-sqlite";

export const eventStoreDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "core-golden-flight",
    "core-ai-overlap",
    "core-unavailable-sources",
    "b01-replay-reordered",
  ],
  gaps: [
    {
      code: "no_snapshot_expiry",
      message:
        "Snapshots never expire during this run; expired_snapshot is reported only when member events were removed from the store.",
    },
    {
      code: "registry_check_by_caller",
      message:
        "The store checks the contract digest; descriptor and metric-version compatibility of a stored manifest is checked by the analyze owner against the live registry.",
    },
  ],
  id: DescriptorIdSchema.make(EVENT_STORE_DESCRIPTOR_ID),
  kind: "service",
  owner: "B01",
  readiness: "ready",
  requiredInputs: ["store path (--store, DX_STORE or default)"],
  supportedFields: [
    "append.inserted",
    "append.duplicates",
    "snapshot.events",
    "snapshot.coverage",
    "snapshot.manifest",
    "getSnapshot",
    "latestSnapshotId",
    "snapshotCount",
    "spool.drain",
  ],
  version: "1.0.0",
};
