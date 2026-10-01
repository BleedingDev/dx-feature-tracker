import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
} from "effect";
import type { Schema } from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { HarnessStore, StoredSession } from "../contract.js";
import { memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";
import { LocalSqlite } from "../local-sqlite.js";
import type { MemoryTables, SqlValue } from "../local-sqlite.js";

export interface OpencodeStoreAccess extends HarnessStore {
  readonly query: <A>(
    dbPath: string,
    sql: string,
    row: Schema.Decoder<A>,
    params?: readonly SqlValue[]
  ) => Effect.Effect<readonly A[], SourceUnavailable>;
}

export interface OpencodeMemoryInput extends MemoryStoreInput {
  readonly databases?: Readonly<
    Record<string, { readonly mtimeMs?: number; readonly tables: MemoryTables }>
  >;
}

export const OPENCODE_DB_ENV = "OPENCODE_DB" as const;

const DATABASE_NAME = /^opencode(?:-[\w.-]+)?\.db$/u;

export const isOpencodeDatabase = (name: string): boolean =>
  DATABASE_NAME.test(name);

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: "harness.opencode", message });

const optionalText = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) =>
      Option.getOrNull(
        value.pipe(Option.filter((text: string) => text.trim() !== ""))
      )
    )
  );

export class OpencodeStore extends Context.Service<
  OpencodeStore,
  OpencodeStoreAccess
>()("dx/harness/opencode/OpencodeStore", {
  make: Effect.gen(function* makeOpencodeStore() {
    const home = yield* HarnessHome;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const sqlite = yield* LocalSqlite;
    const dataDir = home.dirs.opencodeData;

    const userHome = yield* optionalText("HOME").pipe(
      Effect.orElseSucceed(() => null)
    );

    const override = yield* optionalText(OPENCODE_DB_ENV).pipe(
      Effect.orElseSucceed(() => null)
    );

    const ownHome =
      userHome !== null && path.resolve(userHome) === path.resolve(home.home);

    const overridePath =
      ownHome && override !== null && override !== ":memory:"
        ? path.resolve(dataDir, override)
        : null;

    const statOf = (file: string) =>
      fileSystem.stat(file).pipe(
        Effect.map((info) => ({
          mtimeMs: Option.match(info.mtime, {
            onNone: () => null,
            onSome: (date) => date.getTime(),
          }),
          size: Number(info.size),
        })),
        Effect.orElseSucceed(() => null)
      );

    const describe = Effect.fnUntraced(function* describe(file: string) {
      const main = yield* statOf(file);

      if (main === null) {
        return [];
      }

      const wal = yield* statOf(`${file}-wal`);

      const mtimeMs =
        wal?.mtimeMs === null || wal?.mtimeMs === undefined
          ? main.mtimeMs
          : Math.max(main.mtimeMs ?? 0, wal.mtimeMs);

      const session: StoredSession = {
        mtimeMs,
        path: file,
        size: main.size + (wal?.size ?? 0),
      };

      return [session];
    });

    const listSessions = Effect.gen(function* listDatabases() {
      const names = (yield* fileSystem.exists(dataDir))
        ? yield* fileSystem.readDirectory(dataDir)
        : [];

      const files = names
        .filter(isOpencodeDatabase)
        .toSorted()
        .map((name) => path.join(dataDir, name));

      const all =
        overridePath === null || files.includes(overridePath)
          ? files
          : [...files, overridePath];

      return (yield* Effect.forEach(describe)(all)).flat();
    }).pipe(
      Effect.mapError((failure) =>
        unavailable(`cannot list ${dataDir}: ${failure.message}`)
      )
    );

    const store: OpencodeStoreAccess = {
      listSessions,
      query: sqlite.query,
      readBytes: (file) =>
        fileSystem
          .readFile(file)
          .pipe(
            Effect.mapError((failure) =>
              unavailable(`cannot read ${file}: ${failure.message}`)
            )
          ),
      readText: (file) =>
        fileSystem
          .readFileString(file)
          .pipe(
            Effect.mapError((failure) =>
              unavailable(`cannot read ${file}: ${failure.message}`)
            )
          ),
      roots: Effect.succeed([dataDir]),
      version: Effect.succeed(null),
    };

    return store;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (
    input: OpencodeMemoryInput
  ): Layer.Layer<OpencodeStore> => {
    const databases = input.databases ?? {};

    const tables = Object.fromEntries(
      Object.entries(databases).map(([file, db]) => [file, db.tables])
    );

    return Layer.effect(
      this,
      Effect.gen(function* memoryOpencodeStore() {
        const sqlite = yield* LocalSqlite;
        const files = memoryFileStore("opencode", input);

        const sessions = Object.entries(databases)
          .map(([file, db]): StoredSession => ({
            mtimeMs: db.mtimeMs ?? null,
            path: file,
            size: JSON.stringify(db.tables).length,
          }))
          .toSorted((a, b) => a.path.localeCompare(b.path));

        const store: OpencodeStoreAccess = {
          ...files,
          listSessions: Effect.succeed(sessions),
          query: sqlite.query,
        };

        return store;
      })
    ).pipe(Layer.provide(LocalSqlite.memory(tables)));
  };
}
