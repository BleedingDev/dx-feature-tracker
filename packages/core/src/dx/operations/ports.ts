import type { Effect } from "effect";

import type { AgentStoreFailure } from "../contracts/agent-store.js";
import type { AgentHandle } from "../model/agent-common.js";
import type {
  OperationDescriptor,
  OperationInput,
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import type { OperationWorkBudget } from "./budget.js";

export type OperationPlanInput = Extract<OperationInput, { action: "plan" }>;

export type OperationApplyInput = Extract<OperationInput, { action: "apply" }>;

export type OperationPreparation = Pick<
  OperationPlan,
  | "arguments"
  | "effects"
  | "expectedEvidenceImprovement"
  | "preconditions"
  | "consent"
  | "resumeBoundary"
  | "forecast"
  | "stopCondition"
>;

export interface OperationEffectResult {
  readonly step: OperationStep;
  readonly effects?: OperationReceipt["effects"];
  readonly resources?: OperationReceipt["resources"];
  readonly verificationRefs?: OperationReceipt["verificationRefs"];
  readonly resultingBasisId?: string | null;
}

export type OperationProbe =
  | { readonly state: "complete"; readonly result: OperationEffectResult }
  | { readonly state: "absent" }
  | { readonly state: "indeterminate"; readonly reason: string };

export interface OperationWorkContext {
  readonly budget: OperationWorkBudget;
}

export interface OperationExecutionContext extends OperationWorkContext {
  readonly operation: AgentHandle;
  readonly confirmation: string | null;
}

export interface OperationAdapter {
  readonly descriptor: OperationDescriptor;
  readonly replay: "safe" | "probe-required";
  readonly meteredWork?: boolean;
  readonly unmeasuredValidationResources?: readonly (keyof OperationReceipt["resources"])[];
  readonly prepare: (
    input: OperationPlanInput,
    context: OperationWorkContext
  ) => Effect.Effect<OperationPreparation, AgentStoreFailure>;
  readonly validate: (
    plan: OperationPlan,
    context: OperationWorkContext
  ) => Effect.Effect<readonly string[], AgentStoreFailure>;
  readonly authorize: (
    plan: OperationPlan,
    input: OperationApplyInput,
    context: OperationWorkContext
  ) => Effect.Effect<boolean, AgentStoreFailure>;
  readonly steps: (plan: OperationPlan) => readonly OperationStep[];
  readonly execute: (
    plan: OperationPlan,
    step: OperationStep,
    context: OperationExecutionContext
  ) => Effect.Effect<OperationEffectResult, AgentStoreFailure>;
  readonly probe: (
    plan: OperationPlan,
    step: OperationStep,
    receipt: OperationReceipt,
    context: OperationWorkContext
  ) => Effect.Effect<OperationProbe, AgentStoreFailure>;
}

export const operationStep = (
  id: string,
  source: string | null = null
): OperationStep => ({
  committedThrough: null,
  duplicates: 0,
  gaps: [],
  id,
  inserted: 0,
  rejected: 0,
  remainingWork: null,
  retries: 0,
  safeCursor: null,
  source,
  spooledRefs: [],
  state: "not-attempted",
});
