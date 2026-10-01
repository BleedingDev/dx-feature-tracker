// @effect-diagnostics nodeBuiltinImport:off -- Install wiring edits real files in a throwaway git repository, so the test drives node:fs and git directly.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { resolveDftStore } from "@rat-stack/core/dx";

import {
  CURSOR_HOOK_EVENTS,
  hasDftHooks,
  installCursorHooks,
  installGitHooks,
  installSkills,
  installText,
  installWarnings,
  installWorktree,
  isOldNode,
  mergeCursorHooks,
  otherWorktrees,
  parseWorktreeList,
  uninstallGitHooks,
} from "../src/dft-install.js";
import { enterpriseLine } from "../src/dft-render.js";

const created: string[] = [];

const scratchRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "dft-wire-"));
  created.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);

  return dir;
};

const runHook = (file: string, input: string): number | null =>
  spawnSync("sh", [file], { input, stdio: ["pipe", "ignore", "ignore"] })
    .status;

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("dft store resolution (D7)", () => {
  it("defaults to ~/.dft/dft.db, honours DFT_HOME, and --db wins", () => {
    expect(resolveDftStore({ db: null, env: {}, home: "/h" }).path).toBe(
      "/h/.dft/dft.db"
    );
    expect(
      resolveDftStore({ db: null, env: { DFT_HOME: "/x" }, home: "/h" })
    ).toEqual({ kind: "live", path: "/x/dft.db", source: "env" });
    expect(
      resolveDftStore({ db: "/y/s.db", env: { DFT_HOME: "/x" }, home: "/h" })
        .source
    ).toBe("flag");
  });
});

describe("dft install cursor hooks", () => {
  it("keeps foreign hooks, adds dft once per event, and is idempotent", () => {
    const existing = {
      hooks: { stop: [{ command: "./audit.sh", timeout: 5 }] },
      version: 1,
    };

    const first = mergeCursorHooks(existing, "node /r/bin/dft hook");

    expect(first.added).toEqual([...CURSOR_HOOK_EVENTS]);
    expect(first.file.hooks?.stop).toEqual([
      { command: "./audit.sh", timeout: 5 },
      { command: "node /r/bin/dft hook" },
    ]);
    expect(mergeCursorHooks(first.file, "node /r/bin/dft hook").added).toEqual(
      []
    );

    const fromBuild = mergeCursorHooks(
      existing,
      "/n/node /r/apps/cli/dist/dft-main.js hook"
    ).file;

    expect(
      mergeCursorHooks(fromBuild, "/n/node /r/apps/cli/dist/dft-main.js hook")
        .added
    ).toEqual([]);
  });

  it("points dft hooks that call an old node or dft at this build", () => {
    const existing = {
      hooks: {
        stop: [
          { command: "./audit.sh", timeout: 5 },
          { command: "/old/node/bin/node /old/dft-main.js hook" },
        ],
      },
      version: 1,
    };

    const merged = mergeCursorHooks(existing, "/n/node /r/dft-main.js hook");

    expect(merged.refreshed).toEqual(["stop"]);
    expect(merged.file.hooks?.stop).toEqual([
      { command: "./audit.sh", timeout: 5 },
      { command: "/n/node /r/dft-main.js hook" },
    ]);
    expect(
      mergeCursorHooks(existing, "/n/node /r/dft-main.js hook", false).refreshed
    ).toEqual([]);
  });

  it("writes only the project .cursor/hooks.json and leaves invalid JSON alone", () => {
    const repo = scratchRepo();

    expect(installCursorHooks(repo, "dft hook").action).toBe("created");
    expect(installCursorHooks(repo, "dft hook").action).toBe("unchanged");

    writeFileSync(path.join(repo, ".cursor", "hooks.json"), "{nope");

    expect(installCursorHooks(repo, "dft hook").action).toBe("skipped");
    expect(
      readFileSync(path.join(repo, ".cursor", "hooks.json"), "utf-8")
    ).toBe("{nope");
  });

  it("copies the recorder skills into the project", () => {
    const repo = scratchRepo();
    const steps = installSkills(repo);

    expect(steps.map((step) => step.detail).toSorted()).toEqual([
      "dx-analyze",
      "dx-chats",
      "dx-dashboard",
      "dx-explain",
      "dx-history",
      "dx-line",
    ]);
    expect(
      readFileSync(
        path.join(repo, ".cursor", "skills", "dx-analyze", "SKILL.md"),
        "utf-8"
      )
    ).toContain("dft analyze --json");
  });
});

