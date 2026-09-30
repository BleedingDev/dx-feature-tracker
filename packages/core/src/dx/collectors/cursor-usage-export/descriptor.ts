import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import { CURSOR_USAGE_EXPORT_ADAPTER_VERSION } from "./parse.js";

export const CURSOR_USAGE_EXPORT_FIXTURE_IDS = [
  "b08-usage-kind-cache-split",
  "b08-usage-legacy-flat",
  "b08-usage-team-user",
  "b08-usage-unsupported",
] as const;

export const cursorUsageExportDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CURSOR_USAGE_EXPORT_FIXTURE_IDS],
  gaps: [
    {
      code: "shape-unverified",
      message:
        "No real Cursor dashboard usage CSV was available on this host; column variants follow publicly seen exports and are fixture-tested only",
    },
    {
      code: "branch-unassigned",
      message:
        "Rows carry no branch, request or session identity; every row is unassigned until a correlator assigns it by time window",
    },
    {
      code: "token-category-mapping-unverified",
      message:
        "Raw column names are preserved in payload.rawTokens; normalized categories are best-effort until a semantic probe against a real export passes",
    },
    {
      code: "explicit-file-only",
      message:
        "Imports one explicitly selected .csv file; never scans Downloads, browser storage or Cursor dashboard",
    },
  ],
  id: DescriptorIdSchema.make("collector.cursor-usage-export"),
  kind: "collector",
  owner: "B08",
  readiness: "degraded",
  requiredInputs: [
    "selectedInput: path to one user-exported Cursor usage .csv",
  ],
  supportedFields: [
    "occurredAt",
    "payload.model",
    "payload.maxMode",
    "payload.rawCategory",
    "payload.tokens.input",
    "payload.tokens.cached-input",
    "payload.tokens.cache-write",
    "payload.tokens.output",
    "payload.tokens.reasoning",
    "payload.tokens.total",
    "payload.rawTokens",
    "payload.costUsd",
    "payload.costLedger",
    "payload.charge",
    "payload.requestUnits",
    "payload.batchId",
  ],
  version: CURSOR_USAGE_EXPORT_ADAPTER_VERSION,
};
