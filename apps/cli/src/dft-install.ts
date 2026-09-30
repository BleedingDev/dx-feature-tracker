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
import { DatabaseSync } from "node:sqlite";

import { Option, Result, Schema } from "effect";

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

export const isGitRepo = (worktree: string): boolean => {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: worktree,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
};

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
  if (!isGitRepo(worktree)) {
    return [
      {
        action: "skipped",
        detail: "not a git repo, so there are no git hooks to add",
        path: worktree,
      },
    ];
  }

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

export const MIN_NODE = [24, 18] as const;

export const isOldNode = (version: string): boolean => {
  const [major = 0, minor = 0] = version
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Math.trunc(Number(part)) || 0);

  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
};

export const cursorConfigDir = (home: string, platform: string): string =>
  platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Cursor")
    : path.join(home, ".config", "Cursor");

export const isCursorInstalled = (home: string, platform: string): boolean =>
  existsSync(path.join(home, ".cursor")) ||
  existsSync(cursorConfigDir(home, platform));

export type CursorLogin = "yes" | "no" | "unknown";

const decodeTokenSize = Schema.decodeUnknownOption(
  Schema.Struct({ size: Schema.Finite })
);

export const cursorLogin = (home: string, platform: string): CursorLogin => {
  const db = path.join(
    cursorConfigDir(home, platform),
    "User",
    "globalStorage",
    "state.vscdb"
  );

  if (!existsSync(db)) {
    return "no";
  }

  try {
    const sqlite = new DatabaseSync(db, { readOnly: true });

    try {
      const row = sqlite
        .prepare(
          "SELECT length(value) AS size FROM ItemTable WHERE key = 'cursorAuth/accessToken'"
        )
        .get();

      return Option.match(decodeTokenSize(row), {
        onNone: () => "no",
        onSome: ({ size }) => (size > 2 ? "yes" : "no"),
      });
    } finally {
      sqlite.close();
    }
  } catch {
    return "unknown";
  }
};

export interface InstallChecks {
  readonly cursorInstalled: boolean;
  readonly gitRepo: boolean;
  readonly login: CursorLogin;
  readonly nodeVersion: string;
}

export const installChecks = (
  worktree: string,
  home: string,
  platform: string,
  nodeVersion: string
): InstallChecks => {
  const cursorInstalled = isCursorInstalled(home, platform);

  return {
    cursorInstalled,
    gitRepo: isGitRepo(worktree),
    login: cursorInstalled ? cursorLogin(home, platform) : "unknown",
    nodeVersion,
  };
};

export const installWarnings = (checks: InstallChecks): readonly string[] => [
  ...(checks.gitRepo
    ? []
    : [
        "This folder is not a git repo. dft tracks cost per branch, so run `git init` or cd into a repo.",
      ]),
  ...(checks.cursorInstalled
    ? []
    : [
        "Cursor not found on this machine. Install it from https://cursor.com, then open this repo in it.",
      ]),
  ...(checks.login === "no"
    ? [
        "Not logged in to Cursor. Sign in inside Cursor so dft can import your billed usage.",
      ]
    : []),
  ...(isOldNode(checks.nodeVersion)
    ? [
        `Node ${checks.nodeVersion.replace(/^v/u, "")} is too old. dft needs Node ${MIN_NODE.join(".")} or newer.`,
      ]
    : []),
];

const rel = (worktree: string, file: string): string => {
  const relative = path.relative(worktree, file);

  return relative.startsWith("..") || path.isAbsolute(relative)
    ? file
    : relative;
};

const isDone = (step: InstallStep): boolean =>
  step.action === "created" ||
  step.action === "updated" ||
  step.action === "unchanged";

export interface InstallResult {
  readonly git: readonly InstallStep[] | null;
  readonly hooks: InstallStep;
  readonly skills: readonly InstallStep[];
  readonly worktree: string;
}

interface Row {
  readonly label: string;
  readonly text: string;
}

interface Outcome {
  readonly done: Row | null;
  readonly skipped: string | null;
}

const doneRow = (label: string, text: string): Outcome => ({
  done: { label, text },
  skipped: null,
});

const skippedLine = (text: string): Outcome => ({ done: null, skipped: text });

const LABEL_WIDTH = 15;

const row = (mark: string, item: Row): string =>
  `  ${mark} ${item.label.padEnd(LABEL_WIDTH)} ${item.text}`;

const hooksLine = (result: InstallResult): Outcome => {
  const { hooks, worktree } = result;
  const where = rel(worktree, hooks.path);

  if (hooks.action === "skipped") {
    return skippedLine(
      `${where} is not valid JSON, so dft left it alone. Fix or delete it, then run \`dft install\` again.`
    );
  }

  return doneRow(
    "Cursor hooks",
    hooks.action === "unchanged" ? `${where} (already there)` : where
  );
};

