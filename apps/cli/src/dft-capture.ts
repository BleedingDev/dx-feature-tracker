// @effect-diagnostics nodeBuiltinImport:off -- dft install writes project-local capture files (tool hooks, extensions, plugins) at the process boundary with synchronous node:fs and git calls.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  OMP_EXTENSION_FILE,
  OMP_EXTENSION_MARKER,
  OPENCODE_PLUGIN_FILE,
  PI_EXTENSION_FILE_NAME,
  PI_EXTENSION_MARKER,
  ompExtensionSource,
  opencodePluginSource,
  piExtensionSource,
} from "@rat-stack/core/dx";
import { Result, Schema, Struct } from "effect";

import { isDftHookCommand, otherWorktrees } from "./dft-install.js";

export const CAPTURE_TOOLS = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
  "omp",
  "deepseek",
] as const;

export type CaptureTool = (typeof CAPTURE_TOOLS)[number];

export const CAPTURE_TOOL_NAMES: Readonly<Record<CaptureTool, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  deepseek: "DeepSeek Harness",
  omp: "OMP",
  opencode: "OpenCode",
  pi: "Pi",
};

export const isCaptureTool = (value: string): value is CaptureTool =>
  CAPTURE_TOOLS.some((tool) => tool === value);

export type CaptureAction =
  | "created"
  | "updated"
  | "unchanged"
  | "removed"
  | "skipped";

export interface CaptureStep {
  readonly action: CaptureAction;
  readonly detail: string;
  readonly path: string;
  readonly tool: CaptureTool | "cursor" | "git";
}

export interface DftCommand {
  readonly argv: readonly string[];
  readonly line: string;
}

const quote = (value: string): string =>
  /^[\w./@:-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export const dftCommandFor = (nodePath: string, entry: string): DftCommand => {
  const script = path.resolve(entry);

  return {
    argv: [nodePath, script],
    line: `${quote(nodePath)} ${quote(script)}`,
  };
};

const JsonRest = [Schema.Record(Schema.String, Schema.Json)] as const;

const CommandHookSchema = Schema.StructWithRest(
  Schema.Struct({ command: Schema.optional(Schema.String) }),
  JsonRest
);

type CommandHook = typeof CommandHookSchema.Type;

const MatcherGroupSchema = Schema.StructWithRest(
  Schema.Struct({ hooks: Schema.optional(Schema.Array(CommandHookSchema)) }),
  JsonRest
);

type MatcherGroup = typeof MatcherGroupSchema.Type;

const HookConfigSchema = Schema.StructWithRest(
  Schema.Struct({
    hooks: Schema.optional(
      Schema.Record(Schema.String, Schema.Array(MatcherGroupSchema))
    ),
  }),
  JsonRest
);

export type HookConfig = typeof HookConfigSchema.Type;

const decodeJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Json)
);

const isHookConfig = Schema.is(HookConfigSchema);

export const parseHookConfig = (text: string): HookConfig | null => {
  const decoded = decodeJson(text);

  return Result.isSuccess(decoded) && isHookConfig(decoded.success)
    ? decoded.success
    : null;
};

export interface HookSpec {
  readonly event: string;
  readonly matcher: string | null;
  readonly sync?: boolean;
}

const SYNC_TIMEOUT = 3;

export interface HookStyle {
  readonly async: boolean;
  readonly timeout: number;
}

const isDftEntry = (entry: CommandHook): boolean =>
  entry.command !== undefined && isDftHookCommand(entry.command);

const groupHasDft = (group: MatcherGroup): boolean =>
  (group.hooks ?? []).some(isDftEntry);

const newGroup = (
  spec: HookSpec,
  command: string,
  style: HookStyle
): MatcherGroup => {
  const entry: CommandHook =
    style.async && spec.sync !== true
      ? { async: true, command, timeout: style.timeout, type: "command" }
      : {
          command,
          timeout:
            spec.sync === true
              ? Math.min(style.timeout, SYNC_TIMEOUT)
              : style.timeout,
          type: "command",
        };

  return spec.matcher === null
    ? { hooks: [entry] }
    : { hooks: [entry], matcher: spec.matcher };
};

