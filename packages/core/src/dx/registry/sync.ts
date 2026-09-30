// @effect-diagnostics nodeBuiltinImport:off -- Auto-sync discovers per-repo pull sources (transcript folders) with synchronous directory listings at the process boundary.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { Console, Effect } from "effect";

import { runCollect } from "../cli/commands/collect.js";
import { chatStoreSources } from "../collectors/cursor-chats-store/sources.js";
import {
  HOOK_SPOOL_FOLDER,
  LEGACY_SPOOL_FOLDER,
  latestSpoolRecord,
} from "../collectors/cursor-hooks/spool.js";
import { localDbSources } from "../collectors/cursor-local-db/sources.js";
import { autoSources, worktreeSources } from "../composition.js";
import type { AutoSource } from "../composition.js";
import type { EventStoreService } from "../contracts/services.js";
import type { FlightContext } from "../model/event.js";
import type { DxCollectorServices, RegisteredCollector } from "./registry.js";
import {
  contextForRepo,
  defaultDftHome,
  legacyHookSpoolDirFor,
  listRepoWorktrees,
  repoWorktrees,
} from "./runtime.js";

export interface SyncStep {
  readonly duplicates: number | null;
  readonly input: string | null;
  readonly inserted: number | null;
  readonly reason: string | null;
  readonly source: string;
  readonly status: "synced" | "unavailable";
}

export interface SyncReport {
  readonly context: FlightContext;
  readonly steps: readonly SyncStep[];
}

export interface AutoSyncOptions {
  readonly cwd: string;
  readonly dftHome?: string;
  readonly home: string;
  readonly repo: string;
  readonly storePath: string;
}

export const LEGACY_FOLDER_NOTE =
  `Old folder ${LEGACY_SPOOL_FOLDER}/ in this repo is no longer used; you can delete it.` as const;

const TRANSCRIPT_SOURCE = "collector.cursor-transcripts";

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
): readonly AutoSource[] => {
  const root = transcriptDirFor(home, worktree);

  const nested = listDirs(root).flatMap((dir) => [
    ...listFiles(dir),
    ...listFiles(path.join(dir, "subagents")),
  ]);

  return [...listFiles(root), ...nested].map((input) => ({
    input,
    source: TRANSCRIPT_SOURCE,
  }));
};

export const unavailableSteps = (
  context: FlightContext,
  home: string
): readonly SyncStep[] => {
  const worktree = context.worktreePath;

  const transcripts =
    worktree === null ? null : transcriptDirFor(home, worktree);

  return transcripts === null || existsSync(transcripts)
    ? []
    : [
        {
          duplicates: null,
          input: transcripts,
          inserted: null,
          reason:
            "no Cursor agent-transcripts folder for this worktree (slug match is by path)",
          source: TRANSCRIPT_SOURCE,
          status: "unavailable",
        },
      ];
};

export const leftoverSpoolSources = (
  dftHome: string,
  repoCommonDir: string | null,
  planned: ReadonlySet<string>
): readonly AutoSource[] =>
  repoCommonDir === null
    ? []
    : listDirs(path.join(dftHome, "spool"))
        .map((dir) => path.join(dir, HOOK_SPOOL_FOLDER))
        .filter(
          (dir) =>
            !planned.has(dir) &&
            latestSpoolRecord(dir)?.git.repoCommonDir === repoCommonDir
        )
        .map((input) => ({ input, source: "collector.cursor-hooks" }));

export interface PlannedSource extends AutoSource {
  readonly context: FlightContext;
}

const withContext =
  (context: FlightContext) =>
  (source: AutoSource): PlannedSource => ({ ...source, context });

