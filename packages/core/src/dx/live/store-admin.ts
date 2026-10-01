// @effect-diagnostics nodeBuiltinImport:off -- Delete, reset and restore work on the SQLite store, the hook spool and snapshots.jsonl under DFT_HOME with synchronous file moves at the process boundary.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { DateTime, Effect, Option, Schema } from "effect";

import { SpoolRecordSchema } from "../collectors/cursor-hooks/spool-record.js";
import {
  HOOK_SPOOL_FOLDER,
  latestSpoolRecord,
} from "../collectors/cursor-hooks/spool.js";
import { repoWorktrees, worktreeSpoolId } from "../registry/runtime.js";
import { STORE_SCHEMA_VERSION } from "../storage/migrations.js";
import { openSqliteEventStore } from "../storage/sqlite-event-store.js";
import {
  addRepo,
  readLiveConfig,
  removeRepo,
  resolveGitRepo,
} from "./config.js";
import type { GitRepo } from "./config.js";
import {
  backupsDir,
  commitSnapshotsPath,
  confined,
  LiveActionError,
  spoolRoot,
  usageStateDir,
} from "./home.js";
import type { LiveHome } from "./home.js";

export interface BranchRemoval {
  readonly branch: string | null;
  readonly commitSnapshots: number;
  readonly events: number;
  readonly spoolFiles: number;
  readonly storeSnapshots: number;
}

export interface RemovalTotals {
  readonly commitSnapshots: number;
  readonly coverage: number;
  readonly events: number;
  readonly spoolFiles: number;
  readonly storeSnapshots: number;
}

export interface RepoDataPlan {
  readonly branches: readonly BranchRemoval[];
  readonly confirmText: string;
  readonly repo: GitRepo;
  readonly spoolDirs: readonly string[];
  readonly totals: RemovalTotals;
  readonly tracked: boolean;
}

export interface RepoEventCount {
  readonly events: number;
  readonly repoCommonDir: string | null;
}

export const RESET_CONFIRM_TEXT = "reset" as const;

export interface ResetPlan {
  readonly confirmText: typeof RESET_CONFIRM_TEXT;
  readonly repos: readonly RepoEventCount[];
  readonly spoolDirs: readonly string[];
  readonly totals: RemovalTotals;
}

export const BackupReasonSchema = Schema.Literals([
  "delete",
  "reset",
  "restore",
  "unknown",
]);

export type BackupReason = typeof BackupReasonSchema.Type;

const BackupMetaSchema = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  reason: BackupReasonSchema,
  repo: Schema.NullOr(Schema.String),
  retrack: Schema.Array(Schema.String),
});

type BackupMeta = typeof BackupMetaSchema.Type;

const decodeMeta = Schema.decodeUnknownOption(
  Schema.fromJsonString(BackupMetaSchema)
);

export interface BackupInfo extends BackupMeta {
  readonly bytes: number;
  readonly path: string;
}

export interface DeleteRepoResult {
  readonly backup: BackupInfo;
  readonly plan: RepoDataPlan;
}

export interface ResetResult {
  readonly backup: BackupInfo;
  readonly plan: ResetPlan;
}

export interface RestoreResult {
  readonly restored: BackupInfo;
  readonly retracked: readonly string[];
  readonly safety: BackupInfo;
}

const decodeCountRow = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Int })
);

const decodeBranchCountRow = Schema.decodeUnknownSync(
  Schema.Struct({ branch: Schema.NullOr(Schema.String), n: Schema.Int })
);

const decodeRepoCountRow = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Int, repo: Schema.NullOr(Schema.String) })
);

const decodeNameRow = Schema.decodeUnknownSync(
  Schema.Struct({ name: Schema.String })
);

const decodeVersionRow = Schema.decodeUnknownSync(
  Schema.Struct({ user_version: Schema.Int })
);

const decodeSpoolRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(SpoolRecordSchema)
);

const decodeCommitSnapshot = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
      repoCommonDir: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })
  )
);

const BACKUP_ID = /^[A-Za-z0-9-]+$/u;

