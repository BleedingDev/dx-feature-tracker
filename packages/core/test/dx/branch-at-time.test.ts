import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { GitRunner } from "../../src/dx/collectors/git-observation/git-runner.js";
import { SourceUnavailable } from "../../src/dx/contracts/error-source-unavailable.js";
import {
  attributeHistoricalBranches,
  summarizeAttribution,
} from "../../src/dx/correlation/branch-at-time/attribute.js";
import { loadWorktreeTimeline } from "../../src/dx/correlation/branch-at-time/git.js";
import {
  branchAt,
  buildHeadMoves,
  parseReflogLines,
} from "../../src/dx/correlation/branch-at-time/timeline.js";
import type { WorktreeTimeline } from "../../src/dx/correlation/branch-at-time/timeline.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const MONTH_AGO = "2026-08-30T10:00:00+00:00";

const NOW = "2026-09-30T10:00:00+00:00";

const ms = (iso: string): number => Date.parse(iso);

const GIT_CONFIG = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

const spawnDated = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  repo: string,
  date: string,
  args: readonly string[]
) =>
  Effect.scoped(
    Effect.gen(function* runDatedGit() {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-C", repo, ...GIT_CONFIG, ...args], {
          env: {
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
          extendEnv: true,
          stderr: "ignore",
          stdin: "ignore",
        })
      );

      const [stdout, code] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 2 }
      );

      return { code: Number(code), stdout };
    })
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SourceUnavailable({ adapterId: "git", message: cause.message })
    ),
    Effect.flatMap((out) =>
      out.code === 0
        ? Effect.succeed(out.stdout)
        : Effect.fail(
            new SourceUnavailable({
              adapterId: "git",
              message: `git ${args[0] ?? ""} exited ${out.code}`,
            })
          )
    )
  );

const datedGit = (repo: string, date: string, args: readonly string[]) =>
  Effect.gen(function* withSpawner() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* spawnDated(spawner, repo, date, args);
  });

const nowRunner = Effect.gen(function* makeNowRunner() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run: GitRunner = (cwd, args) => spawnDated(spawner, cwd, NOW, args);

  return run;
});

const scriptRepo = Effect.gen(function* scriptRepo() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const repo = path.join(root, "repo");

  yield* fileSystem.makeDirectory(repo);

  const commitAt = (date: string, file: string) =>
    Effect.gen(function* commit() {
      yield* fileSystem.writeFileString(path.join(repo, file), `${date}\n`);
      yield* datedGit(repo, date, ["add", file]);
      yield* datedGit(repo, date, ["commit", "-q", "-m", `edit ${file}`]);
    });

  yield* datedGit(repo, "2026-08-20T09:00:00+00:00", [
    "init",
    "-q",
    "-b",
    "main",
  ]);
  yield* commitAt("2026-08-20T09:00:00+00:00", "base.txt");
  yield* datedGit(repo, "2026-08-30T08:00:00+00:00", [
    "switch",
    "-q",
    "-c",
    "feature/retro",
  ]);
  yield* commitAt("2026-08-30T12:00:00+00:00", "feature.txt");
  yield* datedGit(repo, "2026-08-31T08:00:00+00:00", ["switch", "-q", "main"]);
  yield* commitAt("2026-09-10T09:00:00+00:00", "main.txt");
  yield* datedGit(repo, "2026-09-30T08:00:00+00:00", [
    "switch",
    "-q",
    "feature/retro",
  ]);
  yield* commitAt("2026-09-30T09:30:00+00:00", "feature.txt");

  return repo;
});

const aiEvent = (
  id: string,
  occurredAt: string,
  overrides: Partial<DxEventEnvelope> = {}
): DxEventEnvelope => ({
  acquisition: "db-snapshot",
  adapterId: "cursor-local-db",
  adapterVersion: "1.0.0",
  ai: null,
  context: { ...emptyFlightContext, branch: "feature/retro" },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind: "ai.usage",
  observedAt: NOW,
  occurredAt,
  occurredAtPrecision: "second",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: id,
  usage: null,
  ...overrides,
});