describe("dft install --git-hooks", () => {
  it("keeps an existing hook and adds its line right after the shebang", () => {
    const repo = scratchRepo();
    const preCommit = path.join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(preCommit, "#!/bin/sh\necho mine\n");

    const steps = installGitHooks(repo, "/r/bin/dft");

    expect(steps.map((step) => step.action)).toEqual(["updated", "created"]);
    expect(readFileSync(preCommit, "utf-8")).toBe(
      "#!/bin/sh\n/r/bin/dft snapshot </dev/null || true\necho mine\n"
    );
    expect(statSync(preCommit).mode.toString(8).endsWith("755")).toBe(true);
    expect(
      installGitHooks(repo, "/r/bin/dft").map((step) => step.action)
    ).toEqual(["unchanged", "unchanged"]);
  });

  it("leaves a failing hook failing so the user's own checks still block git", () => {
    const repo = scratchRepo();
    const hooks = path.join(repo, ".git", "hooks");
    const preCommit = path.join(hooks, "pre-commit");
    const prePush = path.join(hooks, "pre-push");
    const lint = '#!/bin/sh\necho "lint failed"; false\n';

    const refCheck =
      '#!/bin/sh\nread local_ref rest\ntest "$local_ref" = refs/heads/main\n';

    writeFileSync(preCommit, lint);
    writeFileSync(prePush, refCheck);

    installGitHooks(repo, 'sh -c "cat >/dev/null" dft');

    expect(runHook(preCommit, "")).toBe(1);
    expect(runHook(prePush, "refs/heads/main abc refs/heads/main def\n")).toBe(
      0
    );
    expect(runHook(prePush, "refs/heads/wip abc refs/heads/wip def\n")).toBe(1);

    uninstallGitHooks(repo);

    expect(readFileSync(preCommit, "utf-8")).toBe(lint);
    expect(readFileSync(prePush, "utf-8")).toBe(refCheck);
  });

  it("moves a line an older dft appended at the end up to the top", () => {
    const repo = scratchRepo();
    const preCommit = path.join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(preCommit, "#!/bin/sh\nfalse\n/r/bin/dft snapshot || true\n");

    const [step] = installGitHooks(repo, "/r/bin/dft");

    expect(step?.action).toBe("updated");
    expect(readFileSync(preCommit, "utf-8")).toBe(
      "#!/bin/sh\n/r/bin/dft snapshot </dev/null || true\nfalse\n"
    );
  });

  it("leaves a hook written in another language alone", () => {
    const repo = scratchRepo();
    const preCommit = path.join(repo, ".git", "hooks", "pre-commit");
    const python = "#!/usr/bin/env python3\nraise SystemExit(1)\n";
    writeFileSync(preCommit, python);

    const [step] = installGitHooks(repo, "/r/bin/dft");

    expect(step?.action).toBe("skipped");
    expect(readFileSync(preCommit, "utf-8")).toBe(python);
  });

  it("prints a snippet instead of editing when lefthook manages hooks", () => {
    const repo = scratchRepo();
    writeFileSync(path.join(repo, "lefthook.yml"), "pre-commit: {}\n");

    const [step] = installGitHooks(repo, "/r/bin/dft");

    expect(step?.action).toBe("printed");
    expect(step?.detail).toContain("run: /r/bin/dft snapshot || true");
  });
});

