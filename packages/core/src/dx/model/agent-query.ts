import { Schema, Struct } from "effect";

import {
  AgentBudgetSchema,
  AgentCountSchema,
  AgentHandleSchema,
  AgentIdSchema,
  AgentOriginCountSchema,
  AgentReadPoliciesSchema,
  AgentRefResolutionSchema,
  AgentRefSchema,
  AgentRequestSchema,
  AgentScopeSchema,
  AgentStringsSchema,
  AgentTextSchema,
  AgentWindowSchema,
  AGENT_PROFILE_VERSION,
} from "./agent-common.js";
import { IsoTimestampSchema } from "./common.js";
import { SourceCoverageSchema } from "./coverage.js";
import { DxEventEnvelopeSchema } from "./event.js";
import { VersionedIdSchema } from "./snapshot.js";

export const ANALYSIS_BASIS_VERSION = "dx.basis.v1" as const;

export const AGENT_RESULT_VERSION = "dx.result.v1" as const;

export const AgentJsonSchema = Schema.String.check(
  Schema.isMaxLength(4_194_304)
);

export const AnalysisBasisSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  acquisitionReceiptIds: AgentStringsSchema,
  attributionVersion: AgentIdSchema,
  configDigest: AgentIdSchema,
  contractDigest: AgentIdSchema,
  contractVersion: AgentIdSchema,
  coverage: Schema.Array(SourceCoverageSchema).check(Schema.isMaxLength(256)),
  createdAt: IsoTimestampSchema,
  descriptors: Schema.Array(VersionedIdSchema).check(Schema.isMaxLength(256)),
  eventWatermark: AgentIdSchema,
  interpretationInputs: AgentJsonSchema,
  metricDefinitions: Schema.Array(VersionedIdSchema).check(
    Schema.isMaxLength(256)
  ),
  normalizedFilters: Schema.Record(AgentIdSchema, AgentStringsSchema),
  originMix: Schema.Array(AgentOriginCountSchema).check(Schema.isMaxLength(5)),
  priceSheets: Schema.Array(
    Schema.Struct({
      content: AgentJsonSchema,
      contentHash: AgentIdSchema,
      effectiveFrom: Schema.NullOr(IsoTimestampSchema),
      effectiveUntil: Schema.NullOr(IsoTimestampSchema),
      id: AgentIdSchema,
    })
  ).check(Schema.isMaxLength(32)),
  queryKey: AgentIdSchema,
  reconciliationVersion: AgentIdSchema,
  reproducibility: Schema.Literals([
    "retained-inputs",
    "retained-results-only",
    "evidence-selection-only",
  ]),
  retainedEvents: Schema.Array(DxEventEnvelopeSchema).check(
    Schema.isMaxLength(100_000)
  ),
  schemaVersion: Schema.Literal(ANALYSIS_BASIS_VERSION),
  scope: AgentScopeSchema,
  selectedEventDigest: AgentIdSchema,
  supportedResultVersions: AgentStringsSchema,
  window: AgentWindowSchema,
});

export type AnalysisBasis = typeof AnalysisBasisSchema.Type;

export const AnalysisBasisMetadataSchema = Schema.Struct({
  ...Struct.omit(AnalysisBasisSchema.fields, [
    "retainedEvents",
    "interpretationInputs",
    "priceSheets",
  ]),
  interpretationBytes: AgentCountSchema,
  priceSheets: Schema.Array(
    Schema.Struct({
      contentHash: AgentIdSchema,
      effectiveFrom: Schema.NullOr(IsoTimestampSchema),
      effectiveUntil: Schema.NullOr(IsoTimestampSchema),
      id: AgentIdSchema,
    })
  ).check(Schema.isMaxLength(32)),
  retainedDecodedBytes: AgentCountSchema,
  retainedEventCount: AgentCountSchema,
});

export type AnalysisBasisMetadata = typeof AnalysisBasisMetadataSchema.Type;

export const AgentCoveragePageSchema = Schema.Struct({
  coverage: Schema.Array(SourceCoverageSchema).check(Schema.isMaxLength(256)),
  decodedBytes: AgentCountSchema,
  factsExamined: AgentCountSchema,
  omitted: AgentCountSchema,
});

export type AgentCoveragePage = typeof AgentCoveragePageSchema.Type;

