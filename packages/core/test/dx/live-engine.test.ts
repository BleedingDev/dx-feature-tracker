// @effect-diagnostics nodeBuiltinImport:off -- The live engine test scripts throwaway git repositories, a DFT_HOME and a SQLite store in an owned scratch directory.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import { cursorUsageApiDescriptor } from "../../src/dx/collectors/cursor-usage-api/descriptor.js";
import { SourceUnavailable } from "../../src/dx/contracts/error-source-unavailable.js";
import { HOOK_DECODERS } from "../../src/dx/harness/hook-decoders.js";
import { hookSpoolFile, recordHook } from "../../src/dx/harness/hook-spool.js";
import {
  addRepo,
  liveHome,
  readLiveConfig,
  setCursorUsageImport,
  startLiveEngine,
  USAGE_SOURCE,
} from "../../src/dx/live/index.js";
import type { LiveChange, LiveEngineOptions } from "../../src/dx/live/index.js";
import { allCollectors } from "../../src/dx/registry/registry.js";
import type { RegisteredCollector } from "../../src/dx/registry/registry.js";
import {
  hookSpoolDirFor,
  runCursorHook,
} from "../../src/dx/registry/runtime.js";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-live-"))
);

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const dftHome = path.join(scratch, "dft-home");

const home = liveHome(dftHome);

const makeRepo = (name: string): string => {
  const repo = path.join(scratch, name);

  const git = (...args: readonly string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  fs.writeFileSync(path.join(repo, "a.txt"), `${name}\n`);
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "init");

  return repo;
};

const app = makeRepo("app");

const other = makeRepo("other");

const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Int }));

const eventsFor = (repo: string, storePath = home.storePath): number => {
  const db = new DatabaseSync(storePath, { readOnly: true });

  try {
    return decodeCount(
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE repo_common_dir = ?")
        .get(path.join(repo, ".git"))
    ).n;
  } finally {
    db.close();
  }
};

const hook = (generation: string, selectedDftHome = dftHome) =>
  runCursorHook(
    JSON.stringify({
      conversation_id: "conv-live",
      generation_id: generation,
      hook_event_name: "postToolUse",
      tool_name: "Shell",
      workspace_roots: [app],
    }),
    app,
    DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-30T12:00:00.000Z")),
    selectedDftHome
  );

const HOOK_DAY = "2026-09-30T13:00:00.000Z";

const claudeHookDay = hookSpoolFile(dftHome, "claude-code", HOOK_DAY);

const claudeHook = (repo: string, selectedDftHome = dftHome) =>
  recordHook({
    cwd: repo,
    decoder: HOOK_DECODERS["claude-code"],
    dftHome: selectedDftHome,
    event: "UserPromptSubmit",
    now: DateTime.toDateUtc(DateTime.makeUnsafe(HOOK_DAY)),
    resolveGit: () => ({
      branch: "main",
      headSha: null,
      repoCommonDir: path.join(repo, ".git"),
      worktreePath: repo,
    }),
    stdinText: JSON.stringify({
      cwd: repo,
      session_id: `s-${path.basename(repo)}`,
    }),
    tool: "claude-code",
  });

