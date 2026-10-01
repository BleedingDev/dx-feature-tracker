// @effect-diagnostics nodeBuiltinImport:off -- This test reads committed fixtures and opens throwaway SQLite files in an owned temp directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type {
  EventStoreService,
  StoreFailure,
} from "../../src/dx/contracts/services.js";
import { EventBatchSchema } from "../../src/dx/model/event.js";
import type { EventBatch } from "../../src/dx/model/event.js";
import { FlightIdSchema, SnapshotIdSchema } from "../../src/dx/model/ids.js";
import type { SnapshotSelector } from "../../src/dx/model/snapshot.js";
import { eventStoreDescriptor } from "../../src/dx/storage/descriptor.js";
import { drainSpool, writeSpoolBatch } from "../../src/dx/storage/spool.js";
import {
  SNAPSHOT_ERROR_CODES,
  openSqliteEventStore,
} from "../../src/dx/storage/sqlite-event-store.js";
import type { SqliteEventStoreOptions } from "../../src/dx/storage/sqlite-event-store.js";
import {
  resolveStorePath,
  spoolDirFor,
} from "../../src/dx/storage/store-path.js";
import { emptySelector } from "./fakes.js";

const FixtureDocSchema = Schema.Struct({
  batches: Schema.Array(EventBatchSchema),
});

const ReplayPlanSchema = Schema.Struct({
  canonicalOrder: Schema.Array(Schema.Int),
  expectations: Schema.Struct({
    events: Schema.Int,
    replayDuplicates: Schema.Int,
    selectorFlightId: Schema.String,
  }),
  fixtureId: Schema.String,
  replayOrder: Schema.Array(Schema.Int),
});

const fixturesDir = path.join(import.meta.dirname, "fixtures");

const readFixture = (relative: string): string =>
  readFileSync(path.join(fixturesDir, relative), "utf-8");

const decodeFixtureDoc = Schema.decodeUnknownSync(
  Schema.fromJsonString(FixtureDocSchema)
);

const decodeReplayPlan = Schema.decodeUnknownSync(
  Schema.fromJsonString(ReplayPlanSchema)
);

const golden = decodeFixtureDoc(readFixture("core/core-golden-flight.json"));

const unavailable = decodeFixtureDoc(
  readFixture("core/core-unavailable-sources.json")
);

const plan = decodeReplayPlan(readFixture("b01/replay-reordered.json"));

const root = mkdtempSync(path.join(os.tmpdir(), "dft-b01-"));

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const storeFile = (name: string): string => path.join(root, name);

const flightSelector: SnapshotSelector = {
  ...emptySelector,
  flightId: FlightIdSchema.make(plan.expectations.selectorFlightId),
};

const batchAt = (index: number): EventBatch => {
  const batch = golden.batches[index];

  if (batch === undefined) {
    throw new Error(`replay plan references missing batch ${index}`);
  }

  return batch;
};

const withStore = <A, E>(
  options: SqliteEventStoreOptions,
  use: (store: EventStoreService) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    openSqliteEventStore(options),
    (opened) => use(opened.service),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  );

const appendAll = (
  store: EventStoreService,
  order: readonly number[]
): Effect.Effect<{ duplicates: number; inserted: number }, StoreFailure> =>
  Effect.map(
    Effect.forEach((index: number) => store.append(batchAt(index)))(order),
    (results) => ({
      duplicates: results.reduce((sum, r) => sum + r.duplicates, 0),
      inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    })
  );

