import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const AI_CORRELATION_DESCRIPTOR_ID = "correlation/ai";

export const aiCorrelationDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "core-ai-overlap",
    "core-branch-ambiguity",
    "b26-conversation-branch-join",
  ],
  gaps: [
    {
      code: "time-window-provisional",
      message:
        "Claims without branch context or a branch-bearing conversation are placed by observed branch activity windows only; such placements stay provisional.",
    },
    {
      code: "amount-shapes-limited",
      message:
        "Amounts are read from payload.measurements, payload.tokens, payload.charge and payload.costUsd+costLedger; unverified raw hook usage (semanticsVerified=false) contributes no amounts.",
    },
    {
      code: "no-cumulative-differencing",
      message:
        "Cumulative counters are not differenced here; B30 accounts ledgers after cumulativeVerified.",
    },
  ],
  id: DescriptorIdSchema.make(AI_CORRELATION_DESCRIPTOR_ID),
  kind: "correlation",
  owner: "B26",
  readiness: "ready",
  requiredInputs: [
    "ai.request/ai.turn/ai.usage events",
    "optional session:<id> -> branch mappings",
  ],
  supportedFields: [
    "overlapGroups.collapsed",
    "overlapGroups.alternative",
    "overlapGroups.unresolved",
    "claims.branchAttribution",
    "claims.requestKey",
    "branches.units",
    "branches.amounts",
    "fractions.units",
    "fractions.amounts",
  ],
  version: "1.0.0",
};
