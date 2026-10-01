// @effect-diagnostics nodeBuiltinImport:off -- This test scripts throwaway git repositories in the OS temp dir.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { collectGitHistory } from "../../src/dx/collectors/git-history/git-history.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { gitChurnMetric } from "../../src/dx/metrics/git/metric.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import type { EventBatch } from "../../src/dx/model/event.js";
import { fakeManifest } from "./fakes.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const gitIn = (cwd: string, ...args: readonly string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=dft",
      "-c",
      "user.email=dft@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

const commitFile = (cwd: string, name: string) => {
  writeFileSync(path.join(cwd, name), `${name}\n`);
  gitIn(cwd, "add", name);
  gitIn(cwd, "commit", "--quiet", "-m", name);
};

const repoWithFeature = () => {
  const root = mkdtempSync(path.join(tmpdir(), "dft-merged-"));

  roots.push(root);
  gitIn(root, "init", "--quiet", "--initial-branch=main");
  commitFile(root, "base.txt");
  gitIn(root, "checkout", "--quiet", "-b", "feature/x");
  commitFile(root, "x1.txt");
  commitFile(root, "x2.txt");
  commitFile(root, "x3.txt");

  return root;
};

const collect = (cwd: string, branch: string | null = null) =>
  collectGitHistory(
    {
      adapterId: "git-history",
      context: { ...emptyFlightContext, branch },
      cursor: null,
      origin: "live",
      scratchDir: null,
      selectedInput: cwd,
    } satisfies CollectInput,
    { observedAt: "2026-09-30T13:00:00.000Z" }
  );

const commitsValue = (...batches: readonly EventBatch[]) => {
  const { results } = gitChurnMetric.compute({
    coverage: batches.map((batch) => batch.coverage),
    events: batches.flatMap((batch) => batch.events),
    manifest: fakeManifest("merged-branch"),
  });

  return results.find((r) => r.metricId === "dx.git.commits")?.value;
};

describe("git-history commits of merged branches", () => {
  it.effect("counts a --no-ff merged branch's own commits", () =>
    Effect.gen(function* run() {
      const root = repoWithFeature();

      gitIn(root, "checkout", "--quiet", "main");
      commitFile(root, "main1.txt");
      gitIn(root, "merge", "--quiet", "--no-ff", "-m", "merge", "feature/x");
      gitIn(root, "checkout", "--quiet", "feature/x");

      expect(commitsValue(yield* collect(root))).toBe(3);
    })
  );

  it.effect("counts a fast-forwarded branch's own commits", () =>
    Effect.gen(function* run() {
      const root = repoWithFeature();

      gitIn(root, "checkout", "--quiet", "main");
      gitIn(root, "merge", "--quiet", "--ff-only", "feature/x");
      gitIn(root, "checkout", "--quiet", "feature/x");

      expect(commitsValue(yield* collect(root))).toBe(3);
    })
  );

  it.effect("keeps stored commits of a squash-merged, deleted branch", () =>
    Effect.gen(function* run() {
      const root = repoWithFeature();
      const before = yield* collect(root);

      gitIn(root, "checkout", "--quiet", "main");
      gitIn(root, "merge", "--quiet", "--squash", "feature/x");
      gitIn(root, "commit", "--quiet", "-m", "squash");
      gitIn(root, "branch", "--quiet", "-D", "feature/x");

      const after = yield* collect(root, "feature/x");

      expect(after.events).toHaveLength(0);
      expect(commitsValue(before, after)).toBe(3);
    })
  );

  it.effect("keeps stored commits of a merged, deleted branch", () =>
    Effect.gen(function* run() {
      const root = repoWithFeature();
      const before = yield* collect(root);

      gitIn(root, "checkout", "--quiet", "main");
      gitIn(root, "merge", "--quiet", "--no-ff", "-m", "merge", "feature/x");
      gitIn(root, "branch", "--quiet", "-d", "feature/x");

      const after = yield* collect(root, "feature/x");

      expect(commitsValue(before, after)).toBe(3);
    })
  );

  it.effect("collects a branch that is not checked out", () =>
    Effect.gen(function* run() {
      const root = repoWithFeature();

      gitIn(root, "checkout", "--quiet", "main");
      commitFile(root, "main1.txt");

      const batch = yield* collect(root, "feature/x");

      expect(
        batch.events.every((event) => event.context.branch === "feature/x")
      ).toBe(true);
      expect(batch.events.some((event) => event.kind === "git.diff")).toBe(
        false
      );
      expect(commitsValue(batch)).toBe(3);
    })
  );
});
