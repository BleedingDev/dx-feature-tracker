// @effect-diagnostics nodeBuiltinImport:off -- Auto-sync lists local branches with a synchronous git call at the process boundary.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { Console, Effect, Option } from "effect";

import { runCollect, runHarnessRead } from "../cli/commands/collect.js";
import type {
  CollectResult,
  HarnessReadResult,
} from "../cli/commands/collect.js";
import type { DxCommandEnv } from "../cli/commands/context.js";
import { LEGACY_SPOOL_FOLDER } from "../collectors/cursor-hooks/spool.js";
import {
  autoSources,
  CURSOR_ACCOUNT_SOURCE,
  cursorAccountOffReason,
  worktreeSources,
} from "../composition.js";
import type { AutoSource } from "../composition.js";
import type { EventStoreService } from "../contracts/services.js";
import type {
  Harness,
  HarnessScope,
  RemovedWorktrees,
  SessionRef,
} from "../harness/contract.js";
import type { HarnessId } from "../harness/ids.js";
import { harnessAdapterId } from "../harness/pending.js";
import { HarnessRegistry, harnessRegistryFor } from "../harness/registry.js";
import type {
  CollectCursor,
  SourceCoverage,
  SourceGap,
} from "../model/coverage.js";
import type { FlightContext } from "../model/event.js";
import { HarnessCursors, unchangedRef } from "../storage/harness-cursors.js";
import type {
  HarnessCursorsApi,
  StoredCursor,
} from "../storage/harness-cursors.js";
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

export type SyncStepState =
  | "unchanged"
  | "duplicate"
  | "committed"
  | "spooled"
  | "partial"
  | "unavailable";

export interface SyncStepDetails {
  readonly coverage: SourceCoverage | null;
  readonly eventsRead: number | null;
  readonly gaps: readonly SourceGap[];
  readonly lastEventId: string | null;
  readonly readCursor: CollectCursor | null;
  readonly recordsRead: number | null;
  readonly rejected: number | null;
  readonly safeCursor: CollectCursor | null;
  readonly spooledRefs: readonly string[];
  readonly state: SyncStepState;
  readonly unavailableReasons: readonly string[];
  readonly unsettled: boolean | null;
}

