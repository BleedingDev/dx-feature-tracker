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
});
