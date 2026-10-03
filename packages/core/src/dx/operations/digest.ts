// @effect-diagnostics-next-line nodeBuiltinImport:off -- Operation plans use SHA-256 for canonical review identity.
import { createHash } from "node:crypto";

import { Schema } from "effect";

import type { AgentRef } from "../model/agent-common.js";
import { OperationPlanSchema } from "../model/agent-operation.js";
import type { OperationPlan } from "../model/agent-operation.js";

type OperationDigestInput =
  | OperationPlan
  | Pick<
      OperationPlan,
      | "arguments"
      | "bounds"
      | "effects"
      | "scope"
      | "storeGeneration"
      | "storeId"
    >;

export const operationDigest = (value: OperationDigestInput): string => {
  const argumentsValue =
    value.arguments.kind === "configure"
      ? {
          ...value.arguments,
          settings: Object.fromEntries(
            Object.entries(value.arguments.settings).toSorted(
              ([left], [right]) => left.localeCompare(right)
            )
          ),
        }
      : value.arguments;

  return createHash("sha256")
    .update(JSON.stringify({ ...value, arguments: argumentsValue }))
    .digest("hex");
};

const encodePlan = Schema.encodeSync(OperationPlanSchema);

export const digestOperationPlan = (plan: OperationPlan): string => {
  const encoded = encodePlan(plan);

  return operationDigest({
    ...encoded,
    planDigest: "",
    validity: "valid",
  });
};

export const operationScopeDigest = (plan: OperationPlan): string =>
  operationDigest({
    arguments: plan.arguments,
    bounds: plan.bounds,
    effects: plan.effects,
    scope: plan.scope,
    storeGeneration: plan.storeGeneration,
    storeId: plan.storeId,
  });

export const sameOperationRefs = (
  left: readonly string[],
  right: readonly string[]
): boolean =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((entry) => right.includes(entry));

const operationAgentRefKey = (ref: AgentRef): string =>
  JSON.stringify([
    ref.kind,
    ref.id,
    ref.storeId,
    ref.storeGeneration,
    ref.basisId,
    ref.version,
  ]);

export const sameOperationAgentRefs = (
  left: readonly AgentRef[],
  right: readonly AgentRef[]
): boolean =>
  sameOperationRefs(
    left.map(operationAgentRefKey),
    right.map(operationAgentRefKey)
  );
