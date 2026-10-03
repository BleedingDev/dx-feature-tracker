import { Effect, Layer } from "effect";

import { AgentStore } from "./agent-store.js";
import type { AgentStoreService } from "./agent-store.js";
import { AgentError } from "./error-agent.js";

export const makeFakeAgentStore = (
  overrides: Partial<AgentStoreService> = {}
): AgentStoreService => {
  const unavailable = Effect.fail(
    new AgentError({
      code: "basis-content-unavailable",
      currentRevision: null,
      expectedRevision: null,
      message: "Compile-only fixture port has no retained content",
      recovery: { action: "none", ref: null },
      ref: null,
      retryable: false,
    })
  );

  return AgentStore.of({
    appendEvaluation: () => unavailable,
    appendOperationStep: () => unavailable,
    createLearning: () => unavailable,
    findResult: () => Effect.succeed(null),
    findResultMetadata: () => Effect.succeed(null),
    getBasis: () => unavailable,
    getBasisMetadata: () => unavailable,
    getCursor: () => unavailable,
    getEvaluation: () => unavailable,
    getLearning: () => unavailable,
    getOperation: () => unavailable,
    getOperationPlan: () => unavailable,
    getOperationPlanForReceipt: () => Effect.succeed(null),
    getResult: () => unavailable,
    getResultMetadata: () => unavailable,
    identity: Effect.succeed({
      revision: "fixture-1",
      storeGeneration: 1,
      storeId: "fixture-store",
    }),
    latestBasis: () => Effect.succeed(null),
    latestBasisForScope: () => Effect.succeed(null),
    latestBasisMetadata: () => Effect.succeed(null),
    listEvaluations: () => Effect.succeed({ evaluations: [], omitted: 0 }),
    listLearning: () =>
      Effect.succeed({ excluded: 0, nextCursor: null, records: [] }),
    putBasis: () => unavailable,
    putCursor: () => unavailable,
    putOperationPlan: () => unavailable,
    putResult: () => unavailable,
    readBasisMetadata: () =>
      Effect.succeed({ decodedBytes: 0, factsExamined: 0, metadata: null }),
    readCoverage: () =>
      Effect.succeed({
        coverage: [],
        decodedBytes: 0,
        factsExamined: 0,
        omitted: 0,
      }),
    readCursor: () =>
      Effect.succeed({ cursor: null, decodedBytes: 0, factsExamined: 0 }),
    readEventPage: () => unavailable,
    readLatestBasisMetadataForScope: () =>
      Effect.succeed({ decodedBytes: 0, factsExamined: 0, metadata: null }),
    readMatchingResultMetadata: () =>
      Effect.succeed({ decodedBytes: 0, factsExamined: 0, metadata: null }),
    readResultMetadata: () =>
      Effect.succeed({ decodedBytes: 0, factsExamined: 0, metadata: null }),
    readResultPage: () => unavailable,
    requestOperationCancellation: () => unavailable,
    reserveOperation: () => unavailable,
    resolveRefs: (refs) =>
      Effect.succeed(
        refs.map((ref) => ({
          reason: "Compile-only fixture has no evidence",
          ref,
          state: "missing-in-basis",
        }))
      ),
    updateLearning: () => unavailable,
    updateOperation: () => unavailable,
    ...overrides,
  });
};

export const FakeAgentStoreLayer = Layer.succeed(
  AgentStore,
  makeFakeAgentStore()
);