export const AgentCompletenessSchema = Schema.Struct({
  aggregation: Schema.Literals(["complete", "partial", "unavailable"]),
  items: Schema.Literals(["complete", "truncated", "unavailable"]),
  missingRefs: AgentCountSchema,
  omittedItems: AgentCountSchema,
  omittedSeries: AgentCountSchema,
  reason: Schema.NullOr(AgentTextSchema),
  series: Schema.Literals([
    "complete",
    "truncated",
    "partial",
    "unavailable",
    "not-requested",
  ]),
});

export type AgentCompleteness = typeof AgentCompletenessSchema.Type;

export const AgentWorkSchema = Schema.Struct({
  appliedLimits: AgentBudgetSchema,
  continuation: Schema.NullOr(AgentIdSchema),
  decodedBytes: Schema.NullOr(AgentCountSchema),
  elapsedMs: Schema.NullOr(AgentCountSchema),
  factsExamined: Schema.NullOr(AgentCountSchema),
  limitReached: Schema.NullOr(
    Schema.Literals([
      "facts",
      "decoded-bytes",
      "output-bytes",
      "items",
      "series",
      "stacks",
      "elapsed",
      "network",
    ])
  ),
  networkRequests: Schema.NullOr(AgentCountSchema),
  outputBytes: Schema.NullOr(AgentCountSchema),
});

export type AgentWork = typeof AgentWorkSchema.Type;

export const AgentEffectsSchema = Schema.Struct({
  acquisitionReceiptIds: AgentStringsSchema,
  basisWrites: AgentCountSchema,
  cacheWrites: AgentCountSchema,
  networkRequests: AgentCountSchema,
});

export const AgentResponseContextSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  basisId: Schema.NullOr(AgentIdSchema),
  completeness: AgentCompletenessSchema,
  coverage: Schema.Array(SourceCoverageSchema).check(Schema.isMaxLength(256)),
  effectivePolicies: AgentReadPoliciesSchema,
  effects: AgentEffectsSchema,
  freshness: Schema.Array(
    Schema.Struct({
      lastSuccess: Schema.NullOr(IsoTimestampSchema),
      observedAt: Schema.NullOr(IsoTimestampSchema),
      reason: Schema.NullOr(AgentTextSchema),
      source: AgentIdSchema,
    })
  ).check(Schema.isMaxLength(256)),
  next: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(16)),
  originMix: Schema.Array(AgentOriginCountSchema).check(Schema.isMaxLength(5)),
  profileVersion: Schema.Literal(AGENT_PROFILE_VERSION),
  reproducibility: Schema.Literals([
    "retained-inputs",
    "retained-results-only",
    "evidence-selection-only",
    "none",
  ]),
  resources: AgentWorkSchema,
  resultDigest: Schema.NullOr(AgentIdSchema),
  resultRef: Schema.NullOr(AgentRefSchema),
  revisions: Schema.Struct({
    attribution: AgentIdSchema,
    config: AgentIdSchema,
    definitions: AgentIdSchema,
    derivation: AgentIdSchema,
    evidence: AgentIdSchema,
    prices: AgentIdSchema,
  }),
  schemaVersion: Schema.Literal("dx.context.v1"),
  scope: AgentScopeSchema,
  window: AgentWindowSchema,
});

export type AgentResponseContext = typeof AgentResponseContextSchema.Type;

export const AgentResultMetadataSchema = Schema.Struct({
  seriesCount: AgentCountSchema,
  ...AgentHandleSchema.fields,
  basisId: AgentIdSchema,
  byteCount: AgentCountSchema,
  capability: Schema.Literals([
    "dx_status",
    "dx_analyze",
    "dx_usage",
    "dx_explain",
    "dx_evidence",
  ]),
  completeness: AgentCompletenessSchema,
  createdAt: IsoTimestampSchema,
  itemCount: AgentCountSchema,
  projectionVersion: AgentIdSchema,
  queryDigest: AgentIdSchema,
  resultDigest: AgentIdSchema,
  schemaVersion: Schema.Literal(AGENT_RESULT_VERSION),
});

export type AgentResultMetadata = typeof AgentResultMetadataSchema.Type;

export const AgentResultSchema = Schema.Struct({
  ...AgentResultMetadataSchema.fields,
  orderedProjection: AgentJsonSchema,
  resolutions: Schema.Array(AgentRefResolutionSchema).check(
    Schema.isMaxLength(500)
  ),
});

export type AgentResult = typeof AgentResultSchema.Type;

