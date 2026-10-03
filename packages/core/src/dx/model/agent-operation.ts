import { Schema } from "effect";

import {
  AgentCountSchema,
  AgentHandleSchema,
  AgentIdSchema,
  AgentRefSchema,
  AgentScopeSchema,
  AgentStringsSchema,
  AgentTextSchema,
  StoreIdentitySchema,
} from "./agent-common.js";
import { IsoTimestampSchema } from "./common.js";

export const OPERATION_SCHEMA_VERSION = "dx.operation.v1" as const;

export const OperationKindSchema = Schema.Literals([
  "collect",
  "derive-usage",
  "refresh-prices",
  "configure",
  "export",
  "delete",
  "reset",
  "restore",
  "live-start",
  "live-stop",
]);

export type OperationKind = typeof OperationKindSchema.Type;

export const OperationBoundsSchema = Schema.Struct({
  maxBytes: Schema.Int.check(
    Schema.isBetween({ maximum: 67_108_864, minimum: 0 })
  ),
  maxElapsedMs: Schema.Int.check(
    Schema.isBetween({ maximum: 60_000, minimum: 1 })
  ),
  maxFiles: Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 })),
  maxRecords: Schema.Int.check(
    Schema.isBetween({ maximum: 100_000, minimum: 0 })
  ),
  maxRequests: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 })),
  maxRetries: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })),
});

export type OperationBounds = typeof OperationBoundsSchema.Type;

export const OperationArgumentsSchema = Schema.Union([
  Schema.Struct({
    allowSourceGrowth: Schema.Boolean,
    cursor: Schema.NullOr(AgentTextSchema),
    inputRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(256)),
    kind: Schema.Literal("collect"),
    parserVersion: AgentIdSchema,
    selectedRoots: AgentStringsSchema,
    source: AgentIdSchema,
  }),
  Schema.Struct({
    basisId: Schema.NullOr(AgentIdSchema),
    kind: Schema.Literal("derive-usage"),
  }),
  Schema.Struct({
    kind: Schema.Literal("refresh-prices"),
    sources: AgentStringsSchema,
  }),
  Schema.Struct({
    expectedContentDigest: AgentIdSchema,
    kind: Schema.Literal("configure"),
    path: AgentIdSchema,
    settings: Schema.Record(AgentIdSchema, AgentTextSchema),
  }),
  Schema.Struct({
    basisId: AgentIdSchema,
    destination: AgentIdSchema,
    disclosure: Schema.Literals([
      "metadata-only",
      "redacted-evidence",
      "selected-learning",
    ]),
    kind: Schema.Literal("export"),
  }),
  Schema.Struct({
    backupRequired: Schema.Boolean,
    kind: Schema.Literal("delete"),
    selectedRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    backupRequired: Schema.Boolean,
    kind: Schema.Literal("reset"),
  }),
  Schema.Struct({
    backupId: AgentIdSchema,
    expectedContentDigest: AgentIdSchema,
    kind: Schema.Literal("restore"),
  }),
  Schema.Struct({
    kind: Schema.Literal("live-start"),
    sources: AgentStringsSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("live-stop") }),
]);

export type OperationArguments = typeof OperationArgumentsSchema.Type;

export const OperationEffectsSchema = Schema.Struct({
  destructive: Schema.Boolean,
  networkDestinations: AgentStringsSchema,
  reads: AgentStringsSchema,
  writes: AgentStringsSchema,
});

export const OperationDescriptorSchema = Schema.Struct({
  authorization: Schema.Literals([
    "existing-enrollment",
    "explicit-confirmation",
    "none",
  ]),
  cancellation: Schema.Literals([
    "between-records",
    "between-steps",
    "before-start-only",
  ]),
  effects: OperationEffectsSchema,
  enabled: Schema.Boolean,
  idempotency: Schema.Literals(["durable-key", "disabled"]),
  kind: OperationKindSchema,
  reason: Schema.NullOr(AgentTextSchema),
  requiredInputs: AgentStringsSchema,
  version: AgentIdSchema,
});

export type OperationDescriptor = typeof OperationDescriptorSchema.Type;

export const OperationPreconditionSchema = Schema.Struct({
  allowAppend: Schema.Boolean,
  expected: AgentTextSchema,
  kind: Schema.Literals([
    "store-generation",
    "config-digest",
    "source-identity",
    "source-content",
    "source-cursor",
    "parser-version",
    "selected-content",
    "backup-policy",
  ]),
  target: AgentIdSchema,
});

export type OperationPrecondition = typeof OperationPreconditionSchema.Type;

export const OperationConsentSchema = Schema.Struct({
  reason: Schema.NullOr(AgentTextSchema),
  receiptIds: AgentStringsSchema,
  scopeDigest: AgentIdSchema,
  state: Schema.Literals(["authorized", "required", "denied"]),
});

export const OperationPlanSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  arguments: OperationArgumentsSchema,
  bounds: OperationBoundsSchema,
  consent: OperationConsentSchema,
  createdAt: IsoTimestampSchema,
  effects: OperationEffectsSchema,
  expectedEvidenceImprovement: AgentTextSchema,
  expiresAt: IsoTimestampSchema,
  forecast: Schema.Struct({
    bytes: Schema.NullOr(AgentCountSchema),
    cost: Schema.NullOr(Schema.Finite),
    elapsedMs: Schema.NullOr(AgentCountSchema),
    requests: Schema.NullOr(AgentCountSchema),
  }),
  kind: OperationKindSchema,
  planDigest: AgentIdSchema,
  preconditions: Schema.Array(OperationPreconditionSchema).check(
    Schema.isMaxLength(256)
  ),
  purpose: AgentTextSchema,
  resumeBoundary: Schema.Literals(["complete-record", "atomic-step", "none"]),
  schemaVersion: Schema.Literal(OPERATION_SCHEMA_VERSION),
  scope: AgentScopeSchema,
  stopCondition: AgentTextSchema,
  validity: Schema.Literals(["valid", "stale", "expired"]),
});

