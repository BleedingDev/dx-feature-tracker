// @effect-diagnostics nodeBuiltinImport:off -- Runtime wiring resolves the selected repo path and the store path once per invocation at the process boundary.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type { Layer } from "effect";

import { resolveGitContext } from "../collectors/cursor-hooks/handler.js";
import type {
  GitResolver,
  HookWorktree,
} from "../collectors/cursor-hooks/handler.js";
import { cursorSpoolDirFor } from "../collectors/cursor-hooks/spool-dirs.js";
import type { EventStore } from "../contracts/event-store.js";
import type { StoreFailure } from "../contracts/services.js";
import { parseWorktreePorcelain } from "../correlation/repo/worktree-map.js";
import { HOOK_DECODERS } from "../harness/hook-decoders.js";
import { hookEventNameOf, hookToolOf } from "../harness/hook-observation.js";
import type {
  HookGit,
  HookRunReply,
  HookRunRequest,
} from "../harness/hook-observation.js";
import { recordHook } from "../harness/hook-spool.js";
import type { HarnessId } from "../harness/ids.js";
import type { SelectorResolver } from "../mcp/handlers/deps.js";
import type { FlightContext } from "../model/event.js";
import { FlightIdSchema } from "../model/ids.js";
import type { SnapshotSelector } from "../model/snapshot.js";
import { SqliteEventStoreLayer } from "../storage/sqlite-event-store.js";
import { resolveStorePath } from "../storage/store-path.js";
import type { ResolvedStorePath } from "../storage/store-path.js";

export interface DxStoreOptions {
  readonly store: string | null;
  readonly replay: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

export const resolveDxStore = (options: DxStoreOptions): ResolvedStorePath =>
  resolveStorePath(options);

export const dxStoreLayer = (
  resolved: ResolvedStorePath
): Layer.Layer<EventStore, StoreFailure> =>
  SqliteEventStoreLayer({ kind: resolved.kind, path: resolved.path });

export const DFT_HOME_ENV_VAR = "DFT_HOME" as const;

export const DFT_HOME_RELATIVE = ".dft" as const;

export const DFT_DB_FILE = "dft.db" as const;

export interface DftStoreOptions {
  readonly db: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

const trimmedOrNull = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

export const resolveDftHome = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string => {
  const fromEnv = trimmedOrNull(env[DFT_HOME_ENV_VAR]);

  return fromEnv === null
    ? path.join(home, DFT_HOME_RELATIVE)
    : path.resolve(fromEnv);
};

export const resolveDftStore = (
  options: DftStoreOptions
): ResolvedStorePath => {
  const flag = trimmedOrNull(options.db);

  if (flag !== null) {
    return { kind: "live", path: path.resolve(flag), source: "flag" };
  }

  const fromEnv = trimmedOrNull(options.env[DFT_HOME_ENV_VAR]);

  return {
    kind: "live",
    path: path.join(resolveDftHome(options.env, options.home), DFT_DB_FILE),
    source: fromEnv === null ? "default" : "env",
  };
};

const canonical = (target: string): string => {
  const absolute = path.resolve(target);

  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

const canonicalOrNull = (target: string | null): string | null =>
  target === null ? null : canonical(target);

export const resolveCanonicalGit: GitResolver = (cwd) => {
  const git = resolveGitContext(canonical(cwd));

  return {
    ...git,
    repoCommonDir: canonicalOrNull(git.repoCommonDir),
    worktreePath: canonicalOrNull(git.worktreePath),
  };
};

export const contextForRepo = (
  repoPath: string,
  flight: string | null = null
): FlightContext => {
  const git = resolveCanonicalGit(repoPath);

  return {
    branch: git.branch,
    flightId:
      flight === null || flight.trim() === ""
        ? null
        : FlightIdSchema.make(flight.trim()),
    headSha: git.headSha,
    repoCommonDir: git.repoCommonDir,
    worktreePath: git.worktreePath,
  };
};

const WORKTREE_LIST_TIMEOUT_MS = 3000;

export const listRepoWorktrees = (
  repoPath: string
): readonly HookWorktree[] => {
  try {
    const text = execFileSync(
      "git",
      ["-C", canonical(repoPath), "worktree", "list", "--porcelain"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: WORKTREE_LIST_TIMEOUT_MS,
      }
    );

    return parseWorktreePorcelain(text)
      .filter((w) => !w.bare && !w.prunable)
      .map((w) => ({
        branch: w.detached ? null : w.branch,
        headSha: w.headSha,
        path: canonical(w.path),
      }));
  } catch {
    return [];
  }
};

export const repoWorktrees = (repoPath: string): readonly string[] => [
  ...new Set(listRepoWorktrees(repoPath).map((w) => w.path)),
];

export const selectorForContext = (
  context: FlightContext,
  options: { readonly branch?: string | null } = {}
): SnapshotSelector => ({
  branch: options.branch === undefined ? context.branch : options.branch,
  flightId: context.flightId,
  from: null,
  repoCommonDir: context.repoCommonDir,
  to: null,
});

export const gitSelectorResolver =
  (defaultRepo: string): SelectorResolver =>
  (input) =>
    Effect.sync(() => {
      const context = contextForRepo(input.repo ?? defaultRepo, input.flight);

      return selectorForContext(context, {
        branch: input.flight === null ? context.branch : null,
      });
    });

export const defaultDftHome = (): string =>
  resolveDftHome(process.env, homedir());

export {
  legacyHookSpoolDirFor,
  worktreeSpoolId,
} from "../collectors/cursor-hooks/spool-dirs.js";

export const hookSpoolDirFor = (
  worktreePath: string,
  dftHome: string = defaultDftHome()
): string => cursorSpoolDirFor(worktreePath, dftHome);

export interface ToolHookRequest {
  readonly cwd: string;
  readonly event: string | null;
  readonly now: Date;
  readonly stdinText: string;
  readonly tool: string | null;
}

export type ToolHookResult = HookRunReply;

const gitAtHook = (cwd: string): HookGit => {
  const git = resolveCanonicalGit(cwd);

  return {
    branch: git.branch,
    headSha: git.headSha,
    repoCommonDir: git.repoCommonDir,
    worktreePath: git.worktreePath,
  };
};

const spoolObservation = (
  tool: HarnessId,
  request: HookRunRequest
): HookRunReply =>
  recordHook({
    cwd: request.cwd,
    decoder: HOOK_DECODERS[tool],
    dftHome: request.dftHome,
    event: request.event ?? hookEventNameOf(request.stdinText) ?? "unknown",
    now: request.now,
    resolveGit: gitAtHook,
    stdinText: request.stdinText,
    tool,
  });

export const runToolHook = (
  request: ToolHookRequest,
  dftHome: string = defaultDftHome()
): ToolHookResult => {
  const tool = request.tool === null ? "cursor" : hookToolOf(request.tool);

  if (tool === null) {
    return {
      outcome: {
        reason: `unknown tool ${request.tool ?? ""}`,
        state: "skipped",
      },
      stdout: "",
    };
  }

  const run: HookRunRequest = {
    cwd: request.cwd,
    dftHome,
    event: request.event,
    listWorktrees: listRepoWorktrees,
    now: request.now,
    resolveGit: resolveCanonicalGit,
    stdinText: request.stdinText,
  };

  const custom = HOOK_DECODERS[tool].run;

  return custom === undefined ? spoolObservation(tool, run) : custom(run);
};

export const runCursorHook = (
  stdinText: string,
  cwd: string,
  now: Date,
  dftHome: string = defaultDftHome()
): ToolHookResult =>
  runToolHook({ cwd, event: null, now, stdinText, tool: "cursor" }, dftHome);
