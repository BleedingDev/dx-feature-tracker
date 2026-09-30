import { Schema } from "effect";

export const SPOOL_VERSION = "dxfr.cursor-hook-spool.v1" as const;

export const LocatedBySchema = Schema.Literals([
  "tool-cwd",
  "file-path",
  "modified-files",
  "workspace-root",
  "process-cwd",
]);

export type LocatedBy = typeof LocatedBySchema.Type;

export const OWN_PATH_LOCATIONS: ReadonlySet<LocatedBy> = new Set([
  "tool-cwd",
  "file-path",
  "modified-files",
]);

export const SpoolGitContextSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  locatedBy: Schema.optionalKey(LocatedBySchema),
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

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

export const SanitizedHookSchema = Schema.Struct({
  attachmentCount: Schema.NullOr(Schema.Int),
  childConversationId: OptionalText,
  commandBin: Schema.NullOr(Schema.String),
  commandHash: Schema.NullOr(Schema.String),
  composerMode: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  cursorVersion: Schema.NullOr(Schema.String),
  cwd: OptionalText,
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
  modifiedFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  parentConversationId: OptionalText,
  parentToolCallId: OptionalText,
  presentKeys: Schema.Array(Schema.String),
  promptChars: Schema.NullOr(Schema.Int),
  rawUsage: Schema.Array(RawUsageEntrySchema),
  reason: Schema.NullOr(Schema.String),
  reportedBranch: OptionalText,
  sessionId: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  subagentId: OptionalText,
  subagentModel: OptionalText,
  subagentType: OptionalText,
  toolCallId: OptionalText,
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
