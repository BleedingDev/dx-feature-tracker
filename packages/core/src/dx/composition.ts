// @effect-diagnostics nodeBuiltinImport:off -- Composition resolves process-boundary paths (worktree spool dirs, store-relative logs) with pure node:path/node:fs checks.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { FlightContext } from "./model/event.js";
import {
  defaultDftHome,
  hookSpoolDirFor,
  legacyHookSpoolDirFor,
} from "./registry/runtime.js";

export {
  contextForRepo,
  dxStoreLayer,
  gitSelectorResolver,
  defaultDftHome,
  hookSpoolDirFor,
  legacyHookSpoolDirFor,
  resolveDxStore,
  runCursorHook,
  selectorForContext,
} from "./registry/runtime.js";

export type { DxStoreOptions } from "./registry/runtime.js";

export const commandLogPath = (storePath: string): string =>
  path.join(path.dirname(storePath), "commands.jsonl");

const isGlobalStore = (storePath: string): boolean =>
  path
    .resolve(storePath)
    .startsWith(`${path.join(homedir(), ".dft")}${path.sep}`);

export interface AutoSource {
  readonly input: string;
  readonly source: string;
}

export const worktreeSources = (
  worktree: string,
  dftHome: string = defaultDftHome()
): readonly AutoSource[] => {
  const spool = hookSpoolDirFor(worktree, dftHome);
  const legacySpool = legacyHookSpoolDirFor(worktree);

  return [
    { input: worktree, source: "collector.git-history" },
    ...(existsSync(spool)
      ? [{ input: spool, source: "collector.cursor-hooks" }]
      : []),
    ...(existsSync(legacySpool)
      ? [{ input: legacySpool, source: "collector.cursor-hooks" }]
      : []),
  ];
};

export const autoSources = (
  context: FlightContext,
  cwd: string,
  storePath: string,
  dftHome: string = defaultDftHome()
): readonly AutoSource[] => {
  const worktree = context.worktreePath ?? cwd;
  const commands = commandLogPath(storePath);
  const sources: AutoSource[] = [...worktreeSources(worktree, dftHome)];

  if (existsSync(commands)) {
    sources.push({ input: commands, source: "collector/shell-command" });
  }

  if (isGlobalStore(storePath)) {
    sources.push({
      input: "https://cursor.com/api/dashboard/get-filtered-usage-events",
      source: "collector.cursor-usage-api",
    });
  }

  return sources;
};
