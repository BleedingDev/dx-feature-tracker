// @effect-diagnostics nodeBuiltinImport:off -- Delete, reset and restore work on the SQLite store, the hook spool and snapshots.jsonl under DFT_HOME with synchronous file moves at the process boundary.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  opendirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { Cause, DateTime, Effect, Option, Schema } from "effect";

import { SpoolRecordSchema } from "../collectors/cursor-hooks/spool-record.js";
import {
  HOOK_SPOOL_FOLDER,
  latestSpoolRecord,
} from "../collectors/cursor-hooks/spool.js";
import { HookObservationSchema } from "../harness/hook-observation.js";
import type { HookObservation } from "../harness/hook-observation.js";
import { HOOK_SPOOL_ROOT } from "../harness/hook-spool.js";
import { repoWorktrees, worktreeSpoolId } from "../registry/runtime.js";
import {
  AGENT_RECOVERY_TABLES,
  invalidateAgentState,
  tombstoneAgentScope,
} from "../storage/agent-invalidation.js";
import { STORE_SCHEMA_VERSION } from "../storage/migrations.js";
import {
  appendPrivateFile,
  copyPrivateFile,
  ensurePrivateDir,
  tightenPrivateFile,
  writePrivateFile,
} from "../storage/private-files.js";
import { openSqliteEventStore } from "../storage/sqlite-event-store.js";
import {
  addRepo,
  DEFAULT_LIVE_CONFIG,
  readLiveConfig,
  removeRepo,
  resolveGitRepo,
  setCursorUsageImport,
} from "./config.js";
import type {
  GitRepo,
  LiveConfig,
  TrackResult,
  UntrackResult,
} from "./config.js";
import {
  backupsDir,
  commitSnapshotsPath,
  configPath,
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
  readonly hookFiles: readonly string[];
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
  readonly hookFiles: readonly string[];
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

export type LiveAdministrationRequest =
  | { readonly kind: "delete"; readonly target: string }
  | { readonly kind: "reset" }
  | { readonly kind: "restore"; readonly backupId: string }
  | {
      readonly kind: "configure";
      readonly action: "add-repo" | "remove-repo";
      readonly target: string;
    }
  | {
      readonly kind: "configure";
      readonly action: "cursor-usage";
      readonly enabled: boolean;
    };

export interface RetainedAdministrationReview {
  readonly request: LiveAdministrationRequest;
  readonly fingerprint: string;
  readonly selectedRefs: readonly string[];
  readonly configDigest: string;
  readonly resultConfigDigest?: string | undefined;
}

export interface LiveAdministrationPreview extends RetainedAdministrationReview {
  readonly configuration: LiveConfig;
  readonly confirmText: string | null;
  readonly plan: RepoDataPlan | ResetPlan | null;
  readonly backup: BackupInfo | null;
  readonly backupContentDigest: string | null;
  readonly fileDigests: readonly (readonly [string, string])[];
  readonly resources: AdministrationResources;
}

export interface LiveAdministrationLimits {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  readonly maxElapsedMs?: number;
}

export interface AdministrationResources {
  readonly bytesRead: number;
  readonly filesRead: number;
  readonly recordsDecoded: number;
  readonly elapsedMs: number;
}

interface AdministrationBudget {
  readonly limits: LiveAdministrationLimits;
  readonly startedAt: bigint;
  bytesRead: number;
  filesRead: number;
  recordsDecoded: number;
  reservedBytes: number;
  readonly contents: Map<string, Buffer>;
  readonly visitedEntries: Set<string>;
}

export interface LiveAdministrationResult {
  readonly kind: LiveAdministrationRequest["kind"];
  readonly backupIds: readonly string[];
  readonly backupArtifacts: readonly {
    readonly id: string;
    readonly contentDigest: string;
    readonly restorationVersion: number;
  }[];
  readonly filesChanged: readonly string[];
  readonly configDigest: string | null;
  readonly partialErrors: readonly string[];
  readonly removedRefs: readonly string[];
  readonly removedCount: number | null;
  readonly removalReason: string | null;
  readonly resources: AdministrationResources;
  readonly verificationUnavailable: readonly string[];
  readonly result:
    | DeleteRepoResult
    | ResetResult
    | RestoreResult
    | TrackResult
    | UntrackResult
    | LiveConfig
    | null;
}

export interface LiveAdministrationProbe {
  readonly state: "complete" | "absent" | "indeterminate";
  readonly backupIds: readonly string[];
  readonly filesChanged: readonly string[];
  readonly configDigest: string;
  readonly reason: string;
  readonly resources: AdministrationResources;
}

interface AdministrationGuard {
  readonly preview: LiveAdministrationPreview;
  readonly operationId: string;
  readonly limits: LiveAdministrationLimits;
  readonly budget: AdministrationBudget;
}

const decodeCountRow = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Int })
);

const decodeBudgetRow = Schema.decodeUnknownSync(
  Schema.Struct({ bytes: Schema.Number, n: Schema.Int })
);

const decodeBoundedConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      cursorUsageImport: Schema.optionalKey(Schema.Boolean),
      repos: Schema.optionalKey(Schema.Array(Schema.String)),
    })
  )
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

const decodePageSizeRow = Schema.decodeUnknownSync(
  Schema.Struct({ page_size: Schema.Int })
);

const decodeSpoolRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(SpoolRecordSchema)
);

const decodeHookLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(HookObservationSchema)
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

const administrationBudget = (
  limits: LiveAdministrationLimits = {}
): AdministrationBudget => ({
  bytesRead: 0,
  contents: new Map(),
  filesRead: 0,
  limits,
  recordsDecoded: 0,
  reservedBytes: 0,
  startedAt: process.hrtime.bigint(),
  visitedEntries: new Set(),
});

const administrationResources = (
  budget: AdministrationBudget
): AdministrationResources => ({
  bytesRead: budget.bytesRead,
  elapsedMs: Number(process.hrtime.bigint() - budget.startedAt) / 1_000_000,
  filesRead: budget.filesRead,
  recordsDecoded: budget.recordsDecoded,
});

const checkAdministrationBudget = (
  budget: AdministrationBudget,
  additional: {
    readonly bytes?: number;
    readonly files?: number;
    readonly records?: number;
  } = {}
): void => {
  const { limits } = budget;

  if (
    budget.bytesRead + budget.reservedBytes + (additional.bytes ?? 0) >
      (limits.maxBytes ?? Number.MAX_SAFE_INTEGER) ||
    budget.filesRead + (additional.files ?? 0) > (limits.maxFiles ?? 500) ||
    budget.recordsDecoded + (additional.records ?? 0) >
      (limits.maxRecords ?? 500) ||
    administrationResources(budget).elapsedMs >
      (limits.maxElapsedMs ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw new LiveActionError({
      message:
        "The reviewed administration exceeds its file, byte, record or elapsed-time limit.",
      reason: "store",
      resources: administrationResources(budget),
    });
  }
};

const readBoundedFile = (
  file: string,
  budget: AdministrationBudget
): Buffer => {
  const cached = budget.contents.get(file);

  if (cached !== undefined) {
    checkAdministrationBudget(budget);

    return cached;
  }

  const stats = lstatSync(file);

  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw storeError(`Reviewed administration cannot read ${file}.`);
  }

  checkAdministrationBudget(budget, { bytes: stats.size, files: 1 });

  const bytes = readFileSync(file);

  budget.bytesRead += bytes.byteLength;
  budget.filesRead += 1;
  checkAdministrationBudget(budget);
  budget.contents.set(file, bytes);

  return bytes;
};

