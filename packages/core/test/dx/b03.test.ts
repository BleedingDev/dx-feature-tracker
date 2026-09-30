// @effect-diagnostics nodeBuiltinImport:off -- This test reads committed git output fixtures and builds a throwaway git repository in the OS temp dir.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  collectGitHistory,
  gitHistoryCollector,
  gitHistoryDescriptor,
} from "../../src/dx/collectors/git-history/git-history.js";
import type { GitRunner } from "../../src/dx/collectors/git-history/git-history.js";
import { parseLog } from "../../src/dx/collectors/git-history/parse.js";
import { SourceUnavailable } from "../../src/dx/contracts/error-source-unavailable.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  MAX_PAYLOAD_BYTES,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "b03");

const fixture = (name: string) =>
  readFileSync(path.join(fixtureDir, name), "utf-8");

const HEAD = "d".repeat(40);

const BASE = "e".repeat(40);

const OBSERVED_AT = "2026-09-30T13:00:00.000Z";

const input = (overrides: Partial<CollectInput> = {}): CollectInput => ({
  adapterId: "git-history",
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput: "/fixture/repo",
  ...overrides,
});

const cannedRunner =
  (responses: Readonly<Record<string, string | null>>): GitRunner =>
  (_cwd, args) => {
    const key = args.slice(0, 2).join(" ");
    const value = responses[key] ?? responses[args[0] ?? ""];

    return value === null || value === undefined
      ? Effect.fail(
          new SourceUnavailable({
            adapterId: "git-history",
            message: `no canned output for ${key}`,
          })
        )
      : Effect.succeed(value);
  };

const baseResponses = {
  "diff --no-color": fixture("worktree-numstat.txt"),
  "log --no-color": fixture("log-numstat.txt"),
  "ls-files --others": "scratch.txt\n",
  "merge-base": `${BASE}\n`,
  "reflog show": fixture("reflog.txt"),
  "rev-parse --path-format=absolute": "/fixture/repo/.git\n",
  "rev-parse --show-toplevel": "/fixture/repo\n",
  "rev-parse --verify": `${HEAD}\n`,
  "symbolic-ref --quiet": "feature/x\n",
  version: "git version 2.51.0\n",
} satisfies Readonly<Record<string, string | null>>;

describe("b03 git history parser", () => {
  it("parses commits, numstat, binary files and merges from canned log", () => {
    const commits = parseLog(fixture("log-numstat.txt"));

    expect(commits.map((commit) => commit.parents.length)).toEqual([
      2, 1, 1, 1,
    ]);
    expect(commits[1]?.files).toEqual([
      { added: 5, binary: false, deleted: 1, path: "src/feature.ts" },
      { added: null, binary: true, deleted: null, path: "assets/logo.png" },
    ]);
    expect(commits[2]?.files[1]?.path).toBe("docs/with\ttab.md");
    expect(commits[3]?.committedAt).toBe("2026-09-30T10:00:30.000Z");
  });
});

