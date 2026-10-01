import { Option, Schema } from "effect";
import type { Effect } from "effect";

import type { InvalidInput } from "../contracts/error-invalid-input.js";
import type { SourceUnavailable } from "../contracts/error-source-unavailable.js";
import type { ToolFigureKind } from "../model/attribution.js";
import type { Origin } from "../model/common.js";
import type { CollectCursor } from "../model/coverage.js";
import type { EventBatch, FlightContext } from "../model/event.js";
import type { BranchSource, Channel, HarnessId } from "./ids.js";

export interface SessionRef {
  readonly channel: Channel;
  readonly harness: HarnessId;
  readonly id: string;
  readonly mtimeMs: number | null;
  readonly path: string;
  readonly sessionId: string | null;
  readonly size: number | null;
  readonly source: string;
  readonly worktree: string | null;
}

export interface RemovedWorktrees {
  readonly gone: (path: string) => boolean;
  readonly knowsCommit: (sha: string) => boolean;
}

export interface HarnessScope {
  readonly dftHome: string | null;
  readonly removed?: RemovedWorktrees;
  readonly repoCommonDir: string | null;
  readonly since: string | null;
  readonly worktrees: readonly string[];
}

export const everywhere: HarnessScope = {
  dftHome: null,
  repoCommonDir: null,
  since: null,
  worktrees: [],
};

export interface ReadInput {
  readonly context: FlightContext;
  readonly cursor: CollectCursor | null;
  readonly origin: Origin;
}

export interface HarnessCapabilities {
  readonly branchSources: readonly BranchSource[];
  readonly liveHooks: boolean;
  readonly storedFigure: ToolFigureKind | null;
  readonly subagents: boolean;
}

export interface Discovery {
  readonly harness: HarnessId;
  readonly present: boolean;
  readonly reason: string | null;
  readonly roots: readonly string[];
  readonly sessions: number;
  readonly version: string | null;
}

export type ReadError = SourceUnavailable | InvalidInput;

export interface Harness {
  readonly capabilities: HarnessCapabilities;
  readonly channels: readonly Channel[];
  readonly discover: Effect.Effect<Discovery>;
  readonly displayName: string;
  readonly id: HarnessId;
  readonly locate: (
    scope: HarnessScope
  ) => Effect.Effect<readonly SessionRef[], SourceUnavailable>;
  readonly read: (
    ref: SessionRef,
    input: ReadInput
  ) => Effect.Effect<EventBatch, ReadError>;
}

export interface StoredSession {
  readonly mtimeMs: number | null;
  readonly path: string;
  readonly size: number | null;
}

export interface HarnessStore {
  readonly listSessions: Effect.Effect<
    readonly StoredSession[],
    SourceUnavailable
  >;
  readonly readBytes: (
    path: string
  ) => Effect.Effect<Uint8Array, SourceUnavailable>;
  readonly readText: (path: string) => Effect.Effect<string, SourceUnavailable>;
  readonly roots: Effect.Effect<readonly string[]>;
  readonly version: Effect.Effect<string | null>;
}

export const FileCursorSchema = Schema.Struct({
  mtimeMs: Schema.NullOr(Schema.Finite),
  offset: Schema.Int,
  path: Schema.String,
  size: Schema.NullOr(Schema.Int),
});

export type FileCursor = typeof FileCursorSchema.Type;

const decodeFileCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(FileCursorSchema)
);

export const fileCursorOf = (
  adapterId: string,
  cursor: FileCursor
): CollectCursor => ({ adapterId, value: JSON.stringify(cursor) });

export const readFileCursor = (
  cursor: CollectCursor | null,
  ref: SessionRef
): FileCursor | null => {
  if (cursor === null) {
    return null;
  }

  return Option.match(decodeFileCursor(cursor.value), {
    onNone: () => null,
    onSome: (decoded) => (decoded.path === ref.path ? decoded : null),
  });
};

export const unchangedSince = (
  cursor: FileCursor | null,
  ref: SessionRef
): boolean =>
  cursor !== null &&
  cursor.mtimeMs !== null &&
  cursor.mtimeMs === ref.mtimeMs &&
  cursor.size === ref.size;