describe("B01 sqlite event store", () => {
  it.effect("dedupes by event id and replays deterministically", () =>
    Effect.gen(function* b01Step1() {
      const canonical = yield* withStore(
        { kind: "replay", path: storeFile("canonical.sqlite") },
        (store) =>
          Effect.gen(function* canonicalSteps() {
            const counts = yield* appendAll(store, plan.canonicalOrder);
            const again = yield* store.append(batchAt(0));
            const snapshot = yield* store.snapshot(flightSelector);

            return { again, counts, snapshot };
          })
      );

      const reordered = yield* withStore(
        { kind: "replay", path: storeFile("reordered.sqlite") },
        (store) =>
          Effect.gen(function* reorderedSteps() {
            const counts = yield* appendAll(store, plan.replayOrder);
            const snapshot = yield* store.snapshot(flightSelector);

            return { counts, snapshot };
          })
      );

      expect(canonical.counts).toEqual({
        duplicates: 0,
        inserted: plan.expectations.events,
      });
      expect(canonical.again).toEqual({ duplicates: 4, inserted: 0 });
      expect(reordered.counts).toEqual({
        duplicates: plan.expectations.replayDuplicates,
        inserted: plan.expectations.events,
      });
      expect(reordered.snapshot.events).toEqual(canonical.snapshot.events);
      expect(reordered.snapshot.manifest.snapshotId).toBe(
        canonical.snapshot.manifest.snapshotId
      );
      expect(reordered.snapshot.manifest.eventWatermark).toBe(
        canonical.snapshot.manifest.eventWatermark
      );
      expect(canonical.snapshot.manifest.originMix).toEqual([
        { count: plan.expectations.events, origin: "fixture" },
      ]);
      expect(canonical.snapshot.coverage.map((c) => c.adapterId)).toEqual(
        golden.batches.map((b) => b.coverage.adapterId).toSorted()
      );
    })
  );

  it.effect(
    "persists snapshot manifests across restart and freezes membership",
    () =>
      Effect.gen(function* b01Step2() {
        const options: SqliteEventStoreOptions = {
          kind: "live",
          path: storeFile("restart.sqlite"),
        };

        const first = yield* withStore(options, (store) =>
          Effect.gen(function* firstSteps() {
            yield* appendAll(store, [0, 1]);
            const snapshot = yield* store.snapshot(flightSelector);
            yield* store.putSnapshotManifest(snapshot.manifest);
            yield* store.putSnapshotManifest(snapshot.manifest);

            return snapshot;
          })
        );

        const reopened = yield* withStore(options, (store) =>
          Effect.gen(function* reopenedSteps() {
            yield* appendAll(store, [2, 3, 4]);
            const stored = yield* store.getSnapshot(first.manifest.snapshotId);
            const current = yield* store.snapshot(flightSelector);
            const latest = yield* store.latestSnapshotId(flightSelector);
            const count = yield* store.snapshotCount;

            const stale = yield* Effect.flip(
              store.putSnapshotManifest({
                ...first.manifest,
                snapshotId: SnapshotIdSchema.make("snap_stale"),
              })
            );

            return { count, current, latest, stale, stored };
          })
        );

        expect(reopened.stored.events).toEqual(first.events);
        expect(reopened.stored.manifest).toEqual(first.manifest);
        expect(reopened.stored.coverage).toEqual(first.coverage);
        expect(reopened.current.events.length).toBe(plan.expectations.events);
        expect(reopened.current.manifest.snapshotId).not.toBe(
          first.manifest.snapshotId
        );
        expect(reopened.latest).toBe(first.manifest.snapshotId);
        expect(reopened.count).toBe(1);
        expect(reopened.stale._tag).toBe("StoreError");
        expect(reopened.stale.message).toMatch(/^watermark_changed/u);
      })
  );

  it.effect(
    "reuses a snapshot stored by an older build with a different descriptor set",
    () =>
      Effect.gen(function* upgradeReuse() {
        const options: SqliteEventStoreOptions = {
          kind: "live",
          path: storeFile("upgrade.sqlite"),
        };

        const result = yield* withStore(options, (store) =>
          Effect.gen(function* upgradeSteps() {
            yield* appendAll(store, [0, 1]);

            const snapshot = yield* store.snapshot(flightSelector);

            const older = {
              ...snapshot.manifest,
              enabledDescriptors: [
                { id: "collector.claude-jsonl", version: "1" },
                { id: "collector.cursor-hooks", version: "1" },
              ],
              metricDefinitions: [{ id: "dx.cost.legacy", version: "1" }],
            };

            yield* store.putSnapshotManifest(older);

            yield* store.putSnapshotManifest({
              ...snapshot.manifest,
              enabledDescriptors: [
                { id: "collector.cursor-hooks", version: "2" },
              ],
              metricDefinitions: [{ id: "dx.cost.usage", version: "2" }],
            });

            const differentEvents = yield* Effect.flip(
              store.putSnapshotManifest({
                ...snapshot.manifest,
                originMix: [],
              })
            );

            const stored = yield* store.getSnapshot(
              snapshot.manifest.snapshotId
            );

            const count = yield* store.snapshotCount;

            return { count, differentEvents, older, stored };
          })
        );

        expect(result.stored.manifest).toEqual(result.older);
        expect(result.count).toBe(1);
        expect(result.differentEvents.message).toMatch(/^snapshot_conflict/u);
      })
  );

  it.effect(
    "reports unknown, expired and incompatible snapshots distinctly",
    () =>
      Effect.gen(function* b01Step3() {
        const file = storeFile("errors.sqlite");
        const options: SqliteEventStoreOptions = { kind: "live", path: file };

        const ids = yield* withStore(options, (store) =>
          Effect.gen(function* idsSteps() {
            yield* appendAll(store, plan.canonicalOrder);
            const full = yield* store.snapshot(emptySelector);
            yield* store.putSnapshotManifest(full.manifest);
            const flight = yield* store.snapshot(flightSelector);
            yield* store.putSnapshotManifest({
              ...flight.manifest,
              snapshotId: SnapshotIdSchema.make("snap_flight"),
            });

            return {
              flight: SnapshotIdSchema.make("snap_flight"),
              full: full.manifest.snapshotId,
            };
          })
        );

        const tamper = new DatabaseSync(file);
        tamper.exec(
          "UPDATE snapshots SET manifest = json_set(manifest, '$.contractDigest', 'sha256:old') WHERE snapshot_id = 'snap_flight'"
        );
        tamper
          .prepare("DELETE FROM events WHERE event_id = ?")
          .run(batchAt(0).events[0]?.eventId ?? "");
        tamper.close();

        const errors = yield* withStore(options, (store) =>
          Effect.all({
            expired: Effect.flip(store.getSnapshot(ids.full)),
            incompatible: Effect.flip(store.getSnapshot(ids.flight)),
            unknown: Effect.flip(
              store.getSnapshot(SnapshotIdSchema.make("snap_missing"))
            ),
          })
        );

        expect(errors.unknown._tag).toBe("SnapshotNotFound");
        expect(errors.unknown.message).toMatch(
          new RegExp(`^${SNAPSHOT_ERROR_CODES.unknown}`, "u")
        );
        expect(errors.expired.message).toMatch(
          new RegExp(`^${SNAPSHOT_ERROR_CODES.expired}`, "u")
        );
        expect(errors.incompatible.message).toMatch(
          new RegExp(`^${SNAPSHOT_ERROR_CODES.incompatible}`, "u")
        );
      })
  );

  it.effect("keeps live and replay stores separate", () =>
    Effect.gen(function* b01Step4() {
      const file = storeFile("kind.sqlite");
      yield* withStore({ kind: "live", path: file }, () => Effect.void);

      const failure = yield* Effect.flip(
        openSqliteEventStore({ kind: "replay", path: file })
      );

      expect(failure._tag).toBe("StoreError");
      expect(failure.message).toMatch(/live and replay stores stay separate/u);
    })
  );

  it.effect("fails with StoreBusy when another writer holds the lock", () =>
    Effect.gen(function* b01Step5() {
      const file = storeFile("busy.sqlite");

      const failure = yield* withStore(
        { busyTimeoutMs: 20, kind: "live", path: file },
        (store) => {
          const other = new DatabaseSync(file);
          other.exec("BEGIN IMMEDIATE");

          return Effect.flip(store.append(batchAt(0))).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                other.exec("ROLLBACK");
                other.close();
              })
            )
          );
        }
      );

      expect(failure._tag).toBe("StoreBusy");
    })
  );

  it.effect("keeps unavailable-source coverage visible", () =>
    withStore({ kind: "live", path: storeFile("coverage.sqlite") }, (store) =>
      Effect.gen(function* b01Step6() {
        yield* Effect.forEach((batch: EventBatch) => store.append(batch))(
          unavailable.batches
        );
        const coverage = yield* store.coverage(emptySelector);

        expect(coverage.map((c) => [c.adapterId, c.state])).toEqual(
          unavailable.batches
            .map((b) => [b.coverage.adapterId, b.coverage.state])
            .toSorted(([a], [b]) => String(a).localeCompare(String(b)))
        );
        expect(coverage.every((c) => c.gaps.length > 0)).toBe(true);
      })
    )
  );

  it.effect("drains spooled batches and rejects malformed files", () =>
    Effect.gen(function* b01Step7() {
      const storePath = storeFile("spool/events.sqlite");
      const spoolDir = spoolDirFor(storePath);
      yield* writeSpoolBatch(spoolDir, batchAt(0));
      yield* writeSpoolBatch(spoolDir, batchAt(0));
      yield* writeSpoolBatch(spoolDir, batchAt(3));
      writeFileSync(path.join(spoolDir, "0000-bad.batch.json"), "{not json");

      const result = yield* withStore(
        { kind: "live", path: storePath },
        (store) =>
          Effect.gen(function* resultSteps() {
            const drained = yield* drainSpool(store, spoolDir);
            const second = yield* drainSpool(store, spoolDir);

            return { drained, second };
          })
      );

      expect(result.drained).toEqual({
        duplicates: batchAt(0).events.length,
        files: 4,
        inserted: batchAt(0).events.length + batchAt(3).events.length,
        rejected: ["0000-bad.batch.json"],
      });
      expect(result.second.files).toBe(0);
    })
  );

  it("resolves live and replay store paths", () => {
    const home = "/home/dx";

    expect(
      resolveStorePath({ env: {}, home, replay: false, store: null })
    ).toEqual({
      kind: "live",
      path: "/home/dx/.dft/dft.db",
      source: "default",
    });
    expect(
      resolveStorePath({
        env: { DX_STORE: "/data/live.sqlite" },
        home,
        replay: true,
        store: null,
      })
    ).toEqual({
      kind: "replay",
      path: "/home/dx/.dft/replay.db",
      source: "default",
    });
    expect(
      resolveStorePath({
        env: { DX_STORE: "/data/live.sqlite" },
        home,
        replay: false,
        store: null,
      }).source
    ).toBe("env");
    expect(
      resolveStorePath({
        env: { DX_STORE: "/data/live.sqlite" },
        home,
        replay: false,
        store: "/flag/x.sqlite",
      })
    ).toEqual({ kind: "live", path: "/flag/x.sqlite", source: "flag" });
    expect(eventStoreDescriptor.readiness).toBe("ready");
  });
});
