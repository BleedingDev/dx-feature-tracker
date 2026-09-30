// @effect-diagnostics nodeBuiltinImport:off -- This test scripts throwaway git repositories in the OS temp dir.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { collectGitHistory } from "../../src/dx/collectors/git-history/git-history.js";
import { fakeManifest } from "../../src/dx/contracts/fakes.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { gitChurnMetric } from "../../src/dx/metrics/git/metric.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import type { EventBatch } from "../../src/dx/model/event.js";

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
  const root = mkdtempSync(path.join(tmpdir(), "dft-rebased-"));

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
    manifest: fakeManifest("rebased-branch"),
  });

  return results.find((r) => r.metricId === "dx.git.commits")?.value;
};

describe("rebased branch commit count", () => {
  it.effect("counts a rebased branch's commits once, not per rewrite", () =>
    Effect.gen(function* rebasedOnce() {
      const root = repoWithFeature();
      const before = yield* collect(root, "feature/x");

      gitIn(root, "checkout", "--quiet", "main");
      commitFile(root, "main2.txt");
      gitIn(root, "checkout", "--quiet", "feature/x");
      gitIn(root, "rebase", "--quiet", "main");

      const after = yield* collect(root, "feature/x");

      expect(commitsValue(before)).toBe(3);
      expect(commitsValue(before, after)).toBe(3);
    })
  );
});