export interface HookMerge {
  readonly added: readonly string[];
  readonly file: HookConfig;
  readonly refreshed: readonly string[];
}

const staleDft =
  (command: string) =>
  (entry: CommandHook): boolean =>
    isDftEntry(entry) && entry.command !== command;

const withCommand = (group: MatcherGroup, command: string): MatcherGroup =>
  group.hooks === undefined
    ? group
    : {
        ...group,
        hooks: group.hooks.map((entry) =>
          isDftEntry(entry) ? { ...entry, command } : entry
        ),
      };

export const mergeHookConfig = (
  existing: HookConfig,
  specs: readonly HookSpec[],
  commandFor: (event: string) => string,
  style: HookStyle
): HookMerge => {
  const hooks = { ...existing.hooks };
  const added: string[] = [];
  const refreshed: string[] = [];

  for (const spec of specs) {
    const groups = hooks[spec.event] ?? [];
    const command = commandFor(spec.event);

    if (!groups.some(groupHasDft)) {
      hooks[spec.event] = [...groups, newGroup(spec, command, style)];
      added.push(spec.event);
    } else if (
      groups.some((group) => (group.hooks ?? []).some(staleDft(command)))
    ) {
      hooks[spec.event] = groups.map((group) => withCommand(group, command));
      refreshed.push(spec.event);
    }
  }

  return { added, file: { ...existing, hooks }, refreshed };
};

export interface HookRemoval {
  readonly empty: boolean;
  readonly file: HookConfig;
  readonly removed: readonly string[];
}

const withoutKey = (config: HookConfig): HookConfig =>
  Struct.omit(config, ["hooks"]);

export const removeDftHooks = (existing: HookConfig): HookRemoval => {
  const removed: string[] = [];
  const kept: Record<string, readonly MatcherGroup[]> = {};

  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    const next = groups.flatMap((group): readonly MatcherGroup[] => {
      if (!groupHasDft(group)) {
        return [group];
      }

      const rest = (group.hooks ?? []).filter((entry) => !isDftEntry(entry));

      return rest.length === 0 ? [] : [{ ...group, hooks: rest }];
    });

    if (groups.some(groupHasDft)) {
      removed.push(event);
    }

    if (next.length > 0) {
      kept[event] = next;
    }
  }

  const file =
    Object.keys(kept).length === 0 && existing.hooks !== undefined
      ? withoutKey(existing)
      : { ...existing, hooks: kept };

  return { empty: Object.keys(file).length === 0, file, removed };
};

