import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectGitObservation } from "../../src/dx/collectors/git-observation/collector.js";
import type { GitRunner } from "../../src/dx/collectors/git-observation/git-runner.js";
import { SourceUnavailable } from "../../src/dx/contracts/error-source-unavailable.js";
import { loadWorktreeTimeline } from "../../src/dx/correlation/branch-at-time/git.js";
import {
  storedHeadHistory,
  withStoredHistory,
} from "../../src/dx/correlation/branch-at-time/stored-moves.js";
import {
  branchAt,
  buildHeadMoves,
  parseReflogLines,
} from "../../src/dx/correlation/branch-at-time/timeline.js";
import type {
  HeadMove,
  WorktreeTimeline,
} from "../../src/dx/correlation/branch-at-time/timeline.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const ms = (iso: string): number => Date.parse(iso);

const reflog = (lines: readonly (readonly [string, string])[]) =>
  parseReflogLines(
    lines
      .toReversed()
      .map(([at, subject]) => `HEAD@{${at}}\u001F${subject}`)
      .join("\n")
  );

const checkoutRows = (moves: readonly HeadMove[]) =>
  moves.map((move) => ({
    at: DateTime.formatIso(DateTime.makeUnsafe(move.atMs)),
    branch: move.branch,
    detached: move.detached,
    owner: move.owner ?? null,
  }));

const timelineOf = (
  moves: readonly HeadMove[],
  currentBranch: string | null
): WorktreeTimeline => ({
  currentBranch,
  currentSinceMs: null,
  moves,
  points: [],
  reflogFromMs: moves[0]?.atMs ?? null,
  worktree: "/fixture",
});