describe("b03 git history collector (fixture)", () => {
  it.effect("emits decodable commit, worktree and reflog events", () =>
    Effect.gen(function* run() {
      const batch = yield* collectGitHistory(input(), {
        observedAt: OBSERVED_AT,
        runner: cannedRunner(baseResponses),
      });

      const decoded = yield* Schema.decodeEffect(EventBatchSchema)(batch);
      const commits = decoded.events.filter((e) => e.kind === "git.commit");
      const diff = decoded.events.find((e) => e.kind === "git.diff");
      const reflog = decoded.events.find((e) => e.kind === "git.observation");

      expect(commits).toHaveLength(4);
      expect(commits[1]?.payload).toMatchObject({
        binaryFiles: 1,
        filesChanged: 2,
        linesAdded: 5,
        linesDeleted: 1,
        observationMode: "backfill",
        timeBasis: "git-committer-date",
      });
      expect(commits[0]?.payload).toMatchObject({
        isMerge: true,
        numstatAvailable: false,
      });
      expect(commits[1]?.occurredAt).toBe("2026-09-30T10:20:00.000Z");
      expect(commits[1]?.observedAt).toBe(OBSERVED_AT);
      expect(commits[1]?.occurredAt).not.toBe(commits[1]?.observedAt);
      expect(commits[1]?.identity.commitSha).toBe("c".repeat(40));
      expect(commits[1]?.context).toMatchObject({
        branch: "feature/x",
        headSha: HEAD,
        repoCommonDir: "/fixture/repo/.git",
      });
      expect(
        commits[1]?.fieldSemantics.find((s) => s.field === "committedAt")
          ?.method
      ).toBe("source-reported");
      expect(diff?.occurredAt).toBeNull();
      expect(diff?.payload).toMatchObject({
        filesChanged: 1,
        linesAdded: 4,
        linesDeleted: 2,
        untrackedFiles: 1,
      });
      expect(reflog?.payload).toMatchObject({
        branchCreatedAt: "2026-09-30T09:55:00.000Z",
        createdFrom: "main",
        observation: "branch-created",
      });
      expect(decoded.coverage).toMatchObject({
        observedItems: 4,
        state: "complete",
        watermark: HEAD,
        windowFrom: "2026-09-30T10:00:30.000Z",
        windowTo: "2026-09-30T10:31:00.000Z",
      });

      for (const event of decoded.events) {
        expect(JSON.stringify(event.payload).length).toBeLessThan(
          MAX_PAYLOAD_BYTES
        );
        expect(event.origin).toBe("fixture");
      }
    })
  );

  it.effect("is idempotent: same history yields identical event IDs", () =>
    Effect.gen(function* run() {
      const options = {
        observedAt: OBSERVED_AT,
        runner: cannedRunner(baseResponses),
      };

      const first = yield* collectGitHistory(input(), options);

      const second = yield* collectGitHistory(input(), {
        ...options,
        observedAt: "2026-10-01T00:00:00.000Z",
      });

      expect(second.events.map((e) => e.eventId)).toEqual(
        first.events.map((e) => e.eventId)
      );
      expect(new Set(first.events.map((e) => e.eventId)).size).toBe(
        first.events.length
      );
    })
  );

  it.effect("reports partial coverage without a base ref", () =>
    Effect.gen(function* run() {
      const batch = yield* collectGitHistory(input(), {
        baseRef: "refs/heads/does-not-exist",
        observedAt: OBSERVED_AT,
        runner: (cwd, args) =>
          args.includes("refs/heads/does-not-exist^{commit}")
            ? Effect.succeed("")
            : cannedRunner(baseResponses)(cwd, args),
      });

      expect(batch.coverage.state).toBe("partial");
      expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
        "no-base-ref"
      );
    })
  );

  it.effect("returns none coverage for an unborn repository", () =>
    Effect.gen(function* run() {
      const batch = yield* collectGitHistory(input(), {
        observedAt: OBSERVED_AT,
        runner: cannedRunner({ ...baseResponses, "rev-parse --verify": null }),
      });

      expect(batch.events).toEqual([]);
      expect(batch.coverage.state).toBe("none");
    })
  );

  it.effect("fails with SourceUnavailable when no repo path is selected", () =>
    Effect.gen(function* run() {
      const error = yield* Effect.flip(
        collectGitHistory(input({ selectedInput: null }))
      );

      expect(error._tag).toBe("SourceUnavailable");
    })
  );

  it("publishes a schema-valid ready descriptor", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      gitHistoryDescriptor
    );

    expect(descriptor.readiness).toBe("ready");
    expect(descriptor.owner).toBe("B03");
    expect(gitHistoryCollector.descriptor).toBe(gitHistoryDescriptor);
  });
});

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const gitIn = (cwd: string, args: readonly string[], date?: string) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date ?? "2026-09-30T10:00:00Z",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_DATE: date ?? "2026-09-30T10:00:00Z",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
      },
    }
  );

describe("b03 git history collector (live temp repo)", () => {
  it.effect("collects a real feature branch against main", () =>
    Effect.gen(function* run() {
      const root = mkdtempSync(path.join(tmpdir(), "dxfr-b03-"));

      tempRoots.push(root);
      gitIn(root, ["init", "--quiet", "--initial-branch=main"]);
      writeFileSync(path.join(root, "a.txt"), "one\n");
      gitIn(root, ["add", "a.txt"]);
      gitIn(root, ["commit", "--quiet", "-m", "base"]);
      gitIn(root, ["checkout", "--quiet", "-b", "feature/demo"]);
      writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n");
      gitIn(root, ["commit", "--quiet", "-am", "f1"], "2026-09-30T11:00:00Z");
      writeFileSync(path.join(root, "b.txt"), "x\ny\n");
      gitIn(root, ["add", "b.txt"]);
      gitIn(root, ["commit", "--quiet", "-m", "f2"], "2026-09-30T11:30:00Z");
      writeFileSync(path.join(root, "a.txt"), "one\n");
      writeFileSync(path.join(root, "new.txt"), "n\n");

      const batch = yield* gitHistoryCollector.collect(
        input({ origin: "live", selectedInput: root })
      );

      const commits = batch.events.filter((e) => e.kind === "git.commit");
      const diff = batch.events.find((e) => e.kind === "git.diff");
      const reflog = batch.events.find((e) => e.kind === "git.observation");

      expect(commits).toHaveLength(2);
      expect(
        commits.map((e) => [e.payload.linesAdded, e.payload.linesDeleted])
      ).toEqual([
        [2, 0],
        [2, 0],
      ]);
      expect(commits[0]?.occurredAt).toBe("2026-09-30T11:30:00.000Z");
      expect(commits[0]?.context.branch).toBe("feature/demo");
      expect(diff?.payload).toMatchObject({
        linesDeleted: 2,
        untrackedFiles: 1,
      });
      expect(reflog?.payload).toMatchObject({
        createdFrom: "HEAD",
        observation: "branch-created",
      });
      expect(reflog?.payload.branchCreatedAt).toEqual(reflog?.occurredAt);
      expect(batch.coverage.state).toBe("complete");
      expect(batch.events[0]?.sourceVersion).toMatch(/^\d+\.\d+/u);
    })
  );
});
