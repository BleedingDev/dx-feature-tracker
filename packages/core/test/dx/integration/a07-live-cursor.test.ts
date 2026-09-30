// @effect-diagnostics nodeBuiltinImport:off -- This test owns a temporary git repo and store, and replays a sanitized live Cursor capture into them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runAnalyze } from "../../../src/dx/cli/commands/analyze.js";
import { runCollect } from "../../../src/dx/cli/commands/collect.js";
import type { DxCommandEnv } from "../../../src/dx/cli/commands/context.js";
import { selectorFromContext } from "../../../src/dx/cli/commands/context.js";
import { runExplain } from "../../../src/dx/cli/commands/explain.js";
import { cursorCliCollector } from "../../../src/dx/collectors/cursor-cli/collector.js";
import { cursorHooksCollector } from "../../../src/dx/collectors/cursor-hooks/collector.js";
import { gitHistoryCollector } from "../../../src/dx/collectors/git-history/git-history.js";
import type {
  DxCollector,
  StoreSnapshot,
} from "../../../src/dx/contracts/services.js";
import { aiUsageMetric } from "../../../src/dx/metrics/ai-usage/metric.js";
import { costMetric } from "../../../src/dx/metrics/cost/metric.js";
import { frictionMetric } from "../../../src/dx/metrics/friction/metric.js";
import { gitChurnMetric } from "../../../src/dx/metrics/git/metric.js";
import type { FlightContext } from "../../../src/dx/model/event.js";
import type { AnalyzeReport } from "../../../src/dx/model/report.js";
import { hookSpoolDirFor } from "../../../src/dx/registry/runtime.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "a07-live");

const CAPTURE_ROOT = "/tmp/a07-demo";

const BRANCH = "feature/a07-live-demo";

const REQUEST_ID = "6cae283f-4b57-4449-ba6f-33ed59ec5506";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dxfr-a07-"));

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

const makeRepo = (): FlightContext => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "repo-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "demo@example.invalid");
  git(repo, "config", "user.name", "demo");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "math.js"), "export const add = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "--no-verify", "-m", "init");
  git(repo, "checkout", "-q", "-b", BRANCH);
  fs.appendFileSync(path.join(repo, "math.js"), "export const mul = 2;\n");
  git(repo, "commit", "-q", "--no-verify", "-am", "add mul");

  return {
    branch: BRANCH,
    flightId: null,
    headSha: git(repo, "rev-parse", "HEAD"),
    repoCommonDir: path.join(repo, ".git"),
    worktreePath: repo,
  };
};

const replayCapturedSpoolInto = (repo: string): string => {
  const dir = hookSpoolDirFor(repo, path.join(scratch, "dft-home"));
  fs.mkdirSync(dir, { recursive: true });

  for (const name of fs.readdirSync(path.join(FIXTURES, "spool"))) {
    const text = fs.readFileSync(path.join(FIXTURES, "spool", name), "utf-8");
    fs.writeFileSync(path.join(dir, name), text.replaceAll(CAPTURE_ROOT, repo));
  }

  return dir;
};

const collectors: readonly DxCollector<NodeServices.NodeServices>[] = [
  gitHistoryCollector,
  cursorHooksCollector,
  cursorCliCollector,
];

const metrics = [aiUsageMetric, costMetric, gitChurnMetric, frictionMetric];

const openEnv = (name: string) =>
  Effect.map(
    openSqliteEventStore({ kind: "live", path: path.join(scratch, name) }),
    (opened) => ({
      close: opened.close,
      env: {
        store: opened.service,
        storePath: path.join(scratch, name),
      } satisfies DxCommandEnv,
    })
  );

const collectAll = (
  env: DxCommandEnv,
  context: FlightContext,
  spoolDir: string
) =>
  Effect.forEach(
    [
      { input: context.worktreePath, source: "collector.git-history" },
      { input: spoolDir, source: "collector.cursor-hooks" },
      {
        input: path.join(FIXTURES, "cursor-cli.stream.jsonl"),
        source: "collector/cursor-cli",
      },
    ],
    (step) => runCollect(env, collectors, { context, ...step })
  );

