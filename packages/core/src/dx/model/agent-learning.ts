import { Schema } from "effect";

import {
  AgentCountSchema,
  AgentHandleSchema,
  AgentIdSchema,
  AgentOriginCountSchema,
  AgentRefResolutionSchema,
  AgentRefSchema,
  AgentScopeSchema,
  AgentStringsSchema,
  AgentTextSchema,
  AgentWindowSchema,
  StoreIdentitySchema,
} from "./agent-common.js";
import { IsoTimestampSchema } from "./common.js";
import { SourceCoverageSchema } from "./coverage.js";
import { VersionedIdSchema } from "./snapshot.js";

export const LEARNING_SCHEMA_VERSION = "dx.learning.v1" as const;

export const LearningAuthorSchema = Schema.Literals([
  "human",
  "agent",
  "imported",
]);

export const LessonStatusSchema = Schema.Literals([
  "proposed",
  "supported-within-scope",
  "contradicted",
  "superseded",
]);

export const LearningApplicabilitySchema = Schema.Struct({
  coverageRequirements: Schema.Array(AgentTextSchema).check(
    Schema.isMaxLength(32)
  ),
  metricDefinitions: Schema.Array(VersionedIdSchema).check(
    Schema.isMaxLength(64)
  ),
  scope: AgentScopeSchema,
  sourceVersions: Schema.Array(VersionedIdSchema).check(Schema.isMaxLength(64)),
  toolVersions: Schema.Array(VersionedIdSchema).check(Schema.isMaxLength(64)),
  widerScope: Schema.Boolean,
  window: AgentWindowSchema,
  workflowConditions: Schema.Array(AgentTextSchema).check(
    Schema.isMaxLength(32)
  ),
});

export type LearningApplicability = typeof LearningApplicabilitySchema.Type;

export const InvestigationSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  applicability: LearningApplicabilitySchema,
  authorKind: LearningAuthorSchema,
  comparedBasisIds: AgentStringsSchema,
  conclusion: Schema.NullOr(AgentTextSchema),
  createdAt: IsoTimestampSchema,
  inspectedRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(256)),
  kind: Schema.Literal("investigation"),
  limitations: Schema.Array(AgentTextSchema).check(Schema.isMaxLength(32)),
  nextQueryRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(16)),
  observedResultRefs: Schema.Array(AgentRefSchema).check(
    Schema.isMaxLength(256)
  ),
  operationIds: AgentStringsSchema,
  question: AgentTextSchema,
  revision: AgentCountSchema,
  schemaVersion: Schema.Literal(LEARNING_SCHEMA_VERSION),
  startingBasisId: Schema.NullOr(AgentIdSchema),
  state: Schema.Literals(["open", "concluded", "awaiting-evidence"]),
  updatedAt: IsoTimestampSchema,
});

export type Investigation = typeof InvestigationSchema.Type;

export const LessonSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  applicability: LearningApplicabilitySchema,
  authorKind: LearningAuthorSchema,
  claim: AgentTextSchema,
  claimKind: Schema.Literals(["descriptive", "hypothesis", "suggestion"]),
  contradictingRefs: Schema.Array(AgentRefSchema).check(
    Schema.isMaxLength(256)
  ),
  createdAt: IsoTimestampSchema,
  criterion: AgentTextSchema,
  invalidationConditions: Schema.Array(AgentTextSchema).check(
    Schema.isMaxLength(32)
  ),
  kind: Schema.Literal("lesson"),
  limitations: Schema.Array(AgentTextSchema).check(Schema.isMaxLength(32)),
  previousRevision: Schema.NullOr(AgentCountSchema),
  revision: AgentCountSchema,
  schemaVersion: Schema.Literal(LEARNING_SCHEMA_VERSION),
  status: LessonStatusSchema,
  supersededBy: Schema.NullOr(AgentRefSchema),
  supersedes: Schema.NullOr(AgentRefSchema),
  supportingRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(256)),
  updatedAt: IsoTimestampSchema,
});

export type Lesson = typeof LessonSchema.Type;

export const LearningRecordSchema = Schema.Union([
  InvestigationSchema,
  LessonSchema,
]);

export type LearningRecord = typeof LearningRecordSchema.Type;