describe("checking out a remote-tracking ref or a tag detaches HEAD", () => {
  it("never names a branch after origin/main or a tag, with or without the local branch list", () => {
    const entries = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to origin/main"],
      ["2026-09-01T10:00:00Z", `checkout: moving from ${SHA} to main`],
      ["2026-09-01T11:00:00Z", "checkout: moving from main to v1.0"],
      ["2026-09-01T12:00:00Z", `checkout: moving from ${SHA} to feature/x`],
      [
        "2026-09-01T13:00:00Z",
        "checkout: moving from feature/x to origin/main",
      ],
    ]);

    const expected = [
      {
        at: "2026-09-01T08:00:00.000Z",
        branch: "main",
        detached: false,
        owner: null,
      },
      {
        at: "2026-09-01T09:00:00.000Z",
        branch: null,
        detached: true,
        owner: "main",
      },
      {
        at: "2026-09-01T10:00:00.000Z",
        branch: "main",
        detached: false,
        owner: null,
      },
      {
        at: "2026-09-01T11:00:00.000Z",
        branch: null,
        detached: true,
        owner: "main",
      },
      {
        at: "2026-09-01T12:00:00.000Z",
        branch: "feature/x",
        detached: false,
        owner: null,
      },
      {
        at: "2026-09-01T13:00:00.000Z",
        branch: null,
        detached: true,
        owner: "feature/x",
      },
    ];

    expect(
      checkoutRows(buildHeadMoves(entries, new Set(), null))
    ).toStrictEqual(expected);
    expect(
      checkoutRows(
        buildHeadMoves(entries, new Set(["main", "feature/x"]), null)
      )
    ).toStrictEqual(expected);

    const timeline = timelineOf(buildHeadMoves(entries, new Set(), null), null);

    expect(branchAt(timeline, ms("2026-09-01T09:30:00Z"))).toMatchObject({
      attribution: "provisional",
      branch: "main",
      detached: true,
      method: "reflog",
    });
    expect(branchAt(timeline, ms("2026-09-01T13:30:00Z"))).toMatchObject({
      branch: "feature/x",
      detached: true,
    });
  });

  it("reads past a rebase to tell a detached remote checkout from a rebased branch", () => {
    const entries = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to origin/main"],
      ["2026-09-01T09:10:00Z", "rebase (start): checkout main"],
      ["2026-09-01T10:00:00Z", `checkout: moving from ${SHA} to topic`],
      ["2026-09-01T11:00:00Z", "pull --rebase (start): checkout abc1234"],
      [
        "2026-09-01T11:05:00Z",
        "pull --rebase (finish): returning to refs/heads/topic",
      ],
      ["2026-09-01T12:00:00Z", "checkout: moving from topic to topic/next"],
    ]);

    expect(
      checkoutRows(buildHeadMoves(entries, new Set(), "topic/next")).map(
        (move) => move.branch ?? `detached:${move.owner}`
      )
    ).toStrictEqual([
      "main",
      "detached:main",
      "topic",
      "detached:topic",
      "topic",
      "topic/next",
    ]);
  });

  it("keeps a branch whose name looks like a remote when git left it by name", () => {
    const entries = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to origin/fix"],
      ["2026-09-01T10:00:00Z", "checkout: moving from origin/fix to main"],
      ["2026-09-01T11:00:00Z", "checkout: moving from main to upstream/wip"],
    ]);

    expect(
      checkoutRows(buildHeadMoves(entries, new Set(), "upstream/wip")).map(
        (move) => move.branch
      )
    ).toStrictEqual(["main", "origin/fix", "main", "upstream/wip"]);
  });

  it("keeps origin/main detached when a rebase of another branch leaves it", () => {
    const upToDate = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to feat/x"],
      ["2026-09-01T10:00:00Z", "checkout: moving from feat/x to origin/main"],
      ["2026-09-01T10:15:00Z", "rebase: checkout feat/x"],
      ["2026-09-01T11:00:00Z", "checkout: moving from feat/x to main"],
    ]);

    const picked = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to feat/x"],
      ["2026-09-01T10:00:00Z", "checkout: moving from feat/x to origin/main"],
      ["2026-09-01T10:15:00Z", "rebase (pick): x"],
      [
        "2026-09-01T10:15:00Z",
        "rebase (finish): returning to refs/heads/feat/x",
      ],
      ["2026-09-01T11:00:00Z", "checkout: moving from feat/x to main"],
    ]);

    const aborted = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to feat/x"],
      ["2026-09-01T10:00:00Z", "checkout: moving from feat/x to origin/main"],
      ["2026-09-01T10:10:00Z", "rebase (start): checkout main"],
      [
        "2026-09-01T10:15:00Z",
        "rebase (abort): returning to refs/heads/feat/x",
      ],
      ["2026-09-01T11:00:00Z", "checkout: moving from feat/x to main"],
    ]);

    const remotes = new Set(["origin/main"]);

    const rows = (entries: ReturnType<typeof reflog>) =>
      checkoutRows(
        buildHeadMoves(entries, new Set(["main", "feat/x"]), "main", remotes)
      ).map((move) =>
        move.detached ? `detached:${move.owner}` : `${move.branch}`
      );

    expect(rows(upToDate)).toStrictEqual([
      "main",
      "feat/x",
      "detached:feat/x",
      "feat/x",
      "main",
    ]);
    expect(rows(picked)).toStrictEqual([
      "main",
      "feat/x",
      "detached:feat/x",
      "feat/x",
      "main",
    ]);
    expect(rows(aborted)).toStrictEqual([
      "main",
      "feat/x",
      "detached:feat/x",
      "feat/x",
      "main",
    ]);
  });

  it("reads an older git rebase start that names its onto ref as detached", () => {
    const entries = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to topic"],
      ["2026-09-01T10:00:00Z", "rebase: checkout main"],
      ["2026-09-01T10:00:00Z", "rebase: x"],
      [
        "2026-09-01T10:00:00Z",
        "rebase finished: returning to refs/heads/topic",
      ],
    ]);

    expect(
      checkoutRows(
        buildHeadMoves(entries, new Set(["main", "topic"]), "topic")
      ).map((move) => (move.detached ? `detached:${move.owner}` : move.branch))
    ).toStrictEqual(["main", "topic", "detached:topic", "topic"]);
  });

  it("treats a detached checkout of a local branch as detached", () => {
    const entries = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to feat"],
      ["2026-09-01T10:00:00Z", "checkout: moving from feat to main"],
      ["2026-09-01T11:00:00Z", `checkout: moving from ${SHA} to feat`],
      ["2026-09-01T12:00:00Z", "checkout: moving from feat to main"],
    ]);

    const read = (currentBranch: string | null) =>
      checkoutRows(
        buildHeadMoves(entries, new Set(["main", "feat"]), currentBranch)
      ).map((move) => (move.detached ? `detached:${move.owner}` : move.branch));

    expect(read(null)).toStrictEqual([
      "main",
      "feat",
      "detached:feat",
      "feat",
      "detached:feat",
    ]);
    expect(read("main")).toStrictEqual([
      "main",
      "feat",
      "detached:feat",
      "feat",
      "main",
    ]);
  });

  it("does not read a rebase still in progress as a detached checkout", () => {
    const entries = reflog([
      ["2026-09-01T08:00:00Z", "commit (initial): base"],
      ["2026-09-01T09:00:00Z", "checkout: moving from main to feat"],
      ["2026-09-01T10:00:00Z", "rebase (start): checkout main"],
    ]);

    expect(
      checkoutRows(
        buildHeadMoves(entries, new Set(["main", "feat"]), null)
      ).map((move) => (move.detached ? `detached:${move.owner}` : move.branch))
    ).toStrictEqual(["main", "feat", "detached:feat"]);
  });
});

