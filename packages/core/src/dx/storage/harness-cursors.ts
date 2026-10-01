import { DatabaseSync } from "node:sqlite";

import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import type { Scope } from "effect";

import { StoreError } from "../contracts/error-store-error.js";
import { EventStore } from "../contracts/event-store.js";
import type { StoreFailure } from "../contracts/services.js";
import type { SessionRef } from "../harness/contract.js";
import { CollectCursorSchema } from "../model/coverage.js";
import type { CollectCursor } from "../model/coverage.js";

export interface StoredCursor {
  readonly cursor: CollectCursor | null;
  readonly lastEventId: string | null;
  readonly mtimeMs: number | null;
  readonly size: number | null;
}

export interface HarnessCursorsApi {
  readonly get: (
    ref: SessionRef
  ) => Effect.Effect<StoredCursor | null, StoreFailure>;
  readonly put: (
    ref: SessionRef,
    entry: StoredCursor
  ) => Effect.Effect<void, StoreFailure>;
}

export const cursorKey = (ref: SessionRef): string =>
  `${ref.harness}|${ref.channel}|${ref.id}`;

export const unchangedRef = (
  stored: StoredCursor | null,
  ref: SessionRef
): boolean =>
  stored !== null &&
  stored.mtimeMs !== null &&
  stored.size !== null &&
  stored.mtimeMs === ref.mtimeMs &&
  stored.size === ref.size;

const decodeRow = Schema.decodeUnknownSync(
  Schema.Struct({
    cursor: Schema.NullOr(Schema.String),
    kept: Schema.Int,
    last_event_id: Schema.NullOr(Schema.String),
    mtime_ms: Schema.NullOr(Schema.Finite),
    size: Schema.NullOr(Schema.Int),
  })
);

const decodeCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(CollectCursorSchema)
);

const encodeCursor = Schema.encodeSync(
  Schema.fromJsonString(CollectCursorSchema)
);

const attempt = <A>(
  operation: string,
  body: () => A
): Effect.Effect<A, StoreFailure> =>
  Effect.try({
    catch: (cause) =>
      new StoreError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation,
      }),
    try: body,
  });

const sqliteCursors = (db: DatabaseSync): HarnessCursorsApi => {
  const select = db.prepare(
    "SELECT cursor, last_event_id, mtime_ms, size, (last_event_id IS NULL OR EXISTS (SELECT 1 FROM events WHERE event_id = last_event_id)) AS kept FROM harness_cursors WHERE ref_key = ?"
  );

  const upsert = db.prepare(
    "INSERT OR REPLACE INTO harness_cursors (ref_key, harness, path, mtime_ms, size, cursor, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  return {
    get: (ref) =>
      attempt("cursor.get", () => {
        const raw = select.get(cursorKey(ref));

        if (raw === undefined) {
          return null;
        }

        const row = decodeRow(raw);

        return row.kept === 1
          ? {
              cursor:
                row.cursor === null
                  ? null
                  : Option.getOrNull(decodeCursor(row.cursor)),
              lastEventId: row.last_event_id,
              mtimeMs: row.mtime_ms,
              size: row.size,
            }
          : null;
      }),
    put: (ref, entry) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          attempt("cursor.put", () => {
            upsert.run(
              cursorKey(ref),
              ref.harness,
              ref.path,
              entry.mtimeMs,
              entry.size,
              entry.cursor === null ? null : encodeCursor(entry.cursor),
              entry.lastEventId,
              DateTime.formatIso(now)
            );
          })
        )
      ),
  };
};

const memoryCursors = (
  state: Ref.Ref<ReadonlyMap<string, StoredCursor>>
): HarnessCursorsApi => ({
  get: (ref) =>
    Ref.get(state).pipe(Effect.map((map) => map.get(cursorKey(ref)) ?? null)),
  put: (ref, entry) =>
    Ref.update(state, (map) => new Map(map).set(cursorKey(ref), entry)),
});

export const openHarnessCursors = (
  path: string
): Effect.Effect<HarnessCursorsApi, StoreFailure, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      attempt("cursor.open", () => new DatabaseSync(path, { timeout: 5000 })),
      (opened) =>
        Effect.sync(() => {
          opened.close();
        })
    ),
    sqliteCursors
  );

export class HarnessCursors extends Context.Service<
  HarnessCursors,
  HarnessCursorsApi
>()("@rat-stack/core/dx/HarnessCursors") {
  static readonly sqlite = (
    path: string
  ): Layer.Layer<HarnessCursors, StoreFailure, EventStore> =>
    Layer.effect(
      this,
      Effect.gen(function* openCursors() {
        yield* EventStore;

        return yield* openHarnessCursors(path);
      })
    );

  static readonly memory: Layer.Layer<HarnessCursors> = Layer.effect(
    this,
    Effect.map(
      Ref.make<ReadonlyMap<string, StoredCursor>>(new Map()),
      memoryCursors
    )
  );
}
