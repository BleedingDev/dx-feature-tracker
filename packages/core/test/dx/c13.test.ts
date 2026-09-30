// @effect-diagnostics nodeBuiltinImport:off -- This test drives the installer against an owned temporary fixture directory on disk.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";

import {
  HOOK_EVENTS,
  InstallError,
  MANIFEST_FILE,
  MCP_SERVER_NAME,
  SPOOL_IGNORE_LINE,
  hookCommandFor,
  install,
  uninstall,
} from "../../../../scripts/dx-install.js";
import type { InstallOptions } from "../../../../scripts/dx-install.js";

const now = DateTime.makeUnsafe("2026-09-30T12:00:00.000Z");

const later = DateTime.makeUnsafe("2026-09-30T12:05:00.000Z");

const cliPath = "/opt/recorder/apps/cli/dist/cli.js";

const nodePath = "/usr/local/bin/node";

const HooksDoc = Schema.Struct({
  hooks: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ command: Schema.String }))
  ),
});

const McpDoc = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, Schema.Json),
});

const readHooks = (file: string) =>
  Schema.decodeSync(Schema.fromJsonString(HooksDoc))(
    readFileSync(file, "utf-8")
  ).hooks;

const readServers = (file: string) =>
  Schema.decodeSync(Schema.fromJsonString(McpDoc))(readFileSync(file, "utf-8"))
    .mcpServers;

const readJsonText = (file: string) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
    readFileSync(file, "utf-8")
  );

const userHooks = {
  hooks: {
    beforeShellExecution: [
      { command: "node scripts/hooks/block-git-no-verify.mjs", matcher: "git" },
    ],
    stop: [{ command: "./user-stop.sh" }],
  },
  version: 1,
};

const userMcp = {
  mcpServers: { other: { args: ["x"], command: "other-server" } },
};

const fixture = { root: "", skillsSource: "", target: "" };

const options = (hooks: boolean): InstallOptions => ({
  cliPath,
  configRoot: null,
  hooks,
  nodePath,
  now,
  skillsSource: fixture.skillsSource,
  store: null,
  target: fixture.target,
});

beforeEach(() => {
  fixture.root = mkdtempSync(path.join(tmpdir(), "dx-c13-"));
  fixture.target = path.join(fixture.root, "demo");
  mkdirSync(path.join(fixture.target, ".git", "info"), { recursive: true });
  writeFileSync(
    path.join(fixture.target, ".git", "HEAD"),
    "ref: refs/heads/main\n"
  );
  fixture.skillsSource = path.join(fixture.root, "skills");

  for (const skill of ["dx-analyze", "dx-explain"]) {
    mkdirSync(path.join(fixture.skillsSource, skill), { recursive: true });
    writeFileSync(
      path.join(fixture.skillsSource, skill, "SKILL.md"),
      `# ${skill}\n`
    );
  }
});

afterEach(() => {
  rmSync(fixture.root, { force: true, recursive: true });
});

describe("C13 dx installer", () => {
  it("merges MCP, hooks and skills beside unrelated entries, then uninstalls only owned entries", () => {
    const cursor = path.join(fixture.target, ".cursor");
    const exclude = path.join(fixture.target, ".git", "info", "exclude");

    mkdirSync(cursor, { recursive: true });
    writeFileSync(path.join(cursor, "hooks.json"), JSON.stringify(userHooks));
    writeFileSync(path.join(cursor, "mcp.json"), JSON.stringify(userMcp));

    expect(install(options(true)).backups).toHaveLength(2);
    expect(readServers(path.join(cursor, "mcp.json"))).toStrictEqual({
      ...userMcp.mcpServers,
      [MCP_SERVER_NAME]: {
        args: [cliPath, "mcp"],
        command: nodePath,
        env: { DX_REPO: fixture.target },
      },
    });

    const command = hookCommandFor(nodePath, cliPath);
    const hooks = readHooks(path.join(cursor, "hooks.json"));

    for (const event of HOOK_EVENTS) {
      expect(
        hooks[event]?.filter((hook) => hook.command === command)
      ).toHaveLength(1);
    }

    expect(hooks.stop?.[0]).toStrictEqual({ command: "./user-stop.sh" });
    expect(
      JSON.stringify(readJsonText(path.join(cursor, "hooks.json")))
    ).toContain(JSON.stringify(userHooks.hooks.beforeShellExecution));
    expect(
      readFileSync(
        path.join(cursor, "skills", "dx-analyze", "SKILL.md"),
        "utf-8"
      )
    ).toBe("# dx-analyze\n");
    expect(readFileSync(exclude, "utf-8")).toContain(SPOOL_IGNORE_LINE);

    expect(install({ ...options(true), now: later }).backups).toHaveLength(0);
    expect(readHooks(path.join(cursor, "hooks.json")).stop).toHaveLength(2);

    uninstall({ configRoot: null, now: later, target: fixture.target });

    expect(readJsonText(path.join(cursor, "hooks.json"))).toStrictEqual(
      userHooks
    );
    expect(readJsonText(path.join(cursor, "mcp.json"))).toStrictEqual(userMcp);
    expect(existsSync(path.join(cursor, "skills", "dx-analyze"))).toBe(false);
    expect(existsSync(path.join(cursor, MANIFEST_FILE))).toBe(false);
    expect(readFileSync(exclude, "utf-8")).not.toContain(SPOOL_IGNORE_LINE);
    expect(
      readdirSync(cursor).filter((file) => file.includes("dx-backup")).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("installs MCP and skills only (v0) into a configured config root and removes files it created", () => {
    const configRoot = path.join(fixture.root, "fixture-config");

    install({ ...options(false), configRoot });

    expect(existsSync(path.join(configRoot, "mcp.json"))).toBe(true);
    expect(existsSync(path.join(configRoot, "hooks.json"))).toBe(false);
    expect(existsSync(path.join(fixture.target, ".cursor"))).toBe(false);

    uninstall({ configRoot, now: later, target: fixture.target });

    expect(existsSync(path.join(configRoot, "mcp.json"))).toBe(false);
    expect(existsSync(path.join(configRoot, "skills", "dx-explain"))).toBe(
      false
    );
  });

  it("refuses to overwrite a foreign server of the same name or an unparseable file", () => {
    const cursor = path.join(fixture.target, ".cursor");

    mkdirSync(cursor, { recursive: true });
    writeFileSync(
      path.join(cursor, "mcp.json"),
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "x" } } })
    );

    expect(() => install(options(true))).toThrow(InstallError);

    writeFileSync(path.join(cursor, "hooks.json"), "{ not json");
    writeFileSync(path.join(cursor, "mcp.json"), "{}");

    expect(() => install(options(true))).toThrow(InstallError);
    expect(readFileSync(path.join(cursor, "hooks.json"), "utf-8")).toBe(
      "{ not json"
    );
  });

  it("keeps a server entry the user edited after install", () => {
    install(options(false));

    const file = path.join(fixture.target, ".cursor", "mcp.json");
    const servers = readServers(file);

    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { ...servers, [MCP_SERVER_NAME]: { command: "edited" } },
      })
    );

    const result = uninstall({
      configRoot: null,
      now: later,
      target: fixture.target,
    });

    expect(result.notes.join(" ")).toContain("edited after install");
    expect(readServers(file)[MCP_SERVER_NAME]).toStrictEqual({
      command: "edited",
    });
  });
});
