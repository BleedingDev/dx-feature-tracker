import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const CLI_COMMANDS_VERSION = "1.0.0" as const;

export const B38_FIXTURE_IDS = ["b38-branch-flight"] as const;

export const cliCommandsDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...B38_FIXTURE_IDS],
  gaps: [
    {
      code: "registration-external",
      message:
        "Handlers only; argv parsing, CLI/MCP registration and store opening are composed by A02/A07.",
    },
    {
      code: "explicit-source-only",
      message:
        "collect runs exactly one explicitly selected collector; nothing is auto-discovered or scanned.",
    },
    {
      code: "manifest-descriptors-empty",
      message:
        "Snapshot manifests keep the store's enabledDescriptors/metricDefinitions (empty); metric identity is carried by report metrics.",
    },
  ],
  id: DescriptorIdSchema.make("surface/cli-commands"),
  kind: "surface",
  owner: "B38",
  readiness: "ready",
  requiredInputs: [
    "EventStoreService",
    "storePath",
    "DxCollector[]",
    "DxMetric[]",
  ],
  supportedFields: [
    "start.eventId",
    "collect.inserted",
    "collect.spooledTo",
    "import.inserted",
    "analyze.snapshotId",
    "analyze.reportPath",
    "explain.snapshot-unavailable",
    "status.cachedReport.reportPath",
    "status.latestSnapshotId",
    "status.snapshotCount",
  ],
  version: CLI_COMMANDS_VERSION,
};