const hookLinesOf = (file: string): readonly string[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
    : [];

const eventuallyEffect = (check: Effect.Effect<boolean>, limitMs: number) =>
  Effect.gen(function* poll() {
    for (let waited = 0; waited < limitMs; waited += 25) {
      if (yield* check) {
        return true;
      }

      yield* Effect.sleep(25);
    }

    return yield* check;
  });

const eventually = (check: () => boolean, limitMs: number) =>
  eventuallyEffect(Effect.sync(check), limitMs);

const options: LiveEngineOptions = {
  collectors: allCollectors,
  dftHome,
  home: scratch,
  signals: [],
};

const withEngine = <A, E>(
  body: (
    engine: Effect.Success<ReturnType<typeof startLiveEngine>>,
    changes: LiveChange[]
  ) => Effect.Effect<A, E>,
  extra: Partial<LiveEngineOptions> = {}
) =>
  Effect.scoped(
    Effect.gen(function* run() {
      const engine = yield* startLiveEngine({ ...options, ...extra });
      const changes: LiveChange[] = [];

      engine.subscribe((change) => {
        changes.push(change);
      });
      yield* engine.ready;

      return yield* body(engine, changes);
    })
  ).pipe(Effect.provide(NodeServices.layer));

describe("live engine", () => {
  it.live(
    "tracks repos in DFT_HOME/config.json and refuses a folder that is not a git repo",
    () =>
      Effect.gen(function* track() {
        yield* setCursorUsageImport(home, false);

        const first = yield* addRepo(home, app);
        const again = yield* addRepo(home, path.join(app, "."));

        yield* addRepo(home, other);

        const notRepo = yield* Effect.flip(addRepo(home, scratch));
        const config = yield* readLiveConfig(home);

        expect(first.added).toBe(true);
        expect(again.added).toBe(false);
        expect(notRepo.reason).toBe("not-a-repo");
        expect(config).toEqual({
          cursorUsageImport: false,
          repos: [app, other],
        });
      })
  );

  it.live("a hook note triggers a sync and a change event within seconds", () =>
    withEngine((engine, changes) =>
      Effect.gen(function* hookSync() {
        expect(eventsFor(app)).toBeGreaterThan(0);
        expect(eventsFor(other)).toBeGreaterThan(0);

        changes.length = 0;

        const started = yield* DateTime.now;

        expect(hook("gen-1").outcome.state).toBe("spooled");

        const seen = yield* eventually(
          () => changes.some((change) => change.repo === app),
          10_000
        );

        const elapsed =
          DateTime.toEpochMillis(yield* DateTime.now) -
          DateTime.toEpochMillis(started);

        expect(seen).toBe(true);
        expect(elapsed).toBeLessThan(10_000);
        expect(changes).toContainEqual(
          expect.objectContaining({
            branches: ["main"],
            inserted: 1,
            reason: "sync",
            repo: app,
          })
        );

        const status = yield* engine.status;

        expect(status.repos.map((repo) => repo.name)).toEqual(["app", "other"]);
      })
    )
  );

  it.live("a new tool session file triggers a sync within seconds", () => {
    const projects = path.join(scratch, ".claude", "projects");
    const folder = path.join(projects, app.replaceAll(/[^A-Za-z0-9]/gu, "-"));

    fs.mkdirSync(folder, { recursive: true });

    return withEngine(
      (engine) =>
        Effect.gen(function* sessionSync() {
          const syncs = engine.status.pipe(
            Effect.map(
              (status) =>
                status.repos.find((repo) => repo.repo === app)?.syncs ?? 0
            )
          );

          const before = yield* syncs;

          fs.writeFileSync(
            path.join(folder, "live-session.jsonl"),
            `${JSON.stringify({
              cwd: app,
              gitBranch: "main",
              message: {
                content: [{ text: "synthetic", type: "text" }],
                id: "msg_live_1",
                model: "claude-sonnet-5",
                role: "assistant",
                stop_reason: "end_turn",
                usage: { input_tokens: 2, output_tokens: 3 },
              },
              requestId: "req_live_1",
              sessionId: "live-session",
              timestamp: "2026-09-30T12:00:00.000Z",
              type: "assistant",
            })}\n`
          );

          const synced = yield* eventuallyEffect(
            syncs.pipe(Effect.map((after) => after > before)),
            5000
          );

          expect(synced).toBe(true);
        }),
      { pollMs: 600_000, sessionDebounceMs: 100 }
    );
  });

  it.live(
    "a tool session folder created after start is watched within seconds",
    () => {
      const sessions = path.join(scratch, ".codex", "sessions");

      expect(fs.existsSync(sessions)).toBe(false);

      return withEngine(
        (engine) =>
          Effect.gen(function* lateRoot() {
            const syncs = engine.status.pipe(
              Effect.map(
                (status) =>
                  status.repos.find((repo) => repo.repo === app)?.syncs ?? 0
              )
            );

            yield* Effect.sleep(300);

            const before = yield* syncs;
            const day = path.join(sessions, "2026", "09", "30");

            fs.mkdirSync(day, { recursive: true });

            const appeared = yield* eventuallyEffect(
              syncs.pipe(Effect.map((after) => after > before)),
              5000
            );

            const watched = yield* syncs;

            yield* Effect.sleep(300);
            fs.writeFileSync(path.join(day, "rollout-late.jsonl"), "{}\n");

            const written = yield* eventuallyEffect(
              syncs.pipe(Effect.map((after) => after > watched)),
              5000
            );

            expect([appeared, written]).toEqual([true, true]);
          }),
        { pollMs: 600_000, scanMs: 100, sessionDebounceMs: 100 }
      );
    }
  );

  it.live("a sync that finds nothing new sends no change event", () =>
    withEngine((engine, changes) =>
      Effect.gen(function* quietSync() {
        const syncs = engine.status.pipe(
          Effect.map(
            (status) =>
              status.repos.find((repo) => repo.repo === app)?.syncs ?? 0
          )
        );

        const before = yield* syncs;
        const spool = hookSpoolDirFor(app, dftHome);
        const file = path.join(spool, fs.readdirSync(spool)[0] ?? "missing");

        changes.length = 0;
        fs.writeFileSync(file, fs.readFileSync(file));

        const synced = yield* eventuallyEffect(
          syncs.pipe(Effect.map((after) => after > before)),
          10_000
        );

        yield* Effect.sleep(300);

        expect(synced).toBe(true);
        expect(changes).toEqual([]);
      })
    )
  );

  it.live(
    "deleting a repo needs its exact name, keeps a backup and leaves other repos alone",
    () =>
      withEngine((engine, changes) =>
        Effect.gen(function* deleteRepo() {
          claudeHook(app);
          claudeHook(other);

          const [appNote, otherNote] = hookLinesOf(claudeHookDay);
          const appEvents = eventsFor(app);
          const otherEvents = eventsFor(other);
          const plan = yield* engine.planDeleteRepoData(app);

          expect(plan.confirmText).toBe("app");
          expect(plan.tracked).toBe(true);
          expect(plan.totals.events).toBe(appEvents);
          expect(plan.totals.spoolFiles).toBe(2);
          expect(plan.hookFiles).toEqual([claudeHookDay]);
          expect(plan.branches.map((row) => row.branch)).toContain("main");

          const refused = yield* Effect.flip(
            engine.deleteRepoData(app, "other")
          );

          expect(refused.reason).toBe("confirmation");
          expect(eventsFor(app)).toBe(appEvents);
          expect(yield* engine.listBackups).toEqual([]);

          const done = yield* engine.deleteRepoData(app, "app");

          expect(fs.existsSync(done.backup.path)).toBe(true);
          expect(path.dirname(done.backup.path)).toBe(
            path.join(dftHome, "backups")
          );
          expect(eventsFor(app)).toBe(0);
          expect(eventsFor(other)).toBe(otherEvents);
          expect(fs.existsSync(hookSpoolDirFor(app, dftHome))).toBe(false);
          expect(hookLinesOf(claudeHookDay)).toEqual([otherNote]);
          expect(
            hookLinesOf(
              path.join(
                dftHome,
                "backups",
                `${done.backup.id}.files`,
                "hooks",
                "claude-code",
                path.basename(claudeHookDay)
              )
            )
          ).toEqual([appNote]);
          expect((yield* engine.config).repos).toEqual([other]);
          expect(changes).toContainEqual(
            expect.objectContaining({ reason: "delete", repo: app })
          );

          const restored = yield* engine.restoreBackup(done.backup.id);

          expect(restored.retracked).toEqual([app]);
          expect(eventsFor(app)).toBe(appEvents);
          expect(eventsFor(other)).toBe(otherEvents);
          expect(fs.readdirSync(hookSpoolDirFor(app, dftHome))).toHaveLength(1);
          expect(hookLinesOf(claudeHookDay)).toEqual([otherNote, appNote]);
          expect((yield* engine.config).repos).toEqual([other, app]);
          expect(
            (yield* engine.listBackups).map((b) => b.reason).toSorted()
          ).toEqual(["delete", "restore"]);
        })
      )
  );

  it.live(
    "reset needs the word reset, keeps a backup, and restore brings everything back",
    () =>
      Effect.gen(function* isolatedReset() {
        const resetDftHome = path.join(scratch, "reset-dft-home");
        const resetHome = liveHome(resetDftHome);

        const resetHookDay = hookSpoolFile(
          resetDftHome,
          "claude-code",
          HOOK_DAY
        );

        yield* setCursorUsageImport(resetHome, false);
        yield* addRepo(resetHome, app);
        yield* addRepo(resetHome, other);

        expect(claudeHook(app, resetDftHome).outcome.state).toBe("recorded");
        expect(claudeHook(other, resetDftHome).outcome.state).toBe("recorded");
        expect(hook("gen-reset", resetDftHome).outcome.state).toBe("spooled");

        return yield* withEngine(
          (engine) =>
            Effect.gen(function* resetAll() {
              const hookNotes = hookLinesOf(resetHookDay);
              const appEvents = eventsFor(app, resetHome.storePath);
              const otherEvents = eventsFor(other, resetHome.storePath);
              const plan = yield* engine.planResetStore;

              expect(hookNotes).toHaveLength(2);
              expect(plan.hookFiles).toEqual([resetHookDay]);
              expect(appEvents).toBeGreaterThan(0);
              expect(otherEvents).toBeGreaterThan(0);
              expect(plan.totals.events).toBeGreaterThanOrEqual(
                appEvents + otherEvents
              );

              const refused = yield* Effect.flip(engine.resetStore("yes"));

              expect(refused.reason).toBe("confirmation");
              expect(eventsFor(app, resetHome.storePath)).toBe(appEvents);

              const done = yield* engine.resetStore("reset");

              expect(eventsFor(app, resetHome.storePath)).toBe(0);
              expect(eventsFor(other, resetHome.storePath)).toBe(0);
              expect(fs.readdirSync(path.join(resetDftHome, "spool"))).toEqual(
                []
              );
              expect(fs.existsSync(resetHookDay)).toBe(false);

              const missing = yield* Effect.flip(
                engine.restoreBackup("../dft")
              );

              expect(missing.reason).toBe("unknown-backup");

              yield* engine.restoreBackup(done.backup.id);

              expect(eventsFor(app, resetHome.storePath)).toBe(appEvents);
              expect(eventsFor(other, resetHome.storePath)).toBe(otherEvents);
              expect(
                fs.readdirSync(hookSpoolDirFor(app, resetDftHome))
              ).toHaveLength(1);
              expect(hookLinesOf(resetHookDay)).toEqual(hookNotes);
            }),
          { dftHome: resetDftHome }
        );
      })
  );

  it.live("backs off when the Cursor usage import keeps failing", () =>
    Effect.gen(function* backoff() {
      yield* setCursorUsageImport(home, true);

      const failing: RegisteredCollector = {
        collect: () =>
          Effect.fail(
            new SourceUnavailable({
              adapterId: "cursor-usage-api",
              message: "rate limited (429)",
            })
          ),
        descriptor: cursorUsageApiDescriptor,
      };

      const usage = yield* withEngine(
        (engine) => Effect.sleep(1000).pipe(Effect.andThen(engine.status)),
        {
          collectors: [
            ...allCollectors.filter((c) => c.descriptor.id !== USAGE_SOURCE),
            failing,
          ],
          maxBackoffMs: 400,
          usageIntervalMs: 100,
        }
      );

      yield* setCursorUsageImport(home, false);

      expect(usage.usage.failures).toBeGreaterThanOrEqual(2);
      expect(usage.usage.runs).toBeLessThanOrEqual(5);
      expect(usage.usage.lastError).toContain("rate limited");
    })
  );

  it.live("stops cleanly on a signal", () =>
    Effect.scoped(
      Effect.gen(function* signalStop() {
        const engine = yield* startLiveEngine({
          ...options,
          signals: ["SIGUSR2"],
        });

        const received: string[] = [];

        const otherListener = () => {
          received.push("other listener");
        };

        process.on("SIGUSR2", otherListener);
        yield* engine.ready;
        process.emit("SIGUSR2", "SIGUSR2");
        yield* engine.stopped.pipe(Effect.timeout(10_000));
        yield* Effect.sleep(50);

        const status = yield* engine.status;
        const left = process.listenerCount("SIGUSR2");

        process.off("SIGUSR2", otherListener);

        expect(status.running).toBe(false);
        expect(received).toEqual(["other listener"]);
        expect(left).toBe(1);
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );
});