const runGit = (worktree: string, args: readonly string[]): string | null => {
  try {
    return execFileSync("git", [...args], {
      cwd: worktree,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

const insideGit = (worktree: string): boolean =>
  runGit(worktree, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";

export const isTracked = (worktree: string, rel: string): boolean =>
  runGit(worktree, ["ls-files", "--error-unmatch", "--", rel]) !== null;

export const isIgnored = (worktree: string, rel: string): boolean =>
  runGit(worktree, ["check-ignore", "-q", "--no-index", "--", rel]) !== null;

export const EXCLUDE_START = "# >>> dft local capture files";

export const EXCLUDE_END = "# <<< dft local capture files";

const excludeFile = (worktree: string): string | null => {
  const out = runGit(worktree, ["rev-parse", "--git-path", "info/exclude"]);

  return out === null ? null : path.resolve(worktree, out.trim());
};

interface ExcludeParts {
  readonly after: readonly string[];
  readonly before: readonly string[];
  readonly block: readonly string[];
}

const splitExclude = (text: string): ExcludeParts => {
  const lines = text === "" ? [] : text.replace(/\n$/u, "").split("\n");
  const start = lines.indexOf(EXCLUDE_START);
  const end = lines.indexOf(EXCLUDE_END);

  if (start === -1 || end < start) {
    return { after: [], before: lines, block: [] };
  }

  return {
    after: lines.slice(end + 1),
    before: lines.slice(0, start),
    block: lines.slice(start + 1, end),
  };
};

const joinExclude = (parts: ExcludeParts): string => {
  const block =
    parts.block.length === 0
      ? []
      : [EXCLUDE_START, ...parts.block, EXCLUDE_END];

  const lines = [...parts.before, ...block, ...parts.after];

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
};

const ignoreLine = (rel: string): string => `/${rel.split(path.sep).join("/")}`;

export const ignoreCaptureFiles = (
  worktree: string,
  rels: readonly string[]
): readonly CaptureStep[] => {
  if (rels.length === 0 || !insideGit(worktree)) {
    return [];
  }

  const file = excludeFile(worktree);

  if (file === null) {
    return [];
  }

  const missing = rels.filter((rel) => !isIgnored(worktree, rel));

  if (missing.length === 0) {
    return [];
  }

  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const parts = splitExclude(text);
  const lines = missing.map(ignoreLine);

  const block = [
    ...parts.block,
    ...lines.filter((line) => !parts.block.includes(line)),
  ];

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, joinExclude({ ...parts, block }));

  return [
    {
      action: text === "" ? "created" : "updated",
      detail: `ignored by git in this clone only: ${lines.join(", ")}`,
      path: file,
      tool: "git",
    },
  ];
};

interface HooksTarget {
  readonly kind: "hooks";
  readonly rel: string;
  readonly specs: readonly HookSpec[];
  readonly style: HookStyle;
  readonly toolArg: CaptureTool;
}

interface FileTarget {
  readonly content: string;
  readonly kind: "file";
  readonly marker: string;
  readonly rel: string;
}

type CaptureTarget = HooksTarget | FileTarget;

const LIFECYCLE_HOOKS: readonly HookSpec[] = [
  { event: "SessionStart", matcher: null },
  { event: "SessionEnd", matcher: null },
  { event: "Stop", matcher: null },
  { event: "SubagentStop", matcher: null },
  { event: "PostToolUse", matcher: "*" },
];

const CODEX_HOOKS: readonly HookSpec[] = [
  { event: "SessionStart", matcher: null },
  { event: "SessionEnd", matcher: null, sync: true },
  { event: "Stop", matcher: null },
  { event: "SubagentStop", matcher: null },
  { event: "PostToolUse", matcher: "*" },
];

const DSH_HOOKS: readonly HookSpec[] = [
  { event: "SessionStart", matcher: null },
  { event: "Stop", matcher: null },
  { event: "SubagentStop", matcher: null },
  { event: "PostToolUse", matcher: "*" },
];

export const CLAUDE_SETTINGS_LOCAL = path.join(
  ".claude",
  "settings.local.json"
);

export const CODEX_PROJECT_HOOKS = path.join(".codex", "hooks.json");

export const DSH_HOOKS_FILE = path.join(".dsh", "dft-hooks.json");

export const DSH_PATCH_FILE = path.join(".dsh", "dft.patch.yml");

export const PI_EXTENSION_PATH = path.join(
  ".pi",
  "extensions",
  PI_EXTENSION_FILE_NAME
);

export const OMP_EXTENSION_PATH = path.join(
  ".omp",
  "extensions",
  OMP_EXTENSION_FILE
);

export const OPENCODE_PLUGIN_PATH = path.join(
  ".opencode",
  "plugins",
  OPENCODE_PLUGIN_FILE
);

export const DSH_PATCH_MARKER = "# dft-managed dsh patch";

const OPENCODE_MARKER = '"hook", "opencode", event.type';

export const dshPatchSource = (hooksFile: string): string =>
  [
    `${DSH_PATCH_MARKER}: dft uninstall removes this file.`,
    "# Start dsh with --patch .dsh/dft.patch.yml so it reports to dft.",
    "- insert:",
    "    - id: dft-hooks",
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    "      config:",
    `        configPath: ${JSON.stringify(hooksFile)}`,
    "",
  ].join("\n");

const targetsFor = (
  tool: CaptureTool,
  worktree: string,
  command: DftCommand
): readonly CaptureTarget[] => {
  switch (tool) {
    case "claude-code": {
      return [
        {
          kind: "hooks",
          rel: CLAUDE_SETTINGS_LOCAL,
          specs: LIFECYCLE_HOOKS,
          style: { async: true, timeout: 30 },
          toolArg: "claude-code",
        },
      ];
    }

    case "codex": {
      return [
        {
          kind: "hooks",
          rel: CODEX_PROJECT_HOOKS,
          specs: CODEX_HOOKS,
          style: { async: true, timeout: 30 },
          toolArg: "codex",
        },
      ];
    }

    case "deepseek": {
      return [
        {
          kind: "hooks",
          rel: DSH_HOOKS_FILE,
          specs: DSH_HOOKS,
          style: { async: false, timeout: 10 },
          toolArg: "deepseek",
        },
        {
          content: dshPatchSource(path.join(worktree, DSH_HOOKS_FILE)),
          kind: "file",
          marker: DSH_PATCH_MARKER,
          rel: DSH_PATCH_FILE,
        },
      ];
    }

    case "omp": {
      return [
        {
          content: ompExtensionSource(command.argv),
          kind: "file",
          marker: OMP_EXTENSION_MARKER,
          rel: OMP_EXTENSION_PATH,
        },
      ];
    }

    case "opencode": {
      return [
        {
          content: opencodePluginSource(command.argv),
          kind: "file",
          marker: OPENCODE_MARKER,
          rel: OPENCODE_PLUGIN_PATH,
        },
      ];
    }

    case "pi": {
      return [
        {
          content: piExtensionSource(command.argv),
          kind: "file",
          marker: PI_EXTENSION_MARKER,
          rel: PI_EXTENSION_PATH,
        },
      ];
    }

    default: {
      return [];
    }
  }
};

const NO_COMMAND: DftCommand = { argv: [], line: "" };

export const captureFiles = (tool: CaptureTool): readonly string[] =>
  targetsFor(tool, "", NO_COMMAND).map((target) => target.rel);

const step = (
  tool: CaptureTool,
  action: CaptureAction,
  file: string,
  detail: string
): CaptureStep => ({ action, detail, path: file, tool });

const trackedStep = (tool: CaptureTool, file: string): CaptureStep =>
  step(
    tool,
    "skipped",
    file,
    "this file is tracked by git, so changing it would affect teammates; dft left it alone"
  );

const hookChangeText = (change: {
  readonly added: readonly string[];
  readonly refreshed: readonly string[];
}): string =>
  [
    ...(change.added.length === 0
      ? []
      : [`added dft hook to ${change.added.join(", ")}`]),
    ...(change.refreshed.length === 0
      ? []
      : [
          `pointed the dft hook in ${change.refreshed.join(", ")} at this node and dft`,
        ]),
  ].join("; ");

const writeHooks = (
  tool: CaptureTool,
  worktree: string,
  target: HooksTarget,
  command: DftCommand
): CaptureStep => {
  const file = path.join(worktree, target.rel);
  const exists = existsSync(file);
  const parsed = exists ? parseHookConfig(readFileSync(file, "utf-8")) : {};

  if (parsed === null) {
    return step(
      tool,
      "skipped",
      file,
      "not valid hooks JSON, so dft left it alone. Fix it, then run dft install again."
    );
  }

  const merged = mergeHookConfig(
    parsed,
    target.specs,
    (event) => `${command.line} hook ${target.toolArg} ${event}`,
    target.style
  );

  if (merged.added.length === 0 && merged.refreshed.length === 0) {
    return step(tool, "unchanged", file, "dft hooks already there");
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged.file, null, 2)}\n`);

  return step(
    tool,
    exists ? "updated" : "created",
    file,
    hookChangeText(merged)
  );
};

const writeOwned = (
  tool: CaptureTool,
  worktree: string,
  target: FileTarget
): CaptureStep => {
  const file = path.join(worktree, target.rel);

  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, target.content);

    return step(tool, "created", file, "written by dft");
  }

  const current = readFileSync(file, "utf-8");

  if (!current.includes(target.marker)) {
    return step(
      tool,
      "skipped",
      file,
      "a file with this name exists and dft did not write it; left alone"
    );
  }

  if (current === target.content) {
    return step(tool, "unchanged", file, "already there");
  }

  writeFileSync(file, target.content);

  return step(tool, "updated", file, "refreshed to this dft build");
};

export interface ToolCapture {
  readonly steps: readonly CaptureStep[];
  readonly tool: CaptureTool;
}

export const installToolCapture = (
  tool: CaptureTool,
  worktree: string,
  command: DftCommand
): ToolCapture => ({
  steps: targetsFor(tool, worktree, command).map((target) => {
    const file = path.join(worktree, target.rel);

    if (isTracked(worktree, target.rel)) {
      return trackedStep(tool, file);
    }

    return target.kind === "hooks"
      ? writeHooks(tool, worktree, target, command)
      : writeOwned(tool, worktree, target);
  }),
  tool,
});

export interface CaptureInstall {
  readonly ignore: readonly CaptureStep[];
  readonly tools: readonly ToolCapture[];
}

const written = (capture: ToolCapture): readonly string[] =>
  capture.steps.flatMap((item) =>
    item.action === "skipped" ? [] : [item.path]
  );

export const installCapture = (
  tools: readonly CaptureTool[],
  worktree: string,
  command: DftCommand
): CaptureInstall => {
  const captures = tools.map((tool) =>
    installToolCapture(tool, worktree, command)
  );

  const rels = captures
    .flatMap(written)
    .map((file) => path.relative(worktree, file));

  return { ignore: ignoreCaptureFiles(worktree, rels), tools: captures };
};

const removeEmptyDirs = (worktree: string, dir: string): void => {
  let current = dir;

  while (current.startsWith(`${worktree}${path.sep}`)) {
    try {
      if (readdirSync(current).length > 0) {
        return;
      }

      rmdirSync(current);
    } catch {
      return;
    }

    current = path.dirname(current);
  }
};

const removeHooks = (
  tool: CaptureTool,
  worktree: string,
  target: HooksTarget
): CaptureStep | null => {
  const file = path.join(worktree, target.rel);

  if (!existsSync(file)) {
    return null;
  }

  const parsed = parseHookConfig(readFileSync(file, "utf-8"));

  if (parsed === null) {
    return step(tool, "skipped", file, "not valid hooks JSON; left alone");
  }

  const removal = removeDftHooks(parsed);

  if (removal.removed.length === 0) {
    return null;
  }

  if (removal.empty) {
    rmSync(file);
    removeEmptyDirs(worktree, path.dirname(file));

    return step(tool, "removed", file, "only dft hooks were in it");
  }

  writeFileSync(file, `${JSON.stringify(removal.file, null, 2)}\n`);

  return step(
    tool,
    "updated",
    file,
    `removed dft hook from ${removal.removed.join(", ")}; kept everything else`
  );
};

const removeOwned = (
  tool: CaptureTool,
  worktree: string,
  target: FileTarget
): CaptureStep | null => {
  const file = path.join(worktree, target.rel);

  if (
    !existsSync(file) ||
    !readFileSync(file, "utf-8").includes(target.marker)
  ) {
    return null;
  }

  rmSync(file);
  removeEmptyDirs(worktree, path.dirname(file));

  return step(tool, "removed", file, "written by dft");
};

const holdsDft = (target: CaptureTarget, text: string): boolean => {
  if (target.kind === "file") {
    return text.includes(target.marker);
  }

  const parsed = parseHookConfig(text);

  return (
    parsed !== null &&
    target.specs.every((spec) =>
      (parsed.hooks?.[spec.event] ?? []).some(groupHasDft)
    )
  );
};

const holdsDftFile = (worktree: string, rel: string): boolean => {
  const file = path.join(worktree, rel);

  if (!existsSync(file)) {
    return false;
  }

  const target = CAPTURE_TOOLS.flatMap((tool) =>
    targetsFor(tool, worktree, NO_COMMAND)
  ).find((item) => item.rel === rel);

  return target === undefined || holdsDft(target, readFileSync(file, "utf-8"));
};

export const hasCapture = (tool: CaptureTool, worktree: string): boolean =>
  targetsFor(tool, worktree, NO_COMMAND).every((target) =>
    holdsDftFile(worktree, target.rel)
  );

export const hasSomeCapture = (tool: CaptureTool, worktree: string): boolean =>
  targetsFor(tool, worktree, NO_COMMAND).some((target) =>
    holdsDftFile(worktree, target.rel)
  );

const SHELL_WORD = /(?:'[^']*'|\\.|[^\s'\\])+/gu;

const SHELL_PART = /'(?<quoted>[^']*)'|\\(?<escaped>.)|(?<plain>[^'\\]+)/gu;

const unquote = (word: string): string =>
  Array.from(
    word.matchAll(SHELL_PART),
    (part) =>
      part.groups?.quoted ?? part.groups?.escaped ?? part.groups?.plain ?? ""
  ).join("");

export const shellWords = (line: string): readonly string[] =>
  Array.from(line.matchAll(SHELL_WORD), (match) => unquote(match[0]));

const dftCommands = (text: string): readonly string[] =>
  Object.values(parseHookConfig(text)?.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) =>
      (group.hooks ?? []).flatMap((entry) =>
        entry.command !== undefined && isDftHookCommand(entry.command)
          ? [entry.command]
          : []
      )
    )
  );

const EMBEDDED_ARGV =
  /^\s*const\s+(?:DFT_COMMAND\b[^=]*|\[\s*DFT\s*,[^\]]*\])\s*=\s*(?<argv>\[.*\]);\s*$/mu;

const decodeArgv = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(Schema.String))
);

const embeddedArgv = (text: string): readonly string[] => {
  const argv = EMBEDDED_ARGV.exec(text)?.groups?.argv;

  if (argv === undefined) {
    return [];
  }

  const decoded = decodeArgv(argv);

  return Result.isSuccess(decoded) ? decoded.success : [];
};

const commandWords = (target: CaptureTarget, text: string) =>
  target.kind === "hooks"
    ? dftCommands(text).map((command) => shellWords(command))
    : [embeddedArgv(text)];

export const missingHookPaths = (
  tool: CaptureTool,
  worktree: string
): readonly string[] => {
  const missing = targetsFor(tool, worktree, NO_COMMAND).flatMap((target) => {
    const file = path.join(worktree, target.rel);

    if (!existsSync(file)) {
      return [];
    }

    return commandWords(target, readFileSync(file, "utf-8")).flatMap((words) =>
      words
        .slice(0, 2)
        .filter((word) => path.isAbsolute(word) && !existsSync(word))
    );
  });

  return [...new Set(missing)];
};

const ruleRel = (line: string): string =>
  line.replace(/^\//u, "").split("/").join(path.sep);

export const unignoreCaptureFiles = (
  worktree: string
): readonly CaptureStep[] => {
  if (!insideGit(worktree)) {
    return [];
  }

  const file = excludeFile(worktree);

  if (file === null || !existsSync(file)) {
    return [];
  }

  const text = readFileSync(file, "utf-8");
  const parts = splitExclude(text);

  if (parts.block.length === 0 && !text.includes(EXCLUDE_START)) {
    return [];
  }

  const others = otherWorktrees(worktree);

  const kept = parts.block.filter((line) =>
    others.some((other) => holdsDftFile(other, ruleRel(line)))
  );

  const dropped = parts.block.filter((line) => !kept.includes(line));

  if (dropped.length === 0 && parts.block.length > 0) {
    return [];
  }

  writeFileSync(file, joinExclude({ ...parts, block: kept }));

  return [
    {
      action: "removed",
      detail:
        kept.length === 0
          ? `dft lines: ${dropped.join(", ")}`
          : `dft lines: ${dropped.join(", ")}; kept ${kept.join(", ")} for another worktree that still uses them`,
      path: file,
      tool: "git",
    },
  ];
};

export const uninstallCapture = (
  worktree: string,
  command: DftCommand
): readonly CaptureStep[] => {
  const steps = CAPTURE_TOOLS.flatMap((tool) =>
    targetsFor(tool, worktree, command).flatMap((target) => {
      if (isTracked(worktree, target.rel)) {
        return [];
      }

      const result =
        target.kind === "hooks"
          ? removeHooks(tool, worktree, target)
          : removeOwned(tool, worktree, target);

      return result === null ? [] : [result];
    })
  );

  return [...steps, ...unignoreCaptureFiles(worktree)];
};
