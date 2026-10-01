// @effect-diagnostics nodeBuiltinImport:off -- Black-box checks of the built dft binary: they spawn dist/dft-main.js with hook payloads on stdin inside a throwaway git repo and DFT_HOME.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

const dftMain = path.resolve(import.meta.dirname, "..", "dist", "dft-main.js");

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-hook-")));

const home = path.join(root, "home");

const dftHome = path.join(root, "dft-home");

const repo = path.join(root, "repo");

execFileSync("git", ["init", "-q", "-b", "feature/hooks", repo]);

execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "user.name=fixture",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "init",
]);

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const hook = (args: readonly string[], payload: string) =>
  spawnSync(process.execPath, [dftMain, "hook", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      DFT_CURSOR_USAGE: "off",
      DFT_HOME: dftHome,
      HOME: home,
      NO_COLOR: "1",
    },
    input: payload,
  });

const filesUnder = (dir: string): readonly string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))
    : [];

describe("dft hook <tool> <event>", () => {
  it("records a Claude Code observation under DFT_HOME and stays silent", () => {
    const result = hook(
      ["claude-code", "Stop"],
      JSON.stringify({
        cwd: repo,
        hook_event_name: "Stop",
        prompt: "do not keep this prompt",
        session_id: "session-1",
        transcript_path: "/x/session-1.jsonl",
      })
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");

    const files = filesUnder(path.join(dftHome, "hooks", "claude-code"));

    expect(files.length).toBe(1);

    const text = readFileSync(files[0] ?? "", "utf-8");

    expect(text).not.toContain("do not keep this prompt");
    expect(text).toContain('"branch":"feature/hooks"');
    expect(text).toContain('"sessionId":"session-1"');
    expect(text).toContain('"event":"Stop"');
    expect(filesUnder(path.join(repo, ".dft"))).toStrictEqual([]);
  });

  it("keeps plain dft hook working for Cursor with its JSON response", () => {
    const result = hook(
      [],
      JSON.stringify({
        conversation_id: "c1",
        generation_id: "g1",
        hook_event_name: "beforeSubmitPrompt",
        prompt: "secret",
        workspace_roots: [repo],
      })
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toStrictEqual({ continue: true });
    expect(filesUnder(path.join(dftHome, "spool")).length).toBe(1);
  });

  it("exits 0 without output for an unknown tool or a broken payload", () => {
    const unknown = hook(["notatool", "Stop"], "{}");

    expect(unknown.status).toBe(0);
    expect(unknown.stdout).toBe("");

    const broken = hook(["codex", "Stop"], "not json");

    expect(broken.status).toBe(0);
    expect(broken.stdout).toBe("");
    expect(filesUnder(path.join(dftHome, "hooks", "codex")).length).toBe(1);
  });
});