const storeError = (message: string) =>
  new LiveActionError({ message, reason: "store" });

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const openAdminDb = (home: LiveHome) =>
  Effect.acquireRelease(
    Effect.gen(function* open() {
      const opened = yield* openSqliteEventStore({
        kind: "live",
        path: home.storePath,
      }).pipe(
        Effect.mapError((error) =>
          storeError(`Could not open the store: ${error.message}`)
        )
      );

      opened.close();

      return yield* Effect.try({
        catch: (cause) =>
          storeError(`Could not open the store: ${messageOf(cause)}`),
        try: () => new DatabaseSync(home.storePath, { timeout: 5000 }),
      });
    }),
    (db) =>
      Effect.sync(() => {
        db.close();
      })
  );

const withAdminDb = <A>(
  home: LiveHome,
  operation: string,
  body: (db: DatabaseSync) => A
): Effect.Effect<A, LiveActionError> =>
  Effect.scoped(
    Effect.flatMap(openAdminDb(home), (db) =>
      Effect.try({
        catch: (cause) =>
          storeError(`Could not ${operation}: ${messageOf(cause)}`),
        try: () => body(db),
      })
    )
  );

const inTransaction = <A>(db: DatabaseSync, body: () => A): A => {
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
};

const count = (db: DatabaseSync, sql: string, ...params: string[]): number =>
  decodeCountRow(db.prepare(sql).get(...params)).n;

const listEntries = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir)
      .map((name) => path.join(dir, name))
      .toSorted();
  } catch {
    return [];
  }
};

const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

const filesUnder = (target: string): readonly string[] => {
  if (isDirectory(target)) {
    return listEntries(target).flatMap(filesUnder);
  }

  return existsSync(target) ? [target] : [];
};

const branchOfSpoolFile = (file: string): string | null => {
  if (!file.endsWith(".json")) {
    return null;
  }

  try {
    return Option.match(decodeSpoolRecord(readFileSync(file, "utf-8")), {
      onNone: () => null,
      onSome: (record) => record.git.branch,
    });
  } catch {
    return null;
  }
};

export const repoSpoolDirs = (
  home: LiveHome,
  repo: GitRepo
): readonly string[] => {
  const ids = new Set(repoWorktrees(repo.root).map(worktreeSpoolId));

  return listEntries(spoolRoot(home)).filter(
    (dir) =>
      isDirectory(dir) &&
      (ids.has(path.basename(dir)) ||
        latestSpoolRecord(path.join(dir, HOOK_SPOOL_FOLDER))?.git
          .repoCommonDir === repo.commonDir)
  );
};

