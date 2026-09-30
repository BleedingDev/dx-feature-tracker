import { Effect } from "effect";

import type { StoreFailure } from "../../contracts/services.js";
import { CONTRACT_DIGEST, CONTRACT_VERSION } from "../../contracts/version.js";
import type { SourceCoverage } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { SnapshotId } from "../../model/ids.js";
import type { StatusReport } from "../../model/report.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import type { DxCommandEnv } from "./context.js";
import { readLatestReportPointer } from "./report-cache.js";
import type { CachedReportPointer } from "./report-cache.js";

export interface StatusResult extends StatusReport {
  readonly cachedReport: CachedReportPointer | null;
  readonly coverage: readonly SourceCoverage[];
  readonly latestSnapshotId: SnapshotId | null;
}

export const runStatus = (
  env: DxCommandEnv,
  descriptors: readonly ModuleDescriptor[],
  selector: SnapshotSelector
): Effect.Effect<StatusResult, StoreFailure> =>
  Effect.gen(function* status() {
    const snapshotCount = yield* env.store.snapshotCount;
    const latestSnapshotId = yield* env.store.latestSnapshotId(selector);
    const coverage = yield* env.store.coverage(selector);
    const cachedReport = yield* readLatestReportPointer(env.storePath);

    return {
      cachedReport,
      contractDigest: CONTRACT_DIGEST,
      contractVersion: CONTRACT_VERSION,
      coverage,
      descriptors: [...descriptors],
      latestSnapshotId,
      snapshotCount,
      storePath: env.store.storePath ?? env.storePath,
    };
  });
