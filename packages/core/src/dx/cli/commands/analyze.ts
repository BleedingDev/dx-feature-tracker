import { DateTime, Effect } from "effect";

import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import type { StoreError } from "../../contracts/error-store-error.js";
import type {
  DxMetric,
  MetricOutput,
  StoreFailure,
} from "../../contracts/services.js";
import type { SnapshotId } from "../../model/ids.js";
import type { AnalyzeReport } from "../../model/report.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import { composeAnalyzeReport } from "../../reports/analyze/compose.js";
import { selectAnalyzeSnapshot } from "../../reports/analyze/select.js";
import type { DxCommandEnv } from "./context.js";
import { writeCachedReport } from "./report-cache.js";

export interface AnalyzeRequest {
  readonly selector: SnapshotSelector;
  readonly snapshotId: SnapshotId | null;
  readonly asOf: string | null;
}

export interface AnalyzeResult {
  readonly disclosures: readonly string[];
  readonly mode: "pinned" | "as-of" | "latest";
  readonly report: AnalyzeReport;
  readonly reportPath: string;
  readonly snapshotId: SnapshotId;
}

const computeAll = (
  metrics: readonly DxMetric[],
  snapshot: Parameters<DxMetric["compute"]>[0]
): readonly MetricOutput[] => metrics.map((m) => m.compute(snapshot));

export const runAnalyze = (
  env: DxCommandEnv,
  metrics: readonly DxMetric[],
  request: AnalyzeRequest
): Effect.Effect<AnalyzeResult, StoreFailure | SnapshotNotFound | StoreError> =>
  Effect.gen(function* analyze() {
    const selected = yield* selectAnalyzeSnapshot(env.store, request);

    if (selected.mode !== "pinned") {
      yield* env.store.putSnapshotManifest(selected.snapshot.manifest);
    }

    const report = composeAnalyzeReport(
      selected.snapshot,
      computeAll(metrics, selected.snapshot),
      selected.disclosures
    );

    const writtenAt = DateTime.formatIso(yield* DateTime.now);

    const reportPath = yield* writeCachedReport(
      env.storePath,
      report,
      writtenAt
    );

    return {
      disclosures: selected.disclosures,
      mode: selected.mode,
      report,
      reportPath,
      snapshotId: selected.snapshot.manifest.snapshotId,
    };
  });