const readBoundedConfiguration = (
  home: LiveHome,
  budget: AdministrationBudget
): LiveConfig => {
  if (!existsSync(configPath(home))) {
    return DEFAULT_LIVE_CONFIG;
  }

  const parsed = decodeBoundedConfig(
    readBoundedFile(configPath(home), budget).toString("utf-8")
  );

  return {
    cursorUsageImport:
      parsed.cursorUsageImport ?? DEFAULT_LIVE_CONFIG.cursorUsageImport,
    repos: parsed.repos === undefined ? [] : [...new Set(parsed.repos)],
  };
};

const visitAdministrationEntry = (
  budget: AdministrationBudget,
  target: string
): void => {
  budget.visitedEntries.add(target);
  checkAdministrationBudget(budget);

  if (budget.visitedEntries.size > (budget.limits.maxFiles ?? 500)) {
    throw storeError(
      "The reviewed administration exceeds its directory-entry limit."
    );
  }
};

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
  body: (db: DatabaseSync) => A,
  readOnly = false
): Effect.Effect<A, LiveActionError> => {
  const acquire = readOnly
    ? Effect.acquireRelease(
        Effect.try({
          catch: (cause) =>
            storeError(`Could not read the store: ${messageOf(cause)}`),
          try: () =>
            new DatabaseSync(home.storePath, {
              readOnly: true,
              timeout: 5000,
            }),
        }),
        (db) =>
          Effect.sync(() => {
            db.close();
          })
      )
    : openAdminDb(home);

  return Effect.scoped(
    acquire.pipe(
      Effect.flatMap((db) =>
        Effect.try({
          catch: (cause) =>
            cause instanceof LiveActionError
              ? cause
              : storeError(`Could not ${operation}: ${messageOf(cause)}`),
          try: () => body(db),
        })
      )
    )
  );
};

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