export interface SyncStep extends Partial<SyncStepDetails> {
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

const COMMIT_CHECK_TIMEOUT_MS = 3000;

const hasCommit = (repoCommonDir: string, sha: string): boolean => {
  try {
    execFileSync(
      "git",
      [`--git-dir=${repoCommonDir}`, "cat-file", "-e", `${sha}^{commit}`],
      { stdio: "ignore", timeout: COMMIT_CHECK_TIMEOUT_MS }
    );

    return true;
  } catch {
    return false;
  }
};

const isUnder = (folder: string, root: string): boolean => {
  const relative = path.relative(root, folder);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

export const removedWorktreesOf = (
  repoCommonDir: string,
  worktrees: readonly string[]
): RemovedWorktrees => {
  const known = new Map<string, boolean>();

  const roots = [
    ...new Set(worktrees.map((worktree) => path.dirname(worktree))),
  ];

  return {
    gone: (folder) =>
      roots.some((root) => isUnder(folder, root)) && !existsSync(folder),
    knowsCommit: (sha) => {
      const found = known.get(sha) ?? hasCommit(repoCommonDir, sha);

      known.set(sha, found);

      return found;
    },
  };
};

const removedContext = (
  context: FlightContext,
  worktree: string
): FlightContext => ({
  branch: null,
  flightId: null,
  headSha: null,
  repoCommonDir: context.repoCommonDir,
  worktreePath: worktree,
});

const contextForRef = (
  context: FlightContext,
  scope: HarnessScope,
  worktree: string
): FlightContext =>
  scope.removed?.gone(worktree) === true
    ? removedContext(context, worktree)
    : contextForRepo(worktree);

export const harnessScopeFor = (
  context: FlightContext,
  options: AutoSyncOptions,
  worktrees: readonly string[] = []
): HarnessScope => {
  const worktree = context.worktreePath ?? options.cwd;

  const scope: HarnessScope = {
    dftHome: options.dftHome ?? defaultDftHome(),
    repoCommonDir: context.repoCommonDir,
    since: null,
    worktrees: [
      worktree,
      ...worktrees.filter((other) => !samePath(other, worktree)),
    ],
  };

  return context.repoCommonDir === null
    ? scope
    : {
        ...scope,
        removed: removedWorktreesOf(context.repoCommonDir, scope.worktrees),
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
          : contextForRef(context, scope, ref.worktree),
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

interface StepReceipt extends SyncStepDetails {
  readonly duplicates: number;
  readonly inserted: number;
}

interface CursorRead {
  readonly gap: SourceGap | null;
  readonly stored: StoredCursor | null;
}

interface CursorWrite {
  readonly gap: SourceGap | null;
  readonly safeCursor: CollectCursor | null;
}

interface HarnessReceiptDetails {
  readonly gaps: readonly SourceGap[];
  readonly lastEventId: string | null;
  readonly readCursor: CollectCursor | null;
  readonly safeCursor: CollectCursor | null;
  readonly unsettled: boolean;
}

const collectedState = (
  result: CollectResult,
  harnessGaps: readonly SourceGap[],
  unsettled: boolean
): SyncStepState => {
  if (result.spooledTo !== null) {
    return "spooled";
  }

  if (unsettled || harnessGaps.length > 0) {
    return "partial";
  }

  if (
    result.events === 0 &&
    result.coverage.state !== "complete" &&
    result.coverage.state !== "partial"
  ) {
    return "unavailable";
  }

  if (result.coverage.state !== "complete") {
    return "partial";
  }

  return result.events > 0 &&
    result.inserted === 0 &&
    result.duplicates === result.events
    ? "duplicate"
    : "committed";
};

const collectedReceipt = (
  result: CollectResult,
  harness?: HarnessReceiptDetails
): StepReceipt => {
  const gaps = [...result.coverage.gaps, ...(harness?.gaps ?? [])];
  const unsettled = harness?.unsettled ?? null;
  const state = collectedState(result, harness?.gaps ?? [], unsettled === true);

  const unavailableReasons =
    state === "unavailable" ? gaps.map((gap) => gap.message) : [];

  if (state === "unavailable" && unavailableReasons.length === 0) {
    unavailableReasons.push(
      `source reported ${result.coverage.state} coverage`
    );
  }

  return {
    coverage: result.coverage,
    duplicates: result.duplicates,
    eventsRead: result.events,
    gaps,
    inserted: result.inserted,
    lastEventId: harness?.lastEventId ?? null,
    readCursor: harness?.readCursor ?? null,
    recordsRead: result.coverage.observedItems,
    rejected: null,
    safeCursor: harness?.safeCursor ?? null,
    spooledRefs: result.spooledTo === null ? [] : [result.spooledTo],
    state,
    unavailableReasons,
    unsettled,
  };
};

const unavailableDetails = (reason: string): SyncStepDetails => ({
  coverage: null,
  eventsRead: null,
  gaps: [{ code: "sync.unavailable", message: reason }],
  lastEventId: null,
  readCursor: null,
  recordsRead: null,
  rejected: null,
  safeCursor: null,
  spooledRefs: [],
  state: "unavailable",
  unavailableReasons: [reason],
  unsettled: null,
});

const writeHarnessCursor = Effect.fn("writeHarnessCursor")(
  function* persistCursor(
    cursors: HarnessCursorsApi | null,
    ref: SessionRef,
    result: HarnessReadResult,
    stored: StoredCursor | null
  ): Effect.fn.Return<CursorWrite> {
    if (cursors === null || result.spooledTo !== null) {
      return { gap: null, safeCursor: stored?.cursor ?? null };
    }

    return yield* cursors
      .put(ref, {
        cursor: result.cursor,
        lastEventId: result.lastEventId ?? stored?.lastEventId ?? null,
        mtimeMs: result.unsettled ? null : ref.mtimeMs,
        size: result.unsettled ? null : ref.size,
      })
      .pipe(
        Effect.as<CursorWrite>({ gap: null, safeCursor: result.cursor }),
        Effect.catch((error) =>
          Effect.succeed<CursorWrite>({
            gap: { code: "cursor.write-failed", message: error.message },
            safeCursor: stored?.cursor ?? null,
          })
        )
      );
  }
);

const readHarnessRef = (
  env: DxCommandEnv,
  harness: Harness,
  context: FlightContext,
  ref: SessionRef
) =>
  Effect.gen(function* readRef() {
    const cursors = yield* Effect.serviceOption(HarnessCursors);

    const cursorRead: CursorRead = Option.isSome(cursors)
      ? yield* cursors.value.get(ref).pipe(
          Effect.map((stored): CursorRead => ({ gap: null, stored })),
          Effect.catch((error) =>
            Effect.succeed<CursorRead>({
              gap: { code: "cursor.read-failed", message: error.message },
              stored: null,
            })
          )
        )
      : { gap: null, stored: null };

    const { stored } = cursorRead;

    if (unchangedRef(stored, ref)) {
      return {
        coverage: null,
        duplicates: 0,
        eventsRead: 0,
        gaps: [],
        inserted: 0,
        lastEventId: stored?.lastEventId ?? null,
        readCursor: null,
        recordsRead: 0,
        rejected: 0,
        safeCursor: stored?.cursor ?? null,
        spooledRefs: [],
        state: "unchanged",
        unavailableReasons: [],
        unsettled: false,
      } satisfies StepReceipt;
    }

    const result = yield* runHarnessRead(env, {
      context,
      cursor: stored?.cursor ?? null,
      harness,
      ref,
    });

    const cursorWrite = yield* writeHarnessCursor(
      Option.getOrNull(cursors),
      ref,
      result,
      stored
    );

    return collectedReceipt(result, {
      gaps: [
        ...(cursorRead.gap === null ? [] : [cursorRead.gap]),
        ...(cursorWrite.gap === null ? [] : [cursorWrite.gap]),
        ...(result.unsettled
          ? [
              {
                code: "sync.unsettled",
                message:
                  "Source records remain unsettled and need a later read.",
              },
            ]
          : []),
      ],
      lastEventId: result.lastEventId ?? stored?.lastEventId ?? null,
      readCursor: result.cursor,
      safeCursor: cursorWrite.safeCursor,
      unsettled: result.unsettled,
    });
  });

export const runPlannedStep = (
  env: DxCommandEnv,
  collectors: readonly RegisteredCollector[],
  step: PlannedSource
): Effect.Effect<SyncStep, never, DxCollectorServices | HarnessRegistry> =>
  Effect.gen(function* runStep() {
    if (step.unavailable !== null) {
      return {
        ...unavailableDetails(step.unavailable),
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

    const collected: Effect.Effect<
      StepReceipt,
      { readonly message: string },
      DxCollectorServices
    > =
      harness === null || step.ref === null
        ? runCollect(env, collectors, {
            context: step.context,
            input: step.input,
            source: step.source,
          }).pipe(Effect.map((result) => collectedReceipt(result)))
        : readHarnessRef(env, harness, step.context, step.ref);

    return yield* collected.pipe(
      Effect.map((result): SyncStep => ({
        ...result,
        input: step.input,
        reason: null,
        source: step.source,
        status: "synced",
      })),
      Effect.catch((error) =>
        Effect.succeed<SyncStep>({
          ...unavailableDetails(error.message),
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

    const accountOff = cursorAccountOffReason(options.storePath);

    const plan = [
      ...(yield* planSources(context, options, repoWorktrees(options.repo))),
      ...idleBranchSources(context, options.repo),
      ...(accountOff === null
        ? []
        : [
            {
              ...withContext(context)(CURSOR_ACCOUNT_SOURCE),
              unavailable: accountOff,
            },
          ]),
    ];

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes an options object, not a thisArg.
    const steps = yield* Effect.forEach(plan, (step) =>
      runPlannedStep(env, collectors, step)
    );

    const legacy = legacyHookSpoolDirFor(context.worktreePath ?? options.cwd);

    if (steps.some((step) => step.input === legacy)) {
      yield* Console.error(LEGACY_FOLDER_NOTE);
    }

    return { context, steps };
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
