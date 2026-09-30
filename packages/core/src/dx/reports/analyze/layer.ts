import { Layer } from "effect";

import { ReportComposer } from "../../contracts/report-composer.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import { analyzeReportComposer } from "./compose.js";

export const ANALYZE_REPORT_VERSION = "1.0.0" as const;

export const analyzeReportDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b35-mixed-branch",
    "b35-permuted-branch",
    "b35-dishonest-inputs",
    "b35-empty",
  ],
  gaps: [
    {
      code: "no-arithmetic",
      message:
        "The composer never recomputes or sums metric values; per-branch totals must come from metric owners.",
    },
    {
      code: "snapshot-persistence",
      message:
        "selectAnalyzeSnapshot reads manifests through EventStore; persisting a new manifest is the capability handler's job.",
    },
  ],
  id: DescriptorIdSchema.make("dx.report.analyze"),
  kind: "report",
  owner: "B35",
  readiness: "ready",
  requiredInputs: ["StoreSnapshot", "MetricOutput[]"],
  supportedFields: [
    "metrics",
    "findings",
    "coverage",
    "notes",
    "snapshot",
    "flightId",
  ],
  version: ANALYZE_REPORT_VERSION,
};

export const ReportComposerLive = Layer.succeed(
  ReportComposer,
  analyzeReportComposer
);
