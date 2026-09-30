// @effect-diagnostics nodeBuiltinImport:off -- The Cursor hook handler runs synchronously inside the hook process: it reads local git state read-only and writes one bounded spool file, with no Effect runtime or network.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

import { Option, Schema } from "effect";

import { RawObjectSchema } from "./raw-payload.js";
import { sanitizeHookPayload, sha256Hex } from "./sanitize.js";
import type {
  LocatedBy,
  SanitizedHook,
  SpoolGitContext,
  SpoolRecord,
} from "./spool-record.js";
import { emptySpoolGitContext, SPOOL_VERSION } from "./spool-record.js";
import { writeSpoolRecord } from "./spool.js";

const GIT_TIMEOUT_MS = 1500;

const decodeHookJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RawObjectSchema)
);

export type GitResolver = (cwd: string) => SpoolGitContext;

export const resolveGitContext: GitResolver = (cwd) => {
  try {
    const output = execFileSync(
      "git",
      [
        "-C",
        cwd,
        "rev-parse",
        "--git-common-dir",
        "--show-toplevel",
        "HEAD",
        "--abbrev-ref",
        "HEAD",
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      }
    );

    const [commonDir, topLevel, headSha, branch] = output.trim().split("\n");

    return {
      branch: branch === undefined || branch === "HEAD" ? null : branch,
      headSha: headSha ?? null,
      repoCommonDir:
        commonDir === undefined
          ? null
          : path.resolve(
              path.isAbsolute(commonDir) ? commonDir : path.join(cwd, commonDir)
            ),
      worktreePath: topLevel ?? null,
    };
  } catch {
    return emptySpoolGitContext;
  }
};

export interface HookRuntime {
  readonly cwd: string;
  readonly now: Date;
  readonly spoolDirFor: (worktreePath: string) => string;
  readonly resolveGit: GitResolver;
  readonly listWorktrees?: WorktreeLister;
}

export type HookOutcome =
  | { readonly state: "spooled"; readonly path: string }
  | { readonly state: "skipped"; readonly reason: string };

export interface HookResult {
  readonly stdout: string;
  readonly outcome: HookOutcome;
}

const PERMISSIVE_EVENTS: ReadonlySet<string> = new Set([
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeTabFileRead",
  "preToolUse",
]);

export const hookResponseFor = (hookEvent: string | null): string => {
  if (hookEvent === "beforeSubmitPrompt") {
    return JSON.stringify({ continue: true });
  }

  if (hookEvent !== null && PERMISSIVE_EVENTS.has(hookEvent)) {
    return JSON.stringify({ permission: "allow" });
  }

  return "{}";
};

export const buildSpoolRecord = (
  hook: SanitizedHook,
  git: SpoolGitContext,
  capturedAt: Date
): SpoolRecord => ({
  capturedAt: capturedAt.toISOString(),
  git,
  hook,
  recordHash: sha256Hex(JSON.stringify({ git, hook })),
  spoolVersion: SPOOL_VERSION,
});

export interface HookLocation {
  readonly by: LocatedBy;
  readonly path: string;
}

export interface HookWorktree {
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly path: string;
}

export type WorktreeLister = (root: string) => readonly HookWorktree[];

const canonicalTarget = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const worktreeContaining = (
  worktrees: readonly HookWorktree[],
  target: string
): HookWorktree | null =>
  worktrees
    .filter((w) => isWithin(w.path, target))
    .toSorted((a, b) => b.path.length - a.path.length)[0] ?? null;

const absoluteFrom = (base: string, target: string): string =>
  path.isAbsolute(target) ? target : path.resolve(base, target);

export const ownHookPaths = (
  hook: SanitizedHook,
  root: string
): readonly HookLocation[] => {
  const base = hook.cwd ?? root;

  return [
    ...(hook.cwd === null || hook.cwd === undefined
      ? []
      : [{ by: "tool-cwd" as const, path: absoluteFrom(root, hook.cwd) }]),
    ...(hook.filePath === null
      ? []
      : [
          {
            by: "file-path" as const,
            path: path.dirname(absoluteFrom(base, hook.filePath)),
          },
        ]),
    ...(hook.modifiedFiles ?? []).map((file) => ({
      by: "modified-files" as const,
      path: path.dirname(absoluteFrom(base, file)),
    })),
  ];
};

export interface LocatedHook {
  readonly git: SpoolGitContext;
  readonly path: string;
}

export const locateHook = (
  hook: SanitizedHook,
  runtime: HookRuntime
): LocatedHook => {
  const root = hook.workspaceRoots[0] ?? runtime.cwd;
  const rootGit = runtime.resolveGit(root);

  const fallback: LocatedHook = {
    git: {
      ...rootGit,
      locatedBy:
        hook.workspaceRoots[0] === undefined ? "process-cwd" : "workspace-root",
    },
    path: root,
  };

  const own = ownHookPaths(hook, root);
  const { listWorktrees } = runtime;

  if (
    listWorktrees === undefined ||
    rootGit.worktreePath === null ||
    own.length === 0
  ) {
    return fallback;
  }

  const worktrees = listWorktrees(root);

  for (const location of own) {
    const worktree = worktreeContaining(
      worktrees,
      canonicalTarget(location.path)
    );

    if (worktree !== null) {
      return {
        git: {
          branch: worktree.branch,
          headSha: worktree.headSha,
          locatedBy: location.by,
          repoCommonDir: rootGit.repoCommonDir,
          worktreePath: worktree.path,
        },
        path: worktree.path,
      };
    }
  }

  return fallback;
};

const skipped = (reason: string, hookEvent: string | null): HookResult => ({
  outcome: { reason, state: "skipped" },
  stdout: hookResponseFor(hookEvent),
});

export const handleCursorHook = (
  stdinText: string,
  runtime: HookRuntime
): HookResult => {
  const parsed = decodeHookJson(stdinText);

  if (Option.isNone(parsed)) {
    return skipped("stdin is not a JSON object", null);
  }

  const hook = sanitizeHookPayload(parsed.value);

  if (hook === null) {
    return skipped("payload lacks hook_event_name", null);
  }

  const located = locateHook(hook, runtime);
  const { git } = located;

  try {
    const written = writeSpoolRecord(
      runtime.spoolDirFor(git.worktreePath ?? located.path),
      buildSpoolRecord(hook, git, runtime.now)
    );

    return written === null
      ? skipped("sanitized record exceeds payload bound", hook.hookEvent)
      : {
          outcome: { path: written, state: "spooled" },
          stdout: hookResponseFor(hook.hookEvent),
        };
  } catch {
    return skipped("spool write failed", hook.hookEvent);
  }
};
