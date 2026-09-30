// @effect-diagnostics nodeBuiltinImport:off -- This test reads committed git output fixtures and builds a throwaway git repository in the OS temp dir.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { collectGitHistory } from "../../src/dx/collectors/git-history/git-history.js";
import type { GitRunner } from "../../src/dx/collectors/git-history/git-history.js";
import { SourceUnavailable } from "../../src/dx/contracts/error-source-unavailable.js";
import { fakeManifest } from "../../src/dx/contracts/fakes.js";
import type {
  CollectInput,
  StoreSnapshot,
} from "../../src/dx/contracts/services.js";
import {
  gitChurnDescriptor,
  gitChurnMetric,
} from "../../src/dx/metrics/git/metric.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import type { EventBatch } from "../../src/dx/model/event.js";
import {
  MetricResultSchema,
  isHonestMetric,
} from "../../src/dx/model/metric.js";
import type { MetricResult } from "../../src/dx/model/metric.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "b28");

const fixture = (name: string) =>
  readFileSync(path.join(fixtureDir, name), "utf-8");

const HEAD = "1".repeat(40);

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
          new SourceUnavailable({ adapterId: "git-history", message: key })
        )
      : Effect.succeed(value);
  };

const responses = {
  "diff --no-color": fixture("worktree-numstat.txt"),
  "log --no-color": fixture("log-numstat.txt"),
  "ls-files --others": "notes.txt\n",
  "merge-base": `${BASE}\n`,
  "reflog show": fixture("reflog.txt"),
  "rev-parse --path-format=absolute": "/fixture/repo/.git\n",
  "rev-parse --show-toplevel": "/fixture/repo\n",
  "rev-parse --verify": `${HEAD}\n`,
  "symbolic-ref --quiet": "feature/cost\n",
  version: "git version 2.51.0\n",
} satisfies Readonly<Record<string, string | null>>;

const snapshotOf = (...batches: readonly EventBatch[]): StoreSnapshot => ({
  coverage: batches.map((batch) => batch.coverage),
  events: batches.flatMap((batch) => batch.events),
  manifest: fakeManifest("b28-snapshot"),
});

const byId = (results: readonly MetricResult[]) =>
  Object.fromEntries(results.map((r) => [r.metricId, r]));

const values = (results: readonly MetricResult[]) =>
  Object.fromEntries(results.map((r) => [r.metricId, r.value]));

