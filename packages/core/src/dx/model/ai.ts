import { Schema } from "effect";

import { ValueMethodSchema } from "./common.js";
import {
  EvidenceIdSchema,
  OverlapGroupIdSchema,
  RequestKeySchema,
  TurnKeySchema,
} from "./ids.js";
import type { RequestKey, TurnKey } from "./ids.js";

export const AiSourceKindSchema = Schema.Literals([
  "usage-csv",
  "dashboard-json",
  "sdk",
  "cursor-cli",
  "hooks-stop",
  "local-db",
  "entire",
  "transcript-estimate",
  "claude-jsonl",
  "codex-session",
  "opencode",
  "provider-receipt",
]);

export type AiSourceKind = typeof AiSourceKindSchema.Type;

export const AI_SOURCE_PRECEDENCE: readonly AiSourceKind[] = [
  "usage-csv",
  "dashboard-json",
  "sdk",
  "cursor-cli",
  "provider-receipt",
  "hooks-stop",
  "local-db",
  "claude-jsonl",
  "codex-session",
  "opencode",
  "entire",
  "transcript-estimate",
];

export const AiRequestIdentitySchema = Schema.Struct({
  generationId: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  requestKey: Schema.NullOr(RequestKeySchema),
  sessionId: Schema.NullOr(Schema.String),
  sourceKind: AiSourceKindSchema,
  turnIndex: Schema.NullOr(Schema.Int),
});

export type AiRequestIdentity = typeof AiRequestIdentitySchema.Type;

export const AiTurnIdentitySchema = Schema.Struct({
  sessionId: Schema.String,
  turnKey: TurnKeySchema,
});

export type AiTurnIdentity = typeof AiTurnIdentitySchema.Type;

export const TokenCategorySchema = Schema.Literals([
  "input",
  "cached-input",
  "cache-write",
  "output",
  "reasoning",
  "total",
  "other",
]);

export type TokenCategory = typeof TokenCategorySchema.Type;

export const LedgerKindSchema = Schema.Literals([
  "tokens",
  "charge",
  "metered",
  "list-price-estimate",
  "subscription-allocation",
  "unallocated",
]);

export type LedgerKind = typeof LedgerKindSchema.Type;

export const AiUsageMeasurementSchema = Schema.Struct({
  category: TokenCategorySchema,
  cumulativeVerified: Schema.Boolean,
  currency: Schema.NullOr(Schema.String),
  evidenceId: EvidenceIdSchema,
  identity: AiRequestIdentitySchema,
  ledger: LedgerKindSchema,
  method: ValueMethodSchema,
  rawCategory: Schema.NullOr(Schema.String),
  value: Schema.NullOr(Schema.Finite),
});

export type AiUsageMeasurement = typeof AiUsageMeasurementSchema.Type;

export const OverlapResolutionSchema = Schema.Literals([
  "collapsed",
  "alternative",
  "unresolved",
]);

export type OverlapResolution = typeof OverlapResolutionSchema.Type;

export const OverlapGroupSchema = Schema.Struct({
  groupId: OverlapGroupIdSchema,
  memberEvidenceIds: Schema.Array(EvidenceIdSchema),
  preferredEvidenceId: Schema.NullOr(EvidenceIdSchema),
  reason: Schema.String,
  requestKey: Schema.NullOr(RequestKeySchema),
  resolution: OverlapResolutionSchema,
});

export type OverlapGroup = typeof OverlapGroupSchema.Type;

export const OverlapPolicy = {
  aggregateVsDetail: "alternative",
  duplicateStopSameTurn: "collapsed",
  noStrongKey: "unresolved",
  sameRequestKey: "collapsed",
} as const satisfies Record<string, OverlapResolution>;

export const canonicalRequestKey = (input: {
  readonly sourceKind: AiSourceKind;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly generationId: string | null;
  readonly turnIndex: number | null;
}): RequestKey | null => {
  if (input.requestId !== null && input.requestId !== "") {
    return RequestKeySchema.make(
      `source:${input.sourceKind}:request:${input.requestId}`
    );
  }

  const turn = input.generationId ?? input.turnIndex;

  if (input.sessionId !== null && turn !== null) {
    return RequestKeySchema.make(
      `source:${input.sourceKind}:session:${input.sessionId}:turn:${String(turn)}`
    );
  }

  return null;
};

export const canonicalTurnKey = (
  sessionId: string,
  generationIdOrTurnIndex: string | number
): TurnKey =>
  TurnKeySchema.make(`${sessionId}:${String(generationIdOrTurnIndex)}`);
