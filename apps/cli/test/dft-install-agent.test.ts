// @effect-diagnostics nodeBuiltinImport:off -- Installer behavior checks own temporary repositories and remove their exact fixture roots after each test.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";

import {
  install as installLegacy,
  mcpEntryFor,
  uninstall as uninstallLegacy,
} from "../../../scripts/dx-install.js";
import type { InstallOptions } from "../../../scripts/dx-install.js";
import {
  installAgentSkills,
  installCursorHooks,
  installSkills,
  parseHooksFile,
  uninstallAgentSkills,
  uninstallCursorHooks,
  uninstallSkills,
} from "../src/dft-install.js";
import { skillDigest } from "../src/dft-skills.js";

const roots: string[] = [];

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dft-agent-install-"));
  const repo = path.join(root, "repo");
  const source = path.join(root, "source");

  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);

  for (const name of ["dx-analyze", "dx-explain"]) {
    mkdirSync(path.join(source, name), { recursive: true });
    writeFileSync(
      path.join(source, name, "SKILL.md"),
      `# ${name} fixture v1\n`
    );
  }

  return { repo, root, source };
};

const skillFile = (repo: string, host: string, name = "dx-analyze") =>
  path.join(repo, host, "skills", name, "SKILL.md");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("agent skill installation ownership", () => {
  it("installs the reviewed inventory and exact ownership path when its source is unavailable", () => {
    const { repo, source } = fixture();

    const ownershipPath = path.join(
      repo,
      ".git",
      "reviewed-install",
      "ownership.json"
    );

    const body = "# reviewed fixture guidance\n";

    rmSync(source, { recursive: true });
    expect(
      installAgentSkills(repo, source, {
        ownershipPath,
        skills: [{ body, name: "dx-analyze" }],
      })
    ).toEqual([
      {
        action: "created",
        detail: "dx-analyze",
        path: skillFile(repo, ".agents"),
      },
    ]);
    expect(readFileSync(skillFile(repo, ".agents"), "utf-8")).toBe(body);
    expect(readFileSync(ownershipPath, "utf-8")).toContain(skillDigest(body));
    expect(existsSync(path.join(repo, ".git", "dft-install"))).toBe(false);

    writeFileSync(
      skillFile(repo, ".agents"),
      "# user changed reviewed fixture\n"
    );
    expect(
      installAgentSkills(repo, source, {
        ownershipPath,
        skills: [{ body: "# next reviewed fixture\n", name: "dx-analyze" }],
      })[0]?.action
    ).toBe("skipped");
    expect(readFileSync(skillFile(repo, ".agents"), "utf-8")).toBe(
      "# user changed reviewed fixture\n"
    );
  });

  it("installs Codex guidance separately and preserves edited skills and added references", () => {
    const { repo, source } = fixture();
    const file = skillFile(repo, ".agents");

    installAgentSkills(repo, source);
    installSkills(repo, source);
    writeFileSync(file, "# my investigation guidance\n");
    writeFileSync(
      path.join(path.dirname(file), "references.md"),
      "my reference\n"
    );

    expect(installAgentSkills(repo, source)[0]?.action).toBe("skipped");
    expect(uninstallAgentSkills(repo, source)[0]?.action).toBe("skipped");
    expect(readFileSync(file, "utf-8")).toBe("# my investigation guidance\n");
    expect(
      readFileSync(path.join(path.dirname(file), "references.md"), "utf-8")
    ).toBe("my reference\n");
    expect(existsSync(skillFile(repo, ".cursor"))).toBe(true);

    uninstallSkills(repo, source);
    expect(existsSync(skillFile(repo, ".cursor"))).toBe(false);
  });

  it("backs up an unchanged owned skill before upgrading it and removes only owned files", () => {
    const { repo, source } = fixture();
    const file = skillFile(repo, ".agents");

    installAgentSkills(repo, source);
    writeFileSync(
      path.join(source, "dx-analyze", "SKILL.md"),
      "# updated fixture\n"
    );
    writeFileSync(path.join(path.dirname(file), "notes.md"), "my notes\n");

    expect(installAgentSkills(repo, source)[0]?.action).toBe("updated");
    expect(readFileSync(file, "utf-8")).toBe("# updated fixture\n");
    const backups = path.join(repo, ".git", "dft-install", "backups");
    expect(
      readdirSync(backups).some(
        (name) =>
          readFileSync(path.join(backups, name), "utf-8") ===
          "# dx-analyze fixture v1\n"
      )
    ).toBe(true);

    uninstallAgentSkills(repo, source);
    expect(existsSync(file)).toBe(false);
    expect(
      readFileSync(path.join(path.dirname(file), "notes.md"), "utf-8")
    ).toBe("my notes\n");
  });

  it("keeps identical and different pre-existing skills unowned", () => {
    const { repo, source } = fixture();
    const identical = skillFile(repo, ".agents");
    const foreign = skillFile(repo, ".agents", "dx-explain");

    mkdirSync(path.dirname(identical), { recursive: true });
    mkdirSync(path.dirname(foreign), { recursive: true });
    writeFileSync(
      identical,
      readFileSync(path.join(source, "dx-analyze", "SKILL.md"))
    );
    writeFileSync(foreign, "# custom explain skill\n");

    expect(installAgentSkills(repo, source).map((step) => step.action)).toEqual(
      ["unchanged", "skipped"]
    );
    uninstallAgentSkills(repo, source);
    expect(readFileSync(identical, "utf-8")).toBe("# dx-analyze fixture v1\n");
    expect(readFileSync(foreign, "utf-8")).toBe("# custom explain skill\n");
  });

  it("can uninstall owned skills when the package source is unavailable", () => {
    const { repo, source } = fixture();

    installAgentSkills(repo, source);
    rmSync(source, { recursive: true });
    expect(
      uninstallAgentSkills(repo, source).map((step) => step.action)
    ).toEqual(["removed", "removed"]);
    expect(existsSync(path.join(repo, ".agents"))).toBe(false);
  });

  it("leaves a linked owned path and its external target untouched", () => {
    const { repo, root, source } = fixture();
    const file = skillFile(repo, ".agents");
    const external = path.join(root, "external.md");

    installAgentSkills(repo, source);
    writeFileSync(external, readFileSync(file));
    rmSync(file);
    symlinkSync(external, file);
    writeFileSync(
      path.join(source, "dx-analyze", "SKILL.md"),
      "# fixture v2\n"
    );

    expect(installAgentSkills(repo, source)[0]?.action).toBe("skipped");
    expect(uninstallAgentSkills(repo, source)[0]?.action).toBe("skipped");
    expect(readFileSync(external, "utf-8")).toBe("# dx-analyze fixture v1\n");
    expect(existsSync(file)).toBe(true);
  });

  it("does not remove another released skill placed at an owned path", () => {
    const { repo, source } = fixture();
    const file = skillFile(repo, ".agents");
    const replacement = "---\nname: dx-explain\n---\n\n# released fixture\n";

    installAgentSkills(repo, source);
    writeFileSync(file, replacement);
    uninstallAgentSkills(repo, source, new Set([skillDigest(replacement)]));
    expect(readFileSync(file, "utf-8")).toBe(replacement);
  });

  it("keeps external empty directories behind a linked agent root", () => {
    const { repo, root, source } = fixture();
    const external = path.join(root, "external-agents");

    mkdirSync(path.join(external, "skills"), { recursive: true });
    symlinkSync(external, path.join(repo, ".agents"));
    expect(() => uninstallAgentSkills(repo, source)).not.toThrow();
    expect(existsSync(path.join(external, "skills"))).toBe(true);
    expect(existsSync(path.join(repo, ".agents"))).toBe(true);
  });
});

