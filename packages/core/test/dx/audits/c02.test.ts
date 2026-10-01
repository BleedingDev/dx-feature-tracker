// @effect-diagnostics nodeBuiltinImport:off -- This audit reads committed fixtures, opens throwaway SQLite files in an owned temp dir and SIGKILLs a child writer to simulate a crash.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type {
  EventStoreService,
  StoreFailure,
} from "../../../src/dx/contracts/services.js";
import { IsoTimestampSchema } from "../../../src/dx/model/common.js";
import { EventBatchSchema } from "../../../src/dx/model/event.js";
import type { EventBatch } from "../../../src/dx/model/event.js";
import type { SnapshotSelector } from "../../../src/dx/model/snapshot.js";
import { drainSpool, writeSpoolBatch } from "../../../src/dx/storage/spool.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";
import type { SqliteEventStoreOptions } from "../../../src/dx/storage/sqlite-event-store.js";
import { spoolDirFor } from "../../../src/dx/storage/store-path.js";
import { emptySelector } from "../fakes.js";

const FixtureDocSchema = Schema.Struct({
  batches: Schema.Array(EventBatchSchema),
});

const AuditPlanSchema = Schema.Struct({
  canonicalOrder: Schema.Array(Schema.Int),
  earlyArrivals: Schema.Array(Schema.Int),
  earlyWindowTo: Schema.String,
  expectations: Schema.Struct({
    earlyWindowEventsAfterLate: Schema.Int,
    earlyWindowEventsBeforeLate: Schema.Int,
    events: Schema.Int,
    selectorFlightId: Schema.String,
  }),
  fixtureId: Schema.String,
  lateArrivals: Schema.Array(Schema.Int),
  reverseOrder: Schema.Array(Schema.Int),
});

const fixturesDir = path.join(import.meta.dirname, "..", "fixtures");

const readFixture = (relative: string): string =>
  readFileSync(path.join(fixturesDir, relative), "utf-8");

const golden = Schema.decodeSync(Schema.fromJsonString(FixtureDocSchema))(
  readFixture("core/core-golden-flight.json")
);

const plan = Schema.decodeSync(Schema.fromJsonString(AuditPlanSchema))(
  readFixture("c02/replay-audit-plan.json")
);

const root = mkdtempSync(path.join(os.tmpdir(), "dft-c02-"));

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const storeFile = (name: string): string => path.join(root, name);

const batchAt = (index: number): EventBatch => {
  const batch = golden.batches[index];

  if (batch === undefined) {
    throw new Error(`audit plan references missing batch ${index}`);
  }

  return batch;
};

const earlyWindow: SnapshotSelector = {
  ...emptySelector,
  to: IsoTimestampSchema.make(plan.earlyWindowTo),
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

const countEvents = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare("SELECT COUNT(*) AS n FROM events").get();
  db.close();

  return Number(row?.n ?? -1);
};

const eventTime = (e: {
  readonly occurredAt: string | null;
  readonly observedAt: string;
}): string => e.occurredAt ?? e.observedAt;

