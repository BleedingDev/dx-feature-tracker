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

const OBSERVED_AT = "2026-09-30T13:00:00.000Z";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const newRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "dxfr-fork-"));

  roots.push(root);

  return root;
};

const gitIn = (cwd: string, ...args: readonly string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=dxfr",
      "-c",
      "user.email=dxfr@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

const commitFile = (cwd: string, name: string, lines: number) => {
  writeFileSync(
    path.join(cwd, name),
    `${Array.from({ length: lines }, (_, i) => `${name}-${i}`).join("\n")}\n`
  );
  gitIn(cwd, "add", name);
  gitIn(cwd, "commit", "--quiet", "-m", name);
};

const repoWithParent = () => {
  const root = newRoot();

  gitIn(root, "init", "--quiet", "--initial-branch=main");
  commitFile(root, "base.txt", 1);
  gitIn(root, "checkout", "--quiet", "-b", "feature/a");
  commitFile(root, "a1.txt", 2);
  commitFile(root, "a2.txt", 2);

  return { aTip: gitIn(root, "rev-parse", "HEAD"), root };
};

const commitThree = (cwd: string) => {
  commitFile(cwd, "b1.txt", 1);
  commitFile(cwd, "b2.txt", 2);
  commitFile(cwd, "b3.txt", 3);
};

const collect = (cwd: string, baseRef?: string) =>
  collectGitHistory(
    {
      adapterId: "git-history",
      context: emptyFlightContext,
      cursor: null,
      origin: "live",
      scratchDir: null,
      selectedInput: cwd,
    } satisfies CollectInput,
    { baseRef: baseRef ?? null, observedAt: OBSERVED_AT }
  );

const commitsOf = (batch: EventBatch) =>
  batch.events.filter((event) => event.kind === "git.commit");

const baseOf = (batch: EventBatch) => {
  const bases = commitsOf(batch).map((event) => ({
    method: event.payload.baseMethod,
    ref: event.payload.baseRef,
    sha: event.payload.baseSha,
  }));

  expect(bases.length).toBeGreaterThan(0);

  for (const base of bases) {
    expect(base).toEqual(bases[0]);
  }

  return bases[0];
};

const metricsOf = (batch: EventBatch) => {
  const { results } = gitChurnMetric.compute({
    coverage: [batch.coverage],
    events: batch.events,
    manifest: fakeManifest("fork-point"),
  });

  return Object.fromEntries(results.map((r) => [r.metricId, r]));
};

describe("git-history fork point for stacked branches", () => {
  it.effect("B created from A with git branch counts only B's 3 commits", () =>
    Effect.gen(function* run() {
      const { aTip, root } = repoWithParent();

      gitIn(root, "branch", "feature/b", "feature/a");
      gitIn(root, "checkout", "--quiet", "feature/b");
      commitThree(root);

      const batch = yield* collect(root);
      const metrics = metricsOf(batch);

      expect(commitsOf(batch)).toHaveLength(3);
      expect(baseOf(batch)).toEqual({
        method: "reflog",
        ref: "feature/a",
        sha: aTip,
      });
      expect(metrics["dx.git.commits"]?.value).toBe(3);
      expect(metrics["dx.git.lines-added"]?.value).toBe(6);
      expect(metrics["dx.git.files-changed"]?.value).toBe(3);
      expect(metrics["dx.git.commits"]?.measurement).toBe("measured");
      expect(metrics["dx.git.commits"]?.reason).toContain(
        `base: method=reflog ref=feature/a sha=${aTip}`
      );
      expect(metrics["dx.git.commits"]?.checkpoint).toMatch(
        new RegExp(`^range:${aTip}\\.\\.`, "u")
      );
    })
  );

  it.effect("B created with switch -c from HEAD uses the reflog start", () =>
    Effect.gen(function* run() {
      const { aTip, root } = repoWithParent();

      gitIn(root, "switch", "--quiet", "-c", "feature/b");
      commitThree(root);
      gitIn(root, "checkout", "--quiet", "feature/a");
      commitFile(root, "a3.txt", 4);
      gitIn(root, "checkout", "--quiet", "feature/b");

      const batch = yield* collect(root);

      expect(commitsOf(batch)).toHaveLength(3);
      expect(baseOf(batch)).toEqual({
        method: "reflog",
        ref: "feature/a",
        sha: aTip,
      });
      expect(metricsOf(batch)["dx.git.lines-added"]?.value).toBe(6);
    })
  );

  it.effect("expired reflog falls back to the closest ancestor branch", () =>
    Effect.gen(function* run() {
      const { aTip, root } = repoWithParent();

      gitIn(root, "checkout", "--quiet", "-b", "feature/b");
      commitThree(root);
      gitIn(root, "checkout", "--quiet", "feature/a");
      commitFile(root, "a3.txt", 4);
      gitIn(root, "checkout", "--quiet", "-b", "feature/c", "feature/b");
      commitFile(root, "c1.txt", 1);
      gitIn(root, "checkout", "--quiet", "feature/b");
      gitIn(root, "reflog", "expire", "--expire=now", "--all");

      const batch = yield* collect(root);

      expect(commitsOf(batch)).toHaveLength(3);
      expect(baseOf(batch)).toEqual({
        method: "ancestor-branch",
        ref: "feature/a",
        sha: aTip,
      });
      expect(
        batch.events.find((event) => event.kind === "git.observation")
      ).toBeUndefined();
      expect(metricsOf(batch)["dx.git.commits"]?.value).toBe(3);
    })
  );

  it.effect(
    "branch that merged its advanced parent counts from the merge",
    () =>
      Effect.gen(function* run() {
        const { root } = repoWithParent();

        gitIn(root, "checkout", "--quiet", "-b", "feature/b");
        commitThree(root);
        gitIn(root, "checkout", "--quiet", "feature/a");
        commitFile(root, "a3.txt", 4);
        const aNew = gitIn(root, "rev-parse", "HEAD");
        gitIn(root, "checkout", "--quiet", "feature/b");
        gitIn(root, "merge", "--quiet", "--no-edit", "feature/a");

        const batch = yield* collect(root);
        const metrics = metricsOf(batch);

        expect(baseOf(batch)?.sha).toBe(aNew);
        expect(metrics["dx.git.commits"]?.value).toBe(4);
        expect(metrics["dx.git.merge-commits"]?.value).toBe(1);
        expect(metrics["dx.git.lines-added"]?.value).toBe(6);
      })
  );

  it.effect("linked worktree branch stacked on A counts its own commits", () =>
    Effect.gen(function* run() {
      const { aTip, root } = repoWithParent();
      const worktree = `${root}-wt`;

      roots.push(worktree);
      gitIn(root, "checkout", "--quiet", "main");
      gitIn(
        root,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "feature/b",
        worktree,
        "feature/a"
      );
      commitThree(worktree);

      const viaReflog = yield* collect(worktree);

      expect(commitsOf(viaReflog)).toHaveLength(3);
      expect(baseOf(viaReflog)).toEqual({
        method: "reflog",
        ref: "feature/a",
        sha: aTip,
      });
      expect(commitsOf(viaReflog)[0]?.context.worktreePath).toBe(
        gitIn(worktree, "rev-parse", "--show-toplevel")
      );

      gitIn(worktree, "reflog", "expire", "--expire=now", "--all");

      const viaAncestor = yield* collect(worktree);

      expect(commitsOf(viaAncestor)).toHaveLength(3);
      expect(baseOf(viaAncestor)).toEqual({
        method: "ancestor-branch",
        ref: "feature/a",
        sha: aTip,
      });
    })
  );

  it.effect("feature branch from main keeps the default merge-base", () =>
    Effect.gen(function* run() {
      const { root } = repoWithParent();
      const mainTip = gitIn(root, "rev-parse", "main");

      gitIn(root, "reflog", "expire", "--expire=now", "--all");

      const batch = yield* collect(root);

      expect(commitsOf(batch)).toHaveLength(2);
      expect(baseOf(batch)).toEqual({
        method: "default",
        ref: "refs/heads/main",
        sha: mainTip,
      });
    })
  );

  it.effect("main branch behaviour is unchanged", () =>
    Effect.gen(function* run() {
      const { root } = repoWithParent();

      gitIn(root, "checkout", "--quiet", "main");
      commitFile(root, "m1.txt", 1);
      gitIn(root, "branch", "feature/z");
      commitFile(root, "m2.txt", 1);

      const batch = yield* collect(root);

      expect(commitsOf(batch)).toHaveLength(3);
      expect(baseOf(batch)).toEqual({ method: null, ref: null, sha: null });
      expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
        "no-base-ref"
      );
    })
  );

  it.effect("explicit base ref bypasses fork detection", () =>
    Effect.gen(function* run() {
      const { root } = repoWithParent();
      const mainTip = gitIn(root, "rev-parse", "main");

      gitIn(root, "checkout", "--quiet", "-b", "feature/b");
      commitThree(root);

      const batch = yield* collect(root, "refs/heads/main");

      expect(commitsOf(batch)).toHaveLength(5);
      expect(baseOf(batch)).toEqual({
        method: "explicit",
        ref: "refs/heads/main",
        sha: mainTip,
      });
    })
  );
});