describe("dft install output", () => {
  it("lists what was set up and numbered next steps", () => {
    const repo = scratchRepo();

    const text = installText(
      {
        git: null,
        hooks: installCursorHooks(repo, "dft hook"),
        skills: installSkills(repo),
        worktree: repo,
      },
      {
        cursorInstalled: true,
        gitRepo: true,
        login: "yes",
        nodeVersion: "v24.18.0",
      }
    );

    expect(text).toContain("  ✓ Cursor hooks    .cursor/hooks.json\n");
    expect(text).toContain("/dx-analyze");
    expect(text).toContain("/dx-history");
    expect(text).toContain("dft install --git-hooks");
    expect(text).toContain("Next steps");
    expect(text).toMatch(/1\. Restart Cursor/u);
    expect(text).toMatch(/3\. dft analyze .*\/dx-analyze/u);
    expect(text).not.toContain("Check this");
    expect(text.indexOf("whole company")).toBeGreaterThan(
      text.indexOf("Next steps")
    );
    expect(text.endsWith(enterpriseLine())).toBe(true);
  });

  it("gives Cursor steps only when Cursor is on this machine", () => {
    const repo = scratchRepo();

    const text = installText(
      {
        git: null,
        hooks: installCursorHooks(repo, "dft hook"),
        skills: installSkills(repo),
        worktree: repo,
      },
      {
        cursorInstalled: false,
        gitRepo: true,
        login: "unknown",
        nodeVersion: "v24.18.0",
        otherTools: ["claude-code"],
      }
    );

    expect(text).toMatch(/1\. Work as usual +in your coding tools/u);
    expect(text).not.toContain("Restart Cursor");
    expect(text).not.toContain("in Cursor chat");
  });

  it("warns about missing git, Cursor, login and old Node", () => {
    expect(
      installWarnings({
        cursorInstalled: false,
        gitRepo: false,
        login: "no",
        nodeVersion: "v22.3.0",
      })
    ).toHaveLength(4);
    expect(
      installWarnings({
        cursorInstalled: true,
        gitRepo: true,
        login: "unknown",
        nodeVersion: "v24.18.0",
      })
    ).toEqual([]);
    expect(isOldNode("v24.17.9")).toBe(true);
    expect(isOldNode("v25.0.0")).toBe(false);
  });
});

describe("dft install --all-worktrees", () => {
  const checks = {
    cursorInstalled: true,
    gitRepo: true,
    login: "yes" as const,
    nodeVersion: "v24.18.0",
  };

  const repoWithWorktree = () => {
    const repo = scratchRepo();

    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init"
    );

    const linked = path.join(repo, "..", `${path.basename(repo)}-w1`);
    created.push(linked);
    git("worktree", "add", "-q", "-b", "feature/w1", linked);

    return { linked, repo };
  };

  it("finds the other worktrees and says how to set them up", () => {
    const { linked, repo } = repoWithWorktree();
    const others = otherWorktrees(repo);

    expect(others.map((file) => path.basename(file))).toEqual([
      path.basename(linked),
    ]);
    expect(otherWorktrees(linked).map((file) => path.basename(file))).toEqual([
      path.basename(repo),
    ]);

    const text = installText(
      {
        git: null,
        hooks: installCursorHooks(repo, "dft hook"),
        others: null,
        skills: installSkills(repo),
        waiting: others.filter((other) => !hasDftHooks(other)),
        worktree: repo,
      },
      checks
    );

    expect(hasDftHooks(repo)).toBe(true);
    expect(text).toContain(
      `1 other worktree of this repo has no dft hooks yet: ${path.basename(linked)}`
    );
    expect(text).toContain("dft install --all-worktrees");
  });

  it("sets up every other worktree when asked", () => {
    const { linked, repo } = repoWithWorktree();

    const others = otherWorktrees(repo).map((other) =>
      installWorktree(other, "dft hook")
    );

    expect(hasDftHooks(linked)).toBe(true);
    expect(
      readFileSync(
        path.join(linked, ".cursor", "skills", "dx-analyze", "SKILL.md"),
        "utf-8"
      )
    ).toContain("dft analyze");

    const text = installText(
      {
        git: null,
        hooks: installCursorHooks(repo, "dft hook"),
        others,
        skills: installSkills(repo),
        worktree: repo,
      },
      checks
    );

    expect(text).toMatch(
      new RegExp(
        `Other worktrees\\n  ✓ ${path.basename(linked)}\\s+Cursor hooks and skills\\n`,
        "u"
      )
    );
    expect(text).not.toContain("no dft hooks yet");
  });

  it("skips bare entries in git worktree list", () => {
    expect(
      parseWorktreeList(
        "worktree /r/bare.git\nbare\n\nworktree /r/a\nHEAD abc\nbranch refs/heads/a\n\nworktree /r/b\nHEAD def\ndetached\n"
      )
    ).toEqual(["/r/a", "/r/b"]);
  });
});
