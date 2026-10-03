import { Schema } from "effect";

import {
  AgentIdSchema,
  AgentRecoverySchema,
  AgentRefSchema,
  AgentTextSchema,
} from "../model/agent-common.js";

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  code: Schema.Literals([
    "invalid-selector",
    "scope-denied",
    "basis-not-found",
    "basis-incompatible",
    "basis-content-unavailable",
    "cursor-mismatch",
    "expired-cursor",
    "view-not-ready",
    "budget-exhausted",
    "source-unavailable",
    "store-busy",
    "stale-generation",
    "revision-conflict",
    "idempotency-conflict",
    "plan-stale",
    "plan-expired",
    "authorization-required",
    "operation-not-found",
    "learning-not-found",
    "invalid-transition",
  ]),
  currentRevision: Schema.NullOr(AgentIdSchema),
  expectedRevision: Schema.NullOr(AgentIdSchema),
  message: AgentTextSchema,
  recovery: AgentRecoverySchema,
  ref: Schema.NullOr(AgentRefSchema),
  retryable: Schema.Boolean,
}) {}
