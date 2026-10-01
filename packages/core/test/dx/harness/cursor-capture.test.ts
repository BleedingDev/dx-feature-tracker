// @effect-diagnostics nodeBuiltinImport:off -- This test owns a temporary DFT_HOME and writes hook spool files the way hook processes do.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import { cursorSpoolDirFor } from "../../../src/dx/collectors/cursor-hooks/spool-dirs.js";
import { cursorSpoolWatch } from "../../../src/dx/harness/cursor/capture.js";
import { HOOK_OBSERVATION_SCHEMA } from "../../../src/dx/harness/hook-observation.js";
import type { HookObservation } from "../../../src/dx/harness/hook-observation.js";
import {
  ACCOUNT_POLLS,
  hookSpoolWatch,
  LIVE_CAPTURES,
} from "../../../src/dx/live/capture.js";
import { DEFAULT_LIVE_CONFIG } from "../../../src/dx/live/config.js";
import { runToolHook } from "../../../src/dx/registry/runtime.js";

const scratch = mkdtempSync(path.join(os.tmpdir(), "dft-cursor-capture-"));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const NOW = DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-01T09:00:00.000Z"));

const stopPayload = JSON.stringify({
  conversation_id: "conv-capture",
  generation_id: "gen-capture",
  hook_event_name: "stop",
  status: "completed",
});

const observation = (repoCommonDir: string | null): HookObservation => ({
  event: "Stop",
  fields: {
    agentId: null,
    agentType: null,
    cwd: null,
    effort: null,
    model: null,
    parentSessionId: null,
    sessionId: "s1",
    transcriptPath: null,
    turnId: null,
  },
  git: {
    branch: null,
    headSha: null,
    repoCommonDir,
    worktreePath: null,
  },
  observedAt: NOW.toISOString(),
  payloadValid: true,
  schema: HOOK_OBSERVATION_SCHEMA,
  tool: "claude-code",
});

describe("dft hook cursor <event>", () => {
  it("spools into the Cursor worktree spool, the same as plain dft hook", () => {
    const dftHome = path.join(scratch, "hook-home");
    const cwd = path.join(scratch, "not-a-repo");

    mkdirSync(cwd, { recursive: true });

    const named = runToolHook(
      { cwd, event: "stop", now: NOW, stdinText: stopPayload, tool: "cursor" },
      dftHome
    );

    const plain = runToolHook(
      { cwd, event: null, now: NOW, stdinText: stopPayload, tool: null },
      dftHome
    );

    expect(named.outcome.state).toBe("spooled");
    expect(plain.outcome).toStrictEqual(named.outcome);
    expect(named.stdout).toBe("{}");

    const written = named.outcome.state === "skipped" ? "" : named.outcome.path;

    expect(path.dirname(written)).toBe(cursorSpoolDirFor(cwd, dftHome));
  });
});

describe("live capture per tool", () => {
  it("watches a spool for every tool and polls only Cursor's account", () => {
    expect(LIVE_CAPTURES.map((capture) => capture.harness).toSorted()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "deepseek",
      "omp",
      "opencode",
      "pi",
    ]);
    expect(ACCOUNT_POLLS).toHaveLength(1);
    expect(ACCOUNT_POLLS[0]?.source).toBe("collector.cursor-usage-api");
    expect(ACCOUNT_POLLS[0]?.enabled(DEFAULT_LIVE_CONFIG)).toBe(true);
    expect(
      ACCOUNT_POLLS[0]?.enabled({
        ...DEFAULT_LIVE_CONFIG,
        cursorUsageImport: false,
      })
    ).toBe(false);
  });

  it("maps a tool hook spool day to the repo of its newest observation", () => {
    const dftHome = path.join(scratch, "watch-home");
    const watch = hookSpoolWatch(dftHome, "claude-code");
    const day = "2026-10-01.jsonl";

    mkdirSync(watch.root, { recursive: true });
    appendFileSync(
      watch.pathOf(day),
      [
        JSON.stringify(observation("/work/one/.git")),
        JSON.stringify(observation("/work/two/.git")),
        "not json",
        "",
      ].join("\n")
    );

    expect(watch.keys()).toEqual([day]);
    expect(watch.keyOf(day)).toBe(day);
    expect(watch.keyOf("2026-10-01.jsonl.tmp")).toBeNull();
    expect(watch.commonDirOf(day)).toBe("/work/two/.git");
    expect(watch.keyForWorktree).toBeNull();
  });

  it("maps a Cursor spool folder to the repo its hook recorded", () => {
    const dftHome = path.join(scratch, "cursor-watch-home");
    const cwd = path.join(scratch, "cursor-cwd");

    mkdirSync(cwd, { recursive: true });
    runToolHook(
      { cwd, event: "stop", now: NOW, stdinText: stopPayload, tool: "cursor" },
      dftHome
    );

    const watch = cursorSpoolWatch(dftHome);
    const [key] = watch.keys();

    expect(key).toBeDefined();
    expect(watch.keyForWorktree?.(cwd)).toBe(key);
    expect(watch.keyOf(path.join(key ?? "", "cursor-hooks", "x.json"))).toBe(
      key
    );
    expect(watch.keyOf(key ?? "")).toBeNull();
    expect(watch.commonDirOf(key ?? "")).toBeNull();
  });
});
