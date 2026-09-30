// @effect-diagnostics nodeBuiltinImport:off -- Scoping Cursor rows to one worktree needs synchronous git worktree and commit lookups plus pure path handling at the collector boundary.
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Option, Schema } from "effect";

import { parseWorktreePorcelain } from "../../correlation/repo/worktree-map.js";
import type { FlightContext } from "../../model/event.js";

export interface WorktreeScope {
  readonly own: string;
  readonly roots: readonly string[];
}

const GIT_TIMEOUT_MS = 5000;

const FILE_URI = "file://";

const PRIVATE_PREFIX = "/private/";

const trimSlash = (value: string): string =>
  value.length > 1 ? value.replace(/\/+$/u, "") : value;

const decodeUri = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const normalizePath = (value: string): string | null => {
  const raw = value.startsWith(FILE_URI)
    ? decodeUri(value.slice(FILE_URI.length).replace(/^[^/]*(?=\/)/u, ""))
    : value;

  if (!raw.startsWith("/") || raw.includes("\n")) {
    return null;
  }

  return trimSlash(path.posix.normalize(raw));
};

const aliasesOf = (root: string): readonly string[] =>
  root.startsWith(PRIVATE_PREFIX)
    ? [root, root.slice(PRIVATE_PREFIX.length - 1)]
    : [root];

const within = (candidate: string, root: string): boolean =>
  root === "/"
    ? candidate.startsWith("/")
    : candidate === root || candidate.startsWith(`${root}/`);

export const ownerOf = (
  candidate: string,
  roots: readonly string[]
): string | null => {
  const normalized = normalizePath(candidate);

  if (normalized === null) {
    return null;
  }

  let best: string | null = null;
  let bestLength = -1;

  for (const root of roots) {
    for (const alias of aliasesOf(root)) {
      if (within(normalized, alias) && alias.length > bestLength) {
        best = root;
        bestLength = alias.length;
      }
    }
  }

  return best;
};

export const ownsPath = (scope: WorktreeScope, candidate: string): boolean =>
  ownerOf(candidate, scope.roots) === scope.own;

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/gu;

const decodeStringLiteral = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.String)
);

export const pathsIn = (value: Schema.Json | undefined): readonly string[] =>
  [...JSON.stringify(value ?? null).matchAll(STRING_LITERAL)].flatMap(
    (match) => {
      const text = Option.getOrNull(decodeStringLiteral(match[0]));
      const normalized = text === null ? null : normalizePath(text);

      return normalized === null ? [] : [normalized];
    }
  );

export const primaryOwner = (
  scope: WorktreeScope,
  evidence: readonly string[]
): string | null => {
  for (const candidate of evidence) {
    const owner = ownerOf(candidate, scope.roots);

    if (owner !== null) {
      return owner;
    }
  }

  return null;
};

const repoMainOf = (context: FlightContext): string | null => {
  const common = context.repoCommonDir;

  if (common === null || !common.endsWith(".git")) {
    return null;
  }

  return trimSlash(common.replace(/\/\.git\/?$/u, ""));
};

export type WorktreeLister = (worktree: string) => readonly string[];

export const listGitWorktrees: WorktreeLister = (worktree) => {
  try {
    const text = execFileSync(
      "git",
      ["-C", worktree, "worktree", "list", "--porcelain"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      }
    );

    return parseWorktreePorcelain(text)
      .filter((record) => !record.bare && !record.prunable)
      .map((record) => trimSlash(record.path));
  } catch {
    return [];
  }
};

export const scopeFor = (
  context: FlightContext,
  lister: WorktreeLister = listGitWorktrees
): WorktreeScope | null => {
  const main = repoMainOf(context);

  const own =
    context.worktreePath === null ? main : trimSlash(context.worktreePath);

  if (own === null || own.length <= 1) {
    return null;
  }

  const listed = context.repoCommonDir === null ? [] : lister(own);

  return {
    own,
    roots: [...new Set([own, ...(main === null ? [] : [main]), ...listed])],
  };
};

export type CommitChecker = (
  worktree: string,
  shas: readonly string[]
) => ReadonlySet<string> | null;

const COMMIT_LINE = /^(?<sha>\S+) commit \d+$/u;

export const gitKnownCommits: CommitChecker = (worktree, shas) => {
  if (shas.length === 0) {
    return new Set();
  }

  try {
    const text = execFileSync(
      "git",
      ["-C", worktree, "cat-file", "--batch-check"],
      {
        encoding: "utf-8",
        input: `${shas.join("\n")}\n`,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      }
    );

    return new Set(
      text
        .split("\n")
        .flatMap((line) => COMMIT_LINE.exec(line)?.groups?.sha ?? [])
    );
  } catch {
    return null;
  }
};
