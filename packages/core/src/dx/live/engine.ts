// @effect-diagnostics nodeBuiltinImport:off -- The live engine watches git and hook spool folders, reads the store with its own SQLite connection and listens for process signals at the process boundary.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  FileSystem,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { runCollect } from "../cli/commands/collect.js";
import {
  HOOK_SPOOL_FOLDER,
  latestSpoolRecord,
} from "../collectors/cursor-hooks/spool.js";
import type { EventStoreService } from "../contracts/services.js";
import { emptyFlightContext } from "../model/event.js";
import type { FlightContext } from "../model/event.js";
import { allCollectors } from "../registry/registry.js";
import type {
  DxCollectorServices,
  RegisteredCollector,
} from "../registry/registry.js";
import {
  contextForRepo,
  repoWorktrees,
  worktreeSpoolId,
} from "../registry/runtime.js";
import { planSources, unavailableSteps } from "../registry/sync.js";
import type { SyncStep } from "../registry/sync.js";
import { openSqliteEventStore } from "../storage/sqlite-event-store.js";
import {
  addRepo as addRepoToConfig,
  readLiveConfig,
  removeRepo as removeRepoFromConfig,
  resolveGitRepo,
  setCursorUsageImport as saveCursorUsageImport,
} from "./config.js";
import type {
  GitRepo,
  LiveConfig,
  TrackResult,
  UntrackResult,
} from "./config.js";
import { liveHome, LiveActionError, spoolRoot } from "./home.js";
import type { LiveHome } from "./home.js";
import {
  deleteRepoData as deleteRepoDataIn,
  listBackups as listBackupsIn,
  planDeleteRepoData as planDeleteRepoDataIn,
  planResetStore as planResetStoreIn,
  resetStore as resetStoreIn,
  restoreBackup as restoreBackupIn,
} from "./store-admin.js";
import type {
  BackupInfo,
  DeleteRepoResult,
  RepoDataPlan,
  ResetPlan,
  ResetResult,
  RestoreResult,
} from "./store-admin.js";

export const USAGE_SOURCE = "collector.cursor-usage-api" as const;

export const USAGE_INPUT =
  "https://cursor.com/api/dashboard/get-filtered-usage-events" as const;

export const LIVE_DEFAULTS = {
  debounceMs: 500,
  maxBackoffMs: 60 * 60 * 1000,
  pollMs: 60 * 1000,
  scanMs: 2000,
  usageIntervalMs: 5 * 60 * 1000,
} as const;

export type LiveSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGUSR2";

export interface LiveEngineOptions {
  readonly collectors?: readonly RegisteredCollector[];
  readonly debounceMs?: number;
  readonly dftHome: string;
  readonly home: string;
  readonly maxBackoffMs?: number;
  readonly pollMs?: number;
  readonly scanMs?: number;
  readonly signals?: readonly LiveSignal[];
  readonly storePath?: string | null;
  readonly usageIntervalMs?: number;
}

export type LiveChangeReason =
  | "config"
  | "delete"
  | "reset"
  | "restore"
  | "sync"
  | "usage";

export interface LiveChange {
  readonly at: string;
  readonly branches: readonly (string | null)[];
  readonly inserted: number;
  readonly reason: LiveChangeReason;
  readonly repo: string | null;
}

export interface LiveRepoStatus {
  readonly lastError: string | null;
  readonly lastInserted: number | null;
  readonly lastSyncAt: string | null;
  readonly name: string;
  readonly repo: string;
  readonly sources: readonly SyncStep[];
  readonly syncing: boolean;
  readonly syncs: number;
}

export interface LiveUsageStatus {
  readonly enabled: boolean;
  readonly failures: number;
  readonly lastError: string | null;
  readonly lastInserted: number | null;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
  readonly runs: number;
}

export interface LiveStatus {
  readonly repos: readonly LiveRepoStatus[];
  readonly running: boolean;
  readonly usage: LiveUsageStatus;
}

export type LiveListener = (change: LiveChange) => void;

