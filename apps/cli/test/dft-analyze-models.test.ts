// @effect-diagnostics nodeBuiltinImport:off -- The test scripts a throwaway git repo and DFT_HOME and spawns the built dft binary.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { runCursorHook } from "@rat-stack/core/dx";
import { DateTime } from "effect";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "dft-analyze-models-"))
);

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const dftHome = path.join(scratch, "dft-home");

const repo = path.join(scratch, "app");

const cliPath = path.resolve(import.meta.dirname, "../dist/dft-main.js");

const git = (...args: readonly string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const makeRepo = () => {
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  fs.writeFileSync(path.join(repo, "a.txt"), "app\n");
  git("add", ".");
  git("commit", "-q", "--no-gpg-sign", "-m", "init");
};

makeRepo();

const hookAt = (event: string, generation: string, at: string) =>
  runCursorHook(
    JSON.stringify({
      conversation_id: "conv-models",
      generation_id: generation,
      hook_event_name: event,
      model: "fixture-model",
      workspace_roots: [repo],
    }),
    repo,
    DateTime.toDateUtc(DateTime.makeUnsafe(at)),
    dftHome
  );

describe("dft analyze models", () => {
  it("shows the models of a Cursor branch whose hooks carry no tokens", () => {
    expect(
      hookAt("beforeSubmitPrompt", "gen-1", "2026-09-30T12:00:00.000Z").outcome
        .state
    ).toBe("spooled");
    expect(
      hookAt("stop", "gen-1", "2026-09-30T12:01:00.000Z").outcome.state
    ).toBe("spooled");

    const analyze = spawnSync(process.execPath, [cliPath, "analyze"], {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...process.env,
        DFT_CURSOR_USAGE: "off",
        DFT_HOME: dftHome,
        DFT_PRICE_CATALOG: "off",
        HOME: scratch,
      },
    });

    expect(analyze.status).toBe(0);
    expect(analyze.stdout).toMatch(/Models\s+fixture-model 100%/u);
  });
});
