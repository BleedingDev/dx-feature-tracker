// @effect-diagnostics nodeBuiltinImport:off -- Auto-sync discovers per-repo pull sources (transcript folders) with synchronous directory listings at the process boundary.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { Console, Effect } from "effect";

import { runCollect } from "../cli/commands/collect.js";
import { autoSources } from "../composition.js";
import type { AutoSource } from "../composition.js";
import type { EventStoreService } from "../contracts/services.js";
import type { FlightContext } from "../model/event.js";
import type { DxCollectorServices, RegisteredCollector } from "./registry.js";
import {
  contextForRepo,
  defaultDftHome,
  legacyHookSpoolDirFor,
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
  "Old folder .dx-flight-recorder/ in this repo is no longer used; you can delete it." as const;

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

  return [
    ...(transcripts === null || existsSync(transcripts)
      ? []
      : [
          {
            duplicates: null,
            input: transcripts,
            inserted: null,
            reason:
              "no Cursor agent-transcripts folder for this worktree (slug match is by path)",
            source: TRANSCRIPT_SOURCE,
            status: "unavailable" as const,
          },
        ]),
    {
      duplicates: null,
      input: null,
      inserted: null,
      reason:
        "Cursor local DB is global (all workspaces); it is not auto-synced because its rows cannot be scoped to this repo yet. Run `dft collect --source cursor-local-db --input <state.vscdb>` explicitly.",
      source: "collector.cursor-local-db",
      status: "unavailable",
    },
  ];
};

export const planSources = (
  context: FlightContext,
  options: AutoSyncOptions
): readonly AutoSource[] => {
  const worktree = context.worktreePath ?? options.cwd;

  return [
    ...autoSources(
      context,
      options.cwd,
      options.storePath,
      options.dftHome ?? defaultDftHome()
    ),
    ...transcriptSources(options.home, worktree),
  ];
};

export const autoSync = (
  store: EventStoreService,
  collectors: readonly RegisteredCollector[],
  options: AutoSyncOptions
): Effect.Effect<SyncReport, never, DxCollectorServices> =>
  Effect.gen(function* syncRepo() {
    const context = contextForRepo(options.repo);
    const plan = planSources(context, options);

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach takes an options object, not a thisArg.
    const steps = yield* Effect.forEach(plan, (step) =>
      runCollect({ store, storePath: options.storePath }, collectors, {
        context,
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
