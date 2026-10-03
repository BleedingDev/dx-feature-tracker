import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import {
  LearningInputSchema,
  LearningOutputSchema,
} from "../model/agent-learning.js";
import {
  OperationInputSchema,
  OperationOutputSchema,
} from "../model/agent-operation.js";
import { AgentError } from "./error-agent.js";
import { StoreBusy } from "./error-store-busy.js";
import { StoreError } from "./error-store-error.js";

export const AgentFailureSchema = Schema.Union([
  AgentError,
  StoreBusy,
  StoreError,
]);

export type AgentFailure = typeof AgentFailureSchema.Type;

export const dxOperationContract = defineContract("dx_operation", {
  annotations: { idempotent: true, readOnly: false },
  description:
    "Plan, apply, recover or cancel one bounded operation on selected tracker state; apply requires the reviewed plan digest and a durable idempotency key",
  failure: AgentFailureSchema,
  input: Schema.Struct({ request: OperationInputSchema }),
  output: OperationOutputSchema,
});

export const dxLearningContract = defineContract("dx_learning", {
  annotations: { idempotent: true, readOnly: false },
  description:
    "Read or record scoped investigations, lessons and independent evaluations; prose is retained as data and never executed",
  failure: AgentFailureSchema,
  input: Schema.Struct({ request: LearningInputSchema }),
  output: LearningOutputSchema,
});
