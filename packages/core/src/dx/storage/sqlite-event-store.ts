// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event ids and watermarks are sha256 digests from node:crypto.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The store creates its parent directory before opening SQLite.
import { mkdirSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Store directory derives from the resolved store path.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DateTime, Effect, Layer, Schema } from "effect";

import { SnapshotNotFound } from "../contracts/error-snapshot-not-found.js";
import { StoreBusy } from "../contracts/error-store-busy.js";
import { StoreError } from "../contracts/error-store-error.js";
import { EventStore } from "../contracts/event-store.js";
import type {
  EventStoreService,
  StoreFailure,
  StoreSnapshot,
} from "../contracts/services.js";
import { CONTRACT_DIGEST, CONTRACT_VERSION } from "../contracts/version.js";
import type { Origin } from "../model/common.js";
import { SourceCoverageSchema } from "../model/coverage.js";
import type { SourceCoverage } from "../model/coverage.js";
import { DxEventEnvelopeSchema } from "../model/event.js";
import type { DxEventEnvelope, EventBatch } from "../model/event.js";
import { SnapshotIdSchema } from "../model/ids.js";
import type { SnapshotId } from "../model/ids.js";
import { SnapshotManifestSchema } from "../model/snapshot.js";
import type { SnapshotManifest, SnapshotSelector } from "../model/snapshot.js";
import { STORE_MIGRATIONS, STORE_SCHEMA_VERSION } from "./migrations.js";
import type { StoreKind } from "./store-path.js";

export interface SqliteEventStoreOptions {
  readonly busyTimeoutMs?: number;
  readonly kind: StoreKind;
  readonly path: string;
}

export const SNAPSHOT_ERROR_CODES = {
  expired: "expired_snapshot",
  incompatible: "incompatible_snapshot",
  unknown: "unknown_snapshot",
} as const;

const SQLITE_BUSY = 5;

const SQLITE_LOCKED = 6;

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(DxEventEnvelopeSchema)
);

const decodeCoverage = Schema.decodeUnknownSync(
  Schema.fromJsonString(SourceCoverageSchema)
);

const decodeCoverageList = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(SourceCoverageSchema))
);

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(SnapshotManifestSchema)
);

const decodeVersionRow = Schema.decodeUnknownSync(
  Schema.Struct({ user_version: Schema.Int })
);

const decodeValueRow = Schema.decodeUnknownSync(
  Schema.Struct({ value: Schema.String })
);

const decodeBodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const decodeManifestRow = Schema.decodeUnknownSync(
  Schema.Struct({ manifest: Schema.String })
);

const decodeSnapshotRow = Schema.decodeUnknownSync(
  Schema.Struct({
    coverage: Schema.String,
    event_count: Schema.Int,
    manifest: Schema.String,
  })
);

const decodeSnapshotIdRow = Schema.decodeUnknownSync(
  Schema.Struct({ snapshot_id: Schema.String })
);

const decodeCountRow = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Int })
);

const decodeCoverageRow = Schema.decodeUnknownSync(
  Schema.Struct({
    adapter_id: Schema.String,
    body: Schema.String,
    branches: Schema.String,
    flight_ids: Schema.String,
    repos: Schema.String,
  })
);

const decodeStringList = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String))
);

const isSqliteError = Schema.is(Schema.Struct({ errcode: Schema.Int }));

export interface OpenedEventStore {
  readonly close: () => void;
  readonly service: EventStoreService;
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const errcodeOf = (cause: unknown): number | null =>
  isSqliteError(cause) ? cause.errcode : null;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toFailure = (operation: string, cause: unknown): StoreFailure => {
  if (Schema.is(StoreError)(cause) || Schema.is(StoreBusy)(cause)) {
    return cause;
  }

  const code = errcodeOf(cause);

  return code === SQLITE_BUSY || code === SQLITE_LOCKED
    ? new StoreBusy({
        message: `store is locked by another writer during ${operation}: ${messageOf(cause)}`,
      })
    : new StoreError({ message: messageOf(cause), operation });
};

export const selectorKey = (selector: SnapshotSelector): string =>
  JSON.stringify([
    selector.flightId,
    selector.repoCommonDir,
    selector.branch,
    selector.from,
    selector.to,
  ]);

export const eventWatermark = (eventIds: readonly string[]): string =>
  `events:${eventIds.length}:${sha256([...eventIds].toSorted().join("\n")).slice(0, 32)}`;

export const snapshotIdFor = (
  selector: SnapshotSelector,
  watermark: string
): SnapshotId =>
  SnapshotIdSchema.make(
    `snap_${sha256(`${CONTRACT_DIGEST}\n${selectorKey(selector)}\n${watermark}`).slice(0, 32)}`
  );

const uniqueNonNull = (values: readonly (string | null)[]): string[] =>
  [
    ...new Set(values.filter((value): value is string => value !== null)),
  ].toSorted();

const containsOrUnscoped = (
  list: readonly string[],
  wanted: string | null
): boolean => wanted === null || list.length === 0 || list.includes(wanted);

const originMixOf = (
  events: readonly DxEventEnvelope[]
): SnapshotManifest["originMix"] => {
  const counts = new Map<Origin, number>();

  for (const event of events) {
    counts.set(event.origin, (counts.get(event.origin) ?? 0) + 1);
  }

  return [...counts.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([origin, count]) => ({ count, origin }));
};

const comparableManifest = (manifest: SnapshotManifest): string =>
  JSON.stringify({
    ...manifest,
    createdAt: "",
    enabledDescriptors: [],
    metricDefinitions: [],
  });

const openDatabase = (options: SqliteEventStoreOptions): DatabaseSync => {
  mkdirSync(path.dirname(options.path), { recursive: true });

  const db = new DatabaseSync(options.path, {
    timeout: options.busyTimeoutMs ?? 5000,
  });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  return db;
};

const decodeSeqBodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String, seq: Schema.Int })
);

