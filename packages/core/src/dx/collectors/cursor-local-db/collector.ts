// @effect-diagnostics nodeBuiltinImport:off -- The source fingerprint and Cursor workspace folders are synchronous stats and small reads of local Cursor files.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Clock, DateTime, Effect, Option, Schema } from "effect";

import type { CollectInput, DxCollector } from "../../contracts/services.js";
import type { SourceGap } from "../../model/coverage.js";
import type { EventBatch } from "../../model/event.js";
import {
  CURSOR_LOCAL_DB_ADAPTER_ID,
  cursorLocalDbDescriptor,
} from "./descriptor.js";
import { sha256 } from "./envelope.js";
import { mapAiTracking } from "./map-ai-tracking.js";
import { composersInRepo, mapStateDb } from "./map-state.js";
import type { MapResult, WorkspaceFolderOf } from "./map-state.js";
import { gitKnownCommits, normalizePath, scopeFor } from "./scope.js";
import type { WorktreeScope } from "./scope.js";
import { readConsistentSnapshot } from "./snapshot.js";
import type { LocalDbRows } from "./snapshot.js";

const REREAD_AFTER_MS = 30_000;

const MAX_CACHED_READS = 16;

interface CachedRead {
  readonly fingerprint: string;
  readonly readAtMs: number;
  readonly rows: LocalDbRows;
}

const cachedReads = new Map<string, CachedRead>();

const sizeAndTime = (file: string) => {
  try {
    const stat = statSync(file);

    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "absent";
  }
};

const fingerprintOf = (file: string) =>
  `${sizeAndTime(file)}|${sizeAndTime(`${file}-wal`)}`;

const sourceFingerprint = (file: string) =>
  `sha256:${sha256(`${file}\n${fingerprintOf(file)}`)}`;

const WorkspaceJsonSchema = Schema.Struct({
  folder: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
});

const decodeWorkspaceJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(WorkspaceJsonSchema)
);

const workspaceFolders = (statePath: string): WorkspaceFolderOf => {
  const root = path.join(
    path.dirname(path.dirname(statePath)),
    "workspaceStorage"
  );

  const seen = new Map<string, string | null>();

  return (workspaceId) => {
    if (!seen.has(workspaceId)) {
      let folder: string | null = null;

      try {
        const text = readFileSync(
          path.join(root, path.basename(workspaceId), "workspace.json"),
          "utf-8"
        );

        const decoded = Option.getOrNull(decodeWorkspaceJson(text));

        folder = normalizePath(decoded?.folder ?? "");
      } catch {
        folder = null;
      }

      seen.set(workspaceId, folder);
    }

    return seen.get(workspaceId) ?? null;
  };
};

const countGap = (count: number, code: string, message: string) =>
  count > 0 ? [{ code, message: `${count} ${message}` }] : [];

const gapsFor = (result: MapResult, layout: string): SourceGap[] => [
  { code: "layout", message: `Recognized Cursor local DB layout ${layout}` },
  ...countGap(
    result.excluded,
    "scope-excluded",
    "rows of other workspaces, worktrees or branches were skipped"
  ),
  ...countGap(
    result.unreadable,
    "unreadable-rows",
    "key/value rows did not match a recognized JSON shape"
  ),
  {
    code: "no-billed-charge",
    message:
      "Local DB carries no billed charge; spend requires usage CSV or dashboard export",
  },
];

const batchFor = (result: MapResult, layout: string): EventBatch => ({
  coverage: {
    adapterId: CURSOR_LOCAL_DB_ADAPTER_ID,
    expectedItems: result.events.length + result.excluded + result.unreadable,
    gaps: gapsFor(result, layout),
    observedItems: result.events.length,
    state: result.unreadable > 0 ? "partial" : "complete",
    watermark: result.watermark,
    windowFrom: null,
    windowTo: result.watermark,
  },
  cursor:
    result.watermark === null
      ? null
      : { adapterId: CURSOR_LOCAL_DB_ADAPTER_ID, value: result.watermark },
  events: result.events,
});

const cacheKeyOf = (source: string, scope: WorktreeScope | null) =>
  `${source}\n${scope === null ? "" : scope.roots.toSorted().join("\n")}`;

const remember = (key: string, read: CachedRead) => {
  cachedReads.delete(key);
  cachedReads.set(key, read);

  for (const stale of [...cachedReads.keys()].slice(
    0,
    Math.max(0, cachedReads.size - MAX_CACHED_READS)
  )) {
    cachedReads.delete(stale);
  }
};

const readRows = (
  input: CollectInput,
  scope: WorktreeScope | null,
  folderOf: WorkspaceFolderOf
) =>
  Effect.gen(function* readScopedRows() {
    const source = input.selectedInput ?? "";
    const key = cacheKeyOf(source, scope);
    const fingerprint = fingerprintOf(source);
    const now = yield* Clock.currentTimeMillis;
    const cached = cachedReads.get(key);

    if (
      cached !== undefined &&
      (cached.fingerprint === fingerprint ||
        now - cached.readAtMs < REREAD_AFTER_MS)
    ) {
      return cached.rows;
    }

    const rows = yield* readConsistentSnapshot(
      input.selectedInput,
      input.scratchDir,
      { selectComposers: (base) => composersInRepo(base, scope, folderOf) }
    );

    remember(key, { fingerprint, readAtMs: now, rows });

    return rows;
  });

const knownCommitsFor = (
  rows: LocalDbRows,
  scope: WorktreeScope | null,
  input: CollectInput
): ReadonlySet<string> | null => {
  if (
    rows.layout !== "ai-tracking" ||
    scope === null ||
    input.context.repoCommonDir === null
  ) {
    return null;
  }

  const shas = [...new Set(rows.scoredCommits.map((row) => row.commitHash))];

  return gitKnownCommits(scope.own, shas) ?? new Set();
};

const collect = (input: CollectInput) =>
  Effect.gen(function* collectCursorLocalDb() {
    const scope = scopeFor(input.context);
    const folderOf = workspaceFolders(input.selectedInput ?? "");
    const rows = yield* readRows(input, scope, folderOf);
    const now = yield* DateTime.now;

    const ctx = {
      context: input.context,
      folderOf,
      knownCommits: knownCommitsFor(rows, scope, input),
      observedAt: DateTime.formatIso(now),
      origin: input.origin,
      scope,
      sourceHash: sourceFingerprint(input.selectedInput ?? ""),
    };

    const result =
      rows.layout === "ai-tracking"
        ? mapAiTracking(rows, ctx)
        : mapStateDb(rows, ctx);

    return batchFor(result, rows.layout);
  });

export const cursorLocalDbCollector: DxCollector = {
  collect,
  descriptor: cursorLocalDbDescriptor,
};
