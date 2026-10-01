// @effect-diagnostics nodeBuiltinImport:off -- Black-box checks of the built dft binary: dft install, status and uninstall run against a throwaway HOME with every tool's folder and a throwaway git repo.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

const dftMain = path.resolve(import.meta.dirname, "..", "dist", "dft-main.js");

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-tools-")));

const home = path.join(root, "home");

const repo = path.join(root, "repo");

for (const dir of [
  ".claude/projects",
  ".codex/sessions",
  ".pi/agent/sessions",
  ".omp/agent/sessions",
  ".dsh/sessions",
  ".local/share/opencode",
]) {
  mkdirSync(path.join(home, dir), { recursive: true });
}

execFileSync("git", ["init", "-q", "-b", "feature/tools", repo]);

const claudeLocal = path.join(repo, ".claude", "settings.local.json");

const ownSettings = '{\n  "model": "sonnet"\n}\n';

mkdirSync(path.dirname(claudeLocal), { recursive: true });

writeFileSync(claudeLocal, ownSettings);

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const CLEARED = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "DSH_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

const env = Object.fromEntries([
  ...Object.entries(process.env).filter(
    ([key]) => !CLEARED.some((name) => name === key)
  ),
  ["DFT_CURSOR_USAGE", "off"],
  ["DFT_HOME", path.join(root, "dft-home")],
  ["HOME", home],
  ["NO_COLOR", "1"],
]);

const dft = (...args: readonly string[]) =>
  spawnSync(process.execPath, [dftMain, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env,
  });

const InstallJson = Schema.fromJsonString(
  Schema.Struct({
    capture: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          steps: Schema.Array(Schema.Struct({ action: Schema.String })),
          tool: Schema.String,
        })
      ),
    }),
    detected: Schema.Array(
      Schema.Struct({ installed: Schema.Boolean, tool: Schema.String })
    ),
  })
);

const decodeInstall = Schema.decodeUnknownSync(InstallJson);

const StatusJson = Schema.fromJsonString(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        installed: Schema.Boolean,
        lastEvent: Schema.NullOr(Schema.String),
        projectCapture: Schema.Boolean,
        tool: Schema.String,
        userTelemetry: Schema.NullOr(Schema.Boolean),
      })
    ),
  })
);

const decodeStatus = Schema.decodeUnknownSync(StatusJson);

const actions = (stdout: string) =>
  decodeInstall(stdout).capture.tools.map((tool) => [
    tool.tool,
    tool.steps.map((step) => step.action),
  ]);

describe("dft install for every tool", () => {
  it("finds every tool in HOME, sets up local capture once and dft uninstall removes it", () => {
    const first = dft("install", "--json");

    expect(first.status).toBe(0);
    expect(
      decodeInstall(first.stdout).detected.map((item) => [
        item.tool,
        item.installed,
      ])
    ).toEqual([
      ["claude-code", true],
      ["codex", true],
      ["opencode", true],
      ["pi", true],
      ["omp", true],
      ["deepseek", true],
    ]);
    expect(actions(first.stdout)).toEqual([
      ["claude-code", ["updated"]],
      ["codex", ["created"]],
      ["opencode", ["created"]],
      ["pi", ["created"]],
      ["omp", ["created"]],
      ["deepseek", ["created", "created"]],
    ]);
    expect(readFileSync(claudeLocal, "utf-8")).toContain('"model": "sonnet"');

    const again = dft("install", "--json");

    expect(actions(again.stdout)).toEqual([
      ["claude-code", ["unchanged"]],
      ["codex", ["unchanged"]],
      ["opencode", ["unchanged"]],
      ["pi", ["unchanged"]],
      ["omp", ["unchanged"]],
      ["deepseek", ["unchanged", "unchanged"]],
    ]);

    const text = dft("install");

    expect(text.stdout).toContain(
      "Tool capture (this folder only, never committed)"
    );
    expect(text.stdout).toContain("dsh --patch .dsh/dft.patch.yml");
    expect(text.stdout).not.toMatch(/[–—]/u);
    expect(text.stdout).not.toContain("Cursor not found");

    expect(
      execFileSync("git", ["-C", repo, "status", "--porcelain"], {
        encoding: "utf-8",
        env,
      })
    ).toBe("?? .cursor/\n");

    const telemetry = dft("install", "--telemetry");

    expect(telemetry.stdout).toContain(
      '+ env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://127.0.0.1:7420/v1/logs"'
    );
    expect(
      readFileSync(path.join(home, ".codex", "config.toml"), "utf-8")
    ).toContain("[otel]");

    const status = dft("status", "--json", "--no-sync");

    expect(status.status).toBe(0);
    expect(
      decodeStatus(status.stdout).tools.map((tool) => [
        tool.tool,
        tool.installed,
        tool.projectCapture,
        tool.userTelemetry,
        tool.lastEvent,
      ])
    ).toEqual([
      ["claude-code", true, true, true, null],
      ["codex", true, true, true, null],
      ["opencode", true, true, null, null],
      ["pi", true, true, null, null],
      ["omp", true, true, null, null],
      ["deepseek", true, true, null, null],
    ]);

    expect(dft("status", "--no-sync").stdout).toContain(
      "project capture yes, telemetry yes, last event never"
    );

    expect(dft("uninstall", "--telemetry").status).toBe(0);
    expect(existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(false);

    const removed = dft("uninstall");

    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain("Removed what dft added");
    expect(readFileSync(claudeLocal, "utf-8")).toBe(ownSettings);

    for (const rel of [
      ".codex",
      ".pi",
      ".omp",
      ".opencode",
      ".dsh",
      ".cursor",
    ]) {
      expect(existsSync(path.join(repo, rel))).toBe(false);
    }

    expect(
      execFileSync("git", ["-C", repo, "status", "--porcelain"], {
        encoding: "utf-8",
        env,
      })
    ).toBe("?? .claude/\n");
  });

  it("sets up a tool it did not find only when asked with --tool", () => {
    const bare = path.join(root, "bare-repo");
    execFileSync("git", ["init", "-q", "-b", "main", bare]);

    const result = spawnSync(
      process.execPath,
      [dftMain, "install", "--json", "--tool", "pi,nope"],
      {
        cwd: bare,
        encoding: "utf-8",
        env: { ...env, HOME: path.join(root, "empty-home") },
      }
    );

    expect(actions(result.stdout)).toEqual([["pi", ["created"]]]);
  });
});
