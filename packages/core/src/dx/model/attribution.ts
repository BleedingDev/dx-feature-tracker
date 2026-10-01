import { Schema } from "effect";

import type { BranchSource } from "../harness/ids.js";
import {
  BranchSourceSchema,
  ChannelSchema,
  EffortSourceSchema,
  HarnessIdSchema,
  ModelProviderSchema,
} from "../harness/ids.js";

const OptionalText = Schema.NullOr(Schema.String);

const TokenCount = Schema.NullOr(
  Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
);

export const AiAttributionSchema = Schema.Struct({
  agentId: OptionalText,
  agentType: OptionalText,
  branchSource: BranchSourceSchema,
  channel: ChannelSchema,
  cwd: OptionalText,
  effort: OptionalText,
  effortSource: Schema.NullOr(EffortSourceSchema),
  harness: HarnessIdSchema,
  harnessVersion: OptionalText,
  model: OptionalText,
  modelRaw: OptionalText,
  parentSessionId: OptionalText,
  provider: ModelProviderSchema,
  sessionId: OptionalText,
  via: OptionalText,
});

export type AiAttribution = typeof AiAttributionSchema.Type;

export const AiTokensSchema = Schema.Struct({
  cacheRead: TokenCount,
  cacheWrite: TokenCount,
  cacheWrite1h: TokenCount,
  cacheWrite5m: TokenCount,
  inputFresh: TokenCount,
  output: TokenCount,
  reasoning: TokenCount,
  total: TokenCount,
});

export type AiTokens = typeof AiTokensSchema.Type;

export const AI_TOKEN_FIELDS: readonly (keyof AiTokens)[] = [
  "inputFresh",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheWrite",
  "output",
  "reasoning",
  "total",
];

export const unknownTokens: AiTokens = {
  cacheRead: null,
  cacheWrite: null,
  cacheWrite1h: null,
  cacheWrite5m: null,
  inputFresh: null,
  output: null,
  reasoning: null,
  total: null,
};

export const ToolFigureKindSchema = Schema.Literals([
  "charge",
  "list-price",
  "api-equivalent",
]);

export type ToolFigureKind = typeof ToolFigureKindSchema.Type;

export const ToolFigureSchema = Schema.Struct({
  amount: Schema.Finite,
  currency: Schema.String,
  kind: ToolFigureKindSchema,
});

export type ToolFigure = typeof ToolFigureSchema.Type;

export const AiUsageSchema = Schema.Struct({
  premiumRequests: Schema.NullOr(Schema.Finite),
  requestKey: OptionalText,
  serviceTier: OptionalText,
  speed: OptionalText,
  tokens: AiTokensSchema,
  toolFigure: Schema.NullOr(ToolFigureSchema),
});

export type AiUsage = typeof AiUsageSchema.Type;

export const withBranchSource = (
  ai: AiAttribution | null,
  branch: string | null,
  source: BranchSource
): AiAttribution | null =>
  ai === null
    ? null
    : { ...ai, branchSource: branch === null ? "unassigned" : source };

export const hasKnownTokens = (tokens: AiTokens): boolean =>
  AI_TOKEN_FIELDS.some((field) => tokens[field] !== null);
