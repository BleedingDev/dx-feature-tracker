// @effect-diagnostics nodeBuiltinImport:off -- Cursor discovery lists transcript folders and spool directories with synchronous directory reads at the process boundary.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  CURSOR_CLI_SOURCE,
  chatStoreSources,
} from "../../collectors/cursor-chats-store/sources.js";
import {
  cursorSpoolDirFor,
  cursorSpoolRoot,
  legacyHookSpoolDirFor,
} from "../../collectors/cursor-hooks/spool-dirs.js";
import {
  HOOK_SPOOL_FOLDER,
  latestSpoolRecord,
} from "../../collectors/cursor-hooks/spool.js";
import { CURSOR_LOCAL_DB_ADAPTER_ID } from "../../collectors/cursor-local-db/descriptor.js";
import { localDbSources } from "../../collectors/cursor-local-db/sources.js";
import type { Channel } from "../ids.js";

export const CURSOR_HOOKS_SOURCE = "collector.cursor-hooks" as const;

export const CURSOR_TRANSCRIPT_SOURCE = "collector.cursor-transcripts" as const;

export interface CursorSource {
  readonly input: string;
  readonly source: string;
  readonly worktree: string;
}

export interface CursorSourceScope {
  readonly dftHome: string;
  readonly home: string;
  readonly repoCommonDir: string | null;
  readonly worktrees: readonly string[];
}

const TRANSCRIPT_EXTENSIONS = new Set([".jsonl", ".txt"]);

export const cursorProjectSlug = (worktree: string): string =>
  worktree.replaceAll(/[^A-Za-z0-9]+/gu, "-").replace(/^-+/u, "");

const listFiles = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && TRANSCRIPT_EXTENSIONS.has(path.extname(entry.name))
      )
      .map((entry) => path.join(dir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
};

const listDirs = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
};

export const transcriptDirFor = (home: string, worktree: string): string =>
  path.join(
    home,
    ".cursor",
    "projects",
    cursorProjectSlug(worktree),
    "agent-transcripts"
  );

export const transcriptSources = (
  home: string,
  worktree: string
): readonly { readonly input: string; readonly source: string }[] => {
  const root = transcriptDirFor(home, worktree);

  const nested = listDirs(root).flatMap((dir) => [
    ...listFiles(dir),
    ...listFiles(path.join(dir, "subagents")),
  ]);

  return [...listFiles(root), ...nested].map((input) => ({
    input,
    source: CURSOR_TRANSCRIPT_SOURCE,
  }));
};

export const hookSpoolSources = (
  worktree: string,
  dftHome: string
): readonly { readonly input: string; readonly source: string }[] =>
  [
    cursorSpoolDirFor(worktree, dftHome),
    legacyHookSpoolDirFor(worktree),
  ].flatMap((input) =>
    existsSync(input) ? [{ input, source: CURSOR_HOOKS_SOURCE }] : []
  );

export const leftoverSpoolSources = (
  dftHome: string,
  repoCommonDir: string | null,
  planned: ReadonlySet<string>
): readonly { readonly input: string; readonly source: string }[] =>
  repoCommonDir === null
    ? []
    : listDirs(cursorSpoolRoot(dftHome))
        .map((dir) => path.join(dir, HOOK_SPOOL_FOLDER))
        .filter(
          (dir) =>
            !planned.has(dir) &&
            latestSpoolRecord(dir)?.git.repoCommonDir === repoCommonDir
        )
        .map((input) => ({ input, source: CURSOR_HOOKS_SOURCE }));

export const cursorSources = (
  scope: CursorSourceScope
): readonly CursorSource[] => {
  const located = scope.worktrees.flatMap((worktree) =>
    [
      ...hookSpoolSources(worktree, scope.dftHome),
      ...transcriptSources(scope.home, worktree),
      ...chatStoreSources(scope.home, worktree),
      ...localDbSources(scope.home),
    ].map((source) => ({ ...source, worktree }))
  );

  const [primary] = scope.worktrees;

  const leftovers =
    primary === undefined
      ? []
      : leftoverSpoolSources(
          scope.dftHome,
          scope.repoCommonDir,
          new Set(located.map((source) => source.input))
        ).map((source) => ({ ...source, worktree: primary }));

  return [...located, ...leftovers];
};

export const channelOfSource = (source: string): Channel => {
  if (source === CURSOR_HOOKS_SOURCE) {
    return "hooks";
  }

  if (source === CURSOR_TRANSCRIPT_SOURCE) {
    return "transcript";
  }

  if (source === CURSOR_CLI_SOURCE) {
    return "local-db";
  }

  return source === CURSOR_LOCAL_DB_ADAPTER_ID ? "local-db" : "usage-api";
};
