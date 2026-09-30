import { Effect, Option } from "effect";

import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import type {
  EventStoreService,
  StoreFailure,
  StoreSnapshot,
} from "../../contracts/services.js";
import type { SnapshotId } from "../../model/ids.js";
import type { SnapshotSelector } from "../../model/snapshot.js";

export interface AnalyzeSnapshotRequest {
  readonly selector: SnapshotSelector;
  readonly snapshotId: SnapshotId | null;
  readonly asOf: string | null;
}

export interface SelectedSnapshot {
  readonly snapshot: StoreSnapshot;
  readonly mode: "pinned" | "as-of" | "latest";
  readonly disclosures: readonly string[];
}

const pinned = (
  store: EventStoreService,
  snapshotId: SnapshotId
): Effect.Effect<SelectedSnapshot, StoreFailure | SnapshotNotFound> =>
  Effect.map(store.getSnapshot(snapshotId), (snapshot) => ({
    disclosures: [`Reused requested snapshot ${snapshotId}.`],
    mode: "pinned" as const,
    snapshot,
  }));

const latest = (
  store: EventStoreService,
  selector: SnapshotSelector
): Effect.Effect<SelectedSnapshot, StoreFailure> =>
  Effect.gen(function* latestSnapshot() {
    const snapshot = yield* store.snapshot(selector);
    const previousId = yield* store.latestSnapshotId(selector);

    const previous =
      previousId === null || previousId === snapshot.manifest.snapshotId
        ? null
        : yield* Effect.option(store.getSnapshot(previousId));

    const disclosures =
      previous === null || Option.isNone(previous)
        ? [
            `No snapshotId requested; analyzed latest snapshot ${snapshot.manifest.snapshotId}.`,
          ]
        : [
            `No snapshotId requested; analyzed latest snapshot ${snapshot.manifest.snapshotId}.`,
            previous.value.manifest.eventWatermark ===
            snapshot.manifest.eventWatermark
              ? `Evidence unchanged since previous snapshot ${previousId}.`
              : `Evidence changed since previous snapshot ${previousId} (watermark ${previous.value.manifest.eventWatermark} -> ${snapshot.manifest.eventWatermark}).`,
          ];

    return { disclosures, mode: "latest" as const, snapshot };
  });

export const selectAnalyzeSnapshot = (
  store: EventStoreService,
  request: AnalyzeSnapshotRequest
): Effect.Effect<SelectedSnapshot, StoreFailure | SnapshotNotFound> => {
  if (request.snapshotId !== null) {
    return pinned(store, request.snapshotId);
  }

  if (request.asOf !== null) {
    const { asOf } = request;

    return Effect.map(
      store.snapshot({ ...request.selector, to: asOf }),
      (snapshot) => ({
        disclosures: [
          `Analyzed snapshot ${snapshot.manifest.snapshotId} bounded to asOf ${asOf}.`,
        ],
        mode: "as-of" as const,
        snapshot,
      })
    );
  }

  return latest(store, request.selector);
};
