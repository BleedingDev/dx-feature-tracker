// @effect-diagnostics nodeBuiltinImport:off -- This test creates an owned temporary Git repository and replay store with node:fs and git subprocesses.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Result } from "effect";

import { makeDxCapabilities } from "../../../src/dx/capabilities.js";
import {
  buildRegistry,
  allCollectors,
} from "../../../src/dx/registry/registry.js";
import {
  contextForRepo,
  dxStoreLayer,
  resolveDxStore,
  runCursorHook,
} from "../../../src/dx/registry/runtime.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dft-a02-"));

const previousDftHome = process.env.DFT_HOME;

process.env.DFT_HOME = path.join(scratch, "dft-home");

afterAll(() => {
  if (previousDftHome === undefined) {
    delete process.env.DFT_HOME;
  } else {
    process.env.DFT_HOME = previousDftHome;
  }

  fs.rmSync(scratch, { force: true, recursive: true });
});

const repo = path.join(scratch, "repo");

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

fs.mkdirSync(repo);

git("init", "-q", "-b", "main");

git("config", "user.email", "fixture@example.invalid");

git("config", "user.name", "fixture");

fs.writeFileSync(path.join(repo, "a.txt"), "a\n");

git("add", ".");

git("commit", "-qm", "init");

git("switch", "-qc", "feature/a02-spine");

fs.writeFileSync(path.join(repo, "b.txt"), "b\nc\n");

git("add", ".");

git("commit", "-qm", "feature work");

const store = resolveDxStore({
  env: {},
  home: scratch,
  replay: true,
  store: null,
});

const registry = buildRegistry();

const [status, analyze, explain, evidence, collect, mark] = makeDxCapabilities({
  collectors: allCollectors,
  defaultRepo: repo,
  registry,
  storePath: store.path,
});

const layer = Layer.mergeAll(dxStoreLayer(store), NodeServices.layer);

const metricValue = (
  metrics: readonly { readonly metricId: string; readonly value: unknown }[],
  id: string
) => metrics.find((m) => m.metricId === id)?.value;

describe("A02 composed spine over a replay store and a real Git repo", () => {
  it("admits only ready/degraded modules and lists disabled ones for status", () => {
    const disabled = registry.descriptors
      .filter((d) => d.readiness === "disabled")
      .map((d) => d.id);

    expect(disabled.length).toBeGreaterThan(0);
    expect(
      registry.collectors.every((c) => !disabled.includes(c.descriptor.id))
    ).toBe(true);
    expect(store.kind).toBe("replay");
  });

  it.effect(
    "collects Git and a hook spool, then analyzes and explains per branch",
    () =>
      Effect.gen(function* spine() {
        const hook = runCursorHook(
          JSON.stringify({
            conversation_id: "fixture-conv",
            generation_id: "fixture-gen",
            hook_event_name: "postToolUse",
            tool_name: "Shell",
            workspace_roots: [repo],
          }),
          repo,
          DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-30T12:00:00.000Z"))
        );

        expect(hook.outcome.state).toBe("spooled");

        const gitCollected = yield* collect.handler({ source: "git-history" });

        const hooksCollected = yield* collect.handler({
          source: "cursor-hooks",
        });

        const marked = yield* mark.handler({ kind: "start", label: "spine" });

        expect(gitCollected.inserted).toBeGreaterThan(0);
        expect(hooksCollected.adapterId).toBe("cursor-hooks");
        expect(marked.flightId).toContain("feature/a02-spine");

        const report = yield* analyze.handler({});
        const context = contextForRepo(repo);

        expect(report.snapshot.selector.branch).toBe("feature/a02-spine");
        expect(report.snapshot.selector.repoCommonDir).toBe(
          context.repoCommonDir
        );
        expect(metricValue(report.metrics, "dx.git.commits")).toBe(1);
        expect(metricValue(report.metrics, "dx.git.lines-added")).toBe(2);
        expect(metricValue(report.metrics, "dx.ai-usage.tokens.input")).toBe(
          null
        );
        expect(metricValue(report.metrics, "dx.cost.charge.usd")).toBe(null);

        const again = yield* analyze.handler({
          snapshotId: report.snapshot.snapshotId,
        });

        expect(again.snapshot.snapshotId).toBe(report.snapshot.snapshotId);

        const timeline = yield* explain.handler({
          snapshotId: report.snapshot.snapshotId,
        });

        const lanes = new Set(timeline.entries.map((e) => e.lane));

        expect(lanes.has("git-history")).toBe(true);
        expect(lanes.has("cursor-hooks")).toBe(true);
        expect(lanes.has("manual")).toBe(true);

        const unknown = yield* Effect.result(
          evidence.handler({
            evidenceIds: ["missing"],
            snapshotId: "snap_does_not_exist",
          })
        );

        expect(Result.isFailure(unknown)).toBe(true);

        const current = yield* status.handler({});

        expect(current.snapshotCount).toBeGreaterThan(0);
        expect(current.storePath).toBe(store.path);
      }).pipe(Effect.provide(layer))
  );

  it.effect("rejects a disabled source instead of collecting from it", () =>
    Effect.gen(function* disabledSource() {
      const outcome = yield* Effect.result(
        collect.handler({ source: "collector/cursor-sdk" })
      );

      expect(Result.isFailure(outcome)).toBe(true);
    }).pipe(Effect.provide(layer))
  );
});
