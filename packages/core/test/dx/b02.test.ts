import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path, Schema } from "effect";

import {
  collectGitIdentity,
  gitIdentityCollector,
  gitIdentityDescriptor,
  sha256,
} from "../../src/dx/collectors/git-identity/collector.js";
import { gitRunFor } from "../../src/dx/collectors/git-identity/git-runner.js";
import {
  parseBranchCreation,
  parseWorktreeList,
} from "../../src/dx/collectors/git-identity/identity.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type { EventBatch } from "../../src/dx/model/event.js";

const inputFor = (selectedInput: string | null): CollectInput => ({
  adapterId: "git-identity",
  context: emptyFlightContext,
  cursor: null,
  origin: "live",
  scratchDir: null,
  selectedInput,
});

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/u;

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

const git = Effect.fn("b02.git")(function* git(
  cwd: string,
  args: readonly string[]
) {
  const run = yield* gitRunFor(cwd);
  const result = yield* run([...GIT_CONFIG, ...args]);
  expect(result.exitCode).toBe(0);

  return result.stdout.trim();
});

const makeRepo = Effect.fn("b02.makeRepo")(function* makeRepo() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const repo = path.join(root, "repo");
  yield* fileSystem.makeDirectory(repo);
  yield* git(repo, ["init", "-q", "-b", "main"]);
  yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "one\n");
  yield* git(repo, ["add", "a.txt"]);
  yield* git(repo, ["commit", "-q", "-m", "base"]);
  const mainSha = yield* git(repo, ["rev-parse", "HEAD"]);

  return { mainSha, repo, root };
});

const assertEventIdRecipe = Effect.fn("b02.assertEventId")(
  function* assertEventIdRecipe(batch: EventBatch) {
    for (const event of batch.events) {
      const expected = yield* sha256(
        `${event.adapterId}\u0000${event.upstreamKey}\u0000${event.kind}`
      );

      expect(event.eventId).toBe(expected);
    }
  }
);

describe("git-identity parsers", () => {
  it("reads the oldest reflog creation entry", () => {
    const text = [
      "refs/heads/feature@{2026-09-30T12:05:00+02:00}\tcommit: second",
      "refs/heads/feature@{2026-09-30T12:00:00+02:00}\tbranch: Created from main",
    ].join("\n");

    expect(parseBranchCreation(text)).toEqual({
      createdAt: "2026-09-30T10:00:00.000Z",
      createdFrom: "main",
    });
    expect(parseBranchCreation("x@{2026-09-30T12:00:00Z}\tcommit: c")).toBe(
      null
    );
    expect(parseBranchCreation("")).toBe(null);
  });

  it("parses porcelain worktree lists including detached entries", () => {
    const text = [
      "worktree /r/main",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /r/wt",
      "HEAD bbb",
      "detached",
      "",
    ].join("\n");

    expect(parseWorktreeList(text)).toEqual([
      { branch: "main", path: "/r/main" },
      { branch: null, path: "/r/wt" },
    ]);
  });
});