export const planSources = (
  context: FlightContext,
  options: AutoSyncOptions,
  worktrees: readonly string[] = []
): readonly PlannedSource[] => {
  const worktree = context.worktreePath ?? options.cwd;
  const dftHome = options.dftHome ?? defaultDftHome();

  const siblings = worktrees.filter(
    (other) => path.resolve(other) !== path.resolve(worktree)
  );

  const live = [
    ...[
      ...autoSources(context, options.cwd, options.storePath, dftHome),
      ...transcriptSources(options.home, worktree),
      ...chatStoreSources(options.home, worktree),
      ...localDbSources(options.home),
    ].map(withContext(context)),
    ...siblings.flatMap((other) =>
      [
        ...worktreeSources(other, dftHome),
        ...transcriptSources(options.home, other),
        ...chatStoreSources(options.home, other),
        ...localDbSources(options.home),
      ].map(withContext(contextForRepo(other)))
    ),
  ];

  const leftovers = leftoverSpoolSources(
    dftHome,
    context.repoCommonDir,
    new Set(live.map((step) => step.input))
  ).map(withContext(context));

  return [...live, ...leftovers];
};

const BRANCH_LIST_TIMEOUT_MS = 3000;

export const localBranches = (repoPath: string): readonly string[] => {
  try {
    return execFileSync(
      "git",
      [
        "-C",
        repoPath,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: BRANCH_LIST_TIMEOUT_MS,
      }
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
};

export const idleBranchSources = (
  context: FlightContext,
  repoPath: string
): readonly PlannedSource[] => {
  const worktree = context.worktreePath;

  if (worktree === null) {
    return [];
  }

  const checkedOut = new Set(
    listRepoWorktrees(repoPath).flatMap((w) =>
      w.branch === null ? [] : [w.branch]
    )
  );

  return localBranches(repoPath)
    .filter((branch) => !checkedOut.has(branch) && branch !== context.branch)
    .map((branch) => ({
      context: { ...context, branch, headSha: null },
      input: worktree,
      source: "collector.git-history",
    }));
};

export const autoSync = (
  store: EventStoreService,
  collectors: readonly RegisteredCollector[],
  options: AutoSyncOptions
): Effect.Effect<SyncReport, never, DxCollectorServices> =>
  Effect.gen(function* syncRepo() {
    const context = contextForRepo(options.repo);

    const plan = [
      ...planSources(context, options, repoWorktrees(options.repo)),
      ...idleBranchSources(context, options.repo),
    ];

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes an options object, not a thisArg.
    const steps = yield* Effect.forEach(plan, (step) =>
      runCollect({ store, storePath: options.storePath }, collectors, {
        context: step.context,
        input: step.input,
        source: step.source,
      }).pipe(
        Effect.map((result): SyncStep => ({
          duplicates: result.duplicates,
          input: step.input,
          inserted: result.inserted,
          reason: null,
          source: step.source,
          status: "synced",
        })),
        Effect.catch((error) =>
          Effect.succeed<SyncStep>({
            duplicates: null,
            input: step.input,
            inserted: null,
            reason: error.message,
            source: step.source,
            status: "unavailable",
          })
        )
      )
    );

    const legacy = legacyHookSpoolDirFor(context.worktreePath ?? options.cwd);

    if (steps.some((step) => step.input === legacy)) {
      yield* Console.error(LEGACY_FOLDER_NOTE);
    }

    return {
      context,
      steps: [...steps, ...unavailableSteps(context, options.home)],
    };
  });

export const formatSyncLine = (report: SyncReport): string => {
  const synced = report.steps.filter((step) => step.status === "synced");
  const inserted = synced.reduce((sum, step) => sum + (step.inserted ?? 0), 0);

  const duplicates = synced.reduce(
    (sum, step) => sum + (step.duplicates ?? 0),
    0
  );

  const unavailable = report.steps.filter(
    (step) => step.status === "unavailable"
  );

  return [
    `dft sync: ${synced.length} source(s) read, ${inserted} new event(s), ${duplicates} already stored`,
    ...unavailable.map(
      (step) => `  unavailable ${step.source}: ${step.reason ?? "no reason"}`
    ),
  ].join("\n");
};