const readCommitSnapshotLines = (home: LiveHome): readonly string[] => {
  const file = commitSnapshotsPath(home);

  try {
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
};

const commitSnapshotOf = (line: string) =>
  Option.getOrNull(decodeCommitSnapshot(line));

const isRepoLine =
  (repo: GitRepo) =>
  (line: string): boolean =>
    commitSnapshotOf(line)?.repoCommonDir === repo.commonDir;

interface BranchTally {
  commitSnapshots: number;
  events: number;
  spoolFiles: number;
  storeSnapshots: number;
}

type TallyField = keyof BranchTally;

const makeTally = () => {
  const byBranch = new Map<string | null, BranchTally>();

  const add = (branch: string | null, field: TallyField, amount: number) => {
    const current = byBranch.get(branch) ?? {
      commitSnapshots: 0,
      events: 0,
      spoolFiles: 0,
      storeSnapshots: 0,
    };

    current[field] += amount;
    byBranch.set(branch, current);
  };

  const rows = (): readonly BranchRemoval[] =>
    [...byBranch.entries()]
      .map(([branch, tally]) => ({ branch, ...tally }))
      .toSorted((a, b) => (a.branch ?? "").localeCompare(b.branch ?? ""));

  return { add, rows };
};

const repoOf = (db: DatabaseSync, target: string): GitRepo => {
  const resolved = resolveGitRepo(target);

  if (resolved !== null) {
    return resolved;
  }

  const root = path.resolve(target);
  const candidates = [path.join(root, ".git"), root];

  const commonDir =
    candidates.find(
      (candidate) =>
        count(
          db,
          "SELECT COUNT(*) AS n FROM events WHERE repo_common_dir = ?",
          candidate
        ) > 0
    ) ?? path.join(root, ".git");

  return { commonDir, name: path.basename(root), root };
};

const sumOf = (rows: readonly BranchRemoval[], field: TallyField): number =>
  rows.reduce((sum, row) => sum + row[field], 0);

export const planDeleteRepoData = (
  home: LiveHome,
  target: string
): Effect.Effect<RepoDataPlan, LiveActionError> =>
  Effect.gen(function* plan() {
    const config = yield* readLiveConfig(home);

    const counted = yield* withAdminDb(home, "count repo data", (db) => {
      const repo = repoOf(db, target);
      const tally = makeTally();

      for (const raw of db
        .prepare(
          "SELECT branch, COUNT(*) AS n FROM events WHERE repo_common_dir = ? GROUP BY branch"
        )
        .all(repo.commonDir)) {
        const row = decodeBranchCountRow(raw);

        tally.add(row.branch, "events", row.n);
      }

      for (const raw of db
        .prepare(
          "SELECT json_extract(selector_key, '$[2]') AS branch, COUNT(*) AS n FROM snapshots WHERE json_extract(selector_key, '$[1]') = ? GROUP BY 1"
        )
        .all(repo.commonDir)) {
        const row = decodeBranchCountRow(raw);

        tally.add(row.branch, "storeSnapshots", row.n);
      }

      const coverage = count(
        db,
        "SELECT COUNT(*) AS n FROM coverage WHERE repos = ?",
        JSON.stringify([repo.commonDir])
      );

      return { coverage, repo, tally };
    });

    const { repo, tally } = counted;

    for (const line of readCommitSnapshotLines(home).filter(isRepoLine(repo))) {
      tally.add(commitSnapshotOf(line)?.branch ?? null, "commitSnapshots", 1);
    }

    const spoolDirs = repoSpoolDirs(home, repo);

    for (const file of spoolDirs.flatMap(filesUnder)) {
      tally.add(branchOfSpoolFile(file), "spoolFiles", 1);
    }

    const branches = tally.rows();

    return {
      branches,
      confirmText: repo.name,
      repo,
      spoolDirs,
      totals: {
        commitSnapshots: sumOf(branches, "commitSnapshots"),
        coverage: counted.coverage,
        events: sumOf(branches, "events"),
        spoolFiles: sumOf(branches, "spoolFiles"),
        storeSnapshots: sumOf(branches, "storeSnapshots"),
      },
      tracked: config.repos.some(
        (entry) =>
          path.resolve(entry) === repo.root ||
          resolveGitRepo(entry)?.commonDir === repo.commonDir
      ),
    };
  });

export const planResetStore = (
  home: LiveHome
): Effect.Effect<ResetPlan, LiveActionError> =>
  Effect.gen(function* plan() {
    const counted = yield* withAdminDb(home, "count store data", (db) => ({
      coverage: count(db, "SELECT COUNT(*) AS n FROM coverage"),
      repos: db
        .prepare(
          "SELECT repo_common_dir AS repo, COUNT(*) AS n FROM events GROUP BY repo_common_dir ORDER BY repo_common_dir"
        )
        .all()
        .map((raw) => {
          const row = decodeRepoCountRow(raw);

          return { events: row.n, repoCommonDir: row.repo };
        }),
      storeSnapshots: count(db, "SELECT COUNT(*) AS n FROM snapshots"),
    }));

    const spoolDirs = listEntries(spoolRoot(home));

    return {
      confirmText: RESET_CONFIRM_TEXT,
      repos: counted.repos,
      spoolDirs,
      totals: {
        commitSnapshots: readCommitSnapshotLines(home).length,
        coverage: counted.coverage,
        events: counted.repos.reduce((sum, row) => sum + row.events, 0),
        spoolFiles: spoolDirs.flatMap(filesUnder).length,
        storeSnapshots: counted.storeSnapshots,
      },
    };
  });

const backupDbPath = (home: LiveHome, id: string): string =>
  path.join(backupsDir(home), `${id}.db`);

const backupMetaPath = (home: LiveHome, id: string): string =>
  path.join(backupsDir(home), `${id}.json`);

export const backupFilesDir = (home: LiveHome, id: string): string =>
  path.join(backupsDir(home), `${id}.files`);

const freshBackupId = (home: LiveHome, stamp: string): string => {
  const base = stamp.replaceAll(/[:.]/gu, "-");

  const taken = (id: string): boolean =>
    existsSync(backupDbPath(home, id)) || existsSync(backupMetaPath(home, id));

  let id = base;

  for (let n = 2; taken(id); n += 1) {
    id = `${base}-${n}`;
  }

  return id;
};

const infoOf = (home: LiveHome, meta: BackupMeta): BackupInfo => {
  const file = backupDbPath(home, meta.id);

  return {
    ...meta,
    bytes: existsSync(file) ? statSync(file).size : 0,
    path: file,
  };
};

const moveInto = (source: string, destination: string): void => {
  mkdirSync(path.dirname(destination), { recursive: true });

  try {
    renameSync(source, destination);
  } catch {
    cpSync(source, destination, { recursive: true });
    rmSync(source, { force: true, recursive: true });
  }
};

const guardHome = (home: LiveHome): Effect.Effect<void, LiveActionError> => {
  const outside =
    confined(home, home.storePath) ?? confined(home, commitSnapshotsPath(home));

  return outside === null ? Effect.void : Effect.fail(outside);
};

const createBackup = (
  home: LiveHome,
  reason: BackupReason,
  repo: string | null,
  retrack: readonly string[]
): Effect.Effect<BackupInfo, LiveActionError> =>
  Effect.gen(function* makeBackup() {
    const now = yield* DateTime.now;
    const id = freshBackupId(home, DateTime.formatIso(now));
    const file = backupDbPath(home, id);

    yield* Effect.scoped(
      Effect.flatMap(openAdminDb(home), (db) =>
        Effect.tryPromise({
          catch: (cause) =>
            storeError(`Could not write the backup: ${messageOf(cause)}`),
          // @effect-diagnostics-next-line asyncFunction:off -- node:sqlite backup() only exists as a Promise API; Effect.tryPromise wraps it.
          try: async () => {
            mkdirSync(backupsDir(home), { recursive: true });

            return await backup(db, file);
          },
        })
      )
    );

    const meta: BackupMeta = {
      createdAt: DateTime.formatIso(now),
      id,
      reason,
      repo,
      retrack: [...retrack],
    };

    yield* Effect.try({
      catch: (cause) =>
        storeError(`Could not write the backup: ${messageOf(cause)}`),
      try: () => {
        writeFileSync(
          backupMetaPath(home, id),
          `${JSON.stringify(meta, null, 2)}\n`
        );

        const snapshots = commitSnapshotsPath(home);

        if (existsSync(snapshots)) {
          mkdirSync(backupFilesDir(home, id), { recursive: true });
          copyFileSync(
            snapshots,
            path.join(backupFilesDir(home, id), path.basename(snapshots))
          );
        }
      },
    });

    return infoOf(home, meta);
  });

const confirmationError = (expected: string) =>
  new LiveActionError({
    message: `Type ${expected} to confirm. Nothing was changed.`,
    reason: "confirmation",
  });

const fileStep = (message: string, body: () => void) =>
  Effect.try({
    catch: (cause) => storeError(`${message}: ${messageOf(cause)}`),
    try: body,
  });

export const deleteRepoData = (
  home: LiveHome,
  target: string,
  confirmation: string
): Effect.Effect<DeleteRepoResult, LiveActionError> =>
  Effect.gen(function* deleteRepo() {
    yield* guardHome(home);

    const plan = yield* planDeleteRepoData(home, target);

    if (confirmation.trim() !== plan.confirmText) {
      return yield* confirmationError(plan.confirmText);
    }

    const saved = yield* createBackup(
      home,
      "delete",
      plan.repo.root,
      plan.tracked ? [plan.repo.root] : []
    );

    const { commonDir } = plan.repo;

    yield* withAdminDb(home, "delete repo data", (db) => {
      inTransaction(db, () => {
        db.prepare(
          "DELETE FROM snapshot_events WHERE snapshot_id IN (SELECT snapshot_id FROM snapshots WHERE json_extract(selector_key, '$[1]') = ?)"
        ).run(commonDir);
        db.prepare(
          "DELETE FROM snapshots WHERE json_extract(selector_key, '$[1]') = ?"
        ).run(commonDir);
        db.prepare("DELETE FROM events WHERE repo_common_dir = ?").run(
          commonDir
        );
        db.prepare("DELETE FROM coverage WHERE repos = ?").run(
          JSON.stringify([commonDir])
        );
      });
    });

    yield* fileStep("Could not move hook notes into the backup", () => {
      for (const dir of plan.spoolDirs) {
        moveInto(
          dir,
          path.join(backupFilesDir(home, saved.id), "spool", path.basename(dir))
        );
      }
    });

    yield* fileStep("Could not update snapshots.jsonl", () => {
      const lines = readCommitSnapshotLines(home);
      const kept = lines.filter((line) => !isRepoLine(plan.repo)(line));

      if (kept.length !== lines.length) {
        const file = commitSnapshotsPath(home);
        const temp = `${file}.${process.pid}.tmp`;

        writeFileSync(temp, kept.length === 0 ? "" : `${kept.join("\n")}\n`);
        renameSync(temp, file);
      }
    });

    if (plan.tracked) {
      yield* removeRepo(home, plan.repo.root);
    }

    return { backup: saved, plan };
  });

export const resetStore = (
  home: LiveHome,
  confirmation: string
): Effect.Effect<ResetResult, LiveActionError> =>
  Effect.gen(function* reset() {
    yield* guardHome(home);

    const plan = yield* planResetStore(home);

    if (confirmation.trim() !== RESET_CONFIRM_TEXT) {
      return yield* confirmationError(RESET_CONFIRM_TEXT);
    }

    const saved = yield* createBackup(home, "reset", null, []);

    yield* withAdminDb(home, "reset the store", (db) => {
      inTransaction(db, () => {
        db.exec("DELETE FROM snapshot_events");
        db.exec("DELETE FROM snapshots");
        db.exec("DELETE FROM coverage");
        db.exec("DELETE FROM events");
      });
    });

    yield* fileStep("Could not move files into the backup", () => {
      const files = backupFilesDir(home, saved.id);

      for (const entry of listEntries(spoolRoot(home))) {
        moveInto(entry, path.join(files, "spool", path.basename(entry)));
      }

      const snapshots = commitSnapshotsPath(home);

      if (existsSync(snapshots)) {
        rmSync(snapshots, { force: true });
      }

      if (existsSync(usageStateDir(home))) {
        moveInto(
          usageStateDir(home),
          path.join(files, path.basename(usageStateDir(home)))
        );
      }
    });

    return { backup: saved, plan };
  });

export const listBackups = (home: LiveHome): readonly BackupInfo[] =>
  listEntries(backupsDir(home))
    .filter((file) => file.endsWith(".db"))
    .map((file) => {
      const id = path.basename(file, ".db");

      const meta = (() => {
        try {
          return Option.getOrNull(
            decodeMeta(readFileSync(backupMetaPath(home, id), "utf-8"))
          );
        } catch {
          return null;
        }
      })();

      return infoOf(
        home,
        meta ?? {
          createdAt: statSync(file).mtime.toISOString(),
          id,
          reason: "unknown",
          repo: null,
          retrack: [],
        }
      );
    })
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

const unknownBackup = (id: string) =>
  new LiveActionError({
    message: `No backup named ${id}.`,
    reason: "unknown-backup",
  });

const userTables = (db: DatabaseSync, schema: string): readonly string[] =>
  db
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all()
    .map((row) => decodeNameRow(row).name);

const schemaVersion = (db: DatabaseSync, schema: string): number =>
  decodeVersionRow(db.prepare(`PRAGMA ${schema}.user_version`).get())
    .user_version;

const backupVersion = (file: string) =>
  Effect.try({
    catch: (cause) =>
      storeError(`Could not read the backup: ${messageOf(cause)}`),
    try: () => {
      const source = new DatabaseSync(file, { readOnly: true });

      try {
        return schemaVersion(source, "main");
      } finally {
        source.close();
      }
    },
  });

const upgradedCopy = (home: LiveHome, file: string, id: string) =>
  Effect.gen(function* upgradeBackup() {
    const scratch = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) =>
          storeError(`Could not copy the backup: ${messageOf(cause)}`),
        try: () => {
          const dir = path.join(backupsDir(home), `.upgrade-${id}`);

          rmSync(dir, { force: true, recursive: true });
          mkdirSync(dir, { recursive: true });

          return dir;
        },
      }),
      (dir) =>
        Effect.sync(() => {
          rmSync(dir, { force: true, recursive: true });
        })
    );

    const copy = path.join(scratch, path.basename(file));

    yield* Effect.try({
      catch: (cause) =>
        storeError(`Could not copy the backup: ${messageOf(cause)}`),
      try: () => {
        copyFileSync(file, copy);
      },
    });

    const opened = yield* openSqliteEventStore({
      kind: "live",
      path: copy,
    }).pipe(
      Effect.mapError((error) =>
        storeError(`Could not upgrade the backup: ${error.message}`)
      )
    );

    opened.close();

    return copy;
  });

