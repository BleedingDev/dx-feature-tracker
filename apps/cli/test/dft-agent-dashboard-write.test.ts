import { Buffer } from "node:buffer";

import { describe, expect, it } from "@effect/vitest";
import {
  AgentScopeSchema,
  buildRegistry,
  LearningInputSchema,
  LearningOutputSchema,
  makeDxCapabilities,
  OperationInputSchema,
  OperationOutputSchema,
  OperationPlanSchema,
} from "@rat-stack/core/dx";
import type {
  LearningInput,
  OperationInput,
  OperationOutput,
} from "@rat-stack/core/dx";
import { Effect } from "effect";
import { vi } from "vitest";

import { writeAgentDashboardCapability } from "../src/dft-agent-dashboard-write.js";
import { capabilityAt } from "../src/dft-session.js";

const identity = {
  revision: "fixture:revision",
  storeGeneration: 1,
  storeId: "fixture:dashboard-write-store",
};

const scope = AgentScopeSchema.make({
  branchSelection: { branches: [], kind: "all" },
  flightId: null,
  repoId: null,
  resolution: "Synthetic dashboard write fixture.",
  sources: [],
  tools: [],
  worktreeId: null,
});

const planRequest = OperationInputSchema.make({
  action: "plan",
  arguments: { backupRequired: true, kind: "reset" },
  bounds: {
    maxBytes: 1_048_576,
    maxElapsedMs: 1000,
    maxFiles: 10,
    maxRecords: 100,
    maxRequests: 0,
    maxRetries: 0,
  },
  purpose: "Synthetic fixture reset review.",
  scope,
  target: identity,
});

const plan = OperationPlanSchema.make({
  arguments: { backupRequired: true, kind: "reset" },
  bounds: {
    maxBytes: 1_048_576,
    maxElapsedMs: 1000,
    maxFiles: 10,
    maxRecords: 100,
    maxRequests: 0,
    maxRetries: 0,
  },
  consent: {
    reason: "Synthetic fixture requires reviewed text.",
    receiptIds: [],
    scopeDigest: "fixture:scope-digest",
    state: "required",
  },
  createdAt: "2026-10-01T00:00:00.000Z",
  effects: {
    destructive: true,
    networkDestinations: [],
    reads: [],
    writes: [],
  },
  expectedEvidenceImprovement: "Synthetic fixture operation.",
  expiresAt: "2026-10-01T00:15:00.000Z",
  forecast: { bytes: null, cost: null, elapsedMs: null, requests: 0 },
  id: "fixture:write-plan",
  kind: "reset",
  planDigest: "fixture:write-plan-digest",
  preconditions: [
    {
      allowAppend: false,
      expected: "reset",
      kind: "backup-policy",
      target: "confirmation",
    },
  ],
  purpose: "Synthetic fixture reset review.",
  resumeBoundary: "atomic-step",
  schemaVersion: "dx.operation.v1",
  scope,
  stopCondition: "Synthetic fixture stops after one step.",
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  validity: "valid",
});

const planOutput = OperationOutputSchema.make({ action: "plan", plan });

const applyRequest = OperationInputSchema.make({
  action: "apply",
  confirmation: "reset",
  consentReceiptIds: [],
  expectedDigest: plan.planDigest,
  idempotencyKey: "fixture:write-click-key",
  plan: {
    id: plan.id,
    storeGeneration: plan.storeGeneration,
    storeId: plan.storeId,
  },
});