describe("Cursor hook ownership", () => {
  it("preserves an edited entry and unrelated settings on reinstall and uninstall", () => {
    const { repo } = fixture();
    const file = path.join(repo, ".cursor", "hooks.json");

    installCursorHooks(repo, "dft hook");
    const parsed = parseHooksFile(readFileSync(file, "utf-8"));

    expect(parsed).not.toBeNull();
    writeFileSync(
      file,
      JSON.stringify({
        ...parsed,
        hooks: {
          ...parsed?.hooks,
          stop: [{ command: "dft hook --my-option" }],
        },
      })
    );
    expect(installCursorHooks(repo, "node /new/dft-main.js hook").action).toBe(
      "updated"
    );
    uninstallCursorHooks(repo);
    expect(readFileSync(file, "utf-8")).toContain("dft hook --my-option");
  });

  it("does not adopt a pre-existing matching hook", () => {
    const { repo } = fixture();
    const file = path.join(repo, ".cursor", "hooks.json");

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      '{"version":1,"custom":"keep","hooks":{"stop":[{"command":"dft hook"}]}}\n'
    );
    installCursorHooks(repo, "dft hook");
    uninstallCursorHooks(repo);
    expect(readFileSync(file, "utf-8")).toContain('"custom": "keep"');
    expect(readFileSync(file, "utf-8")).toContain('"command": "dft hook"');
  });

  it("preserves a pre-existing empty hook event", () => {
    const { repo } = fixture();
    const file = path.join(repo, ".cursor", "hooks.json");

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"version":1,"hooks":{"stop":[]}}\n');
    installCursorHooks(repo, "dft hook");
    uninstallCursorHooks(repo);
    expect(parseHooksFile(readFileSync(file, "utf-8"))?.hooks?.stop).toEqual(
      []
    );
  });

  it("removes only one owned occurrence when a matching hook is added later", () => {
    const { repo } = fixture();
    const file = path.join(repo, ".cursor", "hooks.json");

    installCursorHooks(repo, "dft hook");
    const parsed = parseHooksFile(readFileSync(file, "utf-8"));

    writeFileSync(
      file,
      JSON.stringify({
        ...parsed,
        hooks: {
          ...parsed?.hooks,
          stop: [{ command: "dft hook" }, { command: "dft hook" }],
        },
      })
    );
    installCursorHooks(repo, "dft hook");
    uninstallCursorHooks(repo);
    expect(parseHooksFile(readFileSync(file, "utf-8"))?.hooks?.stop).toEqual([
      { command: "dft hook" },
    ]);
  });
});

