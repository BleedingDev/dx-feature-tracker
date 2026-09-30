import { Schema } from "effect";

export const SPOOL_VERSION = "dxfr.cursor-hook-spool.v1" as const;

export const SpoolGitContextSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  repoCommonDir: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});

export type SpoolGitContext = typeof SpoolGitContextSchema.Type;

export const emptySpoolGitContext: SpoolGitContext = {
  branch: null,
  headSha: null,
  repoCommonDir: null,
  worktreePath: null,
};

export const RawUsageEntrySchema = Schema.Struct({
  path: Schema.String,
  value: Schema.Finite,
});

export type RawUsageEntry = typeof RawUsageEntrySchema.Type;

export const SanitizedHookSchema = Schema.Struct({
  attachmentCount: Schema.NullOr(Schema.Int),
  commandBin: Schema.NullOr(Schema.String),
  commandHash: Schema.NullOr(Schema.String),
  composerMode: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  cursorVersion: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
  editCount: Schema.NullOr(Schema.Int),
  filePath: Schema.NullOr(Schema.String),
  finalStatus: Schema.NullOr(Schema.String),
  generationId: Schema.NullOr(Schema.String),
  hookEvent: Schema.String,
  isBackgroundAgent: Schema.NullOr(Schema.Boolean),
  linesAdded: Schema.NullOr(Schema.Int),
  linesRemoved: Schema.NullOr(Schema.Int),
  loopCount: Schema.NullOr(Schema.Finite),
  model: Schema.NullOr(Schema.String),
  presentKeys: Schema.Array(Schema.String),
  promptChars: Schema.NullOr(Schema.Int),
  rawUsage: Schema.Array(RawUsageEntrySchema),
  reason: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  toolName: Schema.NullOr(Schema.String),
  toolUseId: Schema.NullOr(Schema.String),
  workspaceRoots: Schema.Array(Schema.String),
});

export type SanitizedHook = typeof SanitizedHookSchema.Type;

export const SpoolRecordSchema = Schema.Struct({
  capturedAt: Schema.String,
  git: SpoolGitContextSchema,
  hook: SanitizedHookSchema,
  recordHash: Schema.String,
  spoolVersion: Schema.Literal(SPOOL_VERSION),
});

export type SpoolRecord = typeof SpoolRecordSchema.Type;
