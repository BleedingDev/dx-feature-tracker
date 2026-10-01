// @effect-diagnostics nodeBuiltinImport:off -- Project capture and user telemetry edit real files in throwaway git repos and a throwaway HOME, so the test drives node:fs and git directly.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import {
  CAPTURE_TOOLS,
  CLAUDE_SETTINGS_LOCAL,
  CODEX_PROJECT_HOOKS,
  DSH_HOOKS_FILE,
  DSH_PATCH_FILE,
  OMP_EXTENSION_PATH,
  OPENCODE_PLUGIN_PATH,
  PI_EXTENSION_PATH,
  captureFiles,
  dftCommandFor,
  hasCapture,
  installCapture,
  mergeHookConfig,
  missingHookPaths,
  parseHookConfig,
  removeDftHooks,
  uninstallCapture,
} from "../src/dft-capture.js";
import type { DftCommand } from "../src/dft-capture.js";
import {
  installCursorHooks,
  uninstallCursorHooks,
} from "../src/dft-install.js";
import {
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  codexTelemetryBlock,
  installTelemetry,
  telemetryState,
  uninstallTelemetry,
} from "../src/dft-telemetry.js";
import type { TelemetryOptions } from "../src/dft-telemetry.js";
import { captureText, codexTrusts, detectedFrom } from "../src/dft-tools.js";

const created: string[] = [];

const scratch = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  created.push(dir);

  return dir;
};

const scratchRepo = (): string => {
  const dir = scratch("dft-capture-");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "core.excludesFile", "/dev/null"]);

  return dir;
};

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const command: DftCommand = {
  argv: ["/usr/bin/node", "/opt/dft/dist/dft-main.js"],
  line: "/usr/bin/node /opt/dft/dist/dft-main.js",
};