export interface LiveEngine {
  readonly addRepo: (
    target: string
  ) => Effect.Effect<TrackResult, LiveActionError>;
  readonly config: Effect.Effect<LiveConfig>;
  readonly deleteRepoData: (
    target: string,
    confirmation: string
  ) => Effect.Effect<DeleteRepoResult, LiveActionError>;
  readonly home: LiveHome;
  readonly listBackups: Effect.Effect<readonly BackupInfo[]>;
  readonly planDeleteRepoData: (
    target: string
  ) => Effect.Effect<RepoDataPlan, LiveActionError>;
  readonly planResetStore: Effect.Effect<ResetPlan, LiveActionError>;
  readonly ready: Effect.Effect<void>;
  readonly removeRepo: (
    target: string
  ) => Effect.Effect<UntrackResult, LiveActionError>;
  readonly resetStore: (
    confirmation: string
  ) => Effect.Effect<ResetResult, LiveActionError>;
  readonly restoreBackup: (
    id: string
  ) => Effect.Effect<RestoreResult, LiveActionError>;
  readonly setCursorUsageImport: (
    enabled: boolean
  ) => Effect.Effect<LiveConfig, LiveActionError>;
  readonly status: Effect.Effect<LiveStatus>;
  readonly stop: Effect.Effect<void>;
  readonly stopped: Effect.Effect<void>;
  readonly subscribe: (listener: LiveListener) => () => void;
}

interface RunState {
  pending: boolean;
  running: boolean;
  waiters: Deferred.Deferred<boolean>[];
}

interface RepoState {
  lastError: string | null;
  lastInserted: number | null;
  lastSyncAt: string | null;
  readonly repo: GitRepo;
  sources: readonly SyncStep[];
  syncing: boolean;
  syncs: number;
  watchingWorktrees: boolean;
}

interface UsageState {
  failures: number;
  lastError: string | null;
  lastInserted: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runs: number;
}

const decodeSeqRow = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Int }));

const decodeBranchRow = Schema.decodeUnknownSync(
  Schema.Struct({ branch: Schema.NullOr(Schema.String), n: Schema.Int })
);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const isoIn = (ms: number) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      DateTime.formatIso(DateTime.add(now, { milliseconds: ms }))
    )
  );

const causeText = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);

  return error instanceof Error ? error.message : String(error);
};

const passSignalOn = (signal: LiveSignal) =>
  Effect.sync(() => {
    if (process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
    }
  });

const stopOnSignal =
  (stop: Effect.Effect<void>, signal: LiveSignal) => (): void => {
    Effect.runFork(stop.pipe(Effect.andThen(passSignalOn(signal))));
  };

const makeCoalescer = (
  scope: Scope.Scope,
  work: (key: string) => Effect.Effect<void>
) => {
  const states = new Map<string, RunState>();

  const drain = (key: string, state: RunState): Effect.Effect<void> =>
    Effect.gen(function* drainRuns() {
      const batch = yield* Effect.sync(() => {
        const waiting = state.waiters;

        state.waiters = [];
        state.pending = false;

        return waiting;
      });

      yield* work(key);

      for (const waiter of batch) {
        yield* Deferred.succeed(waiter, true);
      }

      const again = yield* Effect.sync(() => {
        if (state.pending) {
          return true;
        }

        state.running = false;

        return false;
      });

      if (again) {
        yield* drain(key, state);
      }
    });

  const request = (key: string): Effect.Effect<Deferred.Deferred<boolean>> =>
    Effect.uninterruptible(
      Effect.gen(function* requestRun() {
        const done = yield* Deferred.make<boolean>();

        const start = yield* Effect.sync(() => {
          const state = states.get(key) ?? {
            pending: false,
            running: false,
            waiters: [],
          };

          states.set(key, state);
          state.waiters.push(done);

          if (state.running) {
            state.pending = true;

            return null;
          }

          state.running = true;

          return state;
        });

        if (start !== null) {
          yield* Effect.forkIn(
            drain(key, start).pipe(
              Effect.onExit(() =>
                Effect.sync(() => {
                  start.running = false;
                })
              )
            ),
            scope
          );
        }

        return done;
      })
    );

  return { request };
};

