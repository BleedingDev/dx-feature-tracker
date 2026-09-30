import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import { CURSOR_DASHBOARD_RESPONSE_ADAPTER_VERSION } from "./parse.js";

export const CURSOR_DASHBOARD_RESPONSE_FIXTURE_IDS = [
  "b43-dashboard-complete-paged",
  "b43-dashboard-missing-page",
  "b43-dashboard-single-no-total",
  "b43-dashboard-har-refused",
  "b43-dashboard-cookie-refused",
] as const;

export const cursorDashboardResponseDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CURSOR_DASHBOARD_RESPONSE_FIXTURE_IDS],
  gaps: [
    {
      code: "not-demonstrated",
      message:
        "No user-exported Cursor dashboard usage response exists on this host; the collector is fixture-tested only and must not be registered as ready",
    },
    {
      code: "shape-unverified",
      message:
        "Field names (usageEventsDisplay, totalUsageEventsCount, tokenUsage.*, usageBasedCosts, requestsCosts, kind) follow publicly seen dashboard responses and are not verified against a live export",
    },
    {
      code: "request-key-unverified",
      message:
        "requestId/conversationId are read only when a row carries them; dashboard rows may carry neither, leaving time-window correlation as the only join",
    },
    {
      code: "branch-unassigned",
      message:
        "Dashboard rows carry no branch; every event is unassigned until a correlator assigns it",
    },
    {
      code: "no-credentials",
      message:
        "Imports one explicitly selected response-body JSON; never calls the dashboard, never reads cookies, and refuses HAR captures or files with cookie/token keys",
    },
  ],
  id: DescriptorIdSchema.make("collector.cursor-dashboard-response"),
  kind: "collector",
  owner: "B43",
  readiness: "disabled",
  requiredInputs: [
    "selectedInput: path to one user-saved dashboard usage response JSON (single response, array of responses, or {pages:[{request:{page,pageSize},response}]})",
  ],
  supportedFields: [
    "occurredAt",
    "identity.requestId",
    "identity.sessionId",
    "payload.model",
    "payload.maxMode",
    "payload.rawCategory",
    "payload.tokens.input",
    "payload.tokens.output",
    "payload.tokens.cached-input",
    "payload.tokens.cache-write",
    "payload.tokens.reasoning",
    "payload.tokens.total",
    "payload.rawTokens",
    "payload.costUsd",
    "payload.costLedger",
    "payload.costRawField",
    "payload.charge",
    "payload.requestUnits",
    "payload.requestKey",
    "payload.batchId",
  ],
  version: CURSOR_DASHBOARD_RESPONSE_ADAPTER_VERSION,
};