const skillsLine = (result: InstallResult): Outcome => {
  const done = result.skills.filter(
    (step) => isDone(step) && step.path.endsWith("SKILL.md")
  );

  if (done.length > 0) {
    const names = done.map((step) => `/${step.detail}`).join(", ");

    const already = done.every((step) => step.action === "unchanged")
      ? ", already there"
      : "";

    return doneRow("Cursor skills", `${names} (in .cursor/skills${already})`);
  }

  const [first] = result.skills;

  if (first?.action === "unchanged") {
    return doneRow("Cursor skills", "already in this repo");
  }

  return skippedLine(
    "Cursor skills: none found next to this dft build, so none were copied."
  );
};

interface GitLines {
  readonly done: Row | null;
  readonly notes: readonly string[];
  readonly skipped: readonly string[];
}

const gitLines = (result: InstallResult): GitLines => {
  if (result.git === null) {
    return { done: null, notes: [], skipped: [] };
  }

  const [first] = result.git;

  if (first?.action === "printed") {
    const [, ...snippet] = first.detail.split("\n");

    return {
      done: null,
      notes: [],
      skipped: [
        [
          `Git hooks: lefthook manages them, so dft did not edit any. Add this to ${path.basename(first.path)}:`,
          "",
          ...snippet.map((line) => `      ${line}`),
        ].join("\n"),
      ],
    };
  }

  if (first?.action === "skipped") {
    return { done: null, notes: [], skipped: [`Git hooks: ${first.detail}`] };
  }

  const names = result.git.map((step) => step.detail.split(":")[0]).join(", ");

  const appended = result.git
    .filter((step) => step.action === "updated")
    .map(
      (step) =>
        `Git hook ${step.detail.split(":")[0]} already existed. dft kept it and added one line at the end.`
    );

  return {
    done: { label: "Git hooks", text: `${names} (record cost on each commit)` },
    notes: appended,
    skipped: [],
  };
};

const NEXT_STEPS: readonly Row[] = [
  {
    label: "Restart Cursor",
    text: "so it loads the hooks (or run Developer: Reload Window)",
  },
  { label: "Work as usual", text: "in Cursor, on a branch" },
  {
    label: "dft analyze",
    text: "cost of this branch (or type /dx-analyze in Cursor chat)",
  },
  { label: "dft history", text: "cost of every branch" },
  { label: "dft --help", text: "all commands" },
];

const section = (title: string, lines: readonly string[]): string =>
  [title, ...lines].join("\n");

export const installText = (
  result: InstallResult,
  checks: InstallChecks,
  home = ""
): string => {
  const warnings = installWarnings(checks);
  const done: string[] = [];
  const skipped: string[] = [];

  for (const outcome of [hooksLine(result), skillsLine(result)]) {
    if (outcome.done !== null) {
      done.push(row("✓", outcome.done));
    }

    if (outcome.skipped !== null) {
      skipped.push(outcome.skipped);
    }
  }

  const git = gitLines(result);

  if (git.done !== null) {
    done.push(row("✓", git.done));
  }

  skipped.push(...git.skipped);

  const ok = result.hooks.action !== "skipped";

  const where =
    home !== "" && result.worktree.startsWith(`${home}/`)
      ? `~${result.worktree.slice(home.length)}`
      : result.worktree;

  const header = ok
    ? `dft is set up in ${where}`
    : `dft setup is not finished in ${where}`;

  const blocks = [header];

  if (done.length > 0) {
    blocks.push(section("Set up", done));
  }

  if (result.git === null && checks.gitRepo) {
    blocks.push(
      section("Optional", [
        "  Record cost on every commit:  dft install --git-hooks",
      ])
    );
  }

  if (skipped.length > 0) {
    blocks.push(
      section(
        "Skipped",
        skipped.map((note) => `  - ${note}`)
      )
    );
  }

  if (git.notes.length > 0) {
    blocks.push(
      section(
        "Note",
        git.notes.map((note) => `  - ${note}`)
      )
    );
  }

  if (warnings.length > 0) {
    blocks.push(
      section(
        "Check this",
        warnings.map((warning) => `  ! ${warning}`)
      )
    );
  }

  const width = Math.max(...NEXT_STEPS.map((step) => step.label.length));

  blocks.push(
    section(
      "Next steps",
      NEXT_STEPS.map(
        (step, index) =>
          `  ${index + 1}. ${step.label.padEnd(width)}  ${step.text}`
      )
    )
  );

  return blocks.join("\n\n");
};