const listEntries = (
  dir: string,
  budget?: AdministrationBudget
): readonly string[] => {
  try {
    if (budget !== undefined) {
      const stats = lstatSync(dir, { throwIfNoEntry: false });

      if (stats === undefined) {
        return [];
      }

      if (stats.isSymbolicLink()) {
        throw storeError(
          `Reviewed administration cannot follow the link ${dir}.`
        );
      }

      visitAdministrationEntry(budget, dir);

      const directory = opendirSync(dir);
      const entries: string[] = [];

      try {
        for (
          let entry = directory.readSync();
          entry !== null;
          entry = directory.readSync()
        ) {
          const target = path.join(dir, entry.name);

          visitAdministrationEntry(budget, target);
          entries.push(target);
        }

        return entries.toSorted();
      } finally {
        directory.closeSync();
      }
    }

    return readdirSync(dir)
      .map((name) => path.join(dir, name))
      .toSorted();
  } catch (error) {
    if (budget !== undefined) {
      throw error;
    }

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

const filesUnder = (
  target: string,
  budget?: AdministrationBudget
): readonly string[] => {
  if (budget !== undefined) {
    visitAdministrationEntry(budget, target);

    const stats = lstatSync(target, { throwIfNoEntry: false });

    if (stats === undefined) {
      return [];
    }

    if (stats.isSymbolicLink()) {
      throw storeError(
        `Reviewed administration cannot follow the link ${target}.`
      );
    }

    return stats.isDirectory()
      ? listEntries(target, budget).flatMap((entry) =>
          filesUnder(entry, budget)
        )
      : [target];
  }

  if (isDirectory(target)) {
    return listEntries(target).flatMap((entry) => filesUnder(entry));
  }

  return existsSync(target) ? [target] : [];
};

const branchOfSpoolFile = (
  file: string,
  budget?: AdministrationBudget
): string | null => {
  if (!file.endsWith(".json")) {
    return null;
  }

  try {
    if (budget !== undefined) {
      checkAdministrationBudget(budget, { records: 1 });
      budget.recordsDecoded += 1;
    }

    return Option.match(
      decodeSpoolRecord(
        budget === undefined
          ? readFileSync(file, "utf-8")
          : readBoundedFile(file, budget).toString("utf-8")
      ),
      {
        onNone: () => null,
        onSome: (record) => record.git.branch,
      }
    );
  } catch (error) {
    if (budget !== undefined) {
      throw error;
    }

    return null;
  }
};

export const repoSpoolDirs = (
  home: LiveHome,
  repo: GitRepo,
  budget?: AdministrationBudget
): readonly string[] => {
  const ids = new Set(repoWorktrees(repo.root).map(worktreeSpoolId));

  const latest = (dir: string) => {
    const folder = path.join(dir, HOOK_SPOOL_FOLDER);

    if (budget === undefined) {
      return latestSpoolRecord(folder);
    }

    const file = listEntries(folder, budget).findLast(
      (entry) =>
        entry.endsWith(".json") && !path.basename(entry).startsWith(".")
    );

    if (file === undefined) {
      return null;
    }

    checkAdministrationBudget(budget, { records: 1 });
    budget.recordsDecoded += 1;

    return Option.getOrNull(
      decodeSpoolRecord(readBoundedFile(file, budget).toString("utf-8"))
    );
  };

  return listEntries(spoolRoot(home), budget).filter(
    (dir) =>
      isDirectory(dir) &&
      (ids.has(path.basename(dir)) ||
        latest(dir)?.git.repoCommonDir === repo.commonDir)
  );
};

const hookSpoolRoot = (home: LiveHome): string =>
  path.join(home.dftHome, HOOK_SPOOL_ROOT);

const hookDayFiles = (
  home: LiveHome,
  budget?: AdministrationBudget
): readonly string[] =>
  filesUnder(hookSpoolRoot(home), budget).filter((file) =>
    file.endsWith(".jsonl")
  );

const linesOf = (
  file: string,
  budget?: AdministrationBudget
): readonly string[] => {
  try {
    const text =
      budget === undefined
        ? readFileSync(file, "utf-8")
        : readBoundedFile(file, budget).toString("utf-8");

    const lines = text.split("\n").filter((line) => line.trim() !== "");

    if (budget !== undefined) {
      checkAdministrationBudget(budget, { records: lines.length });
      budget.recordsDecoded += lines.length;
    }

    return lines;
  } catch (error) {
    if (budget !== undefined) {
      throw error;
    }

    return [];
  }
};

const withinAny = (target: string | null, roots: readonly string[]): boolean =>
  target !== null &&
  roots.some((root) => {
    const relative = path.relative(root, path.resolve(target));

    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });

const repoHookObservation = (
  repo: GitRepo
): ((line: string) => HookObservation | null) => {
  const roots = [...new Set([repo.root, ...repoWorktrees(repo.root)])];

  return (line) => {
    const observation = Option.getOrNull(decodeHookLine(line));

    if (observation === null) {
      return null;
    }

    const seen = observation.git;

    const belongs =
      seen.repoCommonDir === null
        ? withinAny(seen.worktreePath ?? observation.fields.cwd, roots)
        : path.resolve(seen.repoCommonDir) === path.resolve(repo.commonDir);

    return belongs ? observation : null;
  };
};

interface HookDayNotes {
  readonly file: string;
  readonly notes: readonly HookObservation[];
}

const repoHookNotes = (
  home: LiveHome,
  repo: GitRepo,
  budget?: AdministrationBudget
): readonly HookDayNotes[] => {
  const ofRepo = repoHookObservation(repo);

  return hookDayFiles(home, budget).flatMap((file) => {
    const notes = linesOf(file, budget).flatMap((line) => {
      const observation = ofRepo(line);

      return observation === null ? [] : [observation];
    });

    return notes.length === 0 ? [] : [{ file, notes }];
  });
};

const appendLines = (file: string, lines: readonly string[]): void => {
  if (lines.length === 0) {
    return;
  }

  ensurePrivateDir(path.dirname(file));
  appendPrivateFile(file, `${lines.join("\n")}\n`);
};

const replaceLines = (file: string, lines: readonly string[]): void => {
  if (lines.length === 0) {
    rmSync(file, { force: true });

    return;
  }

  const temp = `${file}.${process.pid}.tmp`;

  writePrivateFile(temp, `${lines.join("\n")}\n`);
  renameSync(temp, file);
};

const readCommitSnapshotLines = (
  home: LiveHome,
  budget?: AdministrationBudget
): readonly string[] => {
  const file = commitSnapshotsPath(home);

  if (budget !== undefined) {
    return existsSync(file) ? linesOf(file, budget) : [];
  }

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
  target: string,
  budget?: AdministrationBudget
): Effect.Effect<RepoDataPlan, LiveActionError> =>
  Effect.gen(function* plan() {
    const config = yield* budget === undefined
      ? readLiveConfig(home)
      : Effect.try({
          catch: (cause) =>
            cause instanceof LiveActionError
              ? cause
              : new LiveActionError({
                  message: messageOf(cause),
                  reason: "bad-config",
                }),
          try: () => readBoundedConfiguration(home, budget),
        });

    const counted = yield* withAdminDb(
      home,
      "count repo data",
      (db) => {
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
      },
      true
    );

    const { repo, tally } = counted;

    for (const line of readCommitSnapshotLines(home, budget).filter(
      isRepoLine(repo)
    )) {
      tally.add(commitSnapshotOf(line)?.branch ?? null, "commitSnapshots", 1);
    }

    const spoolDirs = repoSpoolDirs(home, repo, budget);

    for (const file of spoolDirs.flatMap((dir) => filesUnder(dir, budget))) {
      tally.add(branchOfSpoolFile(file, budget), "spoolFiles", 1);
    }

    const hookNotes = repoHookNotes(home, repo, budget);

    for (const { notes } of hookNotes) {
      for (const note of notes) {
        tally.add(note.git.branch, "spoolFiles", 1);
      }
    }

    const branches = tally.rows();

    return {
      branches,
      confirmText: repo.name,
      hookFiles: hookNotes.map(({ file }) => file),
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
  home: LiveHome,
  budget?: AdministrationBudget
): Effect.Effect<ResetPlan, LiveActionError> =>
  Effect.gen(function* plan() {
    const counted = yield* withAdminDb(
      home,
      "count store data",
      (db) => ({
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
      }),
      true
    );

    const spoolDirs = listEntries(spoolRoot(home), budget);
    const hookFiles = hookDayFiles(home, budget);

    return {
      confirmText: RESET_CONFIRM_TEXT,
      hookFiles,
      repos: counted.repos,
      spoolDirs,
      totals: {
        commitSnapshots: readCommitSnapshotLines(home, budget).length,
        coverage: counted.coverage,
        events: counted.repos.reduce((sum, row) => sum + row.events, 0),
        spoolFiles:
          spoolDirs.flatMap((dir) => filesUnder(dir, budget)).length +
          hookFiles.reduce(
            (sum, file) => sum + linesOf(file, budget).length,
            0
          ),
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

const hookBackupPath = (home: LiveHome, id: string, file: string): string =>
  path.join(
    backupFilesDir(home, id),
    HOOK_SPOOL_ROOT,
    path.relative(hookSpoolRoot(home), file)
  );

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

const backupInfoFor = (
  home: LiveHome,
  id: string,
  budget?: AdministrationBudget
): BackupInfo | null => {
  if (!BACKUP_ID.test(id) || !existsSync(backupDbPath(home, id))) {
    return null;
  }

  const metaFile = backupMetaPath(home, id);

  const meta = existsSync(metaFile)
    ? Option.getOrNull(
        decodeMeta(
          budget === undefined
            ? readFileSync(metaFile, "utf-8")
            : readBoundedFile(metaFile, budget).toString("utf-8")
        )
      )
    : null;

  return infoOf(
    home,
    meta ?? {
      createdAt: statSync(backupDbPath(home, id)).mtime.toISOString(),
      id,
      reason: "unknown",
      repo: null,
      retrack: [],
    }
  );
};

const moveInto = (source: string, destination: string): void => {
  ensurePrivateDir(path.dirname(destination));

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

const fileStep = (message: string, body: () => void) =>
  Effect.try({
    catch: (cause) =>
      cause instanceof LiveActionError
        ? cause
        : storeError(`${message}: ${messageOf(cause)}`),
    try: body,
  });

const createBackup = (
  home: LiveHome,
  reason: BackupReason,
  repo: string | null,
  retrack: readonly string[],
  budget?: AdministrationBudget
): Effect.Effect<BackupInfo, LiveActionError> =>
  Effect.gen(function* makeBackup() {
    const now = yield* DateTime.now;
    const id = freshBackupId(home, DateTime.formatIso(now));
    const file = backupDbPath(home, id);

    return yield* Effect.gen(function* writeBackup() {
      yield* Effect.scoped(
        Effect.flatMap(openAdminDb(home), (db) =>
          Effect.tryPromise({
            catch: (cause) =>
              storeError(`Could not write the backup: ${messageOf(cause)}`),
            // @effect-diagnostics-next-line asyncFunction:off -- node:sqlite backup() only exists as a Promise API; Effect.tryPromise wraps it.
            try: async () => {
              ensurePrivateDir(backupsDir(home));

              const pageSize = decodePageSizeRow(
                db.prepare("PRAGMA page_size").get()
              ).page_size;

              const pages = await backup(db, file, {
                progress: ({ totalPages }) => {
                  if (budget !== undefined) {
                    budget.reservedBytes = totalPages * pageSize;
                    checkAdministrationBudget(budget);
                  }
                },
              });

              tightenPrivateFile(file);

              if (budget !== undefined) {
                budget.bytesRead += statSync(file).size;
                budget.reservedBytes = 0;
                checkAdministrationBudget(budget);
              }

              return pages;
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
          writePrivateFile(
            backupMetaPath(home, id),
            `${JSON.stringify(meta, null, 2)}\n`
          );

          const snapshots = commitSnapshotsPath(home);

          if (existsSync(snapshots)) {
            if (budget !== undefined) {
              const stats = lstatSync(snapshots);

              checkAdministrationBudget(budget, {
                bytes: stats.size,
                files: 1,
              });
              budget.bytesRead += stats.size;
              budget.filesRead += 1;
            }

            ensurePrivateDir(backupFilesDir(home, id));
            copyPrivateFile(
              snapshots,
              path.join(backupFilesDir(home, id), path.basename(snapshots))
            );
          }

          if (reason === "restore") {
            for (const [source, relative] of [
              [spoolRoot(home), "spool"],
              [hookSpoolRoot(home), HOOK_SPOOL_ROOT],
              [usageStateDir(home), path.basename(usageStateDir(home))],
            ]) {
              if (
                source === undefined ||
                relative === undefined ||
                !existsSync(source)
              ) {
                continue;
              }

              const target = path.join(backupFilesDir(home, id), relative);

              ensurePrivateDir(path.dirname(target));
              cpSync(source, target, {
                filter: (entry) => {
                  if (budget !== undefined) {
                    visitAdministrationEntry(budget, entry);

                    const stats = lstatSync(entry);

                    if (stats.isSymbolicLink()) {
                      throw storeError(
                        `The restore safety backup cannot follow the link ${entry}.`
                      );
                    }

                    checkAdministrationBudget(budget, {
                      bytes: stats.isFile() ? stats.size : 0,
                      files: stats.isFile() ? 1 : 0,
                    });
                    budget.bytesRead += stats.isFile() ? stats.size : 0;
                    budget.filesRead += stats.isFile() ? 1 : 0;
                  }

                  return true;
                },
                recursive: true,
              });
            }
          }
        },
      });

      return infoOf(home, meta);
    }).pipe(
      Effect.mapError(
        (error) =>
          new LiveActionError({
            backupIds: existsSync(file) ? [id] : [],
            message: error.message,
            partialErrors: [error.message],
            reason: error.reason,
          })
      )
    );
  });

const confirmationError = (expected: string) =>
  new LiveActionError({
    message: `Type ${expected} to confirm. Nothing was changed.`,
    reason: "confirmation",
  });

const digestText = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const strictFileState = (
  home: LiveHome,
  target: string,
  budget?: AdministrationBudget
): readonly (readonly [string, string])[] => {
  const outside = confined(home, target);

  if (outside !== null) {
    throw outside;
  }

  if (budget !== undefined) {
    visitAdministrationEntry(budget, target);
  }

  for (
    let parent = path.dirname(target);
    parent !== path.dirname(home.dftHome);
    parent = path.dirname(parent)
  ) {
    const parentStats = lstatSync(parent, { throwIfNoEntry: false });

    if (parentStats?.isSymbolicLink() === true) {
      throw storeError(
        `Reviewed administration cannot follow the link ${parent}.`
      );
    }

    if (parent === home.dftHome) {
      break;
    }
  }

  const stats = lstatSync(target, { throwIfNoEntry: false });

  if (stats === undefined) {
    return [[target, "missing"]];
  }

  if (stats.isSymbolicLink()) {
    throw storeError(
      `Reviewed administration cannot follow the link ${target}.`
    );
  }

  if (stats.isDirectory()) {
    if (budget !== undefined) {
      checkAdministrationBudget(budget);
    }

    const entries =
      budget === undefined ? listEntries(target) : listEntries(target, budget);

    return [
      [target, "directory"],
      ...entries.flatMap((entry) => strictFileState(home, entry, budget)),
    ];
  }

  const bytes =
    budget === undefined
      ? readFileSync(target)
      : readBoundedFile(target, budget);

  return [[target, createHash("sha256").update(bytes).digest("hex")]];
};

export const configurationContentDigest = (
  home: LiveHome,
  budget?: AdministrationBudget
): string =>
  strictFileState(home, configPath(home), budget)[0]?.[1] ?? "missing";

const desiredConfiguration = (
  config: LiveConfig,
  request: LiveAdministrationRequest
): LiveConfig | null => {
  if (request.kind !== "configure") {
    return null;
  }

  if (request.action === "cursor-usage") {
    return { ...config, cursorUsageImport: request.enabled };
  }

  const repo = resolveGitRepo(request.target);

  if (request.action === "add-repo" && repo === null) {
    throw new LiveActionError({
      message: `${path.resolve(request.target)} is not a git repo.`,
      reason: "not-a-repo",
    });
  }

  const matches = (entry: string): boolean =>
    path.resolve(entry) === path.resolve(request.target) ||
    (repo !== null && resolveGitRepo(entry)?.commonDir === repo.commonDir);

  let { repos } = config;

  if (request.action === "remove-repo") {
    repos = config.repos.filter((entry) => !matches(entry));
  } else if (!config.repos.some(matches)) {
    repos = [...config.repos, repo?.root ?? path.resolve(request.target)];
  }

  return {
    ...config,
    repos,
  };
};

const configurationDigestOf = (config: LiveConfig): string =>
  digestText(
    `${JSON.stringify({ cursorUsageImport: config.cursorUsageImport, repos: config.repos }, null, 2)}\n`
  );

const userTables = (db: DatabaseSync, schema: string): readonly string[] =>
  db
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all()
    .map((row) => decodeNameRow(row).name);

const administrationRows = (
  db: DatabaseSync,
  request: LiveAdministrationRequest,
  plan: RepoDataPlan | ResetPlan | null,
  budget?: AdministrationBudget
): readonly (readonly [string, string])[] => {
  if (request.kind === "configure") {
    return [];
  }

  const commonDir =
    plan !== null && "repo" in plan ? plan.repo.commonDir : null;

  const recovery = new Set<string>([
    ...AGENT_RECOVERY_TABLES,
    "agent_operation_plans",
  ]);

  const tables =
    request.kind === "restore" || request.kind === "reset"
      ? userTables(db, "main").filter(
          (name) => name !== "store_meta" && !recovery.has(name)
        )
      : [
          "events",
          "coverage",
          "snapshots",
          "snapshot_events",
          "agent_bases",
          "agent_results",
          "agent_result_headers",
          "agent_result_items",
          "agent_cursors",
          "agent_coverage_latest",
          "agent_event_reads",
        ].filter((table) => userTables(db, "main").includes(table));

  return tables
    .flatMap((table) => {
      let selection = "";
      const params: string[] = [];

      if (request.kind === "delete" && commonDir !== null) {
        params.push(commonDir);

        switch (table) {
          case "events": {
            selection = " WHERE repo_common_dir = ?";

            break;
          }

          case "coverage": {
            selection = " WHERE repos = ?";
            params[0] = JSON.stringify([commonDir]);

            break;
          }

          case "snapshots": {
            selection = " WHERE json_extract(selector_key, '$[1]') = ?";

            break;
          }

          case "snapshot_events": {
            selection =
              " WHERE snapshot_id IN (SELECT snapshot_id FROM snapshots WHERE json_extract(selector_key, '$[1]') = ?)";

            break;
          }

          case "agent_bases": {
            selection = " WHERE repo_id = ?";

            break;
          }

          case "agent_results": {
            selection =
              " WHERE basis_id IN (SELECT id FROM agent_bases WHERE repo_id = ?)";

            break;
          }

          case "agent_result_headers": {
            selection =
              " WHERE id IN (SELECT id FROM agent_results WHERE basis_id IN (SELECT id FROM agent_bases WHERE repo_id = ?))";

            break;
          }

          case "agent_result_items": {
            selection =
              " WHERE result_id IN (SELECT id FROM agent_results WHERE basis_id IN (SELECT id FROM agent_bases WHERE repo_id = ?))";

            break;
          }

          case "agent_cursors": {
            selection =
              " WHERE json_extract(body, '$.basisId') IN (SELECT id FROM agent_bases WHERE repo_id = ?)";

            break;
          }

          case "agent_coverage_latest": {
            selection = " WHERE repo_id = ?";

            break;
          }

          case "agent_event_reads": {
            params.pop();

            break;
          }

          default: {
            break;
          }
        }
      }

      const quoted = table.replaceAll('"', '""');

      if (budget !== undefined) {
        const columns = db
          .prepare("SELECT name FROM pragma_table_info(?)")
          .all(table)
          .map((row) => decodeNameRow(row).name);

        const length = columns
          .map(
            (name) =>
              `COALESCE(length(CAST("${name.replaceAll('"', '""')}" AS BLOB)),0)`
          )
          .join(" + ");

        const totals = decodeBudgetRow(
          db
            .prepare(
              `SELECT COUNT(*) AS n, COALESCE(SUM(${length}),0) AS bytes FROM "${quoted}"${selection}`
            )
            .get(...params)
        );

        checkAdministrationBudget(budget, {
          bytes: totals.bytes,
          records: totals.n,
        });
      }

      return db
        .prepare(`SELECT * FROM "${quoted}"${selection}`)
        .all(...params)
        .map((row) => {
          const content = JSON.stringify(
            Object.entries(row).toSorted(([a], [b]) => a.localeCompare(b))
          );

          if (budget !== undefined) {
            const bytes = Buffer.byteLength(content);

            checkAdministrationBudget(budget, { bytes, records: 1 });
            budget.bytesRead += bytes;
            budget.recordsDecoded += 1;
          }

          const identity =
            table === "snapshot_events"
              ? JSON.stringify([row.snapshot_id, row.ordinal])
              : String(
                  row.event_id ??
                    row.snapshot_id ??
                    row.id ??
                    row.seq ??
                    digestText(content)
                );

          return [`${table}:${identity}`, content] as const;
        });
    })
    .toSorted(([a], [b]) => a.localeCompare(b));
};

const administrationState = (
  home: LiveHome,
  request: LiveAdministrationRequest,
  plan: RepoDataPlan | ResetPlan | null,
  restored: BackupInfo | null,
  existingDb?: DatabaseSync,
  budget?: AdministrationBudget
) => {
  const roots = [configPath(home)];

  if (request.kind === "delete" && plan !== null && "repo" in plan) {
    roots.push(
      ...repoSpoolDirs(home, plan.repo, budget),
      ...repoHookNotes(home, plan.repo, budget).map(({ file }) => file),
      commitSnapshotsPath(home)
    );
  } else if (request.kind === "reset" || request.kind === "restore") {
    roots.push(
      spoolRoot(home),
      hookSpoolRoot(home),
      commitSnapshotsPath(home),
      usageStateDir(home)
    );
  }

  if (restored !== null) {
    roots.push(
      restored.path,
      `${restored.path}-wal`,
      `${restored.path}-journal`,
      backupMetaPath(home, restored.id),
      backupFilesDir(home, restored.id)
    );
  }

  const files = [
    ...new Map(
      roots.flatMap((root) => strictFileState(home, root, budget))
    ).entries(),
  ].toSorted(([a], [b]) => a.localeCompare(b));

  const db =
    request.kind === "configure"
      ? null
      : (existingDb ??
        new DatabaseSync(home.storePath, { readOnly: true, timeout: 5000 }));

  try {
    const rows =
      db === null ? [] : administrationRows(db, request, plan, budget);

    const selectedRefs = [
      ...rows.map(([ref]) => ref),
      ...files.map(([file]) => `file:${file}`),
    ];

    if (selectedRefs.length > 500) {
      throw storeError(
        `This administration scope has ${selectedRefs.length} references; review at most 500 at a time.`
      );
    }

    return {
      configDigest: configurationContentDigest(home, budget),
      files,
      fingerprint: digestText(
        JSON.stringify({
          files,
          repo: plan !== null && "repo" in plan ? plan.repo : null,
          request,
          rows,
        })
      ),
      selectedRefs,
    };
  } finally {
    if (db !== null && existingDb === undefined) {
      db.close();
    }
  }
};

const staleAdministration = (backupIds: readonly string[] = []) =>
  new LiveActionError({
    backupIds,
    message:
      "The reviewed content or configuration changed. Create a new plan before applying it.",
    reason: "stale-plan",
  });

const assertAdministrationReview = (
  home: LiveHome,
  guard: AdministrationGuard | undefined,
  backupIds: readonly string[] = [],
  db?: DatabaseSync
): void => {
  if (guard === undefined) {
    return;
  }

  const reviewed = guard.preview;
  guard.budget.contents.clear();

  const current = administrationState(
    home,
    reviewed.request,
    reviewed.plan,
    reviewed.backup,
    db,
    guard.budget
  );

  if (current.fingerprint !== reviewed.fingerprint) {
    throw staleAdministration(backupIds);
  }
};

const assertReviewedFile = (
  home: LiveHome,
  guard: AdministrationGuard | undefined,
  target: string
): void => {
  if (guard === undefined) {
    return;
  }

  const expected = guard.preview.fileDigests.filter(
    ([file]) => file === target || file.startsWith(`${target}${path.sep}`)
  );

  guard.budget.contents.clear();

  const present = strictFileState(home, target, guard.budget).toSorted(
    ([a], [b]) => a.localeCompare(b)
  );

  if (JSON.stringify(expected) !== JSON.stringify(present)) {
    throw staleAdministration();
  }
};

const preserveBackupError = (
  error: LiveActionError,
  backupIds: readonly string[]
) =>
  new LiveActionError({
    backupIds,
    message: error.message,
    partialErrors: [error.message],
    reason: error.reason,
    resources: error.resources,
  });

export const deleteRepoData = (
  home: LiveHome,
  target: string,
  confirmation: string,
  guard?: AdministrationGuard
): Effect.Effect<DeleteRepoResult, LiveActionError> =>
  Effect.gen(function* deleteRepo() {
    yield* guardHome(home);

    const plan =
      guard?.preview.plan !== null &&
      guard?.preview.plan !== undefined &&
      "repo" in guard.preview.plan
        ? guard.preview.plan
        : yield* planDeleteRepoData(home, target);

    if (confirmation.trim() !== plan.confirmText) {
      return yield* confirmationError(plan.confirmText);
    }

    yield* fileStep("Could not revalidate the review", () => {
      assertAdministrationReview(home, guard);
    });

    return yield* Effect.gen(function* deleteAfterBackup() {
      const saved = yield* createBackup(
        home,
        "delete",
        plan.repo.root,
        plan.tracked ? [plan.repo.root] : [],
        guard?.budget
      );

      return yield* Effect.gen(function* deleteSavedScope() {
        const { commonDir } = plan.repo;

        yield* withAdminDb(home, "delete repo data", (db) => {
          inTransaction(db, () => {
            assertAdministrationReview(home, guard, [saved.id], db);
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
            tombstoneAgentScope(db, commonDir);
          });
        });

        yield* fileStep("Could not move hook notes into the backup", () => {
          for (const dir of plan.spoolDirs) {
            assertReviewedFile(home, guard, dir);
            moveInto(
              dir,
              path.join(
                backupFilesDir(home, saved.id),
                "spool",
                path.basename(dir)
              )
            );
          }

          const ofRepo = repoHookObservation(plan.repo);

          for (const file of plan.hookFiles) {
            assertReviewedFile(home, guard, file);
            const lines = linesOf(file);

            appendLines(
              hookBackupPath(home, saved.id, file),
              lines.filter((line) => ofRepo(line) !== null)
            );
            replaceLines(
              file,
              lines.filter((line) => ofRepo(line) === null)
            );
          }
        });

        yield* fileStep("Could not update snapshots.jsonl", () => {
          assertReviewedFile(home, guard, commitSnapshotsPath(home));
          const lines = readCommitSnapshotLines(home);
          const kept = lines.filter((line) => !isRepoLine(plan.repo)(line));

          if (kept.length !== lines.length) {
            const file = commitSnapshotsPath(home);
            const temp = `${file}.${process.pid}.tmp`;

            writePrivateFile(
              temp,
              kept.length === 0 ? "" : `${kept.join("\n")}\n`
            );
            renameSync(temp, file);
          }
        });

        if (plan.tracked) {
          yield* fileStep("Could not revalidate the configuration", () => {
            assertReviewedFile(home, guard, configPath(home));
          });

          yield* removeRepo(home, plan.repo.root);
        }

        return { backup: saved, plan };
      }).pipe(
        Effect.mapError((error) => preserveBackupError(error, [saved.id]))
      );
    }).pipe(Effect.uninterruptible);
  });

export const resetStore = (
  home: LiveHome,
  confirmation: string,
  guard?: AdministrationGuard
): Effect.Effect<ResetResult, LiveActionError> =>
  Effect.gen(function* reset() {
    yield* guardHome(home);

    const plan =
      guard?.preview.plan !== null &&
      guard?.preview.plan !== undefined &&
      !("repo" in guard.preview.plan)
        ? guard.preview.plan
        : yield* planResetStore(home);

    if (confirmation.trim() !== RESET_CONFIRM_TEXT) {
      return yield* confirmationError(RESET_CONFIRM_TEXT);
    }

    yield* fileStep("Could not revalidate the review", () => {
      assertAdministrationReview(home, guard);
    });

    return yield* Effect.gen(function* resetAfterBackup() {
      const saved = yield* createBackup(home, "reset", null, [], guard?.budget);

      return yield* Effect.gen(function* resetSavedScope() {
        yield* withAdminDb(home, "reset the store", (db) => {
          inTransaction(db, () => {
            assertAdministrationReview(home, guard, [saved.id], db);
            db.exec("DELETE FROM snapshot_events");
            db.exec("DELETE FROM snapshots");
            db.exec("DELETE FROM coverage");
            db.exec("DELETE FROM events");
            invalidateAgentState(
              db,
              "reset",
              guard === undefined
                ? {}
                : { preserveOperationId: guard.operationId }
            );
          });
        });

        yield* fileStep("Could not move files into the backup", () => {
          const files = backupFilesDir(home, saved.id);

          for (const entry of plan.spoolDirs) {
            assertReviewedFile(home, guard, entry);
            moveInto(entry, path.join(files, "spool", path.basename(entry)));
          }

          for (const file of plan.hookFiles) {
            assertReviewedFile(home, guard, file);
            moveInto(file, hookBackupPath(home, saved.id, file));
          }

          const snapshots = commitSnapshotsPath(home);

          assertReviewedFile(home, guard, snapshots);

          if (existsSync(snapshots)) {
            rmSync(snapshots, { force: true });
          }

          if (existsSync(usageStateDir(home))) {
            assertReviewedFile(home, guard, usageStateDir(home));
            moveInto(
              usageStateDir(home),
              path.join(files, path.basename(usageStateDir(home)))
            );
          }
        });

        return { backup: saved, plan };
      }).pipe(
        Effect.mapError((error) => preserveBackupError(error, [saved.id]))
      );
    }).pipe(Effect.uninterruptible);
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
          ensurePrivateDir(dir);

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
        copyPrivateFile(file, copy);
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
  id: string,
  guard?: AdministrationGuard
): Effect.Effect<RestoreResult, LiveActionError> =>
  Effect.gen(function* restore() {
    yield* guardHome(home);

    const restored =
      guard?.preview.backup ?? listBackups(home).find((info) => info.id === id);

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

    yield* fileStep("Could not revalidate the review", () => {
      assertAdministrationReview(home, guard);
    });

    return yield* Effect.gen(function* restoreAfterReview() {
      const source =
        version === STORE_SCHEMA_VERSION
          ? restored.path
          : yield* upgradedCopy(home, restored.path, id);

      const safety = yield* createBackup(
        home,
        "restore",
        null,
        [],
        guard?.budget
      );

      return yield* Effect.gen(function* restoreSavedScope() {
        yield* withAdminDb(home, "restore the backup", (db) => {
          db.prepare("ATTACH DATABASE ? AS restore_source").run(source);

          try {
            const available = new Set(userTables(db, "restore_source"));

            const recovery = new Set<string>([
              ...AGENT_RECOVERY_TABLES,
              "agent_operation_plans",
            ]);

            const tables = userTables(db, "main").filter(
              (name) =>
                available.has(name) &&
                name !== "store_meta" &&
                !recovery.has(name)
            );

            inTransaction(db, () => {
              assertAdministrationReview(home, guard, [safety.id], db);

              for (const table of tables) {
                db.exec(`DELETE FROM main."${table}"`);

                if (table !== "agent_source_associations") {
                  db.exec(
                    `INSERT INTO main."${table}" SELECT * FROM restore_source."${table}"`
                  );
                }
              }

              invalidateAgentState(
                db,
                "restore",
                guard === undefined
                  ? {}
                  : { preserveOperationId: guard.operationId }
              );
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
          const hooks = path.join(files, HOOK_SPOOL_ROOT);

          for (const target of [
            spoolRoot(home),
            hookSpoolRoot(home),
            commitSnapshotsPath(home),
            usageStateDir(home),
          ]) {
            assertReviewedFile(home, guard, target);
          }

          assertReviewedFile(home, guard, backupFilesDir(home, id));

          for (const kept of filesUnder(hooks)) {
            const target = path.join(
              hookSpoolRoot(home),
              path.relative(hooks, kept)
            );

            const present = new Set(linesOf(target));

            appendLines(
              target,
              linesOf(kept).filter((line) => !present.has(line))
            );
          }

          if (existsSync(spool)) {
            cpSync(spool, spoolRoot(home), {
              errorOnExist: false,
              force: false,
              recursive: true,
            });
          }

          if (existsSync(snapshots)) {
            copyPrivateFile(snapshots, commitSnapshotsPath(home));
          }

          if (existsSync(usage)) {
            cpSync(usage, usageStateDir(home), {
              force: true,
              recursive: true,
            });
          }
        });

        const retracked: string[] = [];

        yield* fileStep("Could not revalidate the configuration", () => {
          assertReviewedFile(home, guard, configPath(home));
        });

        for (const repo of restored.retrack) {
          const tracked = yield* Effect.option(addRepo(home, repo));

          if (Option.isSome(tracked)) {
            retracked.push(tracked.value.repo.root);
          }
        }

        return { restored, retracked, safety };
      }).pipe(
        Effect.mapError((error) => preserveBackupError(error, [safety.id]))
      );
    }).pipe(Effect.uninterruptible);
  }).pipe(Effect.scoped);

const administrationBackupArtifacts = (
  home: LiveHome,
  ids: readonly string[],
  budget?: AdministrationBudget
): LiveAdministrationResult["backupArtifacts"] =>
  ids.flatMap((id) => {
    if (!existsSync(backupDbPath(home, id))) {
      return [];
    }

    const dbFile = backupDbPath(home, id);

    const files = [
      dbFile,
      `${dbFile}-wal`,
      `${dbFile}-journal`,
      backupMetaPath(home, id),
      backupFilesDir(home, id),
    ]
      .flatMap((target) => strictFileState(home, target, budget))
      .map(([file, digest]) => [path.relative(backupsDir(home), file), digest]);

    const db = new DatabaseSync(dbFile, { readOnly: true });

    try {
      return [
        {
          contentDigest: digestText(JSON.stringify(files)),
          id,
          restorationVersion: schemaVersion(db, "main"),
        },
      ];
    } finally {
      db.close();
    }
  });

export const previewAdministration = (
  home: LiveHome,
  input: LiveAdministrationRequest,
  limits: LiveAdministrationLimits = {},
  existingBudget?: AdministrationBudget
): Effect.Effect<LiveAdministrationPreview, LiveActionError> =>
  Effect.suspend(() => {
    const budget = existingBudget ?? administrationBudget(limits);

    return Effect.gen(function* preview() {
      yield* guardHome(home);

      yield* fileStep("Could not bound administration input", () => {
        if (existsSync(configPath(home))) {
          readBoundedFile(configPath(home), budget);
        }

        if (input.kind !== "configure") {
          const dbStats = lstatSync(home.storePath);

          const walStats = lstatSync(`${home.storePath}-wal`, {
            throwIfNoEntry: false,
          });

          if (dbStats.isSymbolicLink() || walStats?.isSymbolicLink() === true) {
            throw storeError(
              "Reviewed administration cannot follow a linked SQLite store."
            );
          }

          budget.reservedBytes = dbStats.size + (walStats?.size ?? 0);
          checkAdministrationBudget(budget);
        }
      });

      const request: LiveAdministrationRequest =
        "target" in input
          ? { ...input, target: path.resolve(input.target) }
          : input;

      const config = yield* Effect.try({
        catch: (cause) =>
          cause instanceof LiveActionError
            ? cause
            : new LiveActionError({
                message: messageOf(cause),
                reason: "bad-config",
              }),
        try: () => readBoundedConfiguration(home, budget),
      });

      let plan: RepoDataPlan | ResetPlan | null = null;

      if (request.kind === "delete") {
        plan = yield* planDeleteRepoData(home, request.target, budget);
      } else if (request.kind === "reset") {
        plan = yield* planResetStore(home, budget);
      }

      const restored =
        request.kind === "restore"
          ? yield* Effect.try({
              catch: (cause) =>
                cause instanceof LiveActionError
                  ? cause
                  : storeError(messageOf(cause)),
              try: () => backupInfoFor(home, request.backupId, budget),
            })
          : null;

      if (
        request.kind === "restore" &&
        (!BACKUP_ID.test(request.backupId) || restored === null)
      ) {
        return yield* unknownBackup(request.backupId);
      }

      if (restored !== null) {
        const version = yield* backupVersion(restored.path);

        if (version < 1 || version > STORE_SCHEMA_VERSION) {
          return yield* new LiveActionError({
            message: `Backup ${restored.id} was made by a different dft version and cannot be restored here.`,
            reason: "backup-incompatible",
          });
        }
      }

      return yield* Effect.try({
        catch: (cause) =>
          cause instanceof LiveActionError
            ? cause
            : storeError(
                `Could not inspect the administration scope: ${messageOf(cause)}`
              ),
        try: () => {
          const current = administrationState(
            home,
            request,
            plan,
            restored,
            undefined,
            budget
          );

          const desired = desiredConfiguration(config, request);

          let resultConfigDigest: string | undefined;

          if (desired !== null) {
            const unchanged =
              request.kind === "configure" &&
              request.action !== "cursor-usage" &&
              JSON.stringify(desired) === JSON.stringify(config);

            resultConfigDigest = unchanged
              ? current.configDigest
              : configurationDigestOf(desired);
          }

          return {
            backup: restored,
            backupContentDigest:
              restored === null
                ? null
                : (administrationBackupArtifacts(home, [restored.id], budget)[0]
                    ?.contentDigest ?? null),
            configDigest: current.configDigest,
            configuration: config,
            confirmText: plan?.confirmText ?? null,
            fileDigests: current.files,
            fingerprint: current.fingerprint,
            plan,
            request,
            resources: administrationResources(budget),
            resultConfigDigest,
            selectedRefs: current.selectedRefs,
          };
        },
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) {
          return Effect.failCause(cause);
        }

        const error = Cause.squash(cause);

        const failure =
          error instanceof LiveActionError
            ? error
            : storeError(messageOf(error));

        return Effect.fail(
          new LiveActionError({
            backupIds: failure.backupIds,
            message: failure.message,
            partialErrors: failure.partialErrors,
            reason: failure.reason,
            resources: administrationResources(budget),
          })
        );
      })
    );
  });

const changedAdministrationFiles = (
  home: LiveHome,
  reviewed: LiveAdministrationPreview,
  budget?: AdministrationBudget
): readonly string[] => {
  const current = administrationState(
    home,
    reviewed.request,
    reviewed.plan,
    reviewed.backup,
    undefined,
    budget
  );

  const before = new Map(reviewed.fileDigests);
  const after = new Map(current.files);

  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .toSorted();
};

const administrationRemoval = (
  home: LiveHome,
  reviewed: LiveAdministrationPreview,
  budget?: AdministrationBudget
) => {
  if (reviewed.request.kind !== "delete" && reviewed.request.kind !== "reset") {
    return {
      removalReason: "This operation does not remove selected observations.",
      removedCount: null,
      removedRefs: [],
    };
  }

  const current = administrationState(
    home,
    reviewed.request,
    reviewed.plan,
    reviewed.backup,
    undefined,
    budget
  );

  const remaining = new Set(current.selectedRefs);
  const previousFiles = new Map(reviewed.fileDigests);

  const removedRefs = reviewed.selectedRefs.filter((ref) => {
    if (!ref.startsWith("file:")) {
      return !remaining.has(ref);
    }

    const file = ref.slice(5);

    return previousFiles.get(file) !== "missing" && !existsSync(file);
  });

  return { removalReason: null, removedCount: removedRefs.length, removedRefs };
};

export const applyReviewedAdministration = (
  home: LiveHome,
  request: LiveAdministrationRequest,
  fingerprint: string,
  confirmation: string,
  operationId: string,
  limits: LiveAdministrationLimits = {}
): Effect.Effect<LiveAdministrationResult, LiveActionError> =>
  Effect.suspend(() => {
    const budget = administrationBudget(limits);

    return Effect.gen(function* applyReviewed() {
      const reviewed = yield* previewAdministration(
        home,
        request,
        limits,
        budget
      );

      if (reviewed.fingerprint !== fingerprint) {
        return yield* staleAdministration();
      }

      if (
        reviewed.confirmText !== null &&
        confirmation !== reviewed.confirmText
      ) {
        return yield* confirmationError(reviewed.confirmText);
      }

      const guard: AdministrationGuard = {
        budget,
        limits,
        operationId,
        preview: reviewed,
      };

      return yield* Effect.gen(function* executeReviewed() {
        let result: LiveAdministrationResult["result"] = null;
        let backupIds: readonly string[] = [];

        switch (request.kind) {
          case "delete": {
            const deleted = yield* deleteRepoData(
              home,
              request.target,
              confirmation,
              guard
            );

            result = deleted;
            backupIds = [deleted.backup.id];
            break;
          }

          case "reset": {
            const reset = yield* resetStore(home, confirmation, guard);

            result = reset;
            backupIds = [reset.backup.id];
            break;
          }

          case "restore": {
            const restored = yield* restoreBackup(
              home,
              request.backupId,
              guard
            );

            result = restored;
            backupIds = [restored.safety.id];
            break;
          }

          case "configure": {
            yield* fileStep("Could not revalidate the configuration", () => {
              assertAdministrationReview(home, guard);
            });

            if (request.action === "cursor-usage") {
              result = yield* setCursorUsageImport(home, request.enabled);
            } else if (request.action === "add-repo") {
              result = yield* addRepo(home, request.target);
            } else {
              result = yield* removeRepo(home, request.target);
            }

            break;
          }

          default: {
            break;
          }
        }

        return yield* Effect.try({
          catch: (cause) =>
            preserveBackupError(storeError(messageOf(cause)), backupIds),
          try: () => {
            budget.contents.clear();

            return {
              backupArtifacts: administrationBackupArtifacts(
                home,
                backupIds,
                budget
              ),
              backupIds,
              configDigest: configurationContentDigest(home, budget),
              filesChanged: changedAdministrationFiles(home, reviewed, budget),
              kind: request.kind,
              partialErrors: [],
              ...administrationRemoval(home, reviewed, budget),
              resources: administrationResources(budget),
              result,
              verificationUnavailable: [],
            };
          },
        });
      }).pipe(
        Effect.catch((error) => {
          if (error.backupIds === undefined || error.backupIds.length === 0) {
            return Effect.fail(error);
          }

          return Effect.try({
            catch: (cause) =>
              preserveBackupError(
                storeError(
                  `Could not verify partial administration: ${messageOf(cause)}`
                ),
                error.backupIds ?? []
              ),
            try: (): LiveAdministrationResult => {
              budget.contents.clear();

              return {
                backupArtifacts: administrationBackupArtifacts(
                  home,
                  error.backupIds ?? [],
                  budget
                ),
                backupIds: error.backupIds ?? [],
                configDigest: configurationContentDigest(home, budget),
                filesChanged: changedAdministrationFiles(
                  home,
                  reviewed,
                  budget
                ),
                kind: request.kind,
                partialErrors: error.partialErrors ?? [error.message],
                ...administrationRemoval(home, reviewed, budget),
                resources: administrationResources(budget),
                result: null,
                verificationUnavailable: [],
              };
            },
          }).pipe(
            Effect.catch((verificationError) =>
              Effect.succeed<LiveAdministrationResult>({
                backupArtifacts: [],
                backupIds: error.backupIds ?? [],
                configDigest: null,
                filesChanged: [],
                kind: request.kind,
                partialErrors: [
                  ...(error.partialErrors ?? [error.message]),
                  verificationError.message,
                ],
                removalReason:
                  "Final removal state was not verified within the approved limits.",
                removedCount: null,
                removedRefs: [],
                resources: administrationResources(budget),
                result: null,
                verificationUnavailable: [
                  "backup-content-digests",
                  "configuration-content-digest",
                  "changed-files",
                  "removed-references",
                ],
              })
            )
          );
        }),
        Effect.uninterruptible
      );
    }).pipe(
      Effect.mapError(
        (failure) =>
          new LiveActionError({
            backupIds: failure.backupIds,
            message: failure.message,
            partialErrors: failure.partialErrors,
            reason: failure.reason,
            resources: administrationResources(budget),
          })
      )
    );
  });

export const probeReviewedAdministration = (
  home: LiveHome,
  reviewed: RetainedAdministrationReview,
  backupIds: readonly string[] = [],
  limits: LiveAdministrationLimits = {}
): Effect.Effect<LiveAdministrationProbe, LiveActionError> =>
  Effect.gen(function* probeReviewed() {
    const current = yield* previewAdministration(
      home,
      reviewed.request,
      limits
    );

    const artifacts = backupIds.filter(
      (id) => BACKUP_ID.test(id) && existsSync(backupDbPath(home, id))
    );

    const common = {
      backupIds: artifacts,
      configDigest: current.configDigest,
      filesChanged: [],
      resources: current.resources,
    };

    if (current.fingerprint === reviewed.fingerprint) {
      return {
        ...common,
        reason:
          "The reviewed state is still present; no completed administration effect is proven.",
        state: "absent" as const,
      };
    }

    if (
      reviewed.request.kind === "configure" &&
      reviewed.resultConfigDigest !== undefined &&
      current.configDigest === reviewed.resultConfigDigest
    ) {
      return {
        ...common,
        filesChanged: [configPath(home)],
        reason:
          "The retained intended configuration matches the current file contents.",
        state: "complete" as const,
      };
    }

    return {
      ...common,
      reason:
        "State differs from the review. A prior receipt or explicit artifact verification is required before retrying.",
      state: "indeterminate" as const,
    };
  });