const receiptOutput = OperationOutputSchema.make({
  action: "apply",
  receipt: {
    afterRevision: null,
    beforeRevision: identity.revision,
    cancellationRequested: false,
    completedAt: null,
    effects: {
      backupArtifacts: [
        {
          contentDigest: "fixture:backup-content",
          id: "fixture:safety-backup",
          restorationVersion: "fixture:backup-v1",
          storeGeneration: identity.storeGeneration,
          storeId: identity.storeId,
        },
      ],
      backupIds: ["fixture:safety-backup"],
      configDigest: null,
      evidenceIds: [],
      exportArtifacts: [],
      exports: [],
      filesChanged: [],
      remainingStoreGeneration: identity.storeGeneration,
      removalReason: "Synthetic fixture outcome requires verification.",
      removedCount: null,
      removedRefs: [],
    },
    executionState: "partial",
    id: "fixture:write-receipt",
    idempotencyKey: "fixture:write-click-key",
    planDigest: plan.planDigest,
    planId: plan.id,
    recovery: "verify-indeterminate",
    resources: {
      bytesRead: null,
      elapsedMs: null,
      recordsDecoded: null,
      requests: 0,
      retries: 0,
    },
    resultingBasisId: null,
    revision: 1,
    schemaVersion: "dx.operation.v1",
    startedAt: "2026-10-01T00:00:00.000Z",
    steps: [],
    storeGeneration: identity.storeGeneration,
    storeId: identity.storeId,
    verificationRefs: [],
    verificationState: "indeterminate",
  },
  reused: true,
});

const evaluation: Extract<
  LearningInput,
  { readonly action: "evaluate" }
>["evaluation"] = {
  authorKind: "human",
  basisIds: ["fixture:basis"],
  comparabilityLimitations: ["Synthetic fixture has no real outcome evidence."],
  comparedWindows: [],
  conclusion: "inconclusive",
  coverage: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  criterion: "Synthetic dashboard transport fixture.",
  evidenceRefs: [],
  id: "fixture:evaluation",
  operationIds: [],
  originMix: [{ count: 1, origin: "fixture" }],
  outcome: "No real product effect was evaluated.",
  relation: "operator-report",
  schemaVersion: "dx.learning.v1",
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  target: { id: "fixture:lesson", kind: "lesson", revision: 1 },
};

const learningRequest = LearningInputSchema.make({
  action: "evaluate",
  evaluation,
  idempotencyKey: "fixture:evaluation-key",
});

const learningOutput = LearningOutputSchema.make({
  action: "evaluate",
  evaluation,
  reused: true,
});

const listRequest = LearningInputSchema.make({
  action: "list",
  filter: {
    cursor: null,
    includeSuperseded: false,
    kinds: ["lesson"],
    limit: 5,
    question: null,
    scope,
  },
  target: identity,
});

const fixtures = (operationResult: OperationOutput = planOutput) => {
  const operation = vi.fn((_input: OperationInput) =>
    Effect.succeed(operationResult)
  );

  const learning = vi.fn((_input: LearningInput) =>
    Effect.succeed(learningOutput)
  );

  const prices = vi.fn(() => {
    throw new Error(
      "The dashboard write dispatcher initialized fixture prices."
    );
  });

  const caps = capabilityAt(
    makeDxCapabilities({
      collectors: [],
      defaultRepo: "/fixture/dashboard-write-repo",
      learning,
      operation,
      registry: buildRegistry([], [], []),
      resolveCostOptions: prices,
      storePath: "/fixture/dashboard-write-store.db",
    })
  );

  return { caps, learning, operation, prices };
};