describe("b28 git churn metric (fixture b28-branch-snapshot)", () => {
  it.effect("summarizes commits, lines, files and rework per branch", () =>
    Effect.gen(function* run() {
      const batch = yield* collectGitHistory(input(), {
        observedAt: OBSERVED_AT,
        runner: cannedRunner(responses),
      });

      const { results, findings } = gitChurnMetric.compute(snapshotOf(batch));

      for (const result of results) {
        yield* Schema.decodeEffect(MetricResultSchema)(result);
        expect(isHonestMetric(result)).toBe(true);
      }

      expect(findings).toEqual([]);
      expect(values(results)).toEqual({
        "dx.git.churn-lines": 23,
        "dx.git.commits": 4,
        "dx.git.files-changed": 4,
        "dx.git.files-retouched": 1,
        "dx.git.lines-added": 20,
        "dx.git.lines-deleted": 3,
        "dx.git.merge-commits": 1,
        "dx.git.uncommitted-files": 1,
        "dx.git.uncommitted-lines-added": 5,
        "dx.git.uncommitted-lines-deleted": 1,
        "dx.git.untracked-files": 1,
      });

      const lines = byId(results)["dx.git.lines-added"];

      expect(lines?.checkpoint).toBe(`range:${BASE}..${HEAD}`);
      expect(lines?.measurement).toBe("measured");
      expect(lines?.method).toBe("observed");
      expect(lines?.attribution).toBe("not-applicable");
      expect(lines?.evidenceIds).toHaveLength(4);
      expect(lines?.reason).toContain("1 merge commit(s) contribute no lines");
      expect(lines?.reason).toContain("1 binary file change(s)");
    })
  );

  it.effect("collapses re-collected commits by SHA", () =>
    Effect.gen(function* run() {
      const first = yield* collectGitHistory(input(), {
        observedAt: OBSERVED_AT,
        runner: cannedRunner(responses),
      });

      const again = yield* collectGitHistory(input(), {
        observedAt: "2026-09-30T13:05:00.000Z",
        runner: cannedRunner(responses),
      });

      const { results } = gitChurnMetric.compute(snapshotOf(first, again));

      expect(values(results)["dx.git.commits"]).toBe(4);
      expect(values(results)["dx.git.lines-added"]).toBe(20);
    })
  );

  it.effect("marks the range partial when no base SHA resolves", () =>
    Effect.gen(function* run() {
      const batch = yield* collectGitHistory(input(), {
        observedAt: OBSERVED_AT,
        runner: cannedRunner({ ...responses, "merge-base": null }),
      });

      const commits = byId(gitChurnMetric.compute(snapshotOf(batch)).results)[
        "dx.git.commits"
      ];

      expect(commits?.measurement).toBe("partial");
      expect(commits?.checkpoint).toBe(`range:unbounded..${HEAD}`);
      expect(commits?.reason).toContain("no-base-ref");
    })
  );

  it("reports unavailable, never zero, when no git data was collected", () => {
    const { results } = gitChurnMetric.compute({
      coverage: [],
      events: [],
      manifest: fakeManifest("empty"),
    });

    for (const result of results) {
      expect(result.value).toBeNull();
      expect(result.measurement).toBe("unavailable");
      expect(isHonestMetric(result)).toBe(true);
    }
  });

  it("publishes a schema-valid ready descriptor", () => {
    const decoded = Schema.decodeSync(ModuleDescriptorSchema)(
      gitChurnDescriptor
    );

    expect(decoded.readiness).toBe("ready");
    expect(decoded.owner).toBe("B28");
    expect(decoded.supportedFields).toContain("dx.git.churn-lines");
    expect(decoded.gaps.map((gap) => gap.code)).toContain(
      "base-sha-definition"
    );
  });
});

describe("b28 git churn metric (fixture b28-live-temp-repo)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dft-b28-"));

  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  const git = (...args: readonly string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=dft",
        "-c",
        "user.email=dft@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );

  it.effect("measures a real feature branch against its merge-base", () =>
    Effect.gen(function* run() {
      git("init", "--quiet", "--initial-branch=main");
      writeFileSync(path.join(dir, "base.txt"), "base\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD").trim();
      git("checkout", "--quiet", "-b", "feature/live");
      writeFileSync(path.join(dir, "app.ts"), "a\nb\nc\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "one");
      writeFileSync(path.join(dir, "app.ts"), "a\nB\nc\nd\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "two");
      writeFileSync(path.join(dir, "app.ts"), "a\nB\nc\nd\ne\n");

      const batch = yield* collectGitHistory(
        input({ origin: "live", selectedInput: dir }),
        { observedAt: OBSERVED_AT }
      );

      const { results } = gitChurnMetric.compute(snapshotOf(batch));
      const summary = values(results);

      expect(summary["dx.git.commits"]).toBe(2);
      expect(summary["dx.git.lines-added"]).toBe(5);
      expect(summary["dx.git.lines-deleted"]).toBe(1);
      expect(summary["dx.git.files-changed"]).toBe(1);
      expect(summary["dx.git.files-retouched"]).toBe(1);
      expect(summary["dx.git.uncommitted-lines-added"]).toBe(1);
      expect(byId(results)["dx.git.commits"]?.checkpoint).toMatch(
        new RegExp(`^range:${base}\\.\\.[0-9a-f]{40}$`, "u")
      );
    })
  );
});