export const restoreBackup = (
  home: LiveHome,
  id: string
): Effect.Effect<RestoreResult, LiveActionError> =>
  Effect.gen(function* restore() {
    yield* guardHome(home);

    const restored = listBackups(home).find((info) => info.id === id);

    if (!BACKUP_ID.test(id) || restored === undefined) {
      return yield* unknownBackup(id);
    }

    const version = yield* backupVersion(restored.path);

    if (version < 1 || version > STORE_SCHEMA_VERSION) {
      return yield* new LiveActionError({
        message: `Backup ${id} was made by a different dft version and cannot be restored here.`,
        reason: "backup-incompatible",
      });
    }

    const source =
      version === STORE_SCHEMA_VERSION
        ? restored.path
        : yield* upgradedCopy(home, restored.path, id);

    const safety = yield* createBackup(home, "restore", null, []);

    yield* withAdminDb(home, "restore the backup", (db) => {
      db.prepare("ATTACH DATABASE ? AS restore_source").run(source);

      try {
        const available = new Set(userTables(db, "restore_source"));

        const tables = userTables(db, "main").filter((name) =>
          available.has(name)
        );

        inTransaction(db, () => {
          for (const table of tables) {
            db.exec(`DELETE FROM main."${table}"`);
            db.exec(
              `INSERT INTO main."${table}" SELECT * FROM restore_source."${table}"`
            );
          }
        });
      } finally {
        db.exec("DETACH DATABASE restore_source");
      }
    });

    yield* fileStep("Could not bring back files from the backup", () => {
      const files = backupFilesDir(home, id);
      const spool = path.join(files, "spool");

      const snapshots = path.join(
        files,
        path.basename(commitSnapshotsPath(home))
      );

      const usage = path.join(files, path.basename(usageStateDir(home)));

      if (existsSync(spool)) {
        cpSync(spool, spoolRoot(home), {
          errorOnExist: false,
          force: false,
          recursive: true,
        });
      }

      if (existsSync(snapshots)) {
        copyFileSync(snapshots, commitSnapshotsPath(home));
      }

      if (existsSync(usage)) {
        cpSync(usage, usageStateDir(home), { force: true, recursive: true });
      }
    });

    const retracked: string[] = [];

    for (const repo of restored.retrack) {
      const tracked = yield* Effect.option(addRepo(home, repo));

      if (Option.isSome(tracked)) {
        retracked.push(tracked.value.repo.root);
      }
    }

    return { restored, retracked, safety };
  }).pipe(Effect.scoped);
