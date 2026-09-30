import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const mcpQueryHandlersDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["b39-branch-flight"],
  gaps: [
    {
      code: "no-branch-input",
      message:
        "Frozen dx_analyze/dx_explain inputs carry flight and repo only; per-branch selection needs a resolveSelector that maps repo to repoCommonDir plus current branch.",
    },
    {
      code: "disclosures-in-analyze-only",
      message:
        "Snapshot disclosures appear in AnalyzeReport.notes; explain and evidence outputs have no notes field, so unknown evidence IDs are omitted rather than listed.",
    },
    {
      code: "explain-latest-unpersisted",
      message:
        "dx_explain and dx_evidence are read-only: without snapshotId they read an unpersisted latest snapshot; run dx_analyze first to pin one.",
    },
  ],
  id: DescriptorIdSchema.make("dx.surface.mcp-query-handlers"),
  kind: "surface",
  owner: "B39",
  readiness: "ready",
  requiredInputs: ["EventStore", "ModuleDescriptor[]", "DxMetric[]"],
  supportedFields: ["dx_status", "dx_analyze", "dx_explain", "dx_evidence"],
  version: "1.0.0",
};
