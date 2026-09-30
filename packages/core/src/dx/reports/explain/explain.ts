import { Effect } from "effect";

import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import type {
  EventStoreService,
  StoreFailure,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import type { SnapshotId } from "../../model/ids.js";
import type { ExplainTimeline } from "../../model/report.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import { selectAnalyzeSnapshot } from "../analyze/select.js";
import { buildTimeline } from "./timeline.js";

export const EXPLAIN_REPORT_VERSION = "1.0.0" as const;

export interface ExplainRequest {
  readonly selector: SnapshotSelector;
  readonly snapshotId: SnapshotId | null;
  readonly asOf: string | null;
  readonly cursor: string | null;
  readonly limit: number | null;
}

export interface ExplainResult {
  readonly timeline: ExplainTimeline;
  readonly mode: "pinned" | "as-of" | "latest";
  readonly disclosures: readonly string[];
}

export const explainTimeline = (
  store: EventStoreService,
  request: ExplainRequest
): Effect.Effect<
  ExplainResult,
  StoreFailure | SnapshotNotFound | InvalidInput
> =>
  Effect.gen(function* explainGen() {
    const selected = yield* selectAnalyzeSnapshot(store, {
      asOf: request.asOf,
      selector: request.selector,
      snapshotId: request.snapshotId,
    });

    const timeline = yield* Effect.fromResult(
      buildTimeline(selected.snapshot, {
        cursor: request.cursor,
        limit: request.limit,
      })
    );

    const untimed = timeline.entries.filter(
      (entry) => entry.occurredAt === null
    ).length;

    const disclosures =
      untimed > 0
        ? [
            ...selected.disclosures,

            `${untimed} entr${untimed === 1 ? "y has" : "ies have"} no source timestamp; placed last with orderingUncertain.`,
          ]
        : selected.disclosures;

    return { disclosures, mode: selected.mode, timeline };
  });

export const explainReportDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b36-mixed-lanes",
    "b36-permuted-lanes",
    "b36-uncertain-ordering",
  ],
  gaps: [
    {
      code: "lane-granularity",
      message:
        "Lanes are one per adapterId (source lane); no per-session or per-agent sub-lanes.",
    },
    {
      code: "summary-redaction",
      message:
        "Entry summaries echo only numeric/boolean payload fields plus non-observed value methods; free text stays in dx_evidence.",
    },
    {
      code: "cursor-offset",
      message:
        "Cursor is an offset bound to an immutable snapshotId; a cursor for a different snapshot is rejected as InvalidInput.",
    },
  ],
  id: DescriptorIdSchema.make("dx.report.explain"),
  kind: "report",
  owner: "B36",
  readiness: "ready",
  requiredInputs: ["EventStore", "SnapshotSelector"],
  supportedFields: [
    "entries",
    "lanes",
    "nextCursor",
    "snapshotId",
    "total",
    "orderingUncertain",
  ],
  version: EXPLAIN_REPORT_VERSION,
};
