// @effect-diagnostics nodeBuiltinImport:off -- This test creates an owned temporary Git repository, Cursor hook spool and SQLite stores with node:fs and git subprocesses.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { runAnalyze } from "../../../src/dx/cli/commands/analyze.js";
import { runCollect } from "../../../src/dx/cli/commands/collect.js";
import { runExplain } from "../../../src/dx/cli/commands/explain.js";
import { captureCommand } from "../../../src/dx/collectors/shell-command/capture.js";
import { autoSources, commandLogPath } from "../../../src/dx/composition.js";
import type { MetricResult } from "../../../src/dx/model/metric.js";
import { buildRegistry } from "../../../src/dx/registry/registry.js";
import {
  contextForRepo,
  runCursorHook,
  selectorForContext,
} from "../../../src/dx/registry/runtime.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dxfr-a07-"));

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const repo = path.join(scratch, "repo");

const branch = "feature/a07-rebuild";

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

fs.mkdirSync(repo);

git("init", "-q", "-b", "main");

git("config", "user.email", "fixture@example.invalid");

git("config", "user.name", "fixture");

fs.writeFileSync(path.join(repo, ".gitignore"), ".dx-flight-recorder/\n");

fs.writeFileSync(path.join(repo, "math.mjs"), "export const add = 1;\n");

git("add", ".");

git("commit", "-qm", "init");

git("switch", "-qc", branch);

fs.writeFileSync(
  path.join(repo, "math.mjs"),
  "export const add = 1;\nexport const mul = 2;\nexport const sub = 3;\n"
);

git("add", ".");

git("commit", "-qm", "agent work");

const hookFixture = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "b05",
  "agent-turns.jsonl"
);

const hookLines = fs
  .readFileSync(hookFixture, "utf-8")
  .split("\n")
  .filter((line) => line.trim() !== "");

const cliStream = path.join(scratch, "cursor-cli.stream.jsonl");

fs.writeFileSync(
  cliStream,
  `${[
    {
      apiKeySource: "login",
      cwd: repo,
      model: "fixture-model",
      session_id: "a07-fixture-session",
      subtype: "init",
      type: "system",
    },
    {
      duration_api_ms: 1800,
      duration_ms: 1900,
      is_error: false,
      request_id: "a07-fixture-request",
      result: "fixture",
      session_id: "a07-fixture-session",
      subtype: "success",
      type: "result",
      usage: {
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        inputTokens: 120,
        outputTokens: 30,
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`
);

const hookAt = DateTime.toDateUtc(
  DateTime.makeUnsafe("2026-09-30T12:00:00.000Z")
);

for (const line of hookLines) {
  runCursorHook(
    JSON.stringify({ ...JSON.parse(line), workspace_roots: [repo] }),
    repo,
    hookAt
  );
}

const registry = buildRegistry();

const context = contextForRepo(repo);

const selector = selectorForContext(context);

const metricHash = (metrics: readonly MetricResult[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        metrics
          .map((m) => [m.metricId, m.value, m.unit, m.measurement, m.reason])
          .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))
      )
    )
    .digest("hex");

const recordFlight = (storePath: string) =>
  Effect.gen(function* recordOne() {
    const opened = yield* openSqliteEventStore({
      kind: "replay",
      path: storePath,
    });

    const env = { store: opened.service, storePath };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        opened.close();
      })
    );

    if (!fs.existsSync(commandLogPath(storePath))) {
      yield* captureCommand({
        argv: [process.execPath, "-e", ""],
        context,
        cwd: repo,
        logPath: commandLogPath(storePath),
      });
    }

    const sources = [
      ...autoSources(context, repo, storePath),
      { input: cliStream, source: "collector/cursor-cli" },
    ];

    const collectOne = (s: (typeof sources)[number]) =>
      runCollect(env, registry.collectors, {
        context,
        input: s.input,
        source: s.source,
      });

    const collected = yield* Effect.forEach(collectOne)(sources);

    const first = yield* runAnalyze(env, registry.metrics, {
      asOf: null,
      selector,
      snapshotId: null,
    });

    const pinned = yield* runAnalyze(env, registry.metrics, {
      asOf: null,
      selector,
      snapshotId: first.snapshotId,
    });

    const explained = yield* runExplain(env, {
      asOf: null,
      cursor: null,
      limit: 500,
      selector,
      snapshotId: first.snapshotId,
    });

    const snapshot = yield* opened.service.getSnapshot(first.snapshotId);

    return { collected, explained, first, pinned, snapshot };
  }).pipe(Effect.scoped);

describe("A07 composed recorder: collect, store, analyze, rebuild", () => {
  it.effect(
    "records one branch from git, Cursor hooks, cursor-agent usage and a captured command, and a fresh store rebuilds the same metrics",
    () =>
      Effect.gen(function* rebuild() {
        const storeA = path.join(scratch, "a", "dx.sqlite");
        const storeB = path.join(scratch, "b", "dx.sqlite");
        fs.mkdirSync(path.dirname(storeA), { recursive: true });
        fs.mkdirSync(path.dirname(storeB), { recursive: true });

        const a = yield* recordFlight(storeA);

        expect(a.collected.map((c) => c.adapterId).toSorted()).toEqual([
          "command-capture",
          "cursor-cli",
          "cursor-hooks",
          "git-history",
        ]);
        expect(a.collected.every((c) => c.inserted > 0)).toBe(true);
        expect(a.first.report.snapshot.selector.branch).toBe(branch);
        expect(a.pinned.snapshotId).toBe(a.first.snapshotId);
        expect(metricHash(a.pinned.report.metrics)).toBe(
          metricHash(a.first.report.metrics)
        );

        const value = (id: string) =>
          a.first.report.metrics.find((m) => m.metricId === id)?.value;

        expect(value("dx.git.commits")).toBe(1);
        expect(value("dx.git.lines-added")).toBe(2);
        expect(value("dx.cost.charge.usd")).toBe(null);
        expect(value("dx.ai-usage.tokens.input")).toBe(120);
        expect(value("dx.ai-usage.tokens.cached-input")).toBe(400);
        expect(value("dx.ai-usage.tokens.output")).toBe(30);
        expect(value("dx.ai-usage.tokens.reasoning")).toBe(null);
        expect(value("dx.ai-usage.requests")).toBe(1);

        const usage = a.snapshot.events.find(
          (e) => e.adapterId === "cursor-cli" && e.kind === "ai.usage"
        );

        expect(usage?.context.branch).toBe(branch);
        expect(usage?.payload.tokens).toMatchObject({
          "cached-input": 400,
          input: 120,
          output: 30,
        });
        expect(
          a.snapshot.events.every((e) => e.context.branch === branch)
        ).toBe(true);
        expect(JSON.stringify(a.snapshot.events)).not.toContain(
          "FIXTURE PROMPT"
        );
        expect(a.explained.status).toBe("ok");

        const recollected = yield* recordFlight(storeA);

        expect(recollected.collected.every((c) => c.inserted === 0)).toBe(true);

        fs.copyFileSync(commandLogPath(storeA), commandLogPath(storeB));

        const b = yield* recordFlight(storeB);

        expect(metricHash(b.first.report.metrics)).toBe(
          metricHash(a.first.report.metrics)
        );
        expect(b.snapshot.events.map((e) => e.eventId).toSorted()).toEqual(
          a.snapshot.events.map((e) => e.eventId).toSorted()
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
