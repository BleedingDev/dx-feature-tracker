import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const CURSOR_USAGE_API_FIXTURE_IDS = ["auto-usage-api-pages"] as const;

export const cursorUsageApiDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CURSOR_USAGE_API_FIXTURE_IDS],
  gaps: [
    {
      code: "auto-model-hidden",
      message:
        'Rows billed under Auto report model "default"; Cursor does not expose the real model behind Auto in the usage API, so it stays "default"',
    },
    {
      code: "no-request-id",
      message:
        "Dashboard rows carry conversationId but no requestId; correlation joins on conversationId and time window",
    },
    {
      code: "branch-unassigned",
      message:
        "Dashboard rows carry no branch; every event is unassigned until a correlator assigns it",
    },
  ],
  id: DescriptorIdSchema.make("collector.cursor-usage-api"),
  kind: "collector",
  owner: "AUTO-USAGE",
  readiness: "ready",
  requiredInputs: [
    "logged-in Cursor client (cursorAuth/accessToken in the local state DB), read at runtime only; DFT_CURSOR_USAGE=off disables",
  ],
  supportedFields: [
    "occurredAt",
    "identity.sessionId",
    "payload.model",
    "payload.rawCategory",
    "payload.tokens.input",
    "payload.tokens.output",
    "payload.tokens.cached-input",
    "payload.tokens.cache-write",
    "payload.costUsd",
    "payload.costLedger",
    "payload.charge",
    "payload.chargedUsd",
    "payload.requestUnits",
    "payload.requestKey",
  ],
  version: "0.1.0",
};
