import { Schema } from "effect";

import { IsoTimestampSchema, OriginSchema } from "./common.js";

export const AGENT_PROFILE_VERSION = "dx.agent.v1" as const;

export const AgentIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256)
);

export const AgentTextSchema = Schema.String.check(Schema.isMaxLength(4096));

export const AgentCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
);

export const AgentStringsSchema = Schema.Array(AgentIdSchema).check(
  Schema.isMaxLength(256)
);

export const StoreIdentitySchema = Schema.Struct({
  revision: AgentIdSchema,
  storeGeneration: AgentCountSchema,
  storeId: AgentIdSchema,
});

export type StoreIdentity = typeof StoreIdentitySchema.Type;

export const AgentHandleSchema = Schema.Struct({
  id: AgentIdSchema,
  storeGeneration: AgentCountSchema,
  storeId: AgentIdSchema,
});

export type AgentHandle = typeof AgentHandleSchema.Type;

export const AgentRefSchema = Schema.Struct({
  ...AgentHandleSchema.fields,
  basisId: Schema.NullOr(AgentIdSchema),
  kind: Schema.Literals([
    "basis",
    "result",
    "event",
    "request",
    "metric",
    "finding",
    "attribution",
    "evidence",
    "operation",
    "investigation",
    "lesson",
    "evaluation",
  ]),
  revision: Schema.optional(AgentCountSchema),
  version: AgentIdSchema,
});

export type AgentRef = typeof AgentRefSchema.Type;

export const AgentScopeSchema = Schema.Struct({
  branchSelection: Schema.Struct({
    branches: AgentStringsSchema,
    kind: Schema.Literals(["current", "selected", "all", "unresolved"]),
  }),
  flightId: Schema.NullOr(AgentIdSchema),
  repoId: Schema.NullOr(AgentIdSchema),
  resolution: AgentTextSchema,
  sources: AgentStringsSchema,
  tools: AgentStringsSchema,
  worktreeId: Schema.NullOr(AgentIdSchema),
});

export type AgentScope = typeof AgentScopeSchema.Type;

export const AgentWindowSchema = Schema.Struct({
  resolvedAt: IsoTimestampSchema,
  sinceInclusive: Schema.NullOr(IsoTimestampSchema),
  timezone: AgentIdSchema,
  untilExclusive: IsoTimestampSchema,
});

export type AgentWindow = typeof AgentWindowSchema.Type;

export const AgentReadPoliciesSchema = Schema.Struct({
  acquisition: Schema.Literals(["recorded-only", "refresh-selected"]),
  derivation: Schema.Literals(["ready-only", "bounded-refresh"]),
  learning: Schema.Literals(["hidden", "selected-scope"]),
  prices: Schema.Literals(["pinned", "cached-only", "refresh-selected"]),
});

export type AgentReadPolicies = typeof AgentReadPoliciesSchema.Type;

export const AgentBudgetSchema = Schema.Struct({
  maxDecodedBytes: Schema.Int.check(
    Schema.isBetween({ maximum: 67_108_864, minimum: 1 })
  ),
  maxElapsedMs: Schema.Int.check(
    Schema.isBetween({ maximum: 60_000, minimum: 1 })
  ),
  maxFacts: Schema.Int.check(
    Schema.isBetween({ maximum: 100_000, minimum: 1 })
  ),
  maxItems: Schema.Int.check(Schema.isBetween({ maximum: 500, minimum: 1 })),
  maxNetworkRequests: Schema.Int.check(
    Schema.isBetween({ maximum: 100, minimum: 0 })
  ),
  maxOutputBytes: Schema.Int.check(
    Schema.isBetween({ maximum: 4_194_304, minimum: 2048 })
  ),
  maxSeriesBuckets: Schema.Int.check(
    Schema.isBetween({ maximum: 366, minimum: 1 })
  ),
  maxStacks: Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 1 })),
});

export type AgentBudget = typeof AgentBudgetSchema.Type;

export const AgentRequestSchema = Schema.Struct({
  basisId: Schema.optional(AgentIdSchema),
  budget: AgentBudgetSchema,
  detail: Schema.optional(Schema.Literals(["summary", "expanded"])),
  policies: AgentReadPoliciesSchema,
  previousBasisId: Schema.optional(AgentIdSchema),
  profileVersion: Schema.Literal(AGENT_PROFILE_VERSION),
});

export type AgentRequest = typeof AgentRequestSchema.Type;

export const AgentOriginCountSchema = Schema.Struct({
  count: AgentCountSchema,
  origin: OriginSchema,
});

export const AgentRefResolutionSchema = Schema.Struct({
  reason: Schema.NullOr(AgentTextSchema),
  ref: AgentRefSchema,
  state: Schema.Literals([
    "found",
    "invalid",
    "missing-in-basis",
    "withheld",
    "over-budget",
    "stale-generation",
  ]),
});

export type AgentRefResolution = typeof AgentRefResolutionSchema.Type;

export const AgentRecoverySchema = Schema.Struct({
  action: Schema.Literals([
    "retry",
    "replan",
    "select-scope",
    "refresh-view",
    "use-current-generation",
    "none",
  ]),
  ref: Schema.NullOr(AgentRefSchema),
});
