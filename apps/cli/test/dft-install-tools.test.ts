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
  it(
    "finds every tool in HOME, sets up local capture once and dft uninstall removes it",
    { timeout: 120_000 },
    () => {
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
      ).toBe("");

      const telemetry = dft("install", "--telemetry");

      expect(telemetry.stdout).toContain(
        '+ env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://127.0.0.1:7420/v1/logs"'
      );
      expect(
        readFileSync(path.join(home, ".codex", "config.toml"), "utf-8")
      ).toContain("[otel]");

      const status = dft("status", "--json", "--no-sync", "--probe-sources");

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
        ["cursor", false, true, null, null],
        ["claude-code", true, true, true, null],
        ["codex", true, true, true, null],
        ["opencode", true, true, null, null],
        ["pi", true, true, null, null],
        ["omp", true, true, null, null],
        ["deepseek", true, true, null, null],
      ]);

      expect(dft("status", "--no-sync", "--probe-sources").stdout).toContain(
        "project capture yes, telemetry yes, last event never"
      );

      expect(dft("uninstall", "--telemetry").status).toBe(0);
      expect(existsSync(path.join(home, ".claude", "settings.json"))).toBe(
        false
      );
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
    }
  );

  it("sets up a tool it did not find only when asked with --tool", () => {
    const bare = path.join(root, "bare-repo");
    execFileSync("git", ["init", "-q", "-b", "main", bare]);

    const install = (tools: string) =>
      spawnSync(
        process.execPath,
        [dftMain, "install", "--json", "--tool", tools],
        {
          cwd: bare,
          encoding: "utf-8",
          env: { ...env, HOME: path.join(root, "empty-home") },
        }
      );

    const misspelled = install("pi,codx");

    expect(misspelled.status).not.toBe(0);
    expect(misspelled.stderr).toContain("(unknown: codx)");
    expect(misspelled.stderr).toContain(
      "claude-code, codex, opencode, pi, omp, deepseek"
    );
    expect(existsSync(path.join(bare, ".pi"))).toBe(false);

    expect(actions(install("pi").stdout)).toEqual([["pi", ["created"]]]);
  });

  it("installs Codex guidance and preserves edited skills and unrelated agent files", () => {
    const project = path.join(root, "codex-guidance-repo");

    const ownSkill = path.join(
      project,
      ".agents",
      "skills",
      "my-skill",
      "SKILL.md"
    );

    execFileSync("git", ["init", "-q", "-b", "main", project]);
    mkdirSync(path.dirname(ownSkill), { recursive: true });
    writeFileSync(ownSkill, "# user skill fixture\n");

    const run = (...args: readonly string[]) =>
      spawnSync(process.execPath, [dftMain, ...args], {
        cwd: project,
        encoding: "utf-8",
        env,
      });

    expect(run("install", "--tool", "codex", "--json").status).toBe(0);

    const installed = path.join(
      project,
      ".agents",
      "skills",
      "dx-analyze",
      "SKILL.md"
    );

    expect(readFileSync(installed, "utf-8")).toContain("dx.agent.v1");
    writeFileSync(installed, "# user changed this guidance fixture\n");
    expect(run("install", "--tool", "codex", "--json").status).toBe(0);
    expect(readFileSync(installed, "utf-8")).toBe(
      "# user changed this guidance fixture\n"
    );
    expect(run("uninstall").status).toBe(0);
    expect(readFileSync(installed, "utf-8")).toBe(
      "# user changed this guidance fixture\n"
    );
    expect(readFileSync(ownSkill, "utf-8")).toBe("# user skill fixture\n");
    expect(
      existsSync(
        path.join(project, ".agents", "skills", "dx-explain", "SKILL.md")
      )
    ).toBe(false);
  });

  it("dft install --dry-run writes nothing in the repo or HOME", () => {
    const fresh = path.join(root, "dry-repo");
    const dryHome = path.join(root, "dry-home");
    execFileSync("git", ["init", "-q", "-b", "main", fresh]);
    mkdirSync(path.join(dryHome, ".claude"), { recursive: true });

    const exclude = readFileSync(
      path.join(fresh, ".git", "info", "exclude"),
      "utf-8"
    );

    const result = spawnSync(
      process.execPath,
      [dftMain, "install", "--telemetry", "--dry-run", "--tool", "codex,pi"],
      { cwd: fresh, encoding: "utf-8", env: { ...env, HOME: dryHome } }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Dry run: dft wrote nothing");
    expect(result.stdout).toContain("would add (dry run)");
    expect(
      execFileSync(
        "git",
        ["-C", fresh, "status", "--porcelain", "--ignored", "-uall"],
        { encoding: "utf-8", env }
      )
    ).toBe("");
    expect(
      readFileSync(path.join(fresh, ".git", "info", "exclude"), "utf-8")
    ).toBe(exclude);
    expect(existsSync(path.join(dryHome, ".claude", "settings.json"))).toBe(
      false
    );
  });

  it("a plain re-run repairs hooks that call a node that is gone, and status says so first", () => {
    const stale = path.join(root, "stale-repo");
    const emptyHome = path.join(root, "stale-home");
    execFileSync("git", ["init", "-q", "-b", "main", stale]);

    const run = (...args: readonly string[]) =>
      spawnSync(process.execPath, [dftMain, ...args], {
        cwd: stale,
        encoding: "utf-8",
        env: { ...env, HOME: emptyHome },
      });

    expect(run("install", "--json", "--tool", "codex,deepseek").status).toBe(0);

    const hooks = path.join(stale, ".codex", "hooks.json");

    writeFileSync(
      hooks,
      readFileSync(hooks, "utf-8").replaceAll(
        JSON.stringify(process.execPath).slice(1, -1),
        "/old/node/24.18.0/bin/node"
      )
    );

    expect(run("status", "--no-sync", "--probe-sources").stdout).toContain(
      "project capture broken (its hooks call missing /old/node/24.18.0/bin/node"
    );

    expect(actions(run("install", "--json").stdout)).toEqual([
      ["codex", ["updated"]],
      ["deepseek", ["unchanged", "unchanged"]],
    ]);
    expect(readFileSync(hooks, "utf-8")).not.toContain("/old/node");
  });
});
