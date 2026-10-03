// @effect-diagnostics nodeBuiltinImport:off -- dft install edits project files (.cursor/hooks.json, skills, git hooks) at the process boundary with synchronous node:fs calls.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AgentError } from "@rat-stack/core/dx";
import {
  Array as EffectArray,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";

import { enterpriseLine } from "./dft-render.js";
import {
  RELEASED_SKILL_DIGESTS,
  isReleasedSkillBody,
  loadSkills,
  skillDigest,
  skillsSourceDir,
} from "./dft-skills.js";
import type { DftSkill } from "./dft-skills.js";

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

const gitSucceeds = (worktree: string, args: readonly string[]): boolean => {
  try {
    execFileSync("git", [...args], { cwd: worktree, stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
};

const gitTracks = (worktree: string, rel: string): boolean =>
  gitSucceeds(worktree, ["ls-files", "--error-unmatch", "--", rel]);

const gitIgnores = (worktree: string, rel: string): boolean =>
  gitSucceeds(worktree, ["check-ignore", "-q", "--no-index", "--", rel]);

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
  /\bdft(?:-main)?(?:\.[cm]?js)?['"]?\s+hook\b/u.test(command) ||
  /\bdx\s+hook\b/u.test(command);

export const mergeCursorHooks = (
  existing: HooksFile,
  command: string,
  refresh = true
) => {
  const merged = { ...existing.hooks };

  const added: string[] = [];
  const refreshed: string[] = [];

  for (const event of CURSOR_HOOK_EVENTS) {
    const current = merged[event] ?? [];

    if (!current.some((entry) => isDftHookCommand(entry.command))) {
      merged[event] = [...current, { command }];
      added.push(event);
    } else if (
      refresh &&
      current.some(
        (entry) => isDftHookCommand(entry.command) && entry.command !== command
      )
    ) {
      merged[event] = current.map((entry) =>
        isDftHookCommand(entry.command) ? { ...entry, command } : entry
      );
      refreshed.push(event);
    }
  }

  const file: HooksFile = {
    ...existing,
    hooks: merged,
    version: existing.version ?? 1,
  };

  return { added, file, refreshed };
};

export interface InstallStep {
  readonly action: "created" | "updated" | "unchanged" | "printed" | "skipped";
  readonly detail: string;
  readonly path: string;
}

export interface PreparedOwnershipInstallation {
  readonly maxOwnershipBytes?: number;
  readonly onOwnershipWrite?: (
    file: string,
    body: string | null,
    phase: "before" | "after"
  ) => void;
}

export interface PreparedSkillInstallation extends PreparedOwnershipInstallation {
  readonly ownershipPath: string;
  readonly readFile?: PreparedInstallationReader;
  readonly skills: readonly DftSkill[];
}

export type PreparedInstallationReader = (
  file: string,
  purpose: "text" | "binary"
) => Uint8Array | null;

export interface PreparedHookInstallation extends PreparedOwnershipInstallation {
  readonly ownershipPath: string;
  readonly readFile: PreparedInstallationReader;
  readonly refresh: boolean;
}

const InstallOwnershipSchema = Schema.Struct({
  createdHookEvents: Schema.optional(Schema.Array(Schema.String)),
  hookFileCreated: Schema.Boolean,
  hooks: Schema.Record(Schema.String, Schema.Array(HookEntrySchema)),
  schema: Schema.Literal("dft.install.ownership.v1"),
  skills: Schema.Record(Schema.String, Schema.String),
});

type InstallOwnership = typeof InstallOwnershipSchema.Type;

type OwnershipJson =
  | null
  | undefined
  | string
  | number
  | boolean
  | readonly OwnershipJson[]
  | { readonly [key: string]: OwnershipJson };

const safeInstallPath = (
  root: string,
  file: string,
  finalKind: "file" | "directory" = "file"
): boolean => {
  const relative = path.relative(root, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  const parts = relative.split(path.sep).filter((part) => part.length > 0);

  return parts.every((_, index) => {
    const current = path.join(root, ...parts.slice(0, index + 1));
    const stat = lstatSync(current, { throwIfNoEntry: false });

    return (
      stat === undefined ||
      (!stat.isSymbolicLink() &&
        (index === parts.length - 1 && finalKind === "file"
          ? stat.isFile()
          : stat.isDirectory()))
    );
  });
};

const decodeInstallOwnership = Schema.decodeUnknownOption(
  Schema.fromJsonString(InstallOwnershipSchema)
);

const ownershipFile = (worktree: string, installation: string): string => {
  const name = `${skillDigest(installation).slice(0, 16)}.json`;

  try {
    return path.resolve(
      worktree,
      execFileSync("git", ["rev-parse", "--git-path", `dft-install/${name}`], {
        cwd: worktree,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    );
  } catch {
    return path.join(worktree, installation, "dft-install.ownership.json");
  }
};

const readInstallText = (
  file: string,
  readFile?: PreparedInstallationReader
): string | null => {
  if (readFile === undefined) {
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  }

  const body = readFile(file, "text");

  return body === null ? null : Buffer.from(body).toString("utf-8");
};

const readInstallOwnership = (
  file: string,
  readFile?: PreparedInstallationReader
): InstallOwnership | null => {
  if (!safeInstallPath(path.dirname(path.dirname(file)), file)) {
    return null;
  }

  const body = readInstallText(file, readFile);

  if (body === null) {
    return {
      hookFileCreated: false,
      hooks: {},
      schema: "dft.install.ownership.v1",
      skills: {},
    };
  }

  return Option.getOrNull(decodeInstallOwnership(body));
};

const OWNERSHIP_SHORT_ESCAPES: ReadonlySet<number> = new Set([
  8, 9, 10, 12, 13, 34, 92,
]);

const ownershipStringBytes = (value: string, remaining: number): number => {
  let bytes = 2;

  for (const character of value) {
    if (bytes > remaining) {
      break;
    }

    const code = character.codePointAt(0) ?? 0;

    if (OWNERSHIP_SHORT_ESCAPES.has(code)) {
      bytes += 2;
    } else if (code < 32 || (code >= 0xd8_00 && code <= 0xdf_ff)) {
      bytes += 6;
    } else if (code < 128) {
      bytes += 1;
    } else if (code < 2048) {
      bytes += 2;
    } else if (code < 65_536) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
};

const checkOwnershipBytes = (
  ownership: InstallOwnership,
  maxBytes: number
): void => {
  const pending: { readonly value: OwnershipJson; readonly depth: number }[] = [
    { depth: 0, value: ownership },
  ];

  let bytes = 0;

  const addBytes = (count: number): void => {
    bytes += count;

    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || bytes > maxBytes) {
      throw new AgentError({
        code: "budget-exhausted",
        currentRevision: null,
        expectedRevision: null,
        message: "The serialized installer ownership exceeds its byte bound.",
        recovery: { action: "replan", ref: null },
        ref: null,
        retryable: false,
      });
    }
  };

  addBytes(1);

  while (pending.length > 0) {
    const item = pending.pop();

    if (item === undefined) {
      break;
    }

    const { depth, value } = item;

    if (Predicate.isString(value)) {
      addBytes(ownershipStringBytes(value, maxBytes - bytes));
    } else if (Predicate.isObject(value)) {
      const entries = EffectArray.isArray<OwnershipJson>(value)
        ? Array.from(value, (entry) => ({ key: null, value: entry }))
        : Object.entries<OwnershipJson>(value)
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => ({ key, value: entry }));

      addBytes(2);

      if (entries.length > 0) {
        addBytes(2 + depth * 2 + (entries.length - 1) * 2);

        for (const entry of entries) {
          addBytes((depth + 1) * 2);

          if (entry.key !== null) {
            addBytes(ownershipStringBytes(entry.key, maxBytes - bytes) + 2);
          }

          pending.push({ depth: depth + 1, value: entry.value });
        }
      }
    } else if (Predicate.isNumber(value)) {
      addBytes(Number.isFinite(value) ? String(value).length : 4);
    } else if (Predicate.isBoolean(value)) {
      addBytes(value ? 4 : 5);
    } else {
      addBytes(4);
    }
  }
};

const serializeInstallOwnership = (
  ownership: InstallOwnership,
  maxBytes?: number
): string | null => {
  if (
    Object.keys(ownership.hooks).length === 0 &&
    Object.keys(ownership.skills).length === 0
  ) {
    return null;
  }

  if (maxBytes !== undefined) {
    checkOwnershipBytes(ownership, maxBytes);
  }

  return `${JSON.stringify(ownership, null, 2)}\n`;
};

const writeInstallOwnershipBody = (file: string, body: string | null): void => {
  if (body === null) {
    rmSync(file, { force: true });

    return;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

const writeInstallOwnership = (
  file: string,
  ownership: InstallOwnership
): void => {
  writeInstallOwnershipBody(file, serializeInstallOwnership(ownership));
};

const prepareInstallOwnershipWrite = (
  file: string,
  ownership: InstallOwnership,
  prepared?: PreparedOwnershipInstallation
): (() => void) => {
  const body = serializeInstallOwnership(
    ownership,
    prepared?.maxOwnershipBytes
  );

  prepared?.onOwnershipWrite?.(file, body, "before");

  return () => {
    writeInstallOwnershipBody(file, body);
    prepared?.onOwnershipWrite?.(file, body, "after");
  };
};

const backupInstallFile = (
  file: string,
  stateFile: string,
  readFile?: PreparedInstallationReader
): string => {
  const body =
    readFile === undefined ? readFileSync(file) : readFile(file, "binary");

  if (body === null) {
    throw new Error("Installer file disappeared before its backup");
  }

  const dir = path.join(path.dirname(stateFile), "backups");

  const copy = path.join(
    dir,
    `${skillDigest(file).slice(0, 16)}-${skillDigest(body)}.backup`
  );

  if (!safeInstallPath(path.dirname(stateFile), copy)) {
    throw new Error("Refusing to back up through a linked installer path");
  }

  mkdirSync(dir, { recursive: true });

  if (readFile === undefined) {
    if (!existsSync(copy)) {
      copyFileSync(file, copy, 1);
    }
  } else {
    const previous = readFile(copy, "binary");

    if (previous === null) {
      writeFileSync(copy, body, { flag: "wx" });
    } else if (skillDigest(previous) !== skillDigest(body)) {
      throw new Error(
        "Existing installer backup differs from its content digest"
      );
    }
  }

  return copy;
};

const sameHook = (left: HookEntry, right: HookEntry): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const ownedHookEntries = (
  current: readonly HookEntry[],
  installed: readonly HookEntry[],
  command: string,
  refresh: boolean
) => {
  const previous = [...installed];
  const owned: HookEntry[] = [];
  let refreshed = false;

  const entries = current.map((entry) => {
    const index = previous.findIndex((old) => sameHook(old, entry));

    if (index === -1) {
      return entry;
    }

    previous.splice(index, 1);

    const replacement = refresh ? { ...entry, command } : entry;

    owned.push(replacement);
    refreshed ||= replacement.command !== entry.command;

    return replacement;
  });

  return { entries, owned, refreshed };
};

const prepareCursorHookInstallation = (
  worktree: string,
  prepared?: PreparedHookInstallation
) =>
  prepared ?? {
    ownershipPath: ownershipFile(worktree, ".cursor"),
    readFile: undefined,
    refresh: !gitTracks(worktree, path.join(".cursor", "hooks.json")),
  };

export const installCursorHooks = (
  worktree: string,
  command: string,
  prepared?: PreparedHookInstallation
): InstallStep => {
  const file = path.join(worktree, ".cursor", "hooks.json");

  if (!safeInstallPath(worktree, file)) {
    return {
      action: "skipped",
      detail: "linked or conflicting Cursor config path; kept it",
      path: file,
    };
  }

  const {
    ownershipPath: stateFile,
    readFile,
    refresh,
  } = prepareCursorHookInstallation(worktree, prepared);

  const body = readInstallText(file, readFile);
  const exists = body !== null;
  const parsed = body === null ? { version: 1 } : parseHooksFile(body);

  const ownership = readInstallOwnership(stateFile, readFile);

  if (parsed === null || ownership === null) {
    return {
      action: "skipped",
      detail:
        "existing hooks.json or dft ownership record is invalid; left untouched",
      path: file,
    };
  }

  const hooks = { ...parsed.hooks };
  const owned: Record<string, readonly HookEntry[]> = {};
  const createdHookEvents = new Set(ownership.createdHookEvents);
  const added: string[] = [];
  const refreshed: string[] = [];

  for (const event of CURSOR_HOOK_EVENTS) {
    const {
      entries: next,
      owned: kept,
      refreshed: changed,
    } = ownedHookEntries(
      hooks[event] ?? [],
      ownership.hooks[event] ?? [],
      command,
      refresh
    );

    if (changed) {
      refreshed.push(event);
    }

    if (!next.some((entry) => isDftHookCommand(entry.command))) {
      const entry = { command };

      next.push(entry);
      kept.push(entry);
      added.push(event);

      if (parsed.hooks?.[event] === undefined) {
        createdHookEvents.add(event);
      }
    }

    hooks[event] = next;

    if (kept.length > 0) {
      owned[event] = kept;
    }
  }

  const merged = {
    added,
    file: { ...parsed, hooks, version: parsed.version ?? 1 },
    refreshed,
  };

  const writeOwnership = prepareInstallOwnershipWrite(
    stateFile,
    {
      ...ownership,
      createdHookEvents: [...createdHookEvents],
      hookFileCreated: ownership.hookFileCreated || !exists,
      hooks: owned,
    },
    prepared
  );

  if (merged.added.length === 0 && merged.refreshed.length === 0) {
    writeOwnership();

    return {
      action: "unchanged",
      detail: "every Cursor hook event already calls dft hook",
      path: file,
    };
  }

  mkdirSync(path.dirname(file), { recursive: true });

  if (exists) {
    backupInstallFile(file, stateFile, readFile);
  }

  writeFileSync(file, `${JSON.stringify(merged.file, null, 2)}\n`);
  writeOwnership();

  return {
    action: exists ? "updated" : "created",
    detail: `added hooks for ${String(merged.added.length)} events; refreshed ${String(merged.refreshed.length)} owned entries`,
    path: file,
  };
};

export const installSkills = (
  worktree: string,
  source: string = skillsSourceDir(),
  installation = ".cursor",
  prepared?: PreparedSkillInstallation
): readonly InstallStep[] => {
  const skills = prepared?.skills ?? loadSkills(source);

  if (skills.length === 0) {
    return [
      {
        action: "skipped",
        detail: "no dft skills found next to this build",
        path: source,
      },
    ];
  }

  if (
    prepared === undefined &&
    path.resolve(source) === path.resolve(worktree, installation, "skills")
  ) {
    return [
      {
        action: "unchanged",
        detail:
          "target project is the dx-feature-tracker checkout; skills already in place",
        path: source,
      },
    ];
  }

  const stateFile =
    prepared?.ownershipPath ?? ownershipFile(worktree, installation);

  const ownership = readInstallOwnership(stateFile, prepared?.readFile);

  if (ownership === null) {
    return [
      {
        action: "skipped",
        detail: "invalid dft ownership record; skills left untouched",
        path: stateFile,
      },
    ];
  }

  const owned = { ...ownership.skills };

  const writes: {
    readonly backup: boolean;
    readonly body: string;
    readonly file: string;
  }[] = [];

  const steps = skills.map((skill): InstallStep => {
    const file = path.join(
      worktree,
      installation,
      "skills",
      skill.name,
      "SKILL.md"
    );

    if (!safeInstallPath(worktree, file)) {
      return {
        action: "skipped",
        detail: `${skill.name} has a linked or conflicting path; kept it`,
        path: file,
      };
    }

    const body = readInstallText(file, prepared?.readFile);
    const exists = body !== null;

    if (body !== null) {
      const digest = skillDigest(body);

      if (body === skill.body) {
        return { action: "unchanged", detail: skill.name, path: file };
      }

      if (
        owned[skill.name] === undefined ||
        (owned[skill.name] !== digest && !isReleasedSkillBody(skill.name, body))
      ) {
        return {
          action: "skipped",
          detail: `${skill.name} is unowned or edited; kept your file`,
          path: file,
        };
      }
    }

    writes.push({ backup: exists, body: skill.body, file });
    owned[skill.name] = skillDigest(skill.body);

    return {
      action: exists ? "updated" : "created",
      detail: skill.name,
      path: file,
    };
  });

  const writeOwnership = prepareInstallOwnershipWrite(
    stateFile,
    { ...ownership, skills: owned },
    prepared
  );

  for (const write of writes) {
    if (write.backup) {
      backupInstallFile(write.file, stateFile, prepared?.readFile);
    }

    mkdirSync(path.dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.body);
  }

  writeOwnership();

  return steps;
};

export const installAgentSkills = (
  worktree: string,
  source: string = skillsSourceDir(),
  prepared?: PreparedSkillInstallation
): readonly InstallStep[] =>
  installSkills(worktree, source, ".agents", prepared);

const samePath = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

export const parseWorktreeList = (porcelain: string): readonly string[] =>
  porcelain
    .split(/\n\s*\n/u)
    .map((block) => block.split("\n"))
    .filter((lines) => !lines.includes("bare"))
    .flatMap((lines) => {
      const head = lines.find((line) => line.startsWith("worktree "));

      return head === undefined ? [] : [head.slice("worktree ".length)];
    });

export const repoWorktrees = (worktree: string): readonly string[] => {
  try {
    return parseWorktreeList(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: worktree,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    ).filter((file) => existsSync(file));
  } catch {
    return [];
  }
};

export const otherWorktrees = (worktree: string): readonly string[] => {
  const self = samePath(worktree);

  return repoWorktrees(worktree).filter((file) => samePath(file) !== self);
};

export const hasDftHooks = (worktree: string): boolean => {
  const file = path.join(worktree, ".cursor", "hooks.json");

  if (!existsSync(file)) {
    return false;
  }

  const parsed = parseHooksFile(readFileSync(file, "utf-8"));

  return parsed !== null && mergeCursorHooks(parsed, "").added.length === 0;
};

export interface WorktreeInstall {
  readonly hooks: InstallStep;
  readonly skills: readonly InstallStep[];
  readonly worktree: string;
}

export const installWorktree = (
  worktree: string,
  hookCommand: string
): WorktreeInstall => ({
  hooks: installCursorHooks(worktree, hookCommand),
  skills: installSkills(worktree),
  worktree,
});

export const gitHooksDir = (worktree: string): string =>
  path.resolve(
    worktree,
    execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: worktree,
      encoding: "utf-8",
    }).trim()
  );

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);

  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

const gitCommonDir = (worktree: string): string =>
  path.resolve(
    worktree,
    execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktree,
      encoding: "utf-8",
    }).trim()
  );

const existingPath = (file: string): string =>
  existsSync(file) || path.dirname(file) === file
    ? samePath(file)
    : path.join(existingPath(path.dirname(file)), path.basename(file));

export const hooksDirInWorktree = (
  worktree: string,
  dir: string
): string | null => {
  const hooks = existingPath(dir);
  const top = samePath(worktree);

  if (
    isInside(samePath(gitCommonDir(worktree)), hooks) ||
    !isInside(top, hooks)
  ) {
    return null;
  }

  return path.relative(top, hooks);
};

export const lefthookConfig = (worktree: string): string | null =>
  LEFTHOOK_FILES.map((name) => path.join(worktree, name)).find((file) =>
    existsSync(file)
  ) ?? null;

export const hookLine = (command: string): string =>
  `${command} snapshot || true`;

export const gitHookLine = (command: string): string =>
  `${command} snapshot </dev/null || true`;

const SHARED_HOOK_LINE = gitHookLine("dft");

const POSIX_SHELL_SHEBANG = /^#!\s*\S*\/(?:env\s+)?(?:ba|da|k|z)?sh(?:\s|$)/u;

const isSnapshotLine = (line: string): boolean =>
  line.includes("dft") &&
  /\ssnapshot(?:\s+<\s*\/dev\/null)?\s+\|\|\s+true$/u.test(line.trimEnd());

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
  const shared = hooksDirInWorktree(worktree, dir);
  const line = gitHookLine(command);

  return GIT_HOOKS.map((hook): InstallStep => {
    const file = path.join(dir, hook);
    const rel = shared === null ? null : path.join(shared, hook);

    if (rel !== null && gitTracks(worktree, rel)) {
      return {
        action: "skipped",
        detail: `${hook} is tracked by git in ${shared ?? ""} (core.hooksPath), so changing it would affect teammates; dft left it alone. To record cost for everyone who has dft, commit this line yourself: ${SHARED_HOOK_LINE}`,
        path: file,
      };
    }

    if (
      rel !== null &&
      existsSync(file) &&
      !gitIgnores(worktree, rel) &&
      !readFileSync(file, "utf-8").split("\n").some(isSnapshotLine)
    ) {
      return {
        action: "skipped",
        detail: `${hook} is in the repo (core.hooksPath ${shared ?? ""}) and git does not ignore it, so it could be committed; dft left it alone. Add this line yourself if it stays local: ${line}`,
        path: file,
      };
    }

    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `#!/bin/sh\n${line}\n`);
      chmodSync(file, 0o755);

      return { action: "created", detail: hook, path: file };
    }

    const current = readFileSync(file, "utf-8");
    const lines = current.split("\n");
    const userLines = lines.filter((entry) => !isSnapshotLine(entry));
    const [first] = userLines;
    const shebang = first?.startsWith("#!") === true ? first : null;

    if (
      userLines.length === lines.length &&
      current.includes(" snapshot") &&
      current.includes("dft")
    ) {
      return { action: "unchanged", detail: hook, path: file };
    }

    if (shebang !== null && !POSIX_SHELL_SHEBANG.test(shebang)) {
      return {
        action: "skipped",
        detail: `${hook} is not a shell script, so dft left it alone. Add this line yourself: ${line}`,
        path: file,
      };
    }

    const at = shebang === null ? 0 : 1;

    const next = [...userLines.slice(0, at), line, ...userLines.slice(at)].join(
      "\n"
    );

    if (next === current) {
      return { action: "unchanged", detail: hook, path: file };
    }

    writeFileSync(file, next);
    chmodSync(file, 0o755);

    return {
      action: "updated",
      detail: `${hook}: added before the existing hook body`,
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
  readonly otherTools?: readonly string[];
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
  ...(checks.cursorInstalled || (checks.otherTools ?? []).length > 0
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
  readonly others?: readonly WorktreeInstall[] | null;
  readonly skills: readonly InstallStep[];
  readonly waiting?: readonly string[];
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
    return skippedLine(`${where}: ${hooks.detail}`);
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

  if (first?.action === "skipped") {
    return { done: null, skipped: null };
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

  const hooks = result.git.filter((step) => step.action !== "skipped");

  const skipped = result.git
    .filter((step) => step.action === "skipped")
    .map((step) => `Git hooks: ${step.detail}`);

  if (hooks.length === 0) {
    return { done: null, notes: [], skipped };
  }

  const names = hooks.map((step) => step.detail.split(":")[0]).join(", ");

  const appended = hooks
    .filter((step) => step.action === "updated")
    .map(
      (step) =>
        `Git hook ${step.detail.split(":")[0]} already existed. dft kept it and added one line at the top, so the hook's own checks still decide whether git goes ahead.`
    );

  return {
    done: { label: "Git hooks", text: `${names} (record cost on each commit)` },
    notes: appended,
    skipped,
  };
};

const CURSOR_NEXT_STEPS: readonly Row[] = [
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
  { label: "dft dashboard", text: "the same as a web page" },
  {
    label: "New worktree?",
    text: "run dft install --all-worktrees if you open it in Cursor",
  },
  { label: "dft --help", text: "all commands" },
];

const TOOL_NEXT_STEPS: readonly Row[] = [
  { label: "Work as usual", text: "in your coding tools, on a branch" },
  { label: "dft analyze", text: "cost of this branch" },
  { label: "dft history", text: "cost of every branch" },
  { label: "dft dashboard", text: "the same as a web page" },
  { label: "dft --help", text: "all commands" },
];

const section = (title: string, lines: readonly string[]): string =>
  [title, ...lines].join("\n");

const folder = (file: string): string => path.basename(file) || file;

const otherLine = (other: WorktreeInstall): string => {
  if (other.hooks.action === "skipped") {
    return `  - ${folder(other.worktree)}: .cursor/hooks.json is not valid JSON, so dft left it alone`;
  }

  const note = other.hooks.action === "unchanged" ? " (already there)" : "";

  return row("✓", {
    label: folder(other.worktree),
    text: `Cursor hooks and skills${note}`,
  });
};

const worktreeBlocks = (result: InstallResult): readonly string[] => {
  if (result.others !== undefined && result.others !== null) {
    return result.others.length === 0
      ? [section("Other worktrees", ["  none found"])]
      : [section("Other worktrees", result.others.map(otherLine))];
  }

  const waiting = result.waiting ?? [];

  if (waiting.length === 0) {
    return [];
  }

  const count =
    waiting.length === 1
      ? "1 other worktree of this repo has"
      : `${String(waiting.length)} other worktrees of this repo have`;

  return [
    section("Other worktrees", [
      `  ${count} no dft hooks yet: ${waiting.map(folder).join(", ")}`,
      "  Set them up too:  dft install --all-worktrees",
    ]),
  ];
};

export const installText = (
  result: InstallResult,
  checks: InstallChecks,
  home = "",
  color = false,
  extra: readonly string[] = []
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

  skipped.push(
    ...result.skills
      .filter((step) => step.action === "skipped")
      .map((step) => `${rel(result.worktree, step.path)}: ${step.detail}`)
  );

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

  blocks.push(...extra, ...worktreeBlocks(result));

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

  const nextSteps = checks.cursorInstalled
    ? CURSOR_NEXT_STEPS
    : TOOL_NEXT_STEPS;

  const width = Math.max(...nextSteps.map((step) => step.label.length));

  blocks.push(
    section(
      "Next steps",
      nextSteps.map(
        (step, index) =>
          `  ${index + 1}. ${step.label.padEnd(width)}  ${step.text}`
      )
    ),
    enterpriseLine(color)
  );

  return blocks.join("\n\n");
};

export interface RemovalStep {
  readonly action: "removed" | "updated" | "skipped";
  readonly detail: string;
  readonly path: string;
}

const isEmptyDir = (dir: string): boolean => {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
};

const removeEmptyDir = (dir: string, root: string): void => {
  if (safeInstallPath(root, dir, "directory") && isEmptyDir(dir)) {
    rmdirSync(dir);
  }
};

export const uninstallCursorHooks = (
  worktree: string
): readonly RemovalStep[] => {
  const file = path.join(worktree, ".cursor", "hooks.json");

  if (!safeInstallPath(worktree, file)) {
    return [
      {
        action: "skipped",
        detail: "linked or conflicting Cursor config path; kept it",
        path: file,
      },
    ];
  }

  if (!existsSync(file)) {
    return [];
  }

  const parsed = parseHooksFile(readFileSync(file, "utf-8"));
  const stateFile = ownershipFile(worktree, ".cursor");
  const ownership = readInstallOwnership(stateFile);

  if (parsed === null || ownership === null) {
    return [];
  }

  const removed: string[] = [];
  const kept: Record<string, readonly HookEntry[]> = {};

  for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
    const owned = [...(ownership.hooks[event] ?? [])];

    const rest = entries.filter((entry) => {
      const index = owned.findIndex((old) => sameHook(old, entry));

      if (index === -1) {
        return true;
      }

      owned.splice(index, 1);

      return false;
    });

    if (rest.length !== entries.length) {
      removed.push(event);
    }

    if (
      rest.length > 0 ||
      !(ownership.createdHookEvents ?? []).includes(event)
    ) {
      kept[event] = rest;
    }
  }

  if (removed.length === 0) {
    writeInstallOwnership(stateFile, { ...ownership, hooks: {} });

    return [];
  }

  const others = Object.keys(parsed).filter(
    (key) => key !== "hooks" && key !== "version"
  );

  backupInstallFile(file, stateFile);

  if (
    ownership.hookFileCreated &&
    parsed.version === 1 &&
    Object.keys(kept).length === 0 &&
    others.length === 0
  ) {
    rmSync(file);
    writeInstallOwnership(stateFile, { ...ownership, hooks: {} });

    return [
      { action: "removed", detail: "only dft hooks were in it", path: file },
    ];
  }

  writeFileSync(
    file,
    `${JSON.stringify({ ...parsed, hooks: kept }, null, 2)}\n`
  );
  writeInstallOwnership(stateFile, { ...ownership, hooks: {} });

  return [
    {
      action: "updated",
      detail: `removed dft hook from ${removed.join(", ")}; kept everything else`,
      path: file,
    },
  ];
};

export const uninstallSkills = (
  worktree: string,
  source: string = skillsSourceDir(),
  released: ReadonlySet<string> = RELEASED_SKILL_DIGESTS,
  installation = ".cursor"
): readonly RemovalStep[] => {
  if (path.resolve(source) === path.resolve(worktree, installation, "skills")) {
    return [];
  }

  const stateFile = ownershipFile(worktree, installation);
  const ownership = readInstallOwnership(stateFile);

  if (ownership === null) {
    return [
      {
        action: "skipped",
        detail: "invalid dft ownership record; skills left untouched",
        path: stateFile,
      },
    ];
  }

  const names = new Set([
    ...loadSkills(source).map((skill) => skill.name),
    ...Object.keys(ownership.skills),
  ]);

  const steps = [...names].flatMap((name): readonly RemovalStep[] => {
    if (
      name.length === 0 ||
      path.basename(name) !== name ||
      name === "." ||
      name === ".."
    ) {
      return [];
    }

    const file = path.join(worktree, installation, "skills", name, "SKILL.md");

    if (!safeInstallPath(worktree, file)) {
      return [
        {
          action: "skipped",
          detail: `${name} has a linked or conflicting path; kept it`,
          path: file,
        },
      ];
    }

    if (!existsSync(file)) {
      return [];
    }

    const body = readFileSync(file, "utf-8");
    const digest = skillDigest(body);
    const installed = ownership.skills[name];

    if (
      installed === undefined ||
      (digest !== installed && !isReleasedSkillBody(name, body, released))
    ) {
      return [
        {
          action: "skipped",
          detail: `${name} is unowned or edited, so dft kept it.`,
          path: file,
        },
      ];
    }

    backupInstallFile(file, stateFile);
    rmSync(file);
    removeEmptyDir(path.dirname(file), worktree);

    return [{ action: "removed", detail: name, path: file }];
  });

  writeInstallOwnership(stateFile, { ...ownership, skills: {} });
  removeEmptyDir(path.join(worktree, installation, "skills"), worktree);
  removeEmptyDir(path.join(worktree, installation), worktree);

  return steps;
};

export const uninstallAgentSkills = (
  worktree: string,
  source: string = skillsSourceDir(),
  released: ReadonlySet<string> = RELEASED_SKILL_DIGESTS
): readonly RemovalStep[] =>
  uninstallSkills(worktree, source, released, ".agents");

export const uninstallGitHooks = (worktree: string): readonly RemovalStep[] => {
  if (!isGitRepo(worktree) || lefthookConfig(worktree) !== null) {
    return [];
  }

  const dir = gitHooksDir(worktree);
  const shared = hooksDirInWorktree(worktree, dir);

  return GIT_HOOKS.flatMap((hook): readonly RemovalStep[] => {
    const file = path.join(dir, hook);

    if (
      !existsSync(file) ||
      (shared !== null && gitTracks(worktree, path.join(shared, hook)))
    ) {
      return [];
    }

    const lines = readFileSync(file, "utf-8").split("\n");
    const rest = lines.filter((line) => !isSnapshotLine(line));

    if (rest.length === lines.length) {
      return [];
    }

    const body = rest.filter((line) => line.trim() !== "");

    if (
      body.length === 0 ||
      (body.length === 1 && body[0]?.startsWith("#!") === true)
    ) {
      rmSync(file);

      return [{ action: "removed", detail: hook, path: file }];
    }

    writeFileSync(file, rest.join("\n"));

    return [
      {
        action: "updated",
        detail: `${hook}: removed the dft line`,
        path: file,
      },
    ];
  });
};
