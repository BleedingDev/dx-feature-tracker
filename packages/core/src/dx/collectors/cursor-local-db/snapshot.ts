// @effect-diagnostics nodeBuiltinImport:off -- The collector reads an explicitly selected SQLite file through node:sqlite backup into a scratch copy it removes afterwards.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

import { Clock, Effect, Schema } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import { UnsupportedSource } from "../../contracts/error-unsupported-source.js";
import { CURSOR_LOCAL_DB_ADAPTER_ID } from "./descriptor.js";
import {
  CodeHashRowSchema,
  HeaderRowSchema,
  KeyValueRowSchema,
  ScoredCommitRowSchema,
  TableNameRowSchema,
} from "./schemas.js";
import type {
  CodeHashRow,
  HeaderRow,
  KeyValueRow,
  ScoredCommitRow,
} from "./schemas.js";

export interface StateDbRows {
  readonly layout: "state-vscdb/composer-headers" | "state-vscdb/itemtable";
  readonly headers: readonly HeaderRow[];
  readonly kv: readonly KeyValueRow[];
  readonly items: readonly KeyValueRow[];
}

export interface AiTrackingRows {
  readonly layout: "ai-tracking";
  readonly codeHashes: readonly CodeHashRow[];
  readonly scoredCommits: readonly ScoredCommitRow[];
}

export type LocalDbRows = StateDbRows | AiTrackingRows;

const STATE_TABLES = ["ItemTable", "cursorDiskKV"];

const AI_TRACKING_TABLES = ["ai_code_hashes", "scored_commits"];

const hasAll = (tables: readonly string[], wanted: readonly string[]) =>
  wanted.every((name) => tables.includes(name));

const selectRows = <A>(
  db: DatabaseSync,
  sql: string,
  schema: Schema.Codec<A>
): readonly A[] =>
  Schema.decodeUnknownSync(Schema.Array(schema))(db.prepare(sql).all());

const readTables = (db: DatabaseSync) =>
  selectRows(
    db,
    "select name from sqlite_master where type = 'table'",
    TableNameRowSchema
  ).map((row) => row.name);

const readAiTracking = (db: DatabaseSync): AiTrackingRows => ({
  codeHashes: selectRows(
    db,
    "select hash, source, fileExtension, fileName, requestId, conversationId, timestamp, model, createdAt from ai_code_hashes",
    CodeHashRowSchema
  ),
  layout: "ai-tracking",
  scoredCommits: selectRows(
    db,
    "select commitHash, branchName, scoredAt, linesAdded, linesDeleted, tabLinesAdded, tabLinesDeleted, composerLinesAdded, composerLinesDeleted, humanLinesAdded, humanLinesDeleted, commitDate from scored_commits",
    ScoredCommitRowSchema
  ),
});

const readStateDb = (
  db: DatabaseSync,
  tables: readonly string[]
): StateDbRows => {
  const kv = selectRows(
    db,
    "select key, cast(value as text) as value from cursorDiskKV where key like 'composerData:%' or key like 'bubbleId:%'",
    KeyValueRowSchema
  );

  const items = selectRows(
    db,
    "select key, cast(value as text) as value from ItemTable where key = 'composer.composerData'",
    KeyValueRowSchema
  );

  if (!tables.includes("composerHeaders")) {
    return { headers: [], items, kv, layout: "state-vscdb/itemtable" };
  }

  return {
    headers: selectRows(
      db,
      "select composerId, workspaceId, isSubagent, value from composerHeaders",
      HeaderRowSchema
    ),
    items,
    kv,
    layout: "state-vscdb/composer-headers",
  };
};

const readCopy = (copyPath: string) => {
  const db = new DatabaseSync(copyPath, { readOnly: true });

  try {
    const tables = readTables(db);

    if (hasAll(tables, AI_TRACKING_TABLES)) {
      return { rows: readAiTracking(db), tables };
    }

    if (hasAll(tables, STATE_TABLES)) {
      return { rows: readStateDb(db, tables), tables };
    }

    return { rows: null, tables };
  } finally {
    db.close();
  }
};

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: CURSOR_LOCAL_DB_ADAPTER_ID, message });

export const readConsistentSnapshot = (
  sourcePath: string | null,
  scratchDir: string | null
) =>
  Effect.gen(function* snapshotSelectedDb() {
    if (sourcePath === null || sourcePath.length === 0) {
      return yield* new InvalidInput({
        field: "selectedInput",
        message: "cursor-local-db requires an explicitly selected SQLite path",
      });
    }

    if (scratchDir === null || scratchDir.length === 0) {
      return yield* new InvalidInput({
        field: "scratchDir",
        message:
          "cursor-local-db requires scratchDir for a consistent backup copy",
      });
    }

    if (!existsSync(sourcePath)) {
      return yield* unavailable("Selected Cursor local DB does not exist");
    }

    const stamp = yield* Clock.currentTimeMillis;

    const copyPath = path.join(
      scratchDir,
      `${path.basename(sourcePath)}.${process.pid}.${stamp}.b06-copy.db`
    );

    const removeCopy = Effect.sync(() => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(`${copyPath}${suffix}`, { force: true });
      }
    });

    return yield* Effect.gen(function* copyAndRead() {
      const source = yield* Effect.try({
        catch: (cause) =>
          unavailable(
            `Opening selected Cursor local DB failed: ${String(cause)}`
          ),
        try: () => new DatabaseSync(sourcePath, { readOnly: true }),
      });

      yield* Effect.tryPromise({
        catch: (cause) =>
          unavailable(
            `Backup of selected Cursor local DB failed: ${String(cause)}`
          ),
        // @effect-diagnostics-next-line asyncFunction:off -- node:sqlite backup is promise-only and Effect.tryPromise is its boundary.
        try: async () => await backup(source, copyPath),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            source.close();
          })
        )
      );

      const snapshot = yield* Effect.try({
        catch: (cause) =>
          new UnsupportedSource({
            adapterId: CURSOR_LOCAL_DB_ADAPTER_ID,
            message: `Cursor local DB copy did not match a recognized schema: ${String(cause)}`,
            sourceVersion: null,
          }),
        try: () => readCopy(copyPath),
      });

      if (snapshot.rows === null) {
        return yield* new UnsupportedSource({
          adapterId: CURSOR_LOCAL_DB_ADAPTER_ID,
          message: `Unrecognized Cursor local DB schema (tables: ${snapshot.tables.join(", ") || "none"})`,
          sourceVersion: null,
        });
      }

      return snapshot.rows;
    }).pipe(Effect.ensuring(removeCopy));
  });
