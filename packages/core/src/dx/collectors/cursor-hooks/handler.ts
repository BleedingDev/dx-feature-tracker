// @effect-diagnostics nodeBuiltinImport:off -- The Cursor hook handler runs synchronously inside the hook process: it reads local git state read-only and writes one bounded spool file, with no Effect runtime or network.
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Option, Schema } from "effect";

import { RawObjectSchema } from "./raw-payload.js";
import { sanitizeHookPayload, sha256Hex } from "./sanitize.js";
import type {
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

  const root = hook.workspaceRoots[0] ?? runtime.cwd;
  const git = runtime.resolveGit(root);

  try {
    const written = writeSpoolRecord(
      runtime.spoolDirFor(git.worktreePath ?? root),
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
