import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { HarnessStore } from "../contract.js";
import { liveFileStore, memoryFileStore } from "../file-store.js";
import type { MemoryStoreInput } from "../file-store.js";
import { HarnessHome } from "../home.js";
import { LocalSqlite } from "../local-sqlite.js";
import { harnessAdapterId } from "../pending.js";
import { gunzipSession } from "./gzip.js";
import { isArchivedSession, isOmpSessionPath } from "./paths.js";
import {
  OMP_STATS_TOTALS_SQL,
  OmpStatsTotalSchema,
  statsTotalsByFile,
} from "./stats.js";
import type { OmpStatsTotal, OmpStatsTotals } from "./stats.js";

export const OMP_HEAD_BYTES = 65_536;

const VERSION_FILE = "last-changelog-version";

const STATS_FILE = "stats.db";

export interface OmpStoreService extends HarnessStore {
  readonly readHead: (
    path: string
  ) => Effect.Effect<Uint8Array, SourceUnavailable>;
  readonly readSession: (
    path: string
  ) => Effect.Effect<Uint8Array, SourceUnavailable>;
  readonly realPath: (path: string) => Effect.Effect<string>;
  readonly statsTotals: Effect.Effect<OmpStatsTotals>;
}

export interface OmpMemoryInput extends MemoryStoreInput {
  readonly realPaths?: Readonly<Record<string, string>>;
  readonly stats?: readonly OmpStatsTotal[];
}

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: harnessAdapterId("omp"), message });

const decompressIfArchived = (file: string, bytes: Uint8Array) =>
  isArchivedSession(file) ? gunzipSession(file, bytes) : Effect.succeed(bytes);

const STATS_TTL = "10 minutes";

export class OmpStore extends Context.Service<OmpStore, OmpStoreService>()(
  "dx/harness/omp/OmpStore",
  {
    make: Effect.gen(function* makeOmpStore() {
      const home = yield* HarnessHome;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const sqlite = yield* LocalSqlite;
      const { omp, ompConfig, ompXdgData } = home.dirs;
      const dataDirs = ompXdgData === null ? [omp] : [omp, ompXdgData];

      const roots = dataDirs.flatMap((dir) => [
        path.join(dir, "sessions"),
        path.join(dir, "archive", "sessions"),
      ]);

      const firstText = (files: readonly string[]) =>
        Effect.gen(function* readFirst() {
          for (const file of files) {
            const text = yield* fileSystem
              .readFileString(file)
              .pipe(Effect.orElseSucceed(() => ""));

            if (text.trim() !== "") {
              return text.trim();
            }
          }

          return null;
        });

      const base = yield* liveFileStore({
        harness: "omp",
        isSession: isOmpSessionPath,
        roots: Effect.succeed(roots),
        version: firstText(dataDirs.map((dir) => path.join(dir, VERSION_FILE))),
      });

      const readSession = (file: string) =>
        base
          .readBytes(file)
          .pipe(Effect.flatMap((bytes) => decompressIfArchived(file, bytes)));

      const readHead = (file: string) =>
        isArchivedSession(file)
          ? readSession(file)
          : Effect.scoped(
              Effect.gen(function* readFileHead() {
                const handle = yield* fileSystem.open(file, { flag: "r" });
                const chunk = yield* handle.readAlloc(OMP_HEAD_BYTES);

                return Option.getOrElse(chunk, () => new Uint8Array());
              })
            ).pipe(
              Effect.mapError((failure) =>
                unavailable(`cannot read ${file}: ${failure.message}`)
              )
            );

      const realPath = (file: string) =>
        fileSystem.realPath(file).pipe(Effect.orElseSucceed(() => file));

      const statsFiles = [
        ...(ompXdgData === null ? [] : [path.join(ompXdgData, STATS_FILE)]),
        path.join(ompConfig, STATS_FILE),
      ];

      const loadStats = Effect.gen(function* loadStats() {
        for (const file of statsFiles) {
          if (yield* sqlite.exists(file)) {
            const rows = yield* sqlite
              .query(file, OMP_STATS_TOTALS_SQL, OmpStatsTotalSchema)
              .pipe(Effect.orElseSucceed(() => []));

            return statsTotalsByFile(rows);
          }
        }

        return statsTotalsByFile([]);
      });

      const statsTotals = yield* Effect.cachedWithTTL(loadStats, STATS_TTL);

      const store: OmpStoreService = {
        ...base,
        readHead,
        readSession,
        realPath,
        statsTotals,
      };

      return store;
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly memory = (input: OmpMemoryInput): Layer.Layer<OmpStore> => {
    const base = memoryFileStore("omp", input);

    const readSession = (file: string) =>
      base
        .readBytes(file)
        .pipe(Effect.flatMap((bytes) => decompressIfArchived(file, bytes)));

    return Layer.succeed(this, {
      ...base,
      readHead: readSession,
      readSession,
      realPath: (file) => Effect.succeed(input.realPaths?.[file] ?? file),
      statsTotals: Effect.succeed(statsTotalsByFile(input.stats ?? [])),
    });
  };
}
