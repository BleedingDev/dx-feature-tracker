// @effect-diagnostics nodeBuiltinImport:off -- dft install edits project files (.cursor/hooks.json, skills, git hooks) at the process boundary with synchronous node:fs calls.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Result, Schema } from "effect";

import { loadSkills, skillsSourceDir } from "./dft-skills.js";

export const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "stop",
  "postToolUse",
  "postToolUseFailure",
  "afterFileEdit",
  "afterTabFileEdit",
  "afterShellExecution",
  "afterMCPExecution",
  "afterAgentResponse",
] as const;

export const GIT_HOOKS = ["pre-commit", "pre-push"] as const;

const LEFTHOOK_FILES = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
] as const;

const quote = (value: string): string =>
  /^[\w./@:-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export const dftInvocation = (nodePath: string, entry: string): string =>
  `${quote(nodePath)} ${quote(path.resolve(entry))}`;

const HookEntrySchema = Schema.StructWithRest(
  Schema.Struct({ command: Schema.String }),
  [Schema.Record(Schema.String, Schema.Json)]
);

export type HookEntry = typeof HookEntrySchema.Type;

const HooksFileSchema = Schema.StructWithRest(
  Schema.Struct({
    hooks: Schema.optional(
      Schema.Record(Schema.String, Schema.Array(HookEntrySchema))
    ),
    version: Schema.optional(Schema.Finite),
  }),
  [Schema.Record(Schema.String, Schema.Json)]
);

export type HooksFile = typeof HooksFileSchema.Type;

const decodeHooksFile = Schema.decodeUnknownResult(
  Schema.fromJsonString(HooksFileSchema)
);

export const parseHooksFile = (text: string): HooksFile | null => {
  const decoded = decodeHooksFile(text);

  return Result.isSuccess(decoded) ? decoded.success : null;
};

export const isDftHookCommand = (command: string): boolean =>
  /\bdft(?:\.js)?['"]?\s+hook\b/u.test(command) ||
  /\bdx\s+hook\b/u.test(command);

export const mergeCursorHooks = (existing: HooksFile, command: string) => {
  const merged = { ...existing.hooks };

  const added: string[] = [];

  for (const event of CURSOR_HOOK_EVENTS) {
    const current = merged[event] ?? [];

    if (!current.some((entry) => isDftHookCommand(entry.command))) {
      merged[event] = [...current, { command }];
      added.push(event);
    }
  }

  const file: HooksFile = {
    ...existing,
    hooks: merged,
    version: existing.version ?? 1,
  };

  return { added, file };
};

export interface InstallStep {
  readonly action: "created" | "updated" | "unchanged" | "printed" | "skipped";
  readonly detail: string;
  readonly path: string;
}

export const installCursorHooks = (
  worktree: string,
  command: string
): InstallStep => {
  const file = path.join(worktree, ".cursor", "hooks.json");
  const exists = existsSync(file);

  const parsed = exists
    ? parseHooksFile(readFileSync(file, "utf-8"))
    : { version: 1 };

  if (parsed === null) {
    return {
      action: "skipped",
      detail:
        "existing hooks.json is not valid Cursor hooks JSON; left untouched",
      path: file,
    };
  }

  const merged = mergeCursorHooks(parsed, command);

  if (merged.added.length === 0) {
    return {
      action: "unchanged",
      detail: "every Cursor hook event already calls dft hook",
      path: file,
    };
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged.file, null, 2)}\n`);

  return {
    action: exists ? "updated" : "created",
    detail: `added dft hook to ${merged.added.join(", ")}`,
    path: file,
  };
};

export const installSkills = (
  worktree: string,
  source: string = skillsSourceDir()
): readonly InstallStep[] => {
  const skills = loadSkills(source);

  if (skills.length === 0) {
    return [
      {
        action: "skipped",
        detail: "no Cursor skills found next to this dft build",
        path: source,
      },
    ];
  }

  if (path.resolve(source) === path.resolve(worktree, ".cursor", "skills")) {
    return [
      {
        action: "unchanged",
        detail:
          "target project is the recorder checkout; skills already in place",
        path: source,
      },
    ];
  }

  return skills.map((skill) => {
    const file = path.join(
      worktree,
      ".cursor",
      "skills",
      skill.name,
      "SKILL.md"
    );

    const exists = existsSync(file);

    if (exists && readFileSync(file, "utf-8") === skill.body) {
      return { action: "unchanged", detail: skill.name, path: file };
    }

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, skill.body);

    return {
      action: exists ? "updated" : "created",
      detail: skill.name,
      path: file,
    };
  });
};

export const gitHooksDir = (worktree: string): string =>
  path.resolve(
    worktree,
    execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: worktree,
      encoding: "utf-8",
    }).trim()
  );

export const lefthookConfig = (worktree: string): string | null =>
  LEFTHOOK_FILES.map((name) => path.join(worktree, name)).find((file) =>
    existsSync(file)
  ) ?? null;

export const hookLine = (command: string): string =>
  `${command} snapshot || true`;

export const lefthookSnippet = (command: string): string =>
  GIT_HOOKS.map(
    (hook) =>
      `${hook}:\n  commands:\n    dft-snapshot:\n      run: ${hookLine(command)}`
  ).join("\n");

export const installGitHooks = (
  worktree: string,
  command: string
): readonly InstallStep[] => {
  const lefthook = lefthookConfig(worktree);

  if (lefthook !== null) {
    return [
      {
        action: "printed",
        detail: `lefthook manages git hooks; add this to ${path.basename(lefthook)}:\n${lefthookSnippet(command)}`,
        path: lefthook,
      },
    ];
  }

  const dir = gitHooksDir(worktree);
  const line = hookLine(command);

  return GIT_HOOKS.map((hook) => {
    const file = path.join(dir, hook);

    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `#!/bin/sh\n${line}\n`);
      chmodSync(file, 0o755);

      return { action: "created", detail: hook, path: file };
    }

    const current = readFileSync(file, "utf-8");

    if (current.includes(" snapshot") && current.includes("dft")) {
      return { action: "unchanged", detail: hook, path: file };
    }

    const separator = current.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${current}${separator}${line}\n`);
    chmodSync(file, 0o755);

    return {
      action: "updated",
      detail: `${hook}: appended after the existing hook body`,
      path: file,
    };
  });
};
