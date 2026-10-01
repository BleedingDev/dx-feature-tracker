import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { SourceUnavailable } from "../contracts/error-source-unavailable.js";

export type SqlValue = SQLInputValue;

export interface LocalSqliteReader {
  readonly exists: (dbPath: string) => Effect.Effect<boolean>;
  readonly query: <A>(
    dbPath: string,
    sql: string,
    row: Schema.Decoder<A>,
    params?: readonly SqlValue[]
  ) => Effect.Effect<readonly A[], SourceUnavailable>;
}

const ADAPTER_ID = "local-sqlite";

const unavailable = (message: string): SourceUnavailable =>
  new SourceUnavailable({ adapterId: ADAPTER_ID, message });

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const runQuery = <A>(
  db: DatabaseSync,
  sql: string,
  row: Schema.Decoder<A>,
  params: readonly SqlValue[]
): Effect.Effect<readonly A[], SourceUnavailable> =>
  Effect.try({
    catch: (cause) => unavailable(`query failed: ${messageOf(cause)}`),
    try: () => db.prepare(sql).all(...params),
  }).pipe(
    Effect.flatMap((rows) =>
      Schema.decodeUnknownEffect(Schema.Array(row))(rows).pipe(
        Effect.mapError((failure) =>
          unavailable(`row did not match: ${failure.message}`)
        )
      )
    )
  );

const SIDECARS = ["", "-wal", "-shm"] as const;

export type MemoryTables = Readonly<
  Record<string, readonly Readonly<Record<string, SqlValue>>[]>
>;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const seed = (db: DatabaseSync, tables: MemoryTables): void => {
  for (const [table, rows] of Object.entries(tables)) {
    const columns = [...new Set(rows.flatMap((item) => Object.keys(item)))];

    if (columns.length === 0) {
      continue;
    }

    db.exec(`CREATE TABLE ${quote(table)} (${columns.map(quote).join(", ")})`);

    const insert = db.prepare(
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
    );

    for (const item of rows) {
      insert.run(...columns.map((column) => item[column] ?? null));
    }
  }
};

const withMemoryDb = <A>(
  tables: MemoryTables,
  use: (db: DatabaseSync) => Effect.Effect<A, SourceUnavailable>
): Effect.Effect<A, SourceUnavailable> =>
  Effect.acquireUseRelease(
    Effect.try({
      catch: (cause) => unavailable(`memory db failed: ${messageOf(cause)}`),
      try: () => {
        const db = new DatabaseSync(":memory:");
        seed(db, tables);

        return db;
      },
    }),
    use,
    (db) =>
      Effect.sync(() => {
        db.close();
      })
  );

export class LocalSqlite extends Context.Service<
  LocalSqlite,
  LocalSqliteReader
>()("dx/harness/LocalSqlite", {
  make: Effect.gen(function* makeLocalSqlite() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const exists = (dbPath: string) =>
      fileSystem.exists(dbPath).pipe(Effect.orElseSucceed(() => false));

    const snapshot = Effect.fnUntraced(function* snapshot(dbPath: string) {
      const dir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "dft-sqlite-",
      });

      const target = path.join(dir, path.basename(dbPath));

      for (const suffix of SIDECARS) {
        const source = `${dbPath}${suffix}`;

        if (yield* exists(source)) {
          yield* fileSystem.copyFile(source, `${target}${suffix}`);
        }
      }

      return target;
    });

    const query = <A>(
      dbPath: string,
      sql: string,
      row: Schema.Decoder<A>,
      params: readonly SqlValue[] = []
    ): Effect.Effect<readonly A[], SourceUnavailable> =>
      Effect.scoped(
        Effect.gen(function* queryCopy() {
          if (!(yield* exists(dbPath))) {
            return yield* unavailable(`no database at ${dbPath}`);
          }

          const copy = yield* snapshot(dbPath).pipe(
            Effect.mapError((failure) =>
              unavailable(`could not copy ${dbPath}: ${failure.message}`)
            )
          );

          return yield* Effect.acquireUseRelease(
            Effect.try({
              catch: (cause) =>
                unavailable(`could not open ${dbPath}: ${messageOf(cause)}`),
              try: () => new DatabaseSync(copy, { readOnly: true }),
            }),
            (db) => runQuery(db, sql, row, params),
            (db) =>
              Effect.sync(() => {
                db.close();
              })
          );
        })
      );

    return { exists, query };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    databases: Readonly<Record<string, MemoryTables>>
  ): Layer.Layer<LocalSqlite> =>
    Layer.succeed(this, {
      exists: (dbPath) => Effect.succeed(databases[dbPath] !== undefined),
      query: (dbPath, sql, row, params = []) => {
        const tables = databases[dbPath];

        return tables === undefined
          ? Effect.fail(unavailable(`no database at ${dbPath}`))
          : withMemoryDb(tables, (db) => runQuery(db, sql, row, params));
      },
    });
}