const write = (dir: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

const read = (dir: string, rel: string): string =>
  readFileSync(path.join(dir, rel), "utf-8");

const git = (dir: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" });

const teammateSettings = [
  "{",
  '  "permissions": {',
  '    "allow": [',
  '      "Bash(ls)"',
  "    ]",
  "  },",
  '  "hooks": {',
  '    "Stop": [',
  "      {",
  '        "hooks": [',
  "          {",
  '            "type": "command",',
  '            "command": "notify-done"',
  "          }",
  "        ]",
  "      }",
  "    ],",
  '    "PostToolUse": [',
  "      {",
  '        "matcher": "Edit",',
  '        "hooks": [',
  "          {",
  '            "type": "command",',
  '            "command": "lint"',
  "          }",
  "        ]",
  "      }",
  "    ]",
  "  }",
  "}",
  "",
].join("\n");

const claudeHookCommand = (event: string): string =>
  `dft hook claude-code ${event}`;

describe("hook config merge", () => {
  it("adds one dft group per event, keeps other entries and key order, and is idempotent", () => {
    const parsed = parseHookConfig(teammateSettings);

    expect(parsed).not.toBeNull();

    const specs = [
      { event: "Stop", matcher: null },
      { event: "PostToolUse", matcher: "*" },
    ];

    const style = { async: true, timeout: 30 };

    const first = mergeHookConfig(
      parsed ?? {},
      specs,
      claudeHookCommand,
      style
    );

    expect(first.added).toEqual(["Stop", "PostToolUse"]);
    expect(Object.keys(first.file)).toEqual(["permissions", "hooks"]);
    expect(first.file.hooks?.Stop).toHaveLength(2);
    expect(first.file.hooks?.Stop?.[0]).toEqual({
      hooks: [{ command: "notify-done", type: "command" }],
    });
    expect(first.file.hooks?.PostToolUse?.[1]).toEqual({
      hooks: [
        {
          async: true,
          command: "dft hook claude-code PostToolUse",
          timeout: 30,
          type: "command",
        },
      ],
      matcher: "*",
    });

    const second = mergeHookConfig(first.file, specs, claudeHookCommand, style);

    expect(second.added).toEqual([]);

    const removal = removeDftHooks(second.file);

    expect(removal.removed).toEqual(["Stop", "PostToolUse"]);
    expect(`${JSON.stringify(removal.file, null, 2)}\n`).toBe(teammateSettings);
  });

  it("drops the hooks key and reports an empty file when only dft hooks were there", () => {
    const merged = mergeHookConfig(
      {},
      [{ event: "Stop", matcher: null }],
      () => "node /x/dft-main.js hook codex Stop",
      { async: false, timeout: 10 }
    );

    expect(removeDftHooks(merged.file)).toEqual({
      empty: true,
      file: {},
      removed: ["Stop"],
    });
  });

  it("refuses files that are not hook configs", () => {
    expect(parseHookConfig("not json")).toBeNull();
    expect(parseHookConfig('{"hooks": {"Stop": "oops"}}')).toBeNull();
  });
});

describe("dft install project capture (D39)", () => {
  it("writes every tool's local capture, ignores it in this clone only, and never touches tracked files", () => {
    const repo = scratchRepo();
    write(repo, CLAUDE_SETTINGS_LOCAL, teammateSettings);

    const install = installCapture(CAPTURE_TOOLS, repo, command);

    const actions = install.tools.flatMap((tool) =>
      tool.steps.map((step) => [tool.tool, step.action] as const)
    );

    expect(actions).toEqual([
      ["claude-code", "updated"],
      ["codex", "created"],
      ["opencode", "created"],
      ["pi", "created"],
      ["omp", "created"],
      ["deepseek", "created"],
      ["deepseek", "created"],
    ]);

    for (const tool of CAPTURE_TOOLS) {
      expect(hasCapture(tool, repo)).toBe(true);
    }

    expect(read(repo, CLAUDE_SETTINGS_LOCAL)).toContain('"notify-done"');
    expect(read(repo, CODEX_PROJECT_HOOKS)).toContain(
      "/usr/bin/node /opt/dft/dist/dft-main.js hook codex SessionEnd"
    );
    expect(read(repo, PI_EXTENSION_PATH)).toContain(
      JSON.stringify(command.argv)
    );
    expect(read(repo, OMP_EXTENSION_PATH)).toContain(
      JSON.stringify(command.argv)
    );
    expect(read(repo, OPENCODE_PLUGIN_PATH)).toContain(
      JSON.stringify(command.argv)
    );
    expect(read(repo, DSH_PATCH_FILE)).toContain(
      `configPath: ${JSON.stringify(path.join(repo, DSH_HOOKS_FILE))}`
    );
    expect(read(repo, DSH_HOOKS_FILE)).toContain("hook deepseek Stop");

    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe(
      ""
    );

    expect(install.ignore).toHaveLength(1);
    expect(read(repo, ".git/info/exclude")).toContain(
      "/.claude/settings.local.json"
    );
  });

  it("adds no ignore lines for files git already ignores, and runs again without changes", () => {
    const repo = scratchRepo();
    write(repo, ".gitignore", ".claude/settings.local.json\n.pi/\n");

    const first = installCapture(["claude-code", "pi"], repo, command);

    expect(first.ignore).toEqual([]);

    const again = installCapture(["claude-code", "pi"], repo, command);

    expect(
      again.tools.flatMap((tool) => tool.steps.map((step) => step.action))
    ).toEqual(["unchanged", "unchanged"]);
    expect(again.ignore).toEqual([]);
  });

  it("points dft hooks that call an old node or dft at this build on a re-run", () => {
    const repo = scratchRepo();

    const old: DftCommand = {
      argv: ["/old/node/24.18.0/bin/node", "/old/dft/dft-main.js"],
      line: "/old/node/24.18.0/bin/node /old/dft/dft-main.js",
    };

    const dftMain = path.join(scratch("dft-build-"), "dft main.js");
    write(path.dirname(dftMain), path.basename(dftMain), "");

    const current = dftCommandFor(process.execPath, dftMain);

    write(repo, CLAUDE_SETTINGS_LOCAL, teammateSettings);
    installCapture(["claude-code", "codex"], repo, old);

    expect(missingHookPaths("claude-code", repo)).toEqual(old.argv);

    const again = installCapture(["claude-code", "codex"], repo, current);

    expect(
      again.tools.flatMap((tool) => tool.steps.map((step) => step.action))
    ).toEqual(["updated", "updated"]);

    for (const rel of [CLAUDE_SETTINGS_LOCAL, CODEX_PROJECT_HOOKS]) {
      expect(read(repo, rel)).not.toContain("/old/");
      expect(read(repo, rel).split(current.line).length - 1).toBe(5);
    }

    expect(read(repo, CLAUDE_SETTINGS_LOCAL)).toContain('"notify-done"');
    expect(missingHookPaths("claude-code", repo)).toEqual([]);
    expect(missingHookPaths("codex", repo)).toEqual([]);
  });

  it("reports a plugin or extension that calls an old node or dft as broken", () => {
    const repo = scratchRepo();
    const tools = ["opencode", "pi", "omp"] as const;

    const old: DftCommand = {
      argv: ["/old/node/24.18.0/bin/node", "/old/dft/dft-main.js"],
      line: "/old/node/24.18.0/bin/node /old/dft/dft-main.js",
    };

    installCapture(tools, repo, old);

    for (const tool of tools) {
      expect(missingHookPaths(tool, repo)).toEqual(old.argv);
    }

    installCapture(tools, repo, dftCommandFor(process.execPath, repo));

    for (const tool of tools) {
      expect(missingHookPaths(tool, repo)).toEqual([]);
    }
  });

  it("skips a tracked hooks file and a foreign file with the same name", () => {
    const repo = scratchRepo();
    write(repo, CODEX_PROJECT_HOOKS, '{"hooks": {}}\n');
    git(repo, "add", CODEX_PROJECT_HOOKS);
    write(repo, PI_EXTENSION_PATH, "export default () => {};\n");

    const install = installCapture(["codex", "pi"], repo, command);

    expect(
      install.tools.flatMap((tool) => tool.steps.map((step) => step.action))
    ).toEqual(["skipped", "skipped"]);
    expect(read(repo, CODEX_PROJECT_HOOKS)).toBe('{"hooks": {}}\n');
    expect(read(repo, PI_EXTENSION_PATH)).toBe("export default () => {};\n");

    const text = captureText(repo, [], install, { codexTrusted: false });

    expect(text).not.toContain("approve the hooks");
    expect(text).not.toContain("Pi asks once");
    expect(text).toContain(
      "Live capture is off for Codex in this folder because dft wrote nothing here"
    );
  });

  it("leaves invalid hook JSON alone", () => {
    const repo = scratchRepo();
    write(repo, CLAUDE_SETTINGS_LOCAL, "{ broken");

    const [claude] = installCapture(["claude-code"], repo, command).tools;

    expect(claude?.steps[0]?.action).toBe("skipped");
    expect(read(repo, CLAUDE_SETTINGS_LOCAL)).toBe("{ broken");
  });

  it("dft uninstall removes only what dft added and restores the files byte for byte", () => {
    const repo = scratchRepo();
    write(repo, CLAUDE_SETTINGS_LOCAL, teammateSettings);
    write(repo, ".git/info/exclude", "# own\n*.log\n");
    write(repo, ".pi/extensions/own.ts", "export default () => {};\n");

    installCapture(CAPTURE_TOOLS, repo, command);

    const steps = uninstallCapture(repo, command);

    expect(steps.map((step) => step.action)).toContain("removed");
    expect(read(repo, CLAUDE_SETTINGS_LOCAL)).toBe(teammateSettings);
    expect(read(repo, ".git/info/exclude")).toBe("# own\n*.log\n");
    expect(read(repo, ".pi/extensions/own.ts")).toBe(
      "export default () => {};\n"
    );

    for (const rel of captureFiles("omp")) {
      expect(existsSync(path.join(repo, rel))).toBe(false);
    }

    expect(existsSync(path.join(repo, ".omp"))).toBe(false);
    expect(existsSync(path.join(repo, ".codex"))).toBe(false);
    expect(existsSync(path.join(repo, ".dsh"))).toBe(false);
    expect(uninstallCapture(repo, command)).toEqual([]);
  });

  it("recognises its own hooks when dft runs from a pnpm global dist/dft.mjs", () => {
    const repo = scratchRepo();

    const shim = dftCommandFor(
      "/usr/bin/node",
      "/pnpm/global/v11/0a1b/node_modules/dx-feature-tracker/dist/dft.mjs"
    );

    const tools = ["claude-code", "codex"] as const;
    const cursorCommand = `${shim.line} hook`;
    write(repo, CLAUDE_SETTINGS_LOCAL, teammateSettings);

    installCapture(tools, repo, shim);
    installCursorHooks(repo, cursorCommand);

    const again = installCapture(tools, repo, shim);

    expect(
      again.tools.flatMap((tool) => tool.steps.map((step) => step.action))
    ).toEqual(["unchanged", "unchanged"]);
    expect(installCursorHooks(repo, cursorCommand).action).toBe("unchanged");
    expect(hasCapture("claude-code", repo)).toBe(true);
    expect(hasCapture("codex", repo)).toBe(true);

    uninstallCapture(repo, shim);
    uninstallCursorHooks(repo);

    expect(read(repo, CLAUDE_SETTINGS_LOCAL)).toBe(teammateSettings);
    expect(existsSync(path.join(repo, CODEX_PROJECT_HOOKS))).toBe(false);
    expect(existsSync(path.join(repo, ".cursor", "hooks.json"))).toBe(false);
  });

  it("dft uninstall in one worktree keeps the ignore lines another worktree still needs", () => {
    const repo = scratchRepo();
    git(
      repo,
      "-c",
      "user.name=dft",
      "-c",
      "user.email=dft@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init"
    );

    const other = path.join(scratch("dft-worktree-"), "second wt");
    git(repo, "worktree", "add", "-q", "-b", "second", other);

    const exclude = read(repo, ".git/info/exclude");
    const tools = ["claude-code", "codex", "pi"] as const;

    installCapture(tools, repo, command);
    installCapture(tools, other, command);
    uninstallCapture(repo, command);

    expect(git(other, "status", "--porcelain", "--untracked-files=all")).toBe(
      ""
    );

    uninstallCapture(other, command);

    expect(read(repo, ".git/info/exclude")).toBe(exclude);
  });
});

describe("tool detection and Codex trust", () => {
  it("counts a tool as installed when its folder exists even without sessions", () => {
    const home = scratch("dft-home-");
    mkdirSync(path.join(home, ".codex"));
    mkdirSync(path.join(home, ".local", "share"), { recursive: true });
    mkdirSync(path.join(home, ".config"));

    const toolDirOf = (tool: string): string =>
      tool === "opencode"
        ? path.join(home, ".local", "share", "opencode")
        : path.join(home, `.${tool}`);

    const detected = detectedFrom(
      [
        {
          harness: "codex",
          present: false,
          reason: "no sessions",
          roots: [path.join(home, ".codex", "sessions")],
          sessions: 0,
          version: null,
        },
        {
          harness: "pi",
          present: false,
          reason: "no sessions",
          roots: [path.join(home, ".pi", "agent", "sessions")],
          sessions: 0,
          version: null,
        },
        {
          harness: "opencode",
          present: false,
          reason: "no sessions",
          roots: [path.join(home, ".local", "share", "opencode")],
          sessions: 0,
          version: null,
        },
        {
          harness: "cursor",
          present: true,
          reason: null,
          roots: [],
          sessions: 3,
          version: null,
        },
      ],
      toolDirOf
    );

    expect(detected.map((item) => [item.tool, item.installed])).toEqual([
      ["codex", true],
      ["pi", false],
      ["opencode", false],
    ]);
  });

  it("reads the trust level of exactly this folder from Codex config", () => {
    const config = [
      '[projects."/home/user/other"]',
      'trust_level = "trusted"',
      "",
      '[projects."/home/user/repo"]',
      'trust_level = "untrusted"',
      "",
      '[projects."/home/user/ok"]',
      'trust_level = "trusted"',
    ].join("\n");

    expect(codexTrusts(config, "/home/user/ok")).toBe(true);
    expect(codexTrusts(config, "/home/user/repo")).toBe(false);
    expect(codexTrusts(config, "/home/user/missing")).toBe(false);
  });
});

const telemetryHome = () => {
  const home = scratch("dft-telemetry-");

  const options = (
    overrides: Partial<TelemetryOptions> = {}
  ): TelemetryOptions => ({
    backupRoot: path.join(home, ".dft", "backups", "telemetry"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    dryRun: false,
    now: DateTime.toDate(DateTime.makeUnsafe("2026-10-01T10:00:00.000Z")),
    port: 7420,
    shell: {},
    stateFile: path.join(home, ".dft", "telemetry.json"),
    ...overrides,
  });

  return { home, options };
};

describe("dft install --telemetry (D38)", () => {
  it("only adds, keeps a backup, is idempotent and dft uninstall --telemetry restores the files", () => {
    const { home, options } = telemetryHome();

    const claudeSettings = `${JSON.stringify(
      {
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OWN: "x" },
        model: "opus",
      },
      null,
      2
    )}\n`;

    const codexConfig = 'model = "gpt-5"\n\n[features]\nhooks = true\n';
    write(home, ".claude/settings.json", claudeSettings);
    write(home, ".codex/config.toml", codexConfig);

    const changes = installTelemetry(options());

    expect(changes.map((change) => change.action)).toEqual(["added", "added"]);
    expect(changes[0]?.lines).toEqual([
      '+ env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://127.0.0.1:7420/v1/logs"',
      '+ env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json"',
      '+ env.OTEL_LOGS_EXPORTER = "otlp"',
    ]);

    const backups = path.join(home, ".dft", "backups", "telemetry");
    const [stamp] = readdirSync(backups);

    expect(
      readFileSync(
        path.join(backups, stamp ?? "", "claude-settings.json"),
        "utf-8"
      )
    ).toBe(claudeSettings);
    expect(read(home, ".codex/config.toml")).toContain(CODEX_BLOCK_START);
    expect(read(home, ".codex/config.toml").startsWith(codexConfig)).toBe(true);
    expect(
      telemetryState(path.join(home, ".claude"), path.join(home, ".codex"))
    ).toEqual({ claudeCode: true, codex: true });

    expect(installTelemetry(options()).map((change) => change.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);

    expect(
      uninstallTelemetry(options()).map((change) => change.action)
    ).toEqual(["removed", "removed"]);
    expect(read(home, ".claude/settings.json")).toBe(claudeSettings);
    expect(read(home, ".codex/config.toml")).toBe(codexConfig);
  });

  it("refuses to replace an OpenTelemetry export the user already has", () => {
    const { home, options } = telemetryHome();
    const claudeSettings = '{"env": {"OTEL_LOGS_EXPORTER": "otlp"}}\n';
    const codexConfig = '[otel]\nexporter = "none"\n';
    write(home, ".claude/settings.json", claudeSettings);
    write(home, ".codex/config.toml", codexConfig);

    const changes = installTelemetry(
      options({
        shell: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" },
      })
    );

    expect(changes.map((change) => change.action)).toEqual([
      "refused",
      "refused",
    ]);
    expect(changes[0]?.message).toContain("https://collector.example");
    expect(read(home, ".claude/settings.json")).toBe(claudeSettings);
    expect(read(home, ".codex/config.toml")).toBe(codexConfig);
  });

  it("refuses when the shell already exports Claude Code logs elsewhere", () => {
    const { home, options } = telemetryHome();
    mkdirSync(path.join(home, ".claude"));

    const [claude] = installTelemetry(
      options({
        shell: {
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example",
          OTEL_LOGS_EXPORTER: "otlp",
        },
      })
    );

    expect(claude?.action).toBe("refused");
    expect(claude?.message).toContain("shell environment");
  });

  it("writes nothing on a dry run", () => {
    const { home, options } = telemetryHome();
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));

    const changes = installTelemetry(options({ dryRun: true }));

    expect(changes.map((change) => change.action)).toEqual(["added", "added"]);
    expect(readdirSync(path.join(home, ".claude"))).toEqual([]);
    expect(readdirSync(path.join(home, ".codex"))).toEqual([]);
    expect(existsSync(path.join(home, ".dft"))).toBe(false);
  });

  it("leaves a tool that is not set up alone instead of creating its folder", () => {
    const { home, options } = telemetryHome();
    mkdirSync(path.join(home, ".claude"));

    const changes = installTelemetry(options());

    expect(changes.map((change) => change.action)).toEqual([
      "added",
      "skipped",
    ]);
    expect(changes[1]?.message).toContain("Codex is not set up");
    expect(existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("moves its own settings to a new --port and still undoes them exactly", () => {
    const { home, options } = telemetryHome();
    const claudeSettings = '{\n  "model": "opus"\n}\n';
    const codexConfig = 'model = "gpt-5"\n';
    write(home, ".claude/settings.json", claudeSettings);
    write(home, ".codex/config.toml", codexConfig);

    installTelemetry(options());

    const moved = installTelemetry(options({ port: 7500 }));

    expect(moved.map((change) => change.action)).toEqual([
      "updated",
      "updated",
    ]);
    expect(moved[0]?.lines).toEqual([
      '~ env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://127.0.0.1:7500/v1/logs"',
    ]);
    expect(read(home, ".claude/settings.json")).toContain(":7500/v1/logs");
    expect(read(home, ".codex/config.toml")).toContain(":7500/v1/logs");
    expect(read(home, ".codex/config.toml")).not.toContain(":7420/");
    expect(
      installTelemetry(options({ port: 7500 })).map((change) => change.action)
    ).toEqual(["unchanged", "unchanged"]);

    uninstallTelemetry(options({ port: 7500 }));

    expect(read(home, ".claude/settings.json")).toBe(claudeSettings);
    expect(read(home, ".codex/config.toml")).toBe(codexConfig);
  });

  it("keeps tables Codex appended inside its markers on refresh and uninstall", () => {
    const { home, options } = telemetryHome();
    write(home, ".codex/config.toml", 'model = "gpt-5"\n');
    mkdirSync(path.join(home, ".claude"));

    installTelemetry(options());

    const codexTables = [
      "[mcp_servers.foo]",
      'command = "echo"',
      'args = ["hi"]',
      "",
      '[hooks.state."/repo/.codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:abc"',
    ].join("\n");

    const codexWrote = read(home, ".codex/config.toml").replace(
      `${CODEX_BLOCK_END}\n`,
      `\n${codexTables}\n${CODEX_BLOCK_END}\n`
    );

    write(home, ".codex/config.toml", codexWrote);

    const [, same] = installTelemetry(options());

    expect(same?.action).toBe("unchanged");
    expect(read(home, ".codex/config.toml")).toBe(codexWrote);

    const [, moved] = installTelemetry(options({ port: 7500 }));

    expect(moved?.action).toBe("updated");
    expect(moved?.message).toContain("kept 6 lines");
    expect(moved?.lines.join("\n")).not.toContain("mcp_servers");
    expect(read(home, ".codex/config.toml")).toBe(
      `model = "gpt-5"\n\n${codexTelemetryBlock(7500)}\n\n${codexTables}\n`
    );

    const [, removed] = uninstallTelemetry(options({ port: 7500 }));

    expect(removed?.action).toBe("removed");
    expect(removed?.lines.join("\n")).not.toContain("hooks.state");
    expect(read(home, ".codex/config.toml")).toBe(
      `model = "gpt-5"\n\n${codexTables}\n`
    );

    write(home, ".codex/config.toml", codexWrote);
    uninstallTelemetry(options());

    expect(read(home, ".codex/config.toml")).toBe(
      `model = "gpt-5"\n\n${codexTables}\n`
    );
  });
});