const metricHash = (report: AnalyzeReport): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        report.metrics
          .map((m) => [m.metricId, m.value, m.unit, m.measurement, m.method])
          .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))
      )
    )
    .digest("hex");

const metricValue = (report: AnalyzeReport, id: string) =>
  report.metrics.find((m) => m.metricId === id);

const eventsOf = (snapshot: StoreSnapshot, adapterId: string) =>
  snapshot.events.filter((e) => e.adapterId === adapterId);

describe("A07 live Cursor capture through real composition", () => {
  it.effect(
    "collects hooks + cursor-cli + git for one branch, dedupes, analyzes reproducibly",
    () =>
      Effect.gen(function* liveCursor() {
        const context = makeRepo();
        const spoolDir = replayCapturedSpoolInto(context.worktreePath ?? "");
        const selector = selectorFromContext(context);
        const first = yield* openEnv("live.sqlite");

        const collected = yield* collectAll(first.env, context, spoolDir);
        expect(collected.every((r) => r.inserted > 0)).toBe(true);

        const again = yield* collectAll(first.env, context, spoolDir);
        expect(again.map((r) => r.inserted)).toEqual([0, 0, 0]);
        expect(again.map((r) => r.duplicates)).toEqual(
          collected.map((r) => r.events)
        );

        const snapshot = yield* first.env.store.snapshot(selector);
        expect(snapshot.events.every((e) => e.context.branch === BRANCH)).toBe(
          true
        );

        const usage = eventsOf(snapshot, "cursor-cli").filter(
          (e) => e.kind === "ai.usage"
        );

        expect(usage).toHaveLength(1);
        expect(usage[0]?.identity.requestId).toBe(REQUEST_ID);
        expect(usage[0]?.payload).toMatchObject({
          charge: null,
          tokens: { "cached-input": 66_304, input: 34_384, output: 710 },
          toolCalls: 7,
        });

        const hooks = eventsOf(snapshot, "cursor-hooks");
        expect(hooks.some((e) => e.kind === "ai.session")).toBe(true);
        expect(hooks.filter((e) => e.kind === "ai.tool-edit").length).toBe(3);

        const a = yield* runAnalyze(first.env, metrics, {
          asOf: null,
          selector,
          snapshotId: null,
        });

        const b = yield* runAnalyze(first.env, metrics, {
          asOf: null,
          selector,
          snapshotId: null,
        });

        expect(b.snapshotId).toBe(a.snapshotId);
        expect(metricHash(b.report)).toBe(metricHash(a.report));

        expect(metricValue(a.report, "dx.git.commits")?.value).toBe(1);
        const charge = metricValue(a.report, "dx.cost.charge.usd");
        expect(charge?.value).toBeNull();
        expect(
          [
            "dx.ai-usage.tokens.input",
            "dx.ai-usage.tokens.cached-input",
            "dx.ai-usage.tokens.output",
            "dx.ai-usage.tokens.reasoning",
            "dx.ai-usage.requests",
          ].map((id) => metricValue(a.report, id)?.value ?? null)
        ).toEqual([34_384, 66_304, 710, null, 1]);

        const explained = yield* runExplain(first.env, {
          asOf: null,
          cursor: null,
          limit: 500,
          selector,
          snapshotId: a.snapshotId,
        });

        expect(explained.status).toBe("ok");
        first.close();

        const fresh = yield* openEnv("fresh.sqlite");
        yield* collectAll(fresh.env, context, spoolDir);

        const c = yield* runAnalyze(fresh.env, metrics, {
          asOf: null,
          selector,
          snapshotId: null,
        });

        expect(metricHash(c.report)).toBe(metricHash(a.report));
        fresh.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000
  );
});