describe("branch-at-time from a scripted worktree", () => {
  it.effect("reads which branch was checked out a month ago and now", () =>
    Effect.scoped(
      Effect.gen(function* readsTimeline() {
        const repo = yield* scriptRepo;

        const { timeline } = yield* loadWorktreeTimeline(
          yield* nowRunner,
          repo
        );

        expect(timeline.currentBranch).toBe("feature/retro");
        expect(branchAt(timeline, ms(MONTH_AGO))).toMatchObject({
          attribution: "strong",
          branch: "feature/retro",
          method: "reflog",
        });
        expect(branchAt(timeline, ms("2026-09-15T12:00:00+00:00")).branch).toBe(
          "main"
        );
        expect(branchAt(timeline, ms(NOW))).toMatchObject({
          branch: "feature/retro",
          method: "reflog",
        });
        expect(
          branchAt(timeline, ms("2026-08-01T00:00:00+00:00"))
        ).toMatchObject({ branch: null, method: "unknown" });
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "falls back to provisional commit-graph evidence beyond reflog retention",
    () =>
      Effect.scoped(
        Effect.gen(function* expiredReflog() {
          const repo = yield* scriptRepo;

          yield* datedGit(repo, NOW, [
            "reflog",
            "expire",
            "--expire=2026-09-20T00:00:00+00:00",
            "--all",
          ]);

          const { commitBranches, timeline } = yield* loadWorktreeTimeline(
            yield* nowRunner,
            repo
          );

          expect(timeline.reflogFromMs).toBeGreaterThanOrEqual(
            ms("2026-09-20T00:00:00+00:00")
          );
          expect(branchAt(timeline, ms(MONTH_AGO))).toMatchObject({
            attribution: "provisional",
            branch: "feature/retro",
            method: "commit-graph",
          });

          const scoredSha = [...commitBranches.entries()].find(
            ([, branch]) => branch === "feature/retro"
          )?.[0];

          expect(scoredSha).toBeDefined();

          const events = [
            aiEvent("old-db-row", MONTH_AGO, {
              context: {
                ...emptyFlightContext,
                branch: "main",
                worktreePath: repo,
              },
            }),
            aiEvent("scored", "2026-09-12T10:00:00+00:00", {
              context: { ...emptyFlightContext, branch: "main" },
              identity: {
                ...emptyEventIdentity,
                commitSha: scoredSha ?? null,
              },
              kind: "provenance.attestation",
            }),
            aiEvent("now-db-row", NOW, {
              context: {
                ...emptyFlightContext,
                branch: "main",
                worktreePath: `${repo}/`,
              },
              identity: { ...emptyEventIdentity, requestId: "req-1" },
            }),
            aiEvent("csv-linked", NOW, {
              acquisition: "file-import",
              adapterId: "cursor-usage-export",
              context: emptyFlightContext,
              identity: { ...emptyEventIdentity, requestId: "req-1" },
            }),
            aiEvent("csv-orphan", NOW, {
              acquisition: "file-import",
              adapterId: "cursor-usage-export",
              context: emptyFlightContext,
            }),
            aiEvent("hook-live", NOW, {
              acquisition: "hook",
              adapterId: "cursor-hooks",
              context: { ...emptyFlightContext, branch: "feature/live" },
            }),
          ];

          const result = attributeHistoricalBranches(events, {
            commitBranches,
            timelines: [timeline],
          });

          const byId = new Map(result.attributions.map((a) => [a.eventId, a]));

          expect(byId.get("old-db-row")).toMatchObject({
            basis: "worktree-at-time",
            branch: "feature/retro",
            collectedBranch: "main",
            method: "commit-graph",
          });
          expect(byId.get("scored")).toMatchObject({
            attribution: "strong",
            basis: "scored-commit",
            branch: "feature/retro",
          });
          expect(byId.get("now-db-row")).toMatchObject({
            attribution: "strong",
            branch: "feature/retro",
            method: "reflog",
          });
          expect(byId.get("csv-linked")).toMatchObject({
            basis: "linked-request",
            branch: "feature/retro",
          });
          expect(byId.get("csv-orphan")).toMatchObject({
            attribution: "unassigned",
            branch: null,
          });
          expect(byId.get("hook-live")?.branch).toBe("feature/live");
          expect(
            summarizeAttribution(result.attributions).find(
              (s) => s.branch === "feature/retro"
            )
          ).toMatchObject({ events: 4, movedFromCollectedBranch: 4 });
          expect(
            result.events.find((e) => e.eventId === "old-db-row")?.payload
          ).toMatchObject({
            historicalBranch: {
              collectedBranch: "main",
              method: "commit-graph",
            },
          });
        })
      ).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("branch-at-time pure timeline", () => {
  it("labels detached rebases and resolves the current branch without a reflog", () => {
    const entries = parseReflogLines(
      [
        "HEAD@{2026-09-02T10:05:00+00:00}\u001Fpull --rebase (finish): returning to refs/heads/topic",
        "HEAD@{2026-09-02T10:00:00+00:00}\u001Fpull --rebase (start): checkout abc123",
        "HEAD@{2026-09-01T10:00:00+00:00}\u001Fcheckout: moving from main to topic",
        "HEAD@{2026-08-31T10:00:00+00:00}\u001Fpull --rebase (finish): returning to refs/heads/main",
        "HEAD@{2026-08-31T10:00:00+00:00}\u001Fpull --rebase (pick): subject",
        "HEAD@{2026-08-31T10:00:00+00:00}\u001Fpull --rebase (start): checkout def456",
        "HEAD@{2026-08-31T09:00:00+00:00}\u001Fcommit (initial): subject",
      ].join("\n")
    );

    const moves = buildHeadMoves(entries, new Set(["main", "topic"]), "topic");

    const timeline: WorktreeTimeline = {
      currentBranch: "topic",
      currentSinceMs: null,
      moves,
      points: [],
      reflogFromMs: moves[0]?.atMs ?? null,
      worktree: "/fixture",
    };

    expect(branchAt(timeline, ms("2026-09-02T10:01:00+00:00"))).toMatchObject({
      attribution: "provisional",
      branch: "topic",
      detached: true,
      method: "reflog",
    });
    expect(branchAt(timeline, ms("2026-09-03T00:00:00+00:00")).branch).toBe(
      "topic"
    );
    expect(branchAt(timeline, ms("2026-08-31T09:30:00+00:00")).branch).toBe(
      "main"
    );
    expect(branchAt(timeline, ms("2026-08-31T12:00:00+00:00")).branch).toBe(
      "main"
    );

    const bare: WorktreeTimeline = {
      currentBranch: "topic",
      currentSinceMs: ms("2026-09-29T00:00:00+00:00"),
      moves: [],
      points: [],
      reflogFromMs: null,
      worktree: "/fixture",
    };

    expect(branchAt(bare, ms(NOW))).toMatchObject({
      branch: "topic",
      method: "current",
    });
    expect(branchAt(bare, ms(MONTH_AGO)).method).toBe("unknown");
  });

  it("attributes a detached bisect to the branch checked out before it", () => {
    const entries = parseReflogLines(
      [
        "HEAD@{2026-09-05T10:00:00+00:00}\u001Fcheckout: moving from topic to 0123456789abcdef0123456789abcdef01234567",
        "HEAD@{2026-09-01T10:00:00+00:00}\u001Fcheckout: moving from main to topic",
        "HEAD@{2026-08-31T09:00:00+00:00}\u001Fcommit (initial): subject",
      ].join("\n")
    );

    const moves = buildHeadMoves(entries, new Set(["main", "topic"]), null);

    const timeline: WorktreeTimeline = {
      currentBranch: null,
      currentSinceMs: null,
      moves,
      points: [],
      reflogFromMs: moves[0]?.atMs ?? null,
      worktree: "/fixture",
    };

    expect(branchAt(timeline, ms("2026-09-06T00:00:00+00:00"))).toMatchObject({
      attribution: "provisional",
      branch: "topic",
      detached: true,
    });
  });
});

const deletedTimeline = (ff: boolean): WorktreeTimeline => {
  const entries = parseReflogLines(
    [
      `HEAD@{2026-09-30T08:45:00+00:00}\u001F${ff ? "merge feature/a: Fast-forward" : "merge feature/a: Merge made by the 'ort' strategy."}`,
      "HEAD@{2026-09-30T08:45:00+00:00}\u001Fcheckout: moving from feature/a to main",
      "HEAD@{2026-09-30T08:40:00+00:00}\u001Fcommit: feat a",
      "HEAD@{2026-09-30T08:10:00+00:00}\u001Fcheckout: moving from main to feature/a",
      "HEAD@{2026-09-30T08:00:00+00:00}\u001Fcommit (initial): init",
    ].join("\n")
  );

  const moves = buildHeadMoves(entries, new Set(["main"]), "main");

  return {
    currentBranch: "main",
    currentSinceMs: null,
    moves,
    points: [],
    reflogFromMs: moves[0]?.atMs ?? null,
    worktree: "/repo",
  };
};

describe("merged and deleted branches", () => {
  for (const ff of [false, true]) {
    it(`keeps a deleted branch name from the HEAD reflog (${ff ? "ff" : "no-ff"})`, () => {
      const timeline = deletedTimeline(ff);

      expect(branchAt(timeline, ms("2026-09-30T08:21:00+00:00"))).toMatchObject(
        {
          attribution: "strong",
          branch: "feature/a",
          detached: false,
        }
      );
      expect(branchAt(timeline, ms("2026-09-30T08:51:00+00:00")).branch).toBe(
        "main"
      );
    });
  }

  it("still treats a commit checkout as detached", () => {
    const moves = buildHeadMoves(
      parseReflogLines(
        "HEAD@{2026-09-05T10:00:00+00:00}\u001Fcheckout: moving from main to 0123456"
      ),
      new Set(),
      null
    );

    expect(moves.at(-1)).toMatchObject({ branch: null, detached: true });
  });

  it("places account rows on the hook turn of the same conversation", () => {
    const hook = (id: string, at: string, branch: string) =>
      aiEvent(id, at, {
        acquisition: "hook",
        context: { ...emptyFlightContext, branch, worktreePath: "/repo" },
        identity: { ...emptyEventIdentity, sessionId: "conv-2" },
      });

    const row = (id: string, at: string) =>
      aiEvent(id, at, {
        context: {
          ...emptyFlightContext,
          branch: "main",
          worktreePath: "/repo",
        },
        identity: { ...emptyEventIdentity, sessionId: "conv-2" },
        payload: { sessionJoin: { method: "nearest-session-event" } },
      });

    const main: WorktreeTimeline = {
      currentBranch: "main",
      currentSinceMs: null,
      moves: [
        {
          atMs: ms("2026-09-30T08:00:00+00:00"),
          branch: "main",
          detached: false,
        },
      ],
      points: [],
      reflogFromMs: ms("2026-09-30T08:00:00+00:00"),
      worktree: "/repo",
    };

    const result = attributeHistoricalBranches(
      [
        hook("h1", "2026-09-30T08:30:00+00:00", "feature/a"),
        hook("h2", "2026-09-30T08:50:00+00:00", "main"),
        row("u1", "2026-09-30T08:31:00+00:00"),
        row("u2", "2026-09-30T08:51:00+00:00"),
        row("u3", "2026-09-30T09:40:00+00:00"),
      ],
      { commitBranches: new Map(), timelines: [main] }
    );

    const byId = new Map(result.attributions.map((a) => [a.eventId, a]));

    expect(byId.get("u1")).toMatchObject({
      basis: "hook-turn",
      branch: "feature/a",
    });
    expect(byId.get("u2")).toMatchObject({
      basis: "hook-turn",
      branch: "main",
    });
    expect(byId.get("u3")).toMatchObject({
      basis: "worktree-at-time",
      branch: "main",
    });
  });
});
