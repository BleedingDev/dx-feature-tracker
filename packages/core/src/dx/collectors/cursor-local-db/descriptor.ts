import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const CURSOR_LOCAL_DB_ADAPTER_ID = "cursor-local-db";

export const CURSOR_LOCAL_DB_ADAPTER_VERSION = "0.1.0";

export const CURSOR_LOCAL_DB_FIXTURE_IDS = [
  "b06-state-vscdb-headers",
  "b06-state-vscdb-legacy-itemtable",
  "b06-ai-tracking",
] as const;

export const cursorLocalDbDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CURSOR_LOCAL_DB_FIXTURE_IDS],
  gaps: [
    {
      code: "opt-in-input",
      message:
        "Reads only an explicitly selected state.vscdb or ai-code-tracking.db through a consistent backup copy in scratchDir.",
    },
    {
      code: "no-billed-charge",
      message:
        "Local DB usageData is emitted as a metered ledger; billed charge requires usage CSV or dashboard export.",
    },
    {
      code: "context-meter-not-spend",
      message:
        "Context window occupancy is reported on ai.session as a context meter and is never token spend.",
    },
    {
      code: "workspace-scope",
      message:
        "Composer rows are scoped to the selected repo only when tracked repos or workspace identifiers reference its path; others are excluded and counted.",
    },
  ],
  id: DescriptorIdSchema.make(CURSOR_LOCAL_DB_ADAPTER_ID),
  kind: "collector",
  owner: "B06",
  readiness: "degraded",
  requiredInputs: ["selectedInput:sqlite-path", "scratchDir"],
  supportedFields: [
    "ai.session.createdAt",
    "ai.session.lastUpdatedAt",
    "ai.session.model",
    "ai.session.mode",
    "ai.session.linesAdded",
    "ai.session.linesRemoved",
    "ai.session.filesAdded",
    "ai.session.filesRemoved",
    "ai.session.contextMeter",
    "ai.turn.role",
    "ai.turn.toolName",
    "ai.turn.toolStatus",
    "ai.turn.tokens.input",
    "ai.turn.tokens.output",
    "ai.usage.metered.cents",
    "ai.tool-edit.source",
    "ai.tool-edit.model",
    "provenance.attestation.linesBySource",
  ],
  version: CURSOR_LOCAL_DB_ADAPTER_VERSION,
};
