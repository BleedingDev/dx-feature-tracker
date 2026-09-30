import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";

export const evidenceReportDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b37-secrets",
    "b37-content-withheld",
    "b37-bounded-ref",
    "b37-unknown-ids",
    "b37-snapshot-pinning",
  ],
  gaps: [
    {
      code: "no-raw-content",
      message:
        "dx_evidence never returns raw prompts, transcripts, diffs or command text; content-bearing fields are withheld with their length only.",
    },
    {
      code: "pattern-redaction",
      message:
        "Secret redaction is pattern based (tokens, keys, JWT, credentials, emails, home paths); unknown secret formats in non-content metadata strings may pass.",
    },
  ],
  id: DescriptorIdSchema.make("dx.report.evidence"),
  kind: "report",
  owner: "B37",
  readiness: "ready",
  requiredInputs: ["EventStore snapshot"],
  supportedFields: [
    "adapterId",
    "evidenceId",
    "excerpt",
    "origin",
    "redacted",
    "ref",
  ],
  version: "1.0.0",
};
