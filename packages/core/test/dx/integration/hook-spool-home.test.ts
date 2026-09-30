// @effect-diagnostics nodeBuiltinImport:off -- This test creates an owned temporary Git repository, DFT_HOME and SQLite store with node:fs and git subprocesses.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { handleCursorHook } from "../../../src/dx/collectors/cursor-hooks/handler.js";
import { allCollectors } from "../../../src/dx/registry/registry.js";
import {
  hookSpoolDirFor,
  legacyHookSpoolDirFor,
  resolveCanonicalGit,
  runCursorHook,
} from "../../../src/dx/registry/runtime.js";
import { autoSync } from "../../../src/dx/registry/sync.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-hook-home-"))
);

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const dftHome = path.join(scratch, "dft-home");

const repo = path.join(scratch, "my-repo");

const git = (...args: readonly string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });

fs.mkdirSync(repo);

git("init", "-q", "-b", "main");

git("config", "user.email", "fixture@example.invalid");

git("config", "user.name", "fixture");

fs.writeFileSync(path.join(repo, "a.txt"), "a\n");

git("add", ".");

git("commit", "-qm", "init");

const hookPayload = (generation: string): string =>
  JSON.stringify({
    conversation_id: "conv-home",
    generation_id: generation,
    hook_event_name: "postToolUse",
    tool_name: "Shell",
    workspace_roots: [repo],
  });

const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-30T12:00:00.000Z"));

describe("Cursor hook spool lives under DFT_HOME", () => {
  it("writes the spool under DFT_HOME and never inside the worktree", () => {
    const result = runCursorHook(hookPayload("gen-1"), repo, now, dftHome);

    expect(result.outcome.state).toBe("spooled");

    const spoolDir = hookSpoolDirFor(repo, dftHome);

    expect(spoolDir.startsWith(path.join(dftHome, "spool"))).toBe(true);
    expect(path.basename(path.dirname(spoolDir))).toMatch(
      /^my-repo-[0-9a-f]{8}$/u
    );
    expect(result.outcome.state === "spooled" && result.outcome.path).toContain(
      spoolDir
    );
    expect(fs.readdirSync(spoolDir).length).toBe(1);
    expect(fs.existsSync(legacyHookSpoolDirFor(repo))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });

  it.effect("imports a legacy in-repo spool once and keeps the folder", () =>
    Effect.gen(function* legacyImport() {
      const legacy = legacyHookSpoolDirFor(repo);

      handleCursorHook(hookPayload("gen-legacy"), {
        cwd: repo,
        now,
        resolveGit: resolveCanonicalGit,
        spoolDirFor: legacyHookSpoolDirFor,
      });

      expect(fs.readdirSync(legacy).length).toBe(1);

      const storePath = path.join(scratch, "store", "dft.db");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });

      const opened = yield* openSqliteEventStore({
        kind: "live",
        path: storePath,
      });

      const options = { cwd: repo, dftHome, home: scratch, repo, storePath };

      const first = yield* autoSync(opened.service, allCollectors, options);
      const second = yield* autoSync(opened.service, allCollectors, options);

      opened.close();

      const legacyStep = (steps: typeof first.steps) =>
        steps.find((step) => step.input === legacy);

      expect(legacyStep(first.steps)?.inserted).toBeGreaterThan(0);
      expect(legacyStep(second.steps)?.inserted).toBe(0);
      expect(
        first.steps.find(
          (step) => step.input === hookSpoolDirFor(repo, dftHome)
        )?.status
      ).toBe("synced");
      expect(fs.existsSync(legacy)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});