const legacyOptions = (repo: string, source: string): InstallOptions => ({
  cliPath: "/fixture/apps/cli/dist/cli.js",
  configRoot: null,
  hooks: true,
  nodePath: process.execPath,
  now: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
  skillsSource: source,
  store: null,
  target: repo,
});

describe("legacy installer preservation", () => {
  it("keeps pre-existing identical MCP, hooks and exclude entries", () => {
    const { repo, source } = fixture();
    const options = legacyOptions(repo, source);
    const config = path.join(repo, ".cursor");

    mkdirSync(config, { recursive: true });
    writeFileSync(
      path.join(config, "mcp.json"),
      JSON.stringify({ mcpServers: { "rat-stack": mcpEntryFor(options) } })
    );
    writeFileSync(
      path.join(config, "hooks.json"),
      JSON.stringify({
        custom: "keep",
        hooks: {
          stop: [
            {
              command: `${process.execPath} /fixture/apps/cli/dist/cli.js dx hook`,
            },
          ],
        },
        version: 1,
      })
    );
    const exclude = path.join(repo, ".git", "info", "exclude");
    writeFileSync(
      exclude,
      `${readFileSync(exclude, "utf-8")}.dx-flight-recorder/\n`
    );

    installLegacy(options);
    uninstallLegacy({ configRoot: null, now: options.now, target: repo });
    expect(readFileSync(path.join(config, "mcp.json"), "utf-8")).toContain(
      "rat-stack"
    );
    expect(readFileSync(path.join(config, "hooks.json"), "utf-8")).toContain(
      '"custom": "keep"'
    );
    expect(readFileSync(path.join(config, "hooks.json"), "utf-8")).toContain(
      "dx hook"
    );
    expect(readFileSync(exclude, "utf-8")).toContain(".dx-flight-recorder/");
  });

  it("preserves edits and added skill assets while retaining earlier hooks across a no-hooks rerun", () => {
    const { repo, source } = fixture();
    const options = legacyOptions(repo, source);
    const file = skillFile(repo, ".cursor");

    installLegacy(options);
    writeFileSync(file, "# custom fixture guidance\n");
    writeFileSync(
      path.join(path.dirname(file), "notes.md"),
      "owned by the user\n"
    );
    installLegacy({ ...options, hooks: false });
    uninstallLegacy({ configRoot: null, now: options.now, target: repo });

    expect(readFileSync(file, "utf-8")).toBe("# custom fixture guidance\n");
    expect(
      readFileSync(path.join(path.dirname(file), "notes.md"), "utf-8")
    ).toBe("owned by the user\n");
    expect(existsSync(path.join(repo, ".cursor", "hooks.json"))).toBe(false);
  });

  it("preserves a pre-existing empty hook event in the legacy installer", () => {
    const { repo, source } = fixture();
    const options = legacyOptions(repo, source);
    const file = path.join(repo, ".cursor", "hooks.json");

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"version":1,"hooks":{"stop":[]}}\n');
    installLegacy(options);
    uninstallLegacy({ configRoot: null, now: options.now, target: repo });
    expect(parseHooksFile(readFileSync(file, "utf-8"))?.hooks?.stop).toEqual(
      []
    );
  });
});
