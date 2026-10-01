// @effect-diagnostics nodeBuiltinImport:off -- Auto-sync lists local branches with a synchronous git call at the process boundary.
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Console, Effect } from "effect";

import { runCollect, runHarnessRead } from "../cli/commands/collect.js";
import type { DxCommandEnv } from "../cli/commands/context.js";
import { LEGACY_SPOOL_FOLDER } from "../collectors/cursor-hooks/spool.js";
import { autoSources, worktreeSources } from "../composition.js";
import type { AutoSource } from "../composition.js";
import type { EventStoreService } from "../contracts/services.js";
import type { HarnessScope, SessionRef } from "../harness/contract.js";
import {
  CURSOR_TRANSCRIPT_SOURCE,
  missingTranscriptFolder,
} from "../harness/cursor/sources.js";
import type { HarnessId } from "../harness/ids.js";
import { harnessAdapterId } from "../harness/pending.js";
import { HarnessRegistry, harnessRegistryFor } from "../harness/registry.js";
import type { FlightContext } from "../model/event.js";
import type { DxCollectorServices, RegisteredCollector } from "./registry.js";
import {
  contextForRepo,
  defaultDftHome,
  legacyHookSpoolDirFor,
  listRepoWorktrees,
  repoWorktrees,
} from "./runtime.js";

export {
  cursorProjectSlug,
  transcriptDirFor,
} from "../harness/cursor/sources.js";

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

export const unavailableSteps = (
  context: FlightContext,
  home: string
): readonly SyncStep[] => {
  const gap = missingTranscriptFolder(home, context.worktreePath);

  return gap === null
    ? []
    : [
        {
          duplicates: null,
          input: gap.input,
          inserted: null,
          reason: gap.reason,
          source: CURSOR_TRANSCRIPT_SOURCE,
          status: "unavailable",
        },
      ];
};

export interface PlannedSource extends AutoSource {
  readonly context: FlightContext;
  readonly harness: HarnessId | null;
  readonly ref: SessionRef | null;
  readonly unavailable: string | null;
}

const withContext =
  (context: FlightContext) =>
  (source: AutoSource): PlannedSource => ({
    ...source,
    context,
    harness: null,
    ref: null,
    unavailable: null,
  });

const samePath = (a: string, b: string): boolean =>
  path.resolve(a) === path.resolve(b);

export const planGitSources = (
  context: FlightContext,
  options: AutoSyncOptions,
  worktrees: readonly string[] = []
): readonly PlannedSource[] => {
  const worktree = context.worktreePath ?? options.cwd;
  const siblings = worktrees.filter((other) => !samePath(other, worktree));

  return [
    ...autoSources(context, options.cwd, options.storePath).map(
      withContext(context)
    ),
    ...siblings.flatMap((other) =>
      worktreeSources(other).map(withContext(contextForRepo(other)))
    ),
  ];
};

export const harnessScopeFor = (
  context: FlightContext,
  options: AutoSyncOptions,
  worktrees: readonly string[] = []
): HarnessScope => {
  const worktree = context.worktreePath ?? options.cwd;

  return {
    dftHome: options.dftHome ?? defaultDftHome(),
    repoCommonDir: context.repoCommonDir,
    since: null,
    worktrees: [
      worktree,
      ...worktrees.filter((other) => !samePath(other, worktree)),
    ],
  };
};

export const planHarnessSources = (
  context: FlightContext,
  options: AutoSyncOptions,
  worktrees: readonly string[] = []
): Effect.Effect<readonly PlannedSource[], never, HarnessRegistry> =>
  Effect.gen(function* planHarnesses() {
    const registry = yield* HarnessRegistry;
    const scope = harnessScopeFor(context, options, worktrees);
    const primary = scope.worktrees[0] ?? null;
    const located = yield* registry.locate(scope);

    const failed = located.failures.map((failure): PlannedSource => ({
      context,
      harness: failure.harness,
      input: primary ?? options.cwd,
      ref: null,
      source: harnessAdapterId(failure.harness),
      unavailable: failure.reason,
    }));

    const found = located.refs.map((ref): PlannedSource => ({
      context:
        ref.worktree === null ||
        primary === null ||
        samePath(ref.worktree, primary)
          ? context
          : contextForRepo(ref.worktree),
      harness: ref.harness,
      input: ref.path,
      ref,
      source: ref.source,
      unavailable: null,
    }));

    return [...found, ...failed];
  });

export const planSources = (
  context: FlightContext,
  options: AutoSyncOptions,
  worktrees: readonly string[] = []
): Effect.Effect<readonly PlannedSource[], never, HarnessRegistry> =>
  Effect.map(
    planHarnessSources(context, options, worktrees),
    (harnessSteps) => [
      ...planGitSources(context, options, worktrees),
      ...harnessSteps,
    ]
  );

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
      harness: null,
      input: worktree,
      ref: null,
      source: "collector.git-history",
      unavailable: null,
    }));
};

export const runPlannedStep = (
  env: DxCommandEnv,
  collectors: readonly RegisteredCollector[],
  step: PlannedSource
): Effect.Effect<SyncStep, never, DxCollectorServices | HarnessRegistry> =>
  Effect.gen(function* runStep() {
    if (step.unavailable !== null) {
      return {
        duplicates: null,
        input: step.input,
        inserted: null,
        reason: step.unavailable,
        source: step.source,
        status: "unavailable",
      } satisfies SyncStep;
    }

    const registry = yield* HarnessRegistry;
    const harness = step.harness === null ? null : registry.get(step.harness);

    const collected =
      harness === null || step.ref === null
        ? runCollect(env, collectors, {
            context: step.context,
            input: step.input,
            source: step.source,
          })
        : runHarnessRead(env, {
            context: step.context,
            harness,
            ref: step.ref,
          });

    return yield* collected.pipe(
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
    );
  });

export const autoSync = (
  store: EventStoreService,
  collectors: readonly RegisteredCollector[],
  options: AutoSyncOptions
): Effect.Effect<SyncReport, never, DxCollectorServices> =>
  Effect.gen(function* syncRepo() {
    const context = contextForRepo(options.repo);
    const env = { store, storePath: options.storePath };

    const plan = [
      ...(yield* planSources(context, options, repoWorktrees(options.repo))),
      ...idleBranchSources(context, options.repo),
    ];

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes an options object, not a thisArg.
    const steps = yield* Effect.forEach(plan, (step) =>
      runPlannedStep(env, collectors, step)
    );

    const legacy = legacyHookSpoolDirFor(context.worktreePath ?? options.cwd);

    if (steps.some((step) => step.input === legacy)) {
      yield* Console.error(LEGACY_FOLDER_NOTE);
    }

    return {
      context,
      steps: [...steps, ...unavailableSteps(context, options.home)],
    };
  }).pipe(Effect.provide(harnessRegistryFor(options.home)));

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
