import { Effect, Option } from "effect";

import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import type {
  EventStoreService,
  StoreFailure,
  StoreSnapshot,
} from "../../contracts/services.js";
import {
  accountAwareEvents,
  narrowToBranch,
  reattributeIfPossible,
  summaryToJson,
} from "../../correlation/branch-at-time/snapshot.js";
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
  readonly attribution?: ReturnType<typeof summaryToJson>;
}

const disclosureOf = (
  applied: boolean,
  attribution: ReturnType<typeof summaryToJson>
): string | null =>
  applied
    ? `Events re-attributed to the branch checked out when they happened (D8): ${
        attribution
          .map(
            (b) =>
              `${b.branch ?? "(unattributed)"} ${String(b.events)} [${Object.entries(
                b.byMethod
              )
                .map(([m, n]) => `${m}=${String(n)}`)
                .join(", ")}]`
          )
          .join("; ") || "no events"
      }.`
    : null;

const retroactive = (
  store: EventStoreService,
  selector: SnapshotSelector
): Effect.Effect<
  {
    readonly snapshot: StoreSnapshot;
    readonly attribution: ReturnType<typeof summaryToJson>;
    readonly disclosure: string | null;
  },
  StoreFailure
> =>
  Effect.gen(function* retroactiveSnapshot() {
    const { events, wide } = yield* accountAwareEvents(store, selector);
    const retro = yield* reattributeIfPossible(events);
    const narrowed = narrowToBranch(wide, selector, retro.events);

    const manifest =
      selector.branch === null
        ? narrowed.manifest
        : (yield* store.snapshot(selector)).manifest;

    return {
      attribution: summaryToJson(retro.summary),
      disclosure: disclosureOf(retro.applied, summaryToJson(retro.summary)),
      snapshot: { ...narrowed, manifest },
    };
  });

const pinned = (
  store: EventStoreService,
  snapshotId: SnapshotId
): Effect.Effect<SelectedSnapshot, StoreFailure | SnapshotNotFound> =>
  Effect.gen(function* pinnedSnapshot() {
    const stored = yield* store.getSnapshot(snapshotId);

    return {
      disclosures: [
        `Reused requested snapshot ${snapshotId}.`,
        "Legacy snapshot reproducibility is evidence-selection-only; historical attribution, prices and metric implementations were not retained. Recorded observations are reused without consulting current Git state.",
      ],
      mode: "pinned" as const,
      snapshot: stored,
    };
  });

const latest = (
  store: EventStoreService,
  selector: SnapshotSelector
): Effect.Effect<SelectedSnapshot, StoreFailure> =>
  Effect.gen(function* latestSnapshot() {
    const retro = yield* retroactive(store, selector);
    const { snapshot } = retro;
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

    return {
      attribution: retro.attribution,
      disclosures:
        retro.disclosure === null
          ? disclosures
          : [...disclosures, retro.disclosure],
      mode: "latest" as const,
      snapshot,
    };
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
      retroactive(store, { ...request.selector, to: asOf }),
      (retro) => ({
        attribution: retro.attribution,
        disclosures: [
          `Analyzed snapshot ${retro.snapshot.manifest.snapshotId} bounded to asOf ${asOf}.`,
          ...(retro.disclosure === null ? [] : [retro.disclosure]),
        ],
        mode: "as-of" as const,
        snapshot: retro.snapshot,
      })
    );
  }

  return latest(store, request.selector);
};