it.layer(NodeServices.layer)("git-identity collector on real Git", (test) => {
  test.effect("captures branch, base SHA, creation time and dirty state", () =>
    Effect.gen(function* featureBranch() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { mainSha, repo } = yield* makeRepo();
      yield* git(repo, ["switch", "-q", "-c", "feature/cost"]);
      yield* fileSystem.writeFileString(path.join(repo, "b.txt"), "two\n");
      yield* git(repo, ["add", "b.txt"]);
      yield* git(repo, ["commit", "-q", "-m", "feature"]);
      const headSha = yield* git(repo, ["rev-parse", "HEAD"]);
      yield* fileSystem.writeFileString(path.join(repo, "dirty.txt"), "x\n");

      const batch = yield* collectGitIdentity(inputFor(repo));
      const decoded = yield* Schema.decodeEffect(EventBatchSchema)(batch);
      const [event] = decoded.events;

      expect(decoded.events).toHaveLength(1);
      expect(event?.kind).toBe("git.context");
      expect(event?.origin).toBe("live");
      expect(event?.context.branch).toBe("feature/cost");
      expect(event?.context.headSha).toBe(headSha);
      expect(event?.context.repoCommonDir?.endsWith("/repo/.git")).toBe(true);
      expect(event?.context.worktreePath?.endsWith("/repo")).toBe(true);
      expect(event?.payload).toMatchObject({
        aheadCount: 1,
        baseRef: "main",
        baseSha: mainSha,
        baseSource: "local-default",
        branchCreatedFrom: "HEAD",
        detached: false,
        dirty: true,
        dirtyEntries: 1,
        isLinkedWorktree: false,
        onBaseBranch: false,
        sameBranchWorktrees: 1,
        worktreeCount: 1,
      });
      expect(String(event?.payload.branchCreatedAt)).toMatch(ISO_PREFIX);
      expect(String(event?.payload.firstBranchCommitAt)).toMatch(ISO_PREFIX);
      expect(event?.sourceVersion).toMatch(/^\d+\.\d+/u);
      expect(decoded.coverage.state).toBe("complete");
      expect(decoded.coverage.gaps).toEqual([]);
      yield* assertEventIdRecipe(decoded);

      const again = yield* collectGitIdentity(inputFor(repo));
      expect(again.events[0]?.eventId).toBe(event?.eventId);
    })
  );

  test.effect("maps a linked worktree to the same common dir", () =>
    Effect.gen(function* linkedWorktree() {
      const path = yield* Path.Path;
      const { repo, root } = yield* makeRepo();
      const worktree = path.join(root, "wt");
      yield* git(repo, ["worktree", "add", "-q", "-b", "feature/wt", worktree]);

      const main = yield* collectGitIdentity(inputFor(repo));
      const linked = yield* collectGitIdentity(inputFor(worktree));
      const [linkedEvent] = linked.events;
      const [mainEvent] = main.events;

      expect(linkedEvent?.context.repoCommonDir).toBe(
        mainEvent?.context.repoCommonDir
      );
      expect(linkedEvent?.context.worktreePath).not.toBe(
        mainEvent?.context.worktreePath
      );
      expect(linkedEvent?.context.branch).toBe("feature/wt");
      expect(linkedEvent?.payload).toMatchObject({
        aheadCount: 0,
        isLinkedWorktree: true,
        worktreeCount: 2,
      });
    })
  );

  test.effect(
    "keeps detached HEAD unassigned and reports partial coverage",
    () =>
      Effect.gen(function* detachedHead() {
        const { repo } = yield* makeRepo();
        yield* git(repo, ["switch", "-q", "--detach"]);

        const batch = yield* collectGitIdentity(inputFor(repo));

        expect(batch.events[0]?.context.branch).toBe(null);
        expect(batch.events[0]?.payload.detached).toBe(true);
        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "unavailable:branch"
        );
      })
  );

  test.effect("reports a missing base instead of inventing one", () =>
    Effect.gen(function* noBase() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const repo = path.join(root, "solo");
      yield* fileSystem.makeDirectory(repo);
      yield* git(repo, ["init", "-q", "-b", "spike"]);
      yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "one\n");
      yield* git(repo, ["add", "a.txt"]);
      yield* git(repo, ["commit", "-q", "-m", "only"]);

      const batch = yield* collectGitIdentity(inputFor(repo));

      expect(batch.events[0]?.payload).toMatchObject({
        aheadCount: null,
        baseSha: null,
        baseSource: "none",
      });
      expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
        "unavailable:baseSha"
      );
    })
  );

  test.effect("fails honestly outside a repository or without input", () =>
    Effect.gen(function* failures() {
      const fileSystem = yield* FileSystem.FileSystem;
      const empty = yield* fileSystem.makeTempDirectoryScoped();

      const outside = yield* Effect.exit(collectGitIdentity(inputFor(empty)));

      const missing = yield* Effect.exit(
        gitIdentityCollector.collect(inputFor(null))
      );

      expect(Exit.isFailure(outside)).toBe(true);
      expect(JSON.stringify(outside)).toContain("SourceUnavailable");
      expect(Exit.isFailure(missing)).toBe(true);
      expect(JSON.stringify(missing)).toContain("InvalidInput");
    })
  );

  test.effect(
    "decodes the redacted fixture with the frozen event ID recipe",
    () =>
      Effect.gen(function* redactedFixture() {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const file = yield* path.fromFileUrl(
          new URL("fixtures/b02/git-context-redacted.json", import.meta.url)
        );

        const text = yield* fileSystem.readFileString(file);

        const batch = yield* Schema.decodeEffect(
          Schema.fromJsonString(EventBatchSchema)
        )(text);

        expect(gitIdentityDescriptor.fixtureIds).toContain(
          "b02-git-context-redacted"
        );
        expect(batch.events[0]?.origin).toBe("fixture");
        expect(batch.events[0]?.context.worktreePath).toBe(
          "/redacted/repos/sample-app"
        );
        yield* assertEventIdRecipe(batch);
      })
  );
});