export const EvaluationSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  authorKind: LearningAuthorSchema,
  basisIds: AgentStringsSchema,
  comparabilityLimitations: Schema.Array(AgentTextSchema).check(
    Schema.isMaxLength(32)
  ),
  comparedWindows: Schema.Array(AgentWindowSchema).check(Schema.isMaxLength(8)),
  conclusion: Schema.Literals(["supports", "contradicts", "inconclusive"]),
  coverage: Schema.Array(SourceCoverageSchema).check(Schema.isMaxLength(64)),
  createdAt: IsoTimestampSchema,
  criterion: AgentTextSchema,
  evidenceRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(256)),
  operationIds: AgentStringsSchema,
  originMix: Schema.Array(AgentOriginCountSchema).check(Schema.isMaxLength(5)),
  outcome: AgentTextSchema,
  relation: Schema.Literals([
    "descriptive-association",
    "operator-report",
    "causal-criterion",
  ]),
  schemaVersion: Schema.Literal(LEARNING_SCHEMA_VERSION),
  target: Schema.Struct({
    id: AgentIdSchema,
    kind: Schema.Literals(["lesson", "investigation"]),
    revision: AgentCountSchema,
  }),
});

export type Evaluation = typeof EvaluationSchema.Type;

export const LearningFilterSchema = Schema.Struct({
  applicability: Schema.optional(LearningApplicabilitySchema),
  basisId: Schema.optional(AgentIdSchema),
  cursor: Schema.NullOr(AgentIdSchema),
  includeSuperseded: Schema.Boolean,
  kinds: Schema.Array(Schema.Literals(["investigation", "lesson"])).check(
    Schema.isMaxLength(2)
  ),
  limit: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 })),
  question: Schema.NullOr(AgentTextSchema),
  scope: AgentScopeSchema,
});

export type LearningFilter = typeof LearningFilterSchema.Type;

export const LearningMatchSchema = Schema.Struct({
  applicable: Schema.Boolean,
  evidence: Schema.Array(AgentRefResolutionSchema).check(
    Schema.isMaxLength(512)
  ),
  inapplicableReason: Schema.NullOr(AgentTextSchema),
  latestEvaluation: Schema.NullOr(EvaluationSchema),
  matchReason: AgentTextSchema,
  record: LearningRecordSchema,
});

export type LearningMatch = typeof LearningMatchSchema.Type;

export const LearningSummarySchema = Schema.Struct({
  applicable: Schema.Boolean,
  claimOrQuestion: Schema.String.check(Schema.isMaxLength(512)),
  claimTruncated: Schema.Boolean,
  drilldown: AgentRefSchema,
  evidence: Schema.Struct({
    found: AgentCountSchema,
    missing: AgentCountSchema,
    omitted: AgentCountSchema,
    stale: AgentCountSchema,
    unchecked: AgentCountSchema,
    withheld: AgentCountSchema,
  }),
  inapplicableReason: Schema.NullOr(AgentTextSchema),
  kind: Schema.Literals(["investigation", "lesson"]),
  latestEvaluationRef: Schema.NullOr(AgentRefSchema),
  matchReason: AgentTextSchema,
  ref: AgentRefSchema,
  status: Schema.Literals([
    "open",
    "concluded",
    "awaiting-evidence",
    "proposed",
    "supported-within-scope",
    "contradicted",
    "superseded",
  ]),
});

export type LearningSummary = typeof LearningSummarySchema.Type;

export const LearningInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list"),
    filter: LearningFilterSchema,
    target: StoreIdentitySchema,
  }),
  Schema.Struct({
    action: Schema.Literal("get"),
    applicability: Schema.optional(LearningApplicabilitySchema),
    ref: AgentRefSchema,
    scope: AgentScopeSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("record"),
    expectedRevision: Schema.NullOr(AgentCountSchema),
    idempotencyKey: AgentIdSchema,
    record: LearningRecordSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("evaluate"),
    evaluation: EvaluationSchema,
    idempotencyKey: AgentIdSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("supersede"),
    expectedRevision: AgentCountSchema,
    idempotencyKey: AgentIdSchema,
    ref: AgentRefSchema,
    replacement: AgentRefSchema,
  }),
]);

export type LearningInput = typeof LearningInputSchema.Type;

export const LearningOutputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list"),
    excluded: AgentCountSchema,
    items: Schema.Array(LearningSummarySchema).check(Schema.isMaxLength(100)),
    nextCursor: Schema.NullOr(AgentIdSchema),
  }),
  Schema.Struct({
    action: Schema.Literal("get"),
    evaluations: Schema.Array(EvaluationSchema).check(Schema.isMaxLength(100)),
    item: LearningMatchSchema,
    omittedEvaluations: AgentCountSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("record"),
    candidateSearch: Schema.Struct({
      algorithm: Schema.Literal("normalized-lexical-v1"),
      examined: AgentCountSchema,
      limit: AgentCountSchema,
      moreAvailable: Schema.NullOr(Schema.Boolean),
      reason: Schema.NullOr(AgentTextSchema),
    }),
    candidates: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(8)),
    record: LearningRecordSchema,
    reused: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("evaluate"),
    evaluation: EvaluationSchema,
    reused: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("supersede"),
    record: LearningRecordSchema,
    reused: Schema.Boolean,
  }),
]);

export type LearningOutput = typeof LearningOutputSchema.Type;