describe("dashboard guarded shared capability writes", () => {
  for (const item of [
    { name: "plan", output: planOutput, request: planRequest },
    { name: "receipt", output: receiptOutput, request: applyRequest },
  ]) {
    it.effect(
      `operation ${item.name} is returned unchanged through its implemented handler`,
      () => {
        const fixture = fixtures(item.output);

        return Effect.gen(function* forwardedOperation() {
          const output = yield* writeAgentDashboardCapability(
            fixture.caps,
            "dx_operation",
            JSON.stringify({ request: item.request })
          );

          expect(output).toBe(item.output);
          expect(fixture.operation).toHaveBeenCalledExactlyOnceWith(
            item.request
          );
          expect(fixture.learning).not.toHaveBeenCalled();
          expect(fixture.prices).not.toHaveBeenCalled();
        });
      }
    );
  }

  it.effect(
    "learning retains its evaluation and reuse acknowledgement unchanged",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* forwardedLearning() {
        const output = yield* writeAgentDashboardCapability(
          fixture.caps,
          "dx_learning",
          JSON.stringify({ request: learningRequest })
        );

        expect(output).toBe(learningOutput);
        expect(fixture.learning).toHaveBeenCalledExactlyOnceWith(
          learningRequest
        );
        expect(fixture.operation).not.toHaveBeenCalled();
        expect(fixture.prices).not.toHaveBeenCalled();
      });
    }
  );

  it.effect(
    "both capabilities reject absent wrappers, malformed JSON and unsupported controls before dispatch",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* rejectedInputs() {
        for (const item of [
          { capability: "dx_operation", input: "{" },
          { capability: "dx_operation", input: JSON.stringify(planRequest) },
          { capability: "dx_learning", input: JSON.stringify(learningRequest) },
          {
            capability: "dx_operation",
            input: JSON.stringify({ autoApprove: true, request: planRequest }),
          },
          {
            capability: "dx_operation",
            input: JSON.stringify({ request: { ...planRequest, force: true } }),
          },
          {
            capability: "dx_operation",
            input: JSON.stringify({
              request: {
                ...planRequest,
                scope: { ...scope, allProjects: true },
              },
            }),
          },
          {
            capability: "dx_operation",
            input: JSON.stringify({
              request: {
                action: "apply",
                confirmation: "reset",
                consentReceiptIds: [],
                expectedDigest: plan.planDigest,
                idempotencyKey: "fixture:key",
                plan: {
                  approve: true,
                  id: plan.id,
                  storeGeneration: plan.storeGeneration,
                  storeId: plan.storeId,
                },
              },
            }),
          },
          {
            capability: "dx_learning",
            input: JSON.stringify({
              autoApprove: true,
              request: learningRequest,
            }),
          },
          {
            capability: "dx_learning",
            input: JSON.stringify({
              request: { ...learningRequest, execute: true },
            }),
          },
          {
            capability: "dx_learning",
            input: JSON.stringify({
              request: {
                ...listRequest,
                filter: {
                  autoExecute: true,
                  cursor: null,
                  includeSuperseded: false,
                  kinds: ["lesson"],
                  limit: 5,
                  question: null,
                  scope,
                },
              },
            }),
          },
        ]) {
          const error = yield* Effect.flip(
            writeAgentDashboardCapability(
              fixture.caps,
              item.capability,
              item.input
            )
          );

          expect(error._tag).toBe("InvalidInput");
          expect(error).toMatchObject({ field: "input" });
        }

        expect(fixture.operation).not.toHaveBeenCalled();
        expect(fixture.learning).not.toHaveBeenCalled();
        expect(fixture.prices).not.toHaveBeenCalled();
      });
    }
  );

  it.effect(
    "unregistered, read and legacy write capabilities are rejected",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* rejectedCapabilities() {
        for (const capability of [
          "dx_analyze",
          "dx_usage",
          "dx_status",
          "dx_collect",
          "dx_mark",
          "unknown",
        ]) {
          const error = yield* Effect.flip(
            writeAgentDashboardCapability(
              fixture.caps,
              capability,
              JSON.stringify({ request: planRequest })
            )
          );

          expect(error._tag).toBe("InvalidInput");
          expect(error).toMatchObject({ field: "capability" });
        }

        expect(fixture.operation).not.toHaveBeenCalled();
        expect(fixture.learning).not.toHaveBeenCalled();
      });
    }
  );

  it.effect("the predecode bound counts multibyte input as UTF-8 bytes", () => {
    const fixture = fixtures();

    const input = JSON.stringify({
      request: { ...planRequest, purpose: "€".repeat(22_000) },
    });

    return Effect.gen(function* boundedInput() {
      expect(input.length).toBeLessThan(65_536);
      expect(Buffer.byteLength(input, "utf-8")).toBeGreaterThan(65_536);

      const error = yield* Effect.flip(
        writeAgentDashboardCapability(fixture.caps, "dx_operation", input)
      );

      expect(error._tag).toBe("InvalidInput");
      expect(error.message).toContain("64 KiB");
      expect(fixture.operation).not.toHaveBeenCalled();
      expect(fixture.learning).not.toHaveBeenCalled();
    });
  });
});
