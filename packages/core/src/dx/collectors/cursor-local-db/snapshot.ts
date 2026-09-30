// @effect-diagnostics nodeBuiltinImport:off -- The collector reads a Cursor SQLite file through node:sqlite backup into a scratch copy it removes afterwards.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  readonly skippedBubbles?: number;
}

export type ComposerSelector = (
  rows: StateDbRows
) => ReadonlySet<string> | null;

export interface SnapshotOptions {
  readonly selectComposers?: ComposerSelector;
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

const CountRowSchema = Schema.Struct({ count: Schema.Finite });

const countBubbles = (db: DatabaseSync) =>
  selectRows(
    db,
    "select count(*) as count from cursorDiskKV where key like 'bubbleId:%'",
    CountRowSchema
  )[0]?.count ?? 0;

const bubblesOf = (
  db: DatabaseSync,
  composerIds: ReadonlySet<string> | null
): readonly KeyValueRow[] => {
  if (composerIds === null) {
    return selectRows(
      db,
      "select key, cast(value as text) as value from cursorDiskKV where key like 'bubbleId:%'",
      KeyValueRowSchema
    );
  }

  const statement = db.prepare(
    "select key, cast(value as text) as value from cursorDiskKV where key >= ? and key < ?"
  );

  return [...composerIds].flatMap((composerId) =>
    Schema.decodeUnknownSync(Schema.Array(KeyValueRowSchema))(
      statement.all(`bubbleId:${composerId}:`, `bubbleId:${composerId};`)
    )
  );
};

const readStateDb = (
  db: DatabaseSync,
  tables: readonly string[],
  options: SnapshotOptions
): StateDbRows => {
  const composerData = selectRows(
    db,
    "select key, cast(value as text) as value from cursorDiskKV where key like 'composerData:%'",
    KeyValueRowSchema
  );

  const items = selectRows(
    db,
    "select key, cast(value as text) as value from ItemTable where key = 'composer.composerData'",
    KeyValueRowSchema
  );

  const hasHeaders = tables.includes("composerHeaders");

  const base = {
    headers: hasHeaders
      ? selectRows(
          db,
          "select composerId, workspaceId, isSubagent, value from composerHeaders",
          HeaderRowSchema
        )
      : [],
    items,
    kv: composerData,
    layout: hasHeaders
      ? ("state-vscdb/composer-headers" as const)
      : ("state-vscdb/itemtable" as const),
  };

  const selected = options.selectComposers?.(base) ?? null;
  const bubbles = bubblesOf(db, selected);

  return {
    ...base,
    kv: [...composerData, ...bubbles],
    skippedBubbles: selected === null ? 0 : countBubbles(db) - bubbles.length,
  };
};

const readCopy = (copyPath: string, options: SnapshotOptions) => {
  const db = new DatabaseSync(copyPath, { readOnly: true });

  try {
    const tables = readTables(db);

    if (hasAll(tables, AI_TRACKING_TABLES)) {
      return { rows: readAiTracking(db), tables };
    }

    if (hasAll(tables, STATE_TABLES)) {
      return { rows: readStateDb(db, tables, options), tables };
    }

    return { rows: null, tables };
  } finally {
    db.close();
  }
};

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: CURSOR_LOCAL_DB_ADAPTER_ID, message });

const ownedScratch = (scratchDir: string | null) => {
  if (scratchDir !== null && scratchDir.length > 0) {
    return { dir: scratchDir, owned: false };
  }

  return {
    dir: mkdtempSync(path.join(tmpdir(), "dft-cursor-db-")),
    owned: true,
  };
};

export const readConsistentSnapshot = (
  sourcePath: string | null,
  scratchDir: string | null,
  options: SnapshotOptions = {}
) =>
  Effect.gen(function* snapshotSelectedDb() {
    if (sourcePath === null || sourcePath.length === 0) {
      return yield* new InvalidInput({
        field: "selectedInput",
        message: "cursor-local-db requires an explicitly selected SQLite path",
      });
    }

    if (!existsSync(sourcePath)) {
      return yield* unavailable("Selected Cursor local DB does not exist");
    }

    const stamp = yield* Clock.currentTimeMillis;

    const scratch = yield* Effect.try({
      catch: (cause) =>
        unavailable(
          `Cannot create a scratch folder for the copy: ${String(cause)}`
        ),
      try: () => ownedScratch(scratchDir),
    });

    const copyPath = path.join(
      scratch.dir,
      `${path.basename(sourcePath)}.${process.pid}.${stamp}.b06-copy.db`
    );

    const removeCopy = Effect.sync(() => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(`${copyPath}${suffix}`, { force: true });
      }

      if (scratch.owned) {
        rmSync(scratch.dir, { force: true, recursive: true });
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
        try: () => readCopy(copyPath, options),
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