export const AgentCursorSchema = Schema.Struct({
  axis: Schema.Literals(["items", "series", "work"]),
  ...AgentHandleSchema.fields,
  basisId: AgentIdSchema,
  kind: Schema.Literals(["output-page", "work-continuation"]),
  position: AgentCountSchema,
  projectionVersion: AgentIdSchema,
  queryDigest: AgentIdSchema,
  resultId: AgentIdSchema,
  storeRevision: Schema.NullOr(AgentIdSchema),
});

export type AgentCursor = typeof AgentCursorSchema.Type;

export const AgentBasisDifferenceSchema = Schema.Struct({
  changedRefs: Schema.optional(
    Schema.Array(AgentRefSchema).check(Schema.isMaxLength(500))
  ),
  changes: Schema.Array(
    Schema.Literals([
      "evidence",
      "coverage",
      "attribution",
      "definitions",
      "prices",
      "scope",
      "window",
    ])
  ).check(Schema.isMaxLength(7)),
  comparable: Schema.Boolean,
  currentBasisId: AgentIdSchema,
  detailReason: Schema.optional(Schema.NullOr(AgentTextSchema)),
  invalidatedResultRefs: Schema.optional(
    Schema.Array(AgentRefSchema).check(Schema.isMaxLength(100))
  ),
  previousBasisId: AgentIdSchema,
  reasons: Schema.Array(AgentTextSchema).check(Schema.isMaxLength(32)),
  unchangedCount: Schema.optional(Schema.NullOr(AgentCountSchema)),
});

export type AgentBasisDifference = typeof AgentBasisDifferenceSchema.Type;

export const AgentQueryInputSchema = Schema.Struct({
  agent: AgentRequestSchema,
  capability: AgentResultSchema.fields.capability,
  cursor: Schema.optional(AgentIdSchema),
  refs: Schema.optional(
    Schema.Array(AgentRefSchema).check(Schema.isMaxLength(500))
  ),
  selectors: Schema.Record(AgentIdSchema, AgentStringsSchema),
});

export type AgentQueryInput = typeof AgentQueryInputSchema.Type;

export const AgentViewSchema = Schema.Struct({
  disclosures: Schema.Array(AgentTextSchema).check(Schema.isMaxLength(64)),
  items: Schema.Array(Schema.Json).check(Schema.isMaxLength(500)),
  nextCursor: Schema.NullOr(AgentIdSchema),
  nextSeriesCursor: Schema.NullOr(AgentIdSchema),
  series: Schema.Array(Schema.Json).check(Schema.isMaxLength(366)),
  summary: Schema.Json,
});

export type AgentView = typeof AgentViewSchema.Type;

export const AgentResultPageInputSchema = Schema.Struct({
  axis: Schema.optional(Schema.Literals(["items", "series"])),
  maxDecodedBytes: AgentBudgetSchema.fields.maxDecodedBytes,
  maxElapsedMs: AgentBudgetSchema.fields.maxElapsedMs,
  maxFacts: AgentBudgetSchema.fields.maxFacts,
  maxItems: AgentBudgetSchema.fields.maxItems,
  maxSeriesBuckets: AgentBudgetSchema.fields.maxSeriesBuckets,
  maxStacks: AgentBudgetSchema.fields.maxStacks,
  position: AgentCountSchema,
  seriesPosition: AgentCountSchema,
});

export type AgentResultPageInput = typeof AgentResultPageInputSchema.Type;

export const AgentResultPageSchema = Schema.Struct({
  decodedBytes: AgentCountSchema,
  factsExamined: AgentCountSchema,
  nextPosition: Schema.NullOr(AgentCountSchema),
  nextSeriesPosition: Schema.NullOr(AgentCountSchema),
  resolutions: Schema.Array(AgentRefResolutionSchema).check(
    Schema.isMaxLength(500)
  ),
  view: AgentViewSchema,
});

export type AgentResultPage = typeof AgentResultPageSchema.Type;

export const AgentQueryOutputSchema = Schema.Struct({
  context: AgentResponseContextSchema,
  difference: Schema.NullOr(AgentBasisDifferenceSchema),
  resolutions: Schema.Array(AgentRefResolutionSchema).check(
    Schema.isMaxLength(500)
  ),
  result: AgentResultMetadataSchema,
  view: AgentViewSchema,
});

export type AgentQueryOutput = typeof AgentQueryOutputSchema.Type;