const gitNameMatches =
  (names: ReadonlySet<string>) =>
  (file: string): boolean =>
    names.has(path.basename(file));

const notLock = (file: string): boolean => !file.endsWith(".lock");

const listDir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

interface Fingerprint {
  count: number;
  mtime: number;
  size: number;
}

const addFiles = (
  totals: Fingerprint,
  target: string,
  accept: (file: string) => boolean
): void => {
  const info = statSync(target, { throwIfNoEntry: false });

  if (info === undefined) {
    return;
  }

  if (info.isDirectory()) {
    for (const entry of listDir(target)) {
      addFiles(totals, path.join(target, entry.name), accept);
    }

    return;
  }

  if (accept(target)) {
    totals.count += 1;
    totals.mtime += info.mtimeMs;
    totals.size += info.size;
  }
};

const fingerprint = (
  targets: readonly (readonly [string, (file: string) => boolean])[]
): string => {
  const totals: Fingerprint = { count: 0, mtime: 0, size: 0 };

  for (const [target, accept] of targets) {
    addFiles(totals, target, accept);
  }

  return `${totals.count}:${totals.mtime}:${totals.size}`;
};

const everyFile = (): boolean => true;

const gitFingerprint = (repo: GitRepo): string =>
  fingerprint([
    [path.join(repo.commonDir, "HEAD"), everyFile],
    [path.join(repo.commonDir, "packed-refs"), everyFile],
    [path.join(repo.commonDir, "refs"), notLock],
    [path.join(repo.commonDir, "logs"), notLock],
    [
      path.join(repo.commonDir, "worktrees"),
      (file) => notLock(file) && path.basename(file) === "HEAD",
    ],
  ]);

export const startLiveEngine = (
  options: LiveEngineOptions
): Effect.Effect<
  LiveEngine,
  LiveActionError,
  Scope.Scope | DxCollectorServices
