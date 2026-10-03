import { Context } from "effect";
import type { Effect } from "effect";

import type {
  AgentHandle,
  AgentRef,
  AgentRefResolution,
  AgentScope,
  StoreIdentity,
} from "../model/agent-common.js";
import type {
  Evaluation,
  LearningFilter,
  LearningRecord,
} from "../model/agent-learning.js";
import type {
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import type {
  AgentCursor,
  AgentCoveragePage,
  AgentResult,
  AgentResultMetadata,
  AgentResultPage,
  AgentResultPageInput,
  AnalysisBasis,
  AnalysisBasisMetadata,
} from "../model/agent-query.js";
import type { SourceCoverage } from "../model/coverage.js";
import type { DxEventEnvelope } from "../model/event.js";
import type { SnapshotSelector } from "../model/snapshot.js";
import type { AgentError } from "./error-agent.js";
import type { StoreBusy } from "./error-store-busy.js";
import type { StoreError } from "./error-store-error.js";

export type AgentStoreFailure = AgentError | StoreBusy | StoreError;

export interface AgentEventPageInput {
  readonly scope?: AgentScope;
  readonly normalizedFilters?: Readonly<Record<string, readonly string[]>>;
  readonly selector: SnapshotSelector;
  readonly eventWatermark: string | null;
  readonly cursor: string | null;
  readonly maxFacts: number;
  readonly maxDecodedBytes: number;
  readonly maxElapsedMs: number;
}

export interface AgentEventPage {
  readonly events: readonly DxEventEnvelope[];
  readonly coverage: readonly SourceCoverage[];
  readonly eventWatermark: string;
  readonly complete: boolean;
  readonly nextCursor: string | null;
  readonly factsExamined: number;
  readonly decodedBytes: number;
}

export interface AgentBasisMetadataRead {
  readonly metadata: AnalysisBasisMetadata | null;
  readonly decodedBytes: number;
  readonly factsExamined: number;
}

export interface AgentResultMetadataRead {
  readonly metadata: AgentResultMetadata | null;
  readonly decodedBytes: number;
  readonly factsExamined: number;
}

export interface AgentCursorRead {
  readonly cursor: AgentCursor | null;
  readonly decodedBytes: number;
  readonly factsExamined: number;
}

export interface AgentStoreService {
  readonly readCoverage: (
    scope: AgentScope,
    maxSources: number,
    maxDecodedBytes: number
  ) => Effect.Effect<AgentCoveragePage, AgentStoreFailure>;
  readonly identity: Effect.Effect<StoreIdentity, AgentStoreFailure>;
  readonly readEventPage: (
    input: AgentEventPageInput
  ) => Effect.Effect<AgentEventPage, AgentStoreFailure>;
  readonly putBasis: (
    basis: AnalysisBasis
  ) => Effect.Effect<void, AgentStoreFailure>;
  readonly getBasis: (
    handle: AgentHandle
  ) => Effect.Effect<AnalysisBasis, AgentStoreFailure>;
  readonly getBasisMetadata: (
    handle: AgentHandle,
    maxDecodedBytes?: number
  ) => Effect.Effect<AnalysisBasisMetadata, AgentStoreFailure>;
  readonly readBasisMetadata: (
    handle: AgentHandle,
    maxDecodedBytes: number
  ) => Effect.Effect<AgentBasisMetadataRead, AgentStoreFailure>;
  readonly latestBasis: (
    queryKey: string
  ) => Effect.Effect<AnalysisBasis | null, AgentStoreFailure>;
  readonly latestBasisMetadata: (
    queryKey: string,
    maxDecodedBytes?: number
  ) => Effect.Effect<AnalysisBasisMetadata | null, AgentStoreFailure>;
  readonly latestBasisForScope: (
    scope: AgentScope,
    maxDecodedBytes?: number
  ) => Effect.Effect<AnalysisBasisMetadata | null, AgentStoreFailure>;
  readonly readLatestBasisMetadataForScope: (
    scope: AgentScope,
    maxDecodedBytes: number
  ) => Effect.Effect<AgentBasisMetadataRead, AgentStoreFailure>;
  readonly putResult: (
    result: AgentResult
  ) => Effect.Effect<void, AgentStoreFailure>;
  readonly getResult: (
    handle: AgentHandle
  ) => Effect.Effect<AgentResult, AgentStoreFailure>;
  readonly getResultMetadata: (
    handle: AgentHandle,
    maxDecodedBytes?: number
  ) => Effect.Effect<AgentResultMetadata, AgentStoreFailure>;
  readonly readResultMetadata: (
    handle: AgentHandle,
    maxDecodedBytes: number
  ) => Effect.Effect<AgentResultMetadataRead, AgentStoreFailure>;
  readonly findResult: (
    basis: AgentHandle,
    capability: AgentResult["capability"],
    queryDigest: string
  ) => Effect.Effect<AgentResult | null, AgentStoreFailure>;
  readonly findResultMetadata: (
    basis: AgentHandle,
    capability: AgentResult["capability"],
    queryDigest: string,
    maxDecodedBytes?: number
  ) => Effect.Effect<AgentResultMetadata | null, AgentStoreFailure>;
  readonly readMatchingResultMetadata: (
    basis: AgentHandle,
    capability: AgentResult["capability"],
    queryDigest: string,
    maxDecodedBytes: number
  ) => Effect.Effect<AgentResultMetadataRead, AgentStoreFailure>;
  readonly readResultPage: (
    handle: AgentHandle,
    input: AgentResultPageInput
  ) => Effect.Effect<AgentResultPage, AgentStoreFailure>;
  readonly putCursor: (
    cursor: AgentCursor
  ) => Effect.Effect<void, AgentStoreFailure>;
  readonly getCursor: (
    handle: AgentHandle
  ) => Effect.Effect<AgentCursor, AgentStoreFailure>;
  readonly readCursor: (
    handle: AgentHandle,
    maxDecodedBytes: number
  ) => Effect.Effect<AgentCursorRead, AgentStoreFailure>;
  readonly putOperationPlan: (
    plan: OperationPlan
  ) => Effect.Effect<void, AgentStoreFailure>;
  readonly getOperationPlan: (
    handle: AgentHandle
  ) => Effect.Effect<OperationPlan, AgentStoreFailure>;
  readonly getOperationPlanForReceipt: (
    operation: AgentHandle
  ) => Effect.Effect<OperationPlan | null, AgentStoreFailure>;
  readonly reserveOperation: (
    plan: AgentHandle,
    expectedDigest: string,
    idempotencyKey: string
  ) => Effect.Effect<
    { readonly receipt: OperationReceipt; readonly reused: boolean },
    AgentStoreFailure
  >;
  readonly getOperation: (
    handle: AgentHandle
  ) => Effect.Effect<OperationReceipt, AgentStoreFailure>;
  readonly updateOperation: (
    receipt: OperationReceipt,
    expectedRevision: number
  ) => Effect.Effect<OperationReceipt, AgentStoreFailure>;
  readonly appendOperationStep: (
    handle: AgentHandle,
    step: OperationStep,
    expectedRevision: number
  ) => Effect.Effect<OperationReceipt, AgentStoreFailure>;
  readonly requestOperationCancellation: (
    handle: AgentHandle,
    expectedRevision: number
  ) => Effect.Effect<OperationReceipt, AgentStoreFailure>;
  readonly createLearning: (
    record: LearningRecord,
    idempotencyKey: string
  ) => Effect.Effect<
    { readonly record: LearningRecord; readonly reused: boolean },
    AgentStoreFailure
  >;
  readonly getLearning: (
    handle: AgentHandle,
    revision?: number
  ) => Effect.Effect<LearningRecord, AgentStoreFailure>;
  readonly listLearning: (filter: LearningFilter) => Effect.Effect<
    {
      readonly records: readonly LearningRecord[];
      readonly excluded: number;
      readonly nextCursor: string | null;
    },
    AgentStoreFailure
  >;
  readonly updateLearning: (
    record: LearningRecord,
    expectedRevision: number,
    idempotencyKey: string
  ) => Effect.Effect<
    { readonly record: LearningRecord; readonly reused: boolean },
    AgentStoreFailure
  >;
  readonly appendEvaluation: (
    evaluation: Evaluation,
    idempotencyKey: string
  ) => Effect.Effect<
    { readonly evaluation: Evaluation; readonly reused: boolean },
    AgentStoreFailure
  >;
  readonly getEvaluation: (
    handle: AgentHandle
  ) => Effect.Effect<Evaluation, AgentStoreFailure>;
  readonly listEvaluations: (
    lesson: AgentHandle,
    limit: number
  ) => Effect.Effect<
    { readonly evaluations: readonly Evaluation[]; readonly omitted: number },
    AgentStoreFailure
  >;
  readonly resolveRefs: (
    refs: readonly AgentRef[],
    scope?: AgentScope
  ) => Effect.Effect<readonly AgentRefResolution[], AgentStoreFailure>;
}

export class AgentStore extends Context.Service<
  AgentStore,
  AgentStoreService
>()("@rat-stack/core/dx/AgentStore") {}