const GIT_CONFIG = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "advice.detachedHead=false",
];

const datedRunner = Effect.gen(function* makeDatedRunner() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return (date: string): GitRunner =>
    (cwd, args) =>
      Effect.scoped(
        Effect.gen(function* runDatedGit() {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", ["-C", cwd, ...GIT_CONFIG, ...args], {
              env: {
                GIT_AUTHOR_DATE: date,
                GIT_COMMITTER_DATE: date,
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_NOSYSTEM: "1",
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
});

describe("a clone that checks out origin/main", () => {
  it.effect(
    "records detached HEAD in the live timeline and in replayed git observations",
    () =>
      Effect.scoped(
        Effect.gen(function* remoteCheckout() {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const gitAt = yield* datedRunner;

          const root = yield* fileSystem.realPath(
            yield* fileSystem.makeTempDirectoryScoped()
          );

          const upstream = path.join(root, "upstream");
          const work = path.join(root, "work");

          yield* fileSystem.makeDirectory(upstream);
          yield* gitAt("2026-09-01T08:00:00Z")(upstream, [
            "init",
            "-q",
            "-b",
            "main",
          ]);
          yield* gitAt("2026-09-01T08:00:00Z")(upstream, [
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "base",
          ]);
          yield* gitAt("2026-09-01T08:30:00Z")(root, [
            "clone",
            "-q",
            upstream,
            work,
          ]);

          const steps: readonly (readonly [string, readonly string[]])[] = [
            ["2026-09-01T09:00:00Z", ["switch", "-q", "-c", "feat/x"]],
            [
              "2026-09-01T09:30:00Z",
              ["commit", "-q", "--allow-empty", "-m", "x"],
            ],
            ["2026-09-01T10:00:00Z", ["checkout", "-q", "origin/main"]],
            ["2026-09-01T11:00:00Z", ["checkout", "-q", "feat/x"]],
            [
              "2026-09-01T12:00:00Z",
              ["switch", "-q", "--detach", "origin/main"],
            ],
            ["2026-09-01T12:30:00Z", ["checkout", "-q", "main"]],
            ["2026-09-01T13:00:00Z", ["checkout", "-q", "origin/main"]],
          ];

          for (const [date, args] of steps) {
            yield* gitAt(date)(work, args);
          }

          const runGit = gitAt("2026-09-01T14:00:00Z");

          const { timeline } = yield* loadWorktreeTimeline(runGit, work);

          const observed = yield* collectGitObservation(runGit, {
            adapterId: "git-observation",
            context: emptyFlightContext,
            cursor: null,
            origin: "fixture",
            scratchDir: null,
            selectedInput: work,
          });

          const replayed = withStoredHistory(
            {
              currentBranch: null,
              currentSinceMs: null,
              moves: [],
              points: [],
              reflogFromMs: null,
              worktree: work,
            },
            storedHeadHistory(observed.events)
          );

          const read = (source: WorktreeTimeline) =>
            [
              "2026-09-01T09:45:00Z",
              "2026-09-01T10:30:00Z",
              "2026-09-01T11:30:00Z",
              "2026-09-01T12:15:00Z",
              "2026-09-01T12:45:00Z",
              "2026-09-01T13:30:00Z",
            ].map((at) => {
              const found = branchAt(source, ms(at));

              return `${found.branch}${found.detached ? " (detached)" : ""}`;
            });

          const expected = [
            "feat/x",
            "feat/x (detached)",
            "feat/x",
            "feat/x (detached)",
            "main",
            "main (detached)",
          ];

          expect(timeline.currentBranch).toBeNull();
          expect(read(timeline)).toStrictEqual(expected);
          expect(read(replayed)).toStrictEqual(expected);
          expect(
            [...timeline.moves, ...replayed.moves].filter((move) =>
              [move.branch, move.owner].includes("origin/main")
            )
          ).toStrictEqual([]);
        })
      ).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "keeps origin/main detached when a rebase of another branch or a detached checkout of main follows",
    () =>
      Effect.scoped(
        Effect.gen(function* rebaseFromRemote() {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const gitAt = yield* datedRunner;

          const root = yield* fileSystem.realPath(
            yield* fileSystem.makeTempDirectoryScoped()
          );

          const upstream = path.join(root, "upstream");
          const work = path.join(root, "work");

          yield* fileSystem.makeDirectory(upstream);
          yield* gitAt("2026-09-01T08:00:00Z")(upstream, [
            "init",
            "-q",
            "-b",
            "main",
          ]);
          yield* gitAt("2026-09-01T08:00:00Z")(upstream, [
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "base",
          ]);
          yield* gitAt("2026-09-01T08:30:00Z")(root, [
            "clone",
            "-q",
            upstream,
            work,
          ]);

          const steps: readonly (readonly [
            string,
            string,
            readonly string[],
          ])[] = [
            ["2026-09-01T09:00:00Z", work, ["switch", "-q", "-c", "feat/x"]],
            [
              "2026-09-01T09:30:00Z",
              work,
              ["commit", "-q", "--allow-empty", "-m", "x"],
            ],
            ["2026-09-01T10:00:00Z", work, ["checkout", "-q", "origin/main"]],
            [
              "2026-09-01T10:15:00Z",
              work,
              ["rebase", "-q", "origin/main", "feat/x"],
            ],
            ["2026-09-01T11:00:00Z", work, ["checkout", "-q", "main"]],
            [
              "2026-09-01T11:10:00Z",
              upstream,
              ["commit", "-q", "--allow-empty", "-m", "up2"],
            ],
            ["2026-09-01T11:20:00Z", work, ["fetch", "-q"]],
            ["2026-09-01T12:00:00Z", work, ["checkout", "-q", "origin/main"]],
            [
              "2026-09-01T12:15:00Z",
              work,
              ["rebase", "-q", "origin/main", "feat/x"],
            ],
            ["2026-09-01T13:00:00Z", work, ["checkout", "-q", "main"]],
            [
              "2026-09-01T13:30:00Z",
              work,
              ["checkout", "-q", "--detach", "main"],
            ],
            ["2026-09-01T14:00:00Z", work, ["checkout", "-q", "feat/x"]],
            [
              "2026-09-01T14:30:00Z",
              work,
              ["switch", "-q", "--detach", "main"],
            ],
          ];

          for (const [date, cwd, args] of steps) {
            yield* gitAt(date)(cwd, args);
          }

          const runGit = gitAt("2026-09-01T15:00:00Z");

          const { timeline } = yield* loadWorktreeTimeline(runGit, work);

          const observed = yield* collectGitObservation(runGit, {
            adapterId: "git-observation",
            context: emptyFlightContext,
            cursor: null,
            origin: "fixture",
            scratchDir: null,
            selectedInput: work,
          });

          const replayed = withStoredHistory(
            {
              currentBranch: null,
              currentSinceMs: null,
              moves: [],
              points: [],
              reflogFromMs: null,
              worktree: work,
            },
            storedHeadHistory(observed.events)
          );

          const read = (source: WorktreeTimeline) =>
            [
              "2026-09-01T10:05:00Z",
              "2026-09-01T10:30:00Z",
              "2026-09-01T11:30:00Z",
              "2026-09-01T12:05:00Z",
              "2026-09-01T12:30:00Z",
              "2026-09-01T13:15:00Z",
              "2026-09-01T13:45:00Z",
              "2026-09-01T14:15:00Z",
              "2026-09-01T14:45:00Z",
            ].map((at) => {
              const found = branchAt(source, ms(at));

              return `${found.branch}${found.detached ? " (detached)" : ""}`;
            });

          const expected = [
            "feat/x (detached)",
            "feat/x",
            "main",
            "feat/x (detached)",
            "feat/x",
            "main",
            "main (detached)",
            "feat/x",
            "feat/x (detached)",
          ];

          expect(read(timeline)).toStrictEqual(expected);
          expect(read(replayed)).toStrictEqual(expected);
          expect(
            observed.events
              .map((event) => event.payload)
              .filter((payload) => payload.observationKind === "head-moves")
              .map((payload) => payload.detachedRefs)
          ).toStrictEqual([["origin/main"]]);
        })
      ).pipe(Effect.provide(NodeServices.layer))
  );
});
