import { Effect } from "effect";

import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { StoreFailure } from "../../contracts/services.js";
import type { SnapshotId } from "../../model/ids.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import { explainTimeline } from "../../reports/explain/explain.js";
import type { ExplainResult } from "../../reports/explain/explain.js";
import type { DxCommandEnv } from "./context.js";

export interface ExplainCommandRequest {
  readonly selector: SnapshotSelector;
  readonly snapshotId: SnapshotId | null;
  readonly asOf: string | null;
  readonly cursor: string | null;
  readonly limit: number | null;
}

export type SnapshotProblem = "unknown" | "expired" | "incompatible";

export type ExplainCommandResult =
  | ({ readonly status: "ok" } & ExplainResult)
  | {
      readonly status: "snapshot-unavailable";
      readonly problem: SnapshotProblem;
      readonly snapshotId: string;
      readonly message: string;
    };

const problemOf = (message: string): SnapshotProblem => {
  if (message.startsWith("expired_snapshot")) {
    return "expired";
  }

  if (message.startsWith("incompatible_snapshot")) {
    return "incompatible";
  }

  return "unknown";
};

export const runExplain = (
  env: DxCommandEnv,
  request: ExplainCommandRequest
): Effect.Effect<ExplainCommandResult, StoreFailure | InvalidInput> =>
  explainTimeline(env.store, request).pipe(
    Effect.map((result): ExplainCommandResult => ({ ...result, status: "ok" })),
    Effect.catchTag("SnapshotNotFound", (notFound) =>
      Effect.succeed<ExplainCommandResult>({
        message: notFound.message,
        problem: problemOf(notFound.message),
        snapshotId: notFound.snapshotId,
        status: "snapshot-unavailable",
      })
    )
  );
