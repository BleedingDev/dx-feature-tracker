import { Schema } from "effect";

import {
  BranchSourceSchema,
  ChannelSchema,
  HarnessIdSchema,
  ModelProviderSchema,
} from "../harness/ids.js";
import { AiTokensSchema, ToolFigureSchema } from "../model/attribution.js";
import type { DxEventEnvelope } from "../model/event.js";

export const USAGE_DERIVATION_VERSION = 18;

export const AGENT_USAGE_DERIVATION_VERSION = "dx.usage.agent.v1" as const;

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

export type UsageExplanationValue = string | number | boolean | null;

export interface UsageFieldCandidate {
  readonly channel: string;
  readonly eventId: string;
  readonly value: UsageExplanationValue;
}

export interface UsageFieldExplanation {
  readonly candidates: readonly UsageFieldCandidate[];
  readonly disagreement: boolean;
  readonly field: string;
  readonly rule: string;
  readonly semantics: "observed" | "reconciled" | "provisional" | "unavailable";
  readonly value: UsageExplanationValue;
  readonly winnerEventId: string | null;
}

export interface UsageExplanation {
  readonly factId: string;
  readonly fields: readonly UsageFieldExplanation[];
  readonly sources: readonly string[];
}

export interface AccountAssociationCandidate {
  readonly distanceMs: number;
  readonly endMs: number;
  readonly eventIds: readonly string[];
  readonly gapMs: number;
  readonly selected: boolean;
  readonly startMs: number;
  readonly turnFactId: string;
}

export interface AccountAssociation {
  readonly accountEventIds: readonly string[];
  readonly accountFactId: string;
  readonly candidates: readonly AccountAssociationCandidate[];
  readonly method: "same-harness-session-window";
  readonly reason: string;
  readonly selectedTurnFactId: string | null;
  readonly semantics: "provisional";
}

export interface AccountAllocation {
  readonly accountEventIds: readonly string[];
  readonly branch: string | null;
  readonly method: "request-identity" | "same-harness-session-window";
  readonly repo: string;
  readonly semantics: "reconciled" | "provisional";
  readonly turnEventIds: readonly string[];
  readonly turnFactId: string;
  readonly worktree: string | null;
}

export interface AgentAccountLedger {
  readonly allocated: readonly AccountAllocation[];
  readonly observed: readonly DxEventEnvelope[];
  readonly remainder: readonly DxEventEnvelope[];
}

export interface AgentDerivedUsageRows {
  readonly accountLedger: AgentAccountLedger;
  readonly associations: readonly AccountAssociation[];
  readonly derived: DerivedRows;
  readonly explanations: readonly UsageExplanation[];
}
