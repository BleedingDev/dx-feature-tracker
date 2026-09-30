import { Schema } from "effect";

const OptNumber = Schema.optional(Schema.NullOr(Schema.Finite));

const OptString = Schema.optional(Schema.NullOr(Schema.String));

const OptBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));

export const TableNameRowSchema = Schema.Struct({ name: Schema.String });

export const HeaderRowSchema = Schema.Struct({
  composerId: Schema.String,
  isSubagent: Schema.NullOr(Schema.Finite),
  value: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
});

export type HeaderRow = typeof HeaderRowSchema.Type;

export const KeyValueRowSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
});

export type KeyValueRow = typeof KeyValueRowSchema.Type;

export const CodeHashRowSchema = Schema.Struct({
  conversationId: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.Finite),
  fileExtension: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  hash: Schema.String,
  model: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  source: Schema.String,
  timestamp: Schema.NullOr(Schema.Finite),
});

export type CodeHashRow = typeof CodeHashRowSchema.Type;

export const ScoredCommitRowSchema = Schema.Struct({
  branchName: Schema.String,
  commitDate: Schema.NullOr(Schema.String),
  commitHash: Schema.String,
  composerLinesAdded: Schema.NullOr(Schema.Finite),
  composerLinesDeleted: Schema.NullOr(Schema.Finite),
  humanLinesAdded: Schema.NullOr(Schema.Finite),
  humanLinesDeleted: Schema.NullOr(Schema.Finite),
  linesAdded: Schema.NullOr(Schema.Finite),
  linesDeleted: Schema.NullOr(Schema.Finite),
  scoredAt: Schema.Finite,
  tabLinesAdded: Schema.NullOr(Schema.Finite),
  tabLinesDeleted: Schema.NullOr(Schema.Finite),
});

export type ScoredCommitRow = typeof ScoredCommitRowSchema.Type;

const UsageEntrySchema = Schema.Struct({
  amount: OptNumber,
  costInCents: OptNumber,
});

export const ComposerJsonSchema = Schema.Struct({
  addedFiles: OptNumber,
  composerId: OptString,
  contextTokenLimit: OptNumber,
  contextTokensUsed: OptNumber,
  contextUsagePercent: OptNumber,
  createdAt: OptNumber,
  isAgentic: OptBoolean,
  lastUpdatedAt: OptNumber,
  modelConfig: Schema.optional(
    Schema.NullOr(Schema.Struct({ maxMode: OptBoolean, modelName: OptString }))
  ),
  removedFiles: OptNumber,
  status: OptString,
  totalLinesAdded: OptNumber,
  totalLinesRemoved: OptNumber,
  trackedGitRepos: Schema.optional(Schema.NullOr(Schema.Json)),
  unifiedMode: OptString,
  usageData: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, UsageEntrySchema))
  ),
  workspaceIdentifier: Schema.optional(Schema.NullOr(Schema.Json)),
});

export type ComposerJson = typeof ComposerJsonSchema.Type;

export const LegacyComposerIndexSchema = Schema.Struct({
  allComposers: Schema.optional(Schema.Array(ComposerJsonSchema)),
});

export const BubbleJsonSchema = Schema.Struct({
  createdAt: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))
  ),
  modelInfo: Schema.optional(
    Schema.NullOr(Schema.Struct({ modelName: OptString }))
  ),
  requestId: OptString,
  tokenCount: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ inputTokens: OptNumber, outputTokens: OptNumber })
    )
  ),
  toolFormerData: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: OptString, status: OptString }))
  ),
  type: OptNumber,
});

export type BubbleJson = typeof BubbleJsonSchema.Type;

export const decodeComposerJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ComposerJsonSchema)
);

export const decodeLegacyIndex = Schema.decodeUnknownOption(
  Schema.fromJsonString(LegacyComposerIndexSchema)
);

export const decodeBubbleJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(BubbleJsonSchema)
);
