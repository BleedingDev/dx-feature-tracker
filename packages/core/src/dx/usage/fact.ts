import { Schema } from "effect";

import {
  BranchSourceSchema,
  ChannelSchema,
  HarnessIdSchema,
  ModelProviderSchema,
} from "../harness/ids.js";
import { AiTokensSchema, ToolFigureSchema } from "../model/attribution.js";

export const USAGE_DERIVATION_VERSION = 14;

export const NO_REPO = "(no repo)" as const;

export const UsageScopeSchema = Schema.Literals(["request", "account-bucket"]);

export type UsageScope = typeof UsageScopeSchema.Type;

const Text = Schema.NullOr(Schema.String);

export const UsageFactSchema = Schema.Struct({
  agent: Text,
  attribution: BranchSourceSchema,
  billed: Schema.NullOr(ToolFigureSchema),
  branch: Text,
  channel: Schema.NullOr(ChannelSchema),
  channels: Schema.Array(Schema.String),
  derivationVersion: Schema.Int,
  effort: Text,
  factId: Schema.String,
  harness: Schema.NullOr(HarnessIdSchema),
  harnessVersion: Text,
  members: Schema.Int,
  model: Text,
  modelRaw: Text,
  occurredAt: Text,
  occurredMs: Schema.NullOr(Schema.Finite),
  parentSession: Text,
  premiumRequests: Schema.NullOr(Schema.Finite),
  provider: Schema.NullOr(ModelProviderSchema),
  repo: Schema.String,
  requestKey: Text,
  requests: Schema.Int,
  scope: UsageScopeSchema,
  serviceTier: Text,
  session: Text,
  speed: Text,
  splitOf: Text,
  tokens: AiTokensSchema,
  toolFigure: Schema.NullOr(ToolFigureSchema),
  via: Text,
  webSearchRequests: Schema.NullOr(Schema.Finite),
  worktree: Text,
});

export type UsageFact = typeof UsageFactSchema.Type;

export const ChannelValueSchema = Schema.Struct({
  channel: Schema.String,
  value: Schema.String,
});

export const UsageDisagreementSchema = Schema.Struct({
  factId: Schema.String,
  field: Schema.String,
  harness: Schema.NullOr(HarnessIdSchema),
  values: Schema.Array(ChannelValueSchema),
});

export type UsageDisagreement = typeof UsageDisagreementSchema.Type;

export interface DerivedUsage {
  readonly disagreements: readonly UsageDisagreement[];
  readonly facts: readonly UsageFact[];
  readonly unresolved: number;
}

export interface DerivedRow {
  readonly fact: UsageFact;
  readonly sources: readonly string[];
}

export interface DerivedRows {
  readonly disagreements: readonly UsageDisagreement[];
  readonly rows: readonly DerivedRow[];
  readonly unresolved: readonly string[];
}