export type OperationPlan = typeof OperationPlanSchema.Type;

export const OperationStepSchema = Schema.Struct({
  committedThrough: Schema.NullOr(AgentTextSchema),
  duplicates: AgentCountSchema,
  gaps: Schema.Array(AgentTextSchema).check(Schema.isMaxLength(64)),
  id: AgentIdSchema,
  inserted: AgentCountSchema,
  rejected: Schema.NullOr(AgentCountSchema),
  remainingWork: Schema.NullOr(AgentTextSchema),
  retries: AgentCountSchema,
  safeCursor: Schema.NullOr(AgentTextSchema),
  source: Schema.NullOr(AgentIdSchema),
  spooledRefs: AgentStringsSchema,
  state: Schema.Literals([
    "not-attempted",
    "running",
    "committed",
    "unchanged",
    "already-applied",
    "spooled",
    "partial",
    "unavailable",
    "rejected",
    "failed",
    "cancelled",
    "indeterminate",
  ]),
});

export type OperationStep = typeof OperationStepSchema.Type;

export const OperationReceiptSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  afterRevision: Schema.NullOr(AgentIdSchema),
  beforeRevision: AgentIdSchema,
  cancellationRequested: Schema.Boolean,
  completedAt: Schema.NullOr(IsoTimestampSchema),
  effects: Schema.Struct({
    backupArtifacts: Schema.Array(
      Schema.Struct({
        contentDigest: AgentIdSchema,
        id: AgentIdSchema,
        restorationVersion: AgentIdSchema,
        storeGeneration: AgentCountSchema,
        storeId: AgentIdSchema,
      })
    ).check(Schema.isMaxLength(32)),
    backupIds: AgentStringsSchema,
    configDigest: Schema.NullOr(AgentIdSchema),
    evidenceIds: AgentStringsSchema,
    exportArtifacts: Schema.Array(
      Schema.Struct({
        basisId: AgentIdSchema,
        contentDigest: AgentIdSchema,
        destination: AgentIdSchema,
        disclosure: Schema.Literals([
          "metadata-only",
          "redacted-evidence",
          "selected-learning",
        ]),
      })
    ).check(Schema.isMaxLength(32)),
    exports: AgentStringsSchema,
    filesChanged: AgentStringsSchema,
    remainingStoreGeneration: AgentCountSchema,
    removalReason: Schema.NullOr(AgentTextSchema),
    removedCount: Schema.NullOr(AgentCountSchema),
    removedRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(500)),
  }),
  executionState: Schema.Literals([
    "planned",
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "interrupted",
    "rejected",
    "expired",
  ]),
  idempotencyKey: AgentIdSchema,
  planDigest: AgentIdSchema,
  planId: AgentIdSchema,
  recovery: Schema.Literals([
    "none",
    "safe-resume",
    "verify-indeterminate",
    "replan",
  ]),
  resources: Schema.Struct({
    bytesRead: Schema.NullOr(AgentCountSchema),
    elapsedMs: Schema.NullOr(AgentCountSchema),
    recordsDecoded: Schema.NullOr(AgentCountSchema),
    requests: Schema.NullOr(AgentCountSchema),
    retries: Schema.NullOr(AgentCountSchema),
  }),
  resultingBasisId: Schema.NullOr(AgentIdSchema),
  revision: AgentCountSchema,
  schemaVersion: Schema.Literal(OPERATION_SCHEMA_VERSION),
  startedAt: Schema.NullOr(IsoTimestampSchema),
  steps: Schema.Array(OperationStepSchema).check(Schema.isMaxLength(256)),
  verificationRefs: Schema.Array(AgentRefSchema).check(Schema.isMaxLength(256)),
  verificationState: Schema.Literals([
    "not-attempted",
    "verified",
    "partial",
    "unavailable",
    "failed",
    "indeterminate",
  ]),
});

export type OperationReceipt = typeof OperationReceiptSchema.Type;

export const OperationInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("plan"),
    arguments: OperationArgumentsSchema,
    bounds: OperationBoundsSchema,
    purpose: AgentTextSchema,
    scope: AgentScopeSchema,
    target: StoreIdentitySchema,
  }),
  Schema.Struct({
    action: Schema.Literal("apply"),
    confirmation: Schema.optional(Schema.NullOr(AgentTextSchema)),
    consentReceiptIds: AgentStringsSchema,
    expectedDigest: AgentIdSchema,
    idempotencyKey: AgentIdSchema,
    plan: AgentHandleSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("get"),
    operation: AgentHandleSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("cancel"),
    expectedRevision: AgentCountSchema,
    operation: AgentHandleSchema,
  }),
]);

export type OperationInput = typeof OperationInputSchema.Type;

export const OperationOutputSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("plan"), plan: OperationPlanSchema }),
  Schema.Struct({
    action: Schema.Literal("apply"),
    receipt: OperationReceiptSchema,
    reused: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("get"),
    receipt: OperationReceiptSchema,
    reviewedPlan: Schema.NullOr(OperationPlanSchema),
    reviewedPlanUnavailableReason: Schema.NullOr(AgentTextSchema),
  }),
  Schema.Struct({
    action: Schema.Literal("cancel"),
    receipt: OperationReceiptSchema,
  }),
]);

export type OperationOutput = typeof OperationOutputSchema.Type;