describe("C02 replay, ordering, retained failures and crash recovery", () => {
  it.effect("replaying the whole fixture twice changes nothing", () =>
    Effect.gen(function* c02ReplayTwice() {
      const file = storeFile("twice.sqlite");
      const options: SqliteEventStoreOptions = { kind: "replay", path: file };

      const first = yield* withStore(options, (store) =>
        Effect.gen(function* firstPass() {
          const counts = yield* appendAll(store, plan.canonicalOrder);
          const snapshot = yield* store.snapshot(emptySelector);
          yield* store.putSnapshotManifest(snapshot.manifest);

          return { counts, snapshot };
        })
      );

      const second = yield* withStore(options, (store) =>
        Effect.gen(function* secondPass() {
          const counts = yield* appendAll(store, plan.reverseOrder);
          const snapshot = yield* store.snapshot(emptySelector);
          yield* store.putSnapshotManifest(snapshot.manifest);
          const count = yield* store.snapshotCount;

          return { count, counts, snapshot };
        })
      );

      const fresh = yield* withStore(
        { kind: "replay", path: storeFile("twice-fresh.sqlite") },
        (store) =>
          Effect.gen(function* freshPass() {
            yield* appendAll(store, plan.reverseOrder);

            return yield* store.snapshot(emptySelector);
          })
      );

      expect(first.counts).toEqual({
        duplicates: 0,
        inserted: plan.expectations.events,
      });
      expect(second.counts).toEqual({
        duplicates: plan.expectations.events,
        inserted: 0,
      });
      expect(countEvents(file)).toBe(plan.expectations.events);
      expect(second.snapshot.events).toEqual(first.snapshot.events);
      expect(second.snapshot.manifest.snapshotId).toBe(
        first.snapshot.manifest.snapshotId
      );
      expect(second.snapshot.manifest.eventWatermark).toBe(
        first.snapshot.manifest.eventWatermark
      );
      expect(second.count).toBe(1);
      expect(fresh.manifest.snapshotId).toBe(
        first.snapshot.manifest.snapshotId
      );
      expect(fresh.events).toEqual(first.snapshot.events);
      expect(second.snapshot.coverage.map((c) => c.adapterId)).toEqual(
        first.snapshot.coverage.map((c) => c.adapterId)
      );
    })
  );

  it.effect(
    "late out-of-order events do not alter a frozen snapshot, only new ones",
    () =>
      withStore({ kind: "live", path: storeFile("late.sqlite") }, (store) =>
        Effect.gen(function* c02OutOfOrder() {
          yield* appendAll(store, plan.earlyArrivals);
          const early = yield* store.snapshot(earlyWindow);
          yield* store.putSnapshotManifest(early.manifest);

          yield* appendAll(store, plan.lateArrivals);
          const full = yield* store.snapshot(emptySelector);
          yield* store.putSnapshotManifest(full.manifest);
          yield* store.putSnapshotManifest(early.manifest);

          const frozenEarly = yield* store.getSnapshot(
            early.manifest.snapshotId
          );

          const lateWindow = yield* store.snapshot(earlyWindow);

          const staleRewrite = yield* Effect.flip(
            store.putSnapshotManifest({
              ...early.manifest,
              snapshotId: lateWindow.manifest.snapshotId,
            })
          );

          yield* store.putSnapshotManifest(lateWindow.manifest);
          const latestWindow = yield* store.latestSnapshotId(earlyWindow);
          const latestFull = yield* store.latestSnapshotId(emptySelector);
          const count = yield* store.snapshotCount;

          expect(early.events.length).toBe(
            plan.expectations.earlyWindowEventsBeforeLate
          );
          expect(frozenEarly.events).toEqual(early.events);
          expect(frozenEarly.manifest).toEqual(early.manifest);
          expect(lateWindow.events.length).toBe(
            plan.expectations.earlyWindowEventsAfterLate
          );
          expect(lateWindow.manifest.snapshotId).not.toBe(
            early.manifest.snapshotId
          );
          expect(staleRewrite._tag).toBe("StoreError");
          expect(latestWindow).toBe(lateWindow.manifest.snapshotId);
          expect(latestFull).toBe(full.manifest.snapshotId);
          expect(count).toBe(3);
          expect(full.events.length).toBe(plan.expectations.events);

          const times = full.events.map(eventTime);
          expect(times).toEqual(times.toSorted());

          const lateIds = new Set(
            plan.lateArrivals.flatMap((i) =>
              batchAt(i).events.map((e) => e.eventId)
            )
          );

          const firstLate = full.events.findIndex((e) =>
            lateIds.has(e.eventId)
          );

          expect(firstLate).toBeGreaterThan(0);
          expect(firstLate).toBeLessThan(full.events.length - lateIds.size);
        })
      )
  );

  it.effect("failed attempts are retained or leave no partial state", () =>
    Effect.gen(function* c02FailedAttempts() {
      const storePath = storeFile("failed/events.sqlite");
      const spoolDir = spoolDirFor(storePath);
      yield* writeSpoolBatch(spoolDir, batchAt(0));
      const badName = "0000-truncated.batch.json";
      const badBody = JSON.stringify(batchAt(1)).slice(0, 40);
      writeFileSync(path.join(spoolDir, badName), badBody);

      const result = yield* withStore(
        { busyTimeoutMs: 20, kind: "live", path: storePath },
        (store) =>
          Effect.gen(function* failedSteps() {
            const drained = yield* drainSpool(store, spoolDir);
            const again = yield* drainSpool(store, spoolDir);

            const other = new DatabaseSync(storePath);
            other.exec("BEGIN IMMEDIATE");

            const busy = yield* Effect.flip(store.append(batchAt(3))).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  other.exec("ROLLBACK");
                  other.close();
                })
              )
            );

            const afterBusy = countEvents(storePath);
            const retry = yield* store.append(batchAt(3));

            const before = yield* store.snapshot(emptySelector);
            yield* store.append(batchAt(4));

            const stale = yield* Effect.flip(
              store.putSnapshotManifest(before.manifest)
            );

            const snapshots = yield* store.snapshotCount;

            return {
              afterBusy,
              again,
              busy,
              drained,
              retry,
              snapshots,
              stale,
            };
          })
      );

      const rejectedDir = path.join(spoolDir, "rejected");
      expect(result.drained.rejected).toEqual([badName]);
      expect(result.again.files).toBe(0);
      expect(readdirSync(rejectedDir)).toEqual([badName]);
      expect(readFileSync(path.join(rejectedDir, badName), "utf-8")).toBe(
        badBody
      );
      expect(readdirSync(path.join(spoolDir, "done")).length).toBe(1);
      expect(result.busy._tag).toBe("StoreBusy");
      expect(result.afterBusy).toBe(batchAt(0).events.length);
      expect(result.retry.inserted).toBe(batchAt(3).events.length);
      expect(result.stale._tag).toBe("StoreError");
      expect(result.stale.message).toMatch(/^watermark_changed/u);
      expect(result.snapshots).toBe(0);
    })
  );

  it.effect("recovers after a writer is killed mid-transaction", () =>
    Effect.gen(function* c02Crash() {
      const file = storeFile("crash.sqlite");

      const options: SqliteEventStoreOptions = {
        busyTimeoutMs: 2000,
        kind: "live",
        path: file,
      };

      const before = yield* withStore(options, (store) =>
        Effect.gen(function* seed() {
          yield* appendAll(store, [0, 1]);

          return yield* store.snapshot(emptySelector);
        })
      );

      const script = [
        "const { DatabaseSync } = require('node:sqlite');",
        "const db = new DatabaseSync(process.argv[1]);",
        "db.exec('PRAGMA journal_mode=WAL');",
        "db.exec('BEGIN IMMEDIATE');",
        "const ins = db.prepare(\"INSERT INTO events (event_id, adapter_id, kind, origin, observed_at, body) VALUES (?, 'crash', 'crash', 'fixture', '2026-09-30T12:00:00.000Z', '{}')\");",
        "for (let i = 0; i < 50; i++) ins.run('crash-' + i);",
        "process.kill(process.pid, 'SIGKILL');",
      ].join("\n");

      const child = spawnSync(process.execPath, ["-e", script, file], {
        encoding: "utf-8",
        timeout: 20_000,
      });

      const spoolDir = spoolDirFor(file);
      mkdirSync(spoolDir, { recursive: true });
      const orphanTmp = path.join(spoolDir, ".orphan.batch.json.tmp");
      writeFileSync(orphanTmp, JSON.stringify(batchAt(2)).slice(0, 25));
      const pending = yield* writeSpoolBatch(spoolDir, batchAt(1));

      const after = yield* withStore(options, (store) =>
        Effect.gen(function* recover() {
          const snapshot = yield* store.snapshot(emptySelector);
          const drained = yield* drainSpool(store, spoolDir);
          const resumed = yield* appendAll(store, plan.canonicalOrder);
          const final = yield* store.snapshot(emptySelector);

          return { drained, final, resumed, snapshot };
        })
      );

      expect(child.signal).toBe("SIGKILL");
      expect(after.snapshot.events).toEqual(before.events);
      expect(after.snapshot.manifest.eventWatermark).toBe(
        before.manifest.eventWatermark
      );
      expect(after.drained).toEqual({
        duplicates: batchAt(1).events.length,
        files: 1,
        inserted: 0,
        rejected: [],
      });
      expect(existsSync(pending)).toBe(false);
      expect(existsSync(orphanTmp)).toBe(true);
      expect(after.resumed.inserted).toBe(
        plan.expectations.events - before.events.length
      );
      expect(after.final.events.length).toBe(plan.expectations.events);
      expect(countEvents(file)).toBe(plan.expectations.events);
    })
  );
});