> =>
  Effect.gen(function* start() {
    const home = liveHome(options.dftHome, options.storePath ?? null);
    const collectors = options.collectors ?? allCollectors;
    const debounceMs = options.debounceMs ?? LIVE_DEFAULTS.debounceMs;
    const pollMs = options.pollMs ?? LIVE_DEFAULTS.pollMs;
    const scanMs = options.scanMs ?? LIVE_DEFAULTS.scanMs;

    const usageIntervalMs =
      options.usageIntervalMs ?? LIVE_DEFAULTS.usageIntervalMs;

    const maxBackoffMs = options.maxBackoffMs ?? LIVE_DEFAULTS.maxBackoffMs;
    const parent = yield* Scope.Scope;
    const scope = yield* Scope.fork(parent);
    const stoppedSignal = yield* Deferred.make<boolean>();
    const readySignal = yield* Deferred.make<boolean>();
    const fs = yield* FileSystem.FileSystem;

    yield* Scope.addFinalizer(scope, Deferred.succeed(stoppedSignal, true));

    const inScope = Scope.provide(scope);

    const store: EventStoreService = yield* inScope(
      Effect.acquireRelease(
        openSqliteEventStore({ kind: "live", path: home.storePath }).pipe(
          Effect.mapError(
            (error) =>
              new LiveActionError({
                message: `Could not open the store: ${error.message}`,
                reason: "store",
              })
          )
        ),
        (opened) =>
          Effect.sync(() => {
            opened.close();
          })
      )
    ).pipe(Effect.map((opened) => opened.service));

    const reader = yield* inScope(
      Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(home.storePath, { timeout: 5000 })),
        (db) =>
          Effect.sync(() => {
            db.close();
          })
      )
    );

    let config = yield* readLiveConfig(home);

    const lock = yield* Semaphore.make(1);
    const listeners = new Set<LiveListener>();
    const repos = new Map<string, RepoState>();
    const spoolIndex = new Map<string, string>();
    const watchers = yield* inScope(FiberMap.make<string>());
    const debouncers = yield* inScope(FiberMap.make<string>());

    const usage: UsageState = {
      failures: 0,
      lastError: null,
      lastInserted: null,
      lastRunAt: null,
      nextRunAt: null,
      runs: 0,
    };

    let running = true;

    const exclusive = Semaphore.withPermits(lock, 1);
    const configLock = yield* Semaphore.make(1);
    const configExclusive = Semaphore.withPermits(configLock, 1);

    const emit = (change: LiveChange) =>
      Effect.sync(() => {
        for (const listener of listeners) {
          try {
            listener(change);
          } catch {
            listeners.delete(listener);
          }
        }
      });

    const change = (
      reason: LiveChangeReason,
      repo: string | null,
      branches: readonly (string | null)[],
      inserted: number
    ) =>
      nowIso.pipe(
        Effect.flatMap((at) => emit({ at, branches, inserted, reason, repo }))
      );

    const maxSeq = (): number =>
      decodeSeqRow(
        reader.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get()
      ).n;

    const branchesSince = (before: number, commonDir: string) =>
      reader
        .prepare(
          "SELECT branch, COUNT(*) AS n FROM events WHERE seq > ? AND repo_common_dir = ? GROUP BY branch ORDER BY branch"
        )
        .all(before, commonDir)
        .map((row) => decodeBranchRow(row));

    const indexSpool = (state: RepoState) => {
      for (const worktree of repoWorktrees(state.repo.root)) {
        spoolIndex.set(worktreeSpoolId(worktree), state.repo.root);
      }
    };

    const collectStep = (
      context: FlightContext,
      source: string,
      input: string
    ): Effect.Effect<SyncStep, never, DxCollectorServices> =>
      runCollect({ store, storePath: home.storePath }, collectors, {
        context,
        input,
        source,
      }).pipe(
        Effect.map((result): SyncStep => ({
          duplicates: result.duplicates,
          input,
          inserted: result.inserted,
          reason: null,
          source,
          status: "synced",
        })),
        Effect.catchCause((cause) =>
          Effect.succeed<SyncStep>({
            duplicates: null,
            input,
            inserted: null,
            reason: causeText(cause),
            source,
            status: "unavailable",
          })
        )
      );

    const syncRepoWork = (root: string) =>
      Effect.gen(function* syncRepo() {
        const state = repos.get(root);

        if (state === undefined || !running) {
          return;
        }

        if (resolveGitRepo(root) === null) {
          state.lastError = `${root} is not a git repo right now.`;

          return;
        }

        state.syncing = true;

        const before = maxSeq();
        const context = contextForRepo(root);

        const plan = planSources(
          context,
          {
            cwd: root,
            dftHome: home.dftHome,
            home: options.home,
            repo: root,
            storePath: home.storePath,
          },
          repoWorktrees(root)
        ).filter((step) => step.source !== USAGE_SOURCE);

        const steps: SyncStep[] = [];

        for (const step of plan) {
          steps.push(yield* collectStep(step.context, step.source, step.input));
        }

        const rows = branchesSince(before, state.repo.commonDir);
        const inserted = rows.reduce((sum, row) => sum + row.n, 0);

        state.lastInserted = inserted;
        state.lastSyncAt = yield* nowIso;
        state.lastError = null;
        state.sources = [...steps, ...unavailableSteps(context, options.home)];
        state.syncs += 1;
        indexSpool(state);

        if (inserted > 0) {
          yield* change(
            "sync",
            root,
            rows.map((row) => row.branch),
            inserted
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const state = repos.get(root);

            if (state !== undefined) {
              state.lastError = causeText(cause);
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            const state = repos.get(root);

            if (state !== undefined) {
              state.syncing = false;
            }
          })
        ),
        exclusive
      );

    const usageWork = exclusive(
      Effect.gen(function* syncUsage() {
        if (!config.cursorUsageImport || !running) {
          return;
        }

        const step = yield* collectStep(
          emptyFlightContext,
          USAGE_SOURCE,
          USAGE_INPUT
        );

        usage.runs += 1;
        usage.lastRunAt = yield* nowIso;

        if (step.status === "synced") {
          usage.failures = 0;
          usage.lastError = null;
          usage.lastInserted = step.inserted;

          if ((step.inserted ?? 0) > 0) {
            yield* change("usage", null, [], step.inserted ?? 0);
          }
        } else {
          usage.failures += 1;
          usage.lastError = step.reason;
        }
      })
    );

    const services = yield* Effect.context<DxCollectorServices>();
    const withServices = Effect.provide(services);

    const repoRuns = makeCoalescer(scope, (root) =>
      withServices(syncRepoWork(root))
    );

    const usageRuns = makeCoalescer(scope, () => withServices(usageWork));

    const trigger = (root: string) =>
      FiberMap.run(
        debouncers,
        root,
        Effect.sleep(debounceMs).pipe(
          Effect.andThen(repoRuns.request(root)),
          Effect.asVoid
        )
      ).pipe(Effect.asVoid);

    const watchDir = (
      dir: string,
      recursive: boolean,
      accept: (file: string) => boolean,
      onHit: Effect.Effect<void>
    ) =>
      fs.watch(dir, { recursive }).pipe(
        Stream.filter((event) => accept(event.path)),
        Stream.runForEach(() => onHit),
        Effect.ignore
      );

    const watchRepo = (state: RepoState) => {
      const { commonDir, root } = state.repo;
      const worktreesDir = path.join(commonDir, "worktrees");
      const hit = trigger(root);

      state.watchingWorktrees = existsSync(worktreesDir);

      return Effect.all(
        [
          watchDir(
            commonDir,
            false,
            gitNameMatches(new Set(["HEAD", "packed-refs", "worktrees"])),
            hit
          ),
          watchDir(path.join(commonDir, "refs"), true, notLock, hit),
          watchDir(path.join(commonDir, "logs"), true, notLock, hit),
          ...(state.watchingWorktrees
            ? [
                watchDir(
                  worktreesDir,
                  true,
                  (file) => notLock(file) && path.basename(file) === "HEAD",
                  hit
                ),
              ]
            : []),
        ],
        { concurrency: "unbounded", discard: true }
      );
    };

    const startWatching = (state: RepoState) =>
      FiberMap.run(watchers, state.repo.root, watchRepo(state)).pipe(
        Effect.asVoid
      );

    const repoForSpool = (id: string): string | null => {
      const known = spoolIndex.get(id);

      if (known !== undefined) {
        return known;
      }

      const commonDir = latestSpoolRecord(
        path.join(spoolRoot(home), id, HOOK_SPOOL_FOLDER)
      )?.git.repoCommonDir;

      const owner = [...repos.values()].find(
        (state) => state.repo.commonDir === commonDir
      );

      if (owner === undefined) {
        return null;
      }

      spoolIndex.set(id, owner.repo.root);

      return owner.repo.root;
    };

    const onSpoolEvent = (file: string) =>
      Effect.suspend(() => {
        const [id, ...rest] = file.split(path.sep);

        const root =
          rest.length === 0 || id === undefined ? null : repoForSpool(id);

        return root === null ? Effect.void : trigger(root);
      });

    const scanned = new Map<string, string>();

    const changedSinceScan = (key: string, next: string): boolean => {
      const known = scanned.get(key);

      scanned.set(key, next);

      return known !== next;
    };

    const scanChanges = Effect.sync(() => {
      const hits = new Set<string>();

      for (const state of repos.values()) {
        if (
          changedSinceScan(`git:${state.repo.root}`, gitFingerprint(state.repo))
        ) {
          hits.add(state.repo.root);
        }
      }

      const ids = listDir(spoolRoot(home))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

      const live = new Set(ids.map((id) => `spool:${id}`));

      for (const key of scanned.keys()) {
        if (key.startsWith("spool:") && !live.has(key)) {
          scanned.delete(key);
        }
      }

      for (const id of ids) {
        const next = fingerprint([[path.join(spoolRoot(home), id), everyFile]]);

        if (changedSinceScan(`spool:${id}`, next)) {
          const root = repoForSpool(id);

          if (root !== null) {
            hits.add(root);
          }
        }
      }

      return hits;
    });

    const track = (repo: GitRepo) =>
      Effect.gen(function* trackRepo() {
        if (repos.has(repo.root)) {
          return;
        }

        const state: RepoState = {
          lastError: null,
          lastInserted: null,
          lastSyncAt: null,
          repo,
          sources: [],
          syncing: false,
          syncs: 0,
          watchingWorktrees: false,
        };

        repos.set(repo.root, state);
        indexSpool(state);
        yield* startWatching(state);
      });

    const untrack = (root: string) =>
      Effect.gen(function* untrackRepo() {
        repos.delete(root);

        for (const [id, owner] of spoolIndex) {
          if (owner === root) {
            spoolIndex.delete(id);
          }
        }

        scanned.delete(`git:${root}`);
        yield* FiberMap.remove(watchers, root);
        yield* FiberMap.remove(debouncers, root);
      });

    const trackConfigured = Effect.gen(function* trackConfiguredRepos() {
      for (const entry of config.repos) {
        const repo = resolveGitRepo(entry);

        if (repo === null) {
          repos.set(path.resolve(entry), {
            lastError: `${entry} is not a git repo right now.`,
            lastInserted: null,
            lastSyncAt: null,
            repo: {
              commonDir: path.join(path.resolve(entry), ".git"),
              name: path.basename(entry),
              root: path.resolve(entry),
            },
            sources: [],
            syncing: false,
            syncs: 0,
            watchingWorktrees: false,
          });
        } else {
          yield* track(repo);
        }
      }
    });

    yield* trackConfigured;

    yield* fs
      .makeDirectory(spoolRoot(home), { recursive: true })
      .pipe(Effect.ignore);

    yield* Effect.forkIn(
      fs.watch(spoolRoot(home), { recursive: true }).pipe(
        Stream.runForEach((event) => onSpoolEvent(event.path)),
        Effect.ignore
      ),
      scope
    );

    const afterSyncCheck = Effect.gen(function* rewatch() {
      for (const state of repos.values()) {
        const hasWorktrees = existsSync(
          path.join(state.repo.commonDir, "worktrees")
        );

        if (hasWorktrees !== state.watchingWorktrees) {
          yield* startWatching(state);
        }
      }
    });

    const syncAll = Effect.gen(function* syncEveryRepo() {
      const pending: Deferred.Deferred<boolean>[] = [];

      for (const root of repos.keys()) {
        pending.push(yield* repoRuns.request(root));
      }

      for (const done of pending) {
        yield* Deferred.await(done);
      }

      yield* afterSyncCheck;
    });

    yield* scanChanges;

    yield* Effect.forkIn(
      syncAll.pipe(Effect.andThen(Deferred.succeed(readySignal, true))),
      scope
    );

    yield* Effect.forkIn(
      Effect.sleep(scanMs).pipe(
        Effect.andThen(scanChanges),
        Effect.flatMap((hits) =>
          running
            ? Effect.forEach(hits, trigger, { discard: true })
            : Effect.void
        ),
        Effect.catchCause(() => Effect.void),
        Effect.forever
      ),
      scope
    );

    yield* Effect.forkIn(
      Effect.sleep(pollMs).pipe(Effect.andThen(syncAll), Effect.forever),
      scope
    );

    const usageDelay = (): number =>
      usage.failures === 0
        ? usageIntervalMs
        : Math.min(usageIntervalMs * 2 ** usage.failures, maxBackoffMs);

    yield* Effect.forkIn(
      Effect.gen(function* usageLoop() {
        const done = yield* usageRuns.request("usage");

        yield* Deferred.await(done);

        const delay = usageDelay();

        usage.nextRunAt = yield* isoIn(delay);
        yield* Effect.sleep(delay);
      }).pipe(Effect.forever),
      scope
    );

    const stop = Scope.close(scope, Exit.void);

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        running = false;
      })
    );

    const handlers = (options.signals ?? ["SIGINT", "SIGTERM"]).map(
      (signal) => [signal, stopOnSignal(stop, signal)] as const
    );

    yield* inScope(
      Effect.acquireRelease(
        Effect.sync(() => {
          for (const [signal, handler] of handlers) {
            process.once(signal, handler);
          }
        }),
        () =>
          Effect.sync(() => {
            for (const [signal, handler] of handlers) {
              process.off(signal, handler);
            }
          })
      )
    );

    const withLock = <A>(
      effect: Effect.Effect<A, LiveActionError>
    ): Effect.Effect<A, LiveActionError> => exclusive(configExclusive(effect));

    const refreshConfig = Effect.gen(function* refresh() {
      config = yield* readLiveConfig(home);
    });

    const engine: LiveEngine = {
      addRepo: (target) =>
        configExclusive(
          Effect.gen(function* addTracked() {
            const result = yield* addRepoToConfig(home, target);

            ({ config } = result);
            yield* track(result.repo);
            yield* repoRuns.request(result.repo.root);

            if (result.added) {
              yield* change("config", result.repo.root, [], 0);
            }

            return result;
          })
        ),
      config: Effect.sync(() => config),
      deleteRepoData: (target, confirmation) =>
        withLock(
          Effect.gen(function* deleteTracked() {
            const result = yield* deleteRepoDataIn(home, target, confirmation);

            yield* untrack(result.plan.repo.root);
            yield* refreshConfig;
            yield* change(
              "delete",
              result.plan.repo.root,
              result.plan.branches.map((row) => row.branch),
              0
            );

            return result;
          })
        ),
      home,
      listBackups: Effect.sync(() => listBackupsIn(home)),
      planDeleteRepoData: (target) =>
        withLock(planDeleteRepoDataIn(home, target)),
      planResetStore: withLock(planResetStoreIn(home)),
      ready: Effect.asVoid(
        Effect.raceFirst(
          Deferred.await(readySignal),
          Deferred.await(stoppedSignal)
        )
      ),
      removeRepo: (target) =>
        configExclusive(
          Effect.gen(function* removeTracked() {
            const result = yield* removeRepoFromConfig(home, target);

            ({ config } = result);

            for (const root of result.removed) {
              yield* untrack(path.resolve(root));
            }

            if (result.removed.length > 0) {
              yield* change("config", result.removed[0] ?? null, [], 0);
            }

            return result;
          })
        ),
      resetStore: (confirmation) =>
        withLock(
          Effect.gen(function* resetAll() {
            const result = yield* resetStoreIn(home, confirmation);

            yield* change("reset", null, [], 0);

            return result;
          })
        ),
      restoreBackup: (id) =>
        withLock(
          Effect.gen(function* restoreAll() {
            const result = yield* restoreBackupIn(home, id);

            yield* refreshConfig;

            for (const root of result.retracked) {
              const repo = resolveGitRepo(root);

              if (repo !== null) {
                yield* track(repo);
              }
            }

            yield* change("restore", null, [], 0);

            return result;
          })
        ).pipe(
          Effect.tap((result) =>
            Effect.forEach(result.retracked, repoRuns.request, {
              discard: true,
            })
          )
        ),
      setCursorUsageImport: (enabled) =>
        configExclusive(
          Effect.gen(function* setUsage() {
            config = yield* saveCursorUsageImport(home, enabled);

            if (enabled) {
              yield* usageRuns.request("usage");
            }

            yield* change("config", null, [], 0);

            return config;
          })
        ),
      status: Effect.sync(() => ({
        repos: [...repos.values()].map((state): LiveRepoStatus => ({
          lastError: state.lastError,
          lastInserted: state.lastInserted,
          lastSyncAt: state.lastSyncAt,
          name: state.repo.name,
          repo: state.repo.root,
          sources: state.sources,
          syncing: state.syncing,
          syncs: state.syncs,
        })),
        running,
        usage: { ...usage, enabled: config.cursorUsageImport },
      })),
      stop,
      stopped: Effect.asVoid(Deferred.await(stoppedSignal)),
      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
    };

    return engine;
  });
