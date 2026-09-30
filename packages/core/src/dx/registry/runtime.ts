// @effect-diagnostics nodeBuiltinImport:off -- Runtime wiring resolves the selected repo path and the store path once per invocation at the process boundary.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type { Layer } from "effect";

import {
  handleCursorHook,
  resolveGitContext,
} from "../collectors/cursor-hooks/handler.js";
import type {
  GitResolver,
  HookResult,
} from "../collectors/cursor-hooks/handler.js";
import {
  HOOK_SPOOL_FOLDER,
  LEGACY_SPOOL_RELATIVE,
} from "../collectors/cursor-hooks/spool.js";
import type { EventStore } from "../contracts/event-store.js";
import type { StoreFailure } from "../contracts/services.js";
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

export const worktreeSpoolId = (worktreePath: string): string => {
  const real = canonical(worktreePath);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  const name = path.basename(real).replaceAll(/[^A-Za-z0-9._-]+/gu, "-");

  return name === "" || name === "-" ? hash : `${name}-${hash}`;
};

export const hookSpoolDirFor = (
  worktreePath: string,
  dftHome: string = defaultDftHome()
): string =>
  path.join(dftHome, "spool", worktreeSpoolId(worktreePath), HOOK_SPOOL_FOLDER);

export const legacyHookSpoolDirFor = (worktreePath: string): string =>
  path.join(worktreePath, LEGACY_SPOOL_RELATIVE);

export const runCursorHook = (
  stdinText: string,
  cwd: string,
  now: Date,
  dftHome: string = defaultDftHome()
): HookResult =>
  handleCursorHook(stdinText, {
    cwd,
    now,
    resolveGit: resolveCanonicalGit,
    spoolDirFor: (worktreePath) => hookSpoolDirFor(worktreePath, dftHome),
  });