const rewriteEventBodies = (
  db: DatabaseSync,
  rewrite: (body: string) => string | null
): void => {
  const update = db.prepare("UPDATE events SET body = ? WHERE seq = ?");

  for (const raw of db.prepare("SELECT seq, body FROM events").all()) {
    const row = decodeSeqBodyRow(raw);
    const next = rewrite(row.body);

    if (next !== null) {
      update.run(next, row.seq);
    }
  }
};

const migrate = (db: DatabaseSync, kind: StoreKind): void => {
  const current = decodeVersionRow(
    db.prepare("PRAGMA user_version").get()
  ).user_version;

  if (current > STORE_SCHEMA_VERSION) {
    throw new StoreError({
      message: `store schema version ${current} is newer than supported ${STORE_SCHEMA_VERSION}`,
      operation: "migrate",
    });
  }

  for (const migration of STORE_MIGRATIONS) {
    if (migration.version > current) {
      db.exec("BEGIN IMMEDIATE");

      try {
        for (const statement of migration.statements) {
          db.exec(statement);
        }

        if (migration.rewriteEventBody !== null) {
          rewriteEventBodies(db, migration.rewriteEventBody);
        }

        db.exec(`PRAGMA user_version = ${migration.version}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  db.prepare(
    "INSERT OR IGNORE INTO store_meta (key, value) VALUES ('store_kind', ?)"
  ).run(kind);

  const storedKind = decodeValueRow(
    db.prepare("SELECT value FROM store_meta WHERE key = 'store_kind'").get()
  ).value;

  if (storedKind !== kind) {
    throw new StoreError({
      message: `store file is a ${storedKind} store and cannot be opened as ${kind}; live and replay stores stay separate`,
      operation: "open",
    });
  }
};

interface Selection {
  readonly events: readonly DxEventEnvelope[];
  readonly watermark: string;
}

export const makeSqliteEventStore = (
  options: SqliteEventStoreOptions
): OpenedEventStore => {
  const db = openDatabase(options);

  try {
    migrate(db, options.kind);
  } catch (error) {
    db.close();
    throw error;
  }

  const write = <A>(
    operation: string,
    body: () => A
  ): Effect.Effect<A, StoreFailure> =>
    Effect.try({
      catch: (cause) => toFailure(operation, cause),
      try: () => {
        db.exec("BEGIN IMMEDIATE");

        try {
          const result = body();
          db.exec("COMMIT");

          return result;
        } catch (error) {
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }

          throw error;
        }
      },
    });

  const read = <A>(
    operation: string,
    body: () => A
  ): Effect.Effect<A, StoreFailure> =>
    Effect.try({
      catch: (cause) => toFailure(operation, cause),
      try: body,
    });

  const selectEvents = (selector: SnapshotSelector): Selection => {
    const clauses: string[] = [];
    const params: string[] = [];

    if (selector.flightId !== null) {
      clauses.push("flight_id = ?");
      params.push(selector.flightId);
    }

    if (selector.repoCommonDir !== null) {
      clauses.push("repo_common_dir = ?");
      params.push(selector.repoCommonDir);
    }

    if (selector.branch !== null) {
      clauses.push("branch = ?");
      params.push(selector.branch);
    }

    if (selector.from !== null) {
      clauses.push("COALESCE(occurred_at, observed_at) >= ?");
      params.push(selector.from);
    }

    if (selector.to !== null) {
      clauses.push("COALESCE(occurred_at, observed_at) <= ?");
      params.push(selector.to);
    }

    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;

    const rows = db
      .prepare(
        `SELECT body FROM events ${where} ORDER BY COALESCE(occurred_at, observed_at), event_id`
      )
      .all(...params);

    const events = rows.map((row) => decodeEvent(decodeBodyRow(row).body));

    return {
      events,
      watermark: eventWatermark(events.map((event) => event.eventId)),
    };
  };

  const selectCoverage = (
    selector: SnapshotSelector
  ): readonly SourceCoverage[] => {
    const latest = new Map<string, SourceCoverage>();

    const rows = db
      .prepare(
        "SELECT adapter_id, flight_ids, repos, branches, body FROM coverage ORDER BY seq"
      )
      .all();

    for (const raw of rows) {
      const row = decodeCoverageRow(raw);
      const adapterId = row.adapter_id;
      const flights = decodeStringList(row.flight_ids);
      const repos = decodeStringList(row.repos);
      const branches = decodeStringList(row.branches);

      const unscoped =
        flights.length === 0 && repos.length === 0 && branches.length === 0;

      const matches =
        unscoped ||
        (containsOrUnscoped(flights, selector.flightId) &&
          containsOrUnscoped(repos, selector.repoCommonDir) &&
          containsOrUnscoped(branches, selector.branch));

      if (matches) {
        latest.set(adapterId, decodeCoverage(row.body));
      }
    }

    return [...latest.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([, coverage]) => coverage);
  };

  const currentSnapshot = (
    selector: SnapshotSelector,
    createdAt: string
  ): StoreSnapshot => {
    const selection = selectEvents(selector);

    return {
      coverage: selectCoverage(selector),
      events: selection.events,
      manifest: {
        contractDigest: CONTRACT_DIGEST,
        contractVersion: CONTRACT_VERSION,
        createdAt,
        enabledDescriptors: [],
        eventWatermark: selection.watermark,
        metricDefinitions: [],
        originMix: originMixOf(selection.events),
        selector,
        snapshotId: snapshotIdFor(selector, selection.watermark),
      },
    };
  };

  const insertEvent = db.prepare(
    "INSERT OR IGNORE INTO events (event_id, adapter_id, kind, origin, flight_id, repo_common_dir, branch, occurred_at, observed_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  const insertCoverage = db.prepare(
    "INSERT INTO coverage (adapter_id, flight_ids, repos, branches, body) VALUES (?, ?, ?, ?, ?)"
  );

  const service: EventStoreService = {
    append: (batch: EventBatch) =>
      write("append", () => {
        let inserted = 0;

        if (batch.replace !== undefined) {
          const { adapterId, fromOccurredAt } = batch.replace;

          const stale =
            "SELECT event_id FROM events WHERE adapter_id = ? AND occurred_at >= ?";

          db.prepare(
            `DELETE FROM snapshots WHERE snapshot_id IN (SELECT snapshot_id FROM snapshot_events WHERE event_id IN (${stale}))`
          ).run(adapterId, fromOccurredAt);

          db.prepare(
            `DELETE FROM snapshot_events WHERE snapshot_id NOT IN (SELECT snapshot_id FROM snapshots)`
          ).run();

          db.prepare(
            "DELETE FROM events WHERE adapter_id = ? AND occurred_at >= ?"
          ).run(adapterId, fromOccurredAt);
        }

        for (const event of batch.events) {
          const result = insertEvent.run(
            event.eventId,
            event.adapterId,
            event.kind,
            event.origin,
            event.context.flightId,
            event.context.repoCommonDir,
            event.context.branch,
            event.occurredAt,
            event.observedAt,
            JSON.stringify(event)
          );

          inserted += Number(result.changes);
        }

        insertCoverage.run(
          batch.coverage.adapterId,
          JSON.stringify(
            uniqueNonNull(batch.events.map((e) => e.context.flightId))
          ),
          JSON.stringify(
            uniqueNonNull(batch.events.map((e) => e.context.repoCommonDir))
          ),
          JSON.stringify(
            uniqueNonNull(batch.events.map((e) => e.context.branch))
          ),
          JSON.stringify(batch.coverage)
        );

        return { duplicates: batch.events.length - inserted, inserted };
      }),
    coverage: (selector) => read("coverage", () => selectCoverage(selector)),
    getSnapshot: (snapshotId) =>
      Effect.flatMap(
        read("getSnapshot", () => {
          const row = db
            .prepare(
              "SELECT manifest, coverage, event_count FROM snapshots WHERE snapshot_id = ?"
            )
            .get(snapshotId);

          if (row === undefined) {
            return {
              code: SNAPSHOT_ERROR_CODES.unknown,
              detail: "no snapshot manifest with this id in the store",
            } as const;
          }

          const record = decodeSnapshotRow(row);
          const manifest = decodeManifest(record.manifest);

          if (manifest.contractDigest !== CONTRACT_DIGEST) {
            return {
              code: SNAPSHOT_ERROR_CODES.incompatible,
              detail: `snapshot contract ${manifest.contractDigest} differs from current ${CONTRACT_DIGEST}; it is not recomputed with current metrics`,
            } as const;
          }

          const events = db
            .prepare(
              "SELECT e.body AS body FROM snapshot_events s JOIN events e ON e.event_id = s.event_id WHERE s.snapshot_id = ? ORDER BY s.ordinal"
            )
            .all(snapshotId)
            .map((eventRow) => decodeEvent(decodeBodyRow(eventRow).body));

          if (events.length !== record.event_count) {
            return {
              code: SNAPSHOT_ERROR_CODES.expired,
              detail: `${record.event_count - events.length} member events were removed from the store`,
            } as const;
          }

          const snapshot: StoreSnapshot = {
            coverage: decodeCoverageList(record.coverage),
            events,
            manifest,
          };

          return { snapshot };
        }),
        (outcome) =>
          "snapshot" in outcome
            ? Effect.succeed(outcome.snapshot)
            : Effect.fail(
                new SnapshotNotFound({
                  message: `${outcome.code}: ${outcome.detail}`,
                  snapshotId,
                })
              )
      ),
    latestSnapshotId: (selector) =>
      read("latestSnapshotId", () => {
        const row = db
          .prepare(
            "SELECT snapshot_id FROM snapshots WHERE selector_key = ? ORDER BY seq DESC LIMIT 1"
          )
          .get(selectorKey(selector));

        return row === undefined
          ? null
          : SnapshotIdSchema.make(decodeSnapshotIdRow(row).snapshot_id);
      }),
    putSnapshotManifest: (manifest) =>
      write("putSnapshotManifest", () => {
        const existing = db
          .prepare("SELECT manifest FROM snapshots WHERE snapshot_id = ?")
          .get(manifest.snapshotId);

        if (existing !== undefined) {
          const stored = decodeManifest(decodeManifestRow(existing).manifest);

          if (comparableManifest(stored) !== comparableManifest(manifest)) {
            throw new StoreError({
              message: `snapshot_conflict: ${manifest.snapshotId} already stored with a different manifest; stored snapshots are immutable`,
              operation: "putSnapshotManifest",
            });
          }

          return;
        }

        if (manifest.contractDigest !== CONTRACT_DIGEST) {
          throw new StoreError({
            message: `incompatible_snapshot: manifest contract ${manifest.contractDigest} differs from current ${CONTRACT_DIGEST}`,
            operation: "putSnapshotManifest",
          });
        }

        const current = currentSnapshot(manifest.selector, manifest.createdAt);

        if (current.manifest.eventWatermark !== manifest.eventWatermark) {
          throw new StoreError({
            message: `watermark_changed: store now has ${current.manifest.eventWatermark} for this selector, manifest has ${manifest.eventWatermark}; take a new snapshot`,
            operation: "putSnapshotManifest",
          });
        }

        db.prepare(
          "INSERT INTO snapshots (snapshot_id, selector_key, contract_digest, event_count, manifest, coverage) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(
          manifest.snapshotId,
          selectorKey(manifest.selector),
          manifest.contractDigest,
          current.events.length,
          JSON.stringify(manifest),
          JSON.stringify(current.coverage)
        );

        const member = db.prepare(
          "INSERT INTO snapshot_events (snapshot_id, ordinal, event_id) VALUES (?, ?, ?)"
        );

        for (const [ordinal, event] of current.events.entries()) {
          member.run(manifest.snapshotId, ordinal, event.eventId);
        }
      }),
    snapshot: (selector) =>
      DateTime.now.pipe(
        Effect.flatMap((createdAt) =>
          read("snapshot", () =>
            currentSnapshot(selector, DateTime.formatIso(createdAt))
          )
        )
      ),
    snapshotCount: read(
      "snapshotCount",
      () =>
        decodeCountRow(db.prepare("SELECT COUNT(*) AS n FROM snapshots").get())
          .n
    ),
    storePath: options.path,
  };

  return {
    close: () => {
      db.close();
    },
    service,
  };
};

export const openSqliteEventStore = (
  options: SqliteEventStoreOptions
): Effect.Effect<OpenedEventStore, StoreFailure> =>
  Effect.try({
    catch: (cause) => toFailure("open", cause),
    try: () => makeSqliteEventStore(options),
  });

export const SqliteEventStoreLayer = (
  options: SqliteEventStoreOptions
): Layer.Layer<EventStore, StoreFailure> =>
  Layer.effect(
    EventStore,
    Effect.map(
      Effect.acquireRelease(openSqliteEventStore(options), (store) =>
        Effect.sync(() => {
          store.close();
        })
      ),
      (store) => store.service
    )
  );
