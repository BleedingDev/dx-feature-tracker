import { Schema, Struct } from "effect";

import {
  AgentBudgetSchema,
  AgentReadPoliciesSchema,
  AgentRefResolutionSchema,
  AgentRefSchema,
  AgentScopeSchema,
  AgentWindowSchema,
  AGENT_PROFILE_VERSION,
  StoreIdentitySchema,
} from "../model/agent-common.js";
import {
  EvaluationSchema,
  InvestigationSchema,
  LearningApplicabilitySchema,
  LEARNING_SCHEMA_VERSION,
  LessonSchema,
} from "../model/agent-learning.js";
import {
  OPERATION_SCHEMA_VERSION,
  OperationDescriptorSchema,
  OperationOutputSchema,
  OperationPlanSchema,
  OperationReceiptSchema,
} from "../model/agent-operation.js";
import {
  AgentCompletenessSchema,
  AgentCursorSchema,
  AgentQueryInputSchema,
  AgentQueryOutputSchema,
  AgentResponseContextSchema,
  AgentResultMetadataSchema,
  AgentResultPageSchema,
  AgentResultSchema,
  AgentViewSchema,
  ANALYSIS_BASIS_VERSION,
  AnalysisBasisMetadataSchema,
  AnalysisBasisSchema,
  AGENT_RESULT_VERSION,
} from "../model/agent-query.js";
import { SourceCoverageSchema } from "../model/coverage.js";
import {
  DxEventEnvelopeSchema,
  emptyEventIdentity,
  emptyFlightContext,
  EVENT_SCHEMA_VERSION,
} from "../model/event.js";
import { EventIdSchema } from "../model/ids.js";
import {
  AGENT_CONTRACT_DIGEST,
  AGENT_CONTRACT_VERSION,
} from "./agent-version.js";

export const agentFixtureStore = StoreIdentitySchema.make({
  revision: "fixture:revision-1",
  storeGeneration: 1,
  storeId: "fixture:agent-store",
});

export const agentFixtureScope = AgentScopeSchema.make({
  branchSelection: { branches: ["fixture:branch"], kind: "selected" },
  flightId: null,
  repoId: "fixture:repo",
  resolution: "Compile-only fixture scope; no live repository was resolved",
  sources: ["fixture:source"],
  tools: ["fixture:tool"],
  worktreeId: "fixture:worktree",
});

export const agentFixtureWindow = AgentWindowSchema.make({
  resolvedAt: "2026-10-01T01:00:00.000Z",
  sinceInclusive: "2026-10-01T00:00:00.000Z",
  timezone: "UTC",
  untilExclusive: "2026-10-01T01:00:00.000Z",
});

export const agentFixturePolicies = AgentReadPoliciesSchema.make({
  acquisition: "recorded-only",
  derivation: "ready-only",
  learning: "selected-scope",
  prices: "pinned",
});

export const agentFixtureBudget = AgentBudgetSchema.make({
  maxDecodedBytes: 16_384,
  maxElapsedMs: 100,
  maxFacts: 64,
  maxItems: 8,
  maxNetworkRequests: 0,
  maxOutputBytes: 8192,
  maxSeriesBuckets: 7,
  maxStacks: 2,
});

export const agentFixtureAmbiguousEvent = DxEventEnvelopeSchema.make({
  acquisition: "manual",
  adapterId: "fixture:source",
  adapterVersion: "fixture:source-v1",
  ai: null,
  context: emptyFlightContext,
  eventId: EventIdSchema.make("fixture:ambiguous-event"),
  evidence: { bounded: true, hash: null, ref: "fixture:ambiguous-evidence" },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind: "other",
  observedAt: "2026-10-01T00:30:00.000Z",
  occurredAt: null,
  occurredAtPrecision: "unknown",
  origin: "fixture",
  payload: {
    accountAssociation: "ambiguous",
    candidateAccounts: ["fixture:account-a", "fixture:account-b"],
    charge: null,
    origin: "fixture",
    reason: "Synthetic ambiguity vocabulary; no account ownership is known",
    tokens: null,
  },
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: "fixture:source-v1",
  upstreamKey: "fixture:ambiguous-event",
  usage: null,
});

export const agentFixtureCoverage = SourceCoverageSchema.make({
  adapterId: "fixture:source",
  expectedItems: null,
  gaps: [
    { code: "fixture:missing-source", message: "Fixture source is incomplete" },
  ],
  observedItems: 1,
  state: "partial",
  watermark: "fixture:event-watermark",
  windowFrom: agentFixtureWindow.sinceInclusive,
  windowTo: agentFixtureWindow.untilExclusive,
});

export const agentFixturePreviousBasis = AnalysisBasisSchema.make({
  acquisitionReceiptIds: [],
  attributionVersion: "fixture:attribution-v1",
  configDigest: "fixture:config-digest",
  contractDigest: AGENT_CONTRACT_DIGEST,
  contractVersion: AGENT_CONTRACT_VERSION,
  coverage: [agentFixtureCoverage],
  createdAt: agentFixtureWindow.resolvedAt,
  descriptors: [{ id: "fixture:source", version: "fixture:source-v1" }],
  eventWatermark: "fixture:event-watermark",
  id: "fixture:basis-v1",
  interpretationInputs: JSON.stringify({
    accountAssociation: "ambiguous",
    origin: "fixture",
  }),
  metricDefinitions: [],
  normalizedFilters: { origin: ["fixture"] },
  originMix: [{ count: 1, origin: "fixture" }],
  priceSheets: [
    {
      content: JSON.stringify({
        origin: "fixture",
        rates: [],
        version: "fixture:prices-v1",
      }),
      contentHash: "fixture:prices-v1-content",
      effectiveFrom: agentFixtureWindow.sinceInclusive,
      effectiveUntil: null,
      id: "fixture:prices-v1",
    },
  ],
  queryKey: "fixture:query-key",
  reconciliationVersion: "fixture:reconciliation-v1",
  reproducibility: "retained-inputs",
  retainedEvents: [agentFixtureAmbiguousEvent],
  schemaVersion: ANALYSIS_BASIS_VERSION,
  scope: agentFixtureScope,
  selectedEventDigest: "fixture:selected-event-digest",
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  supportedResultVersions: [AGENT_RESULT_VERSION],
  window: agentFixtureWindow,
});

export const agentFixtureBasis = AnalysisBasisSchema.make({
  ...agentFixturePreviousBasis,
  attributionVersion: "fixture:attribution-v2",
  id: "fixture:basis-v2",
  priceSheets: [
    {
      content: JSON.stringify({
        origin: "fixture",
        rates: [],
        version: "fixture:prices-v2",
      }),
      contentHash: "fixture:prices-v2-content",
      effectiveFrom: agentFixtureWindow.sinceInclusive,
      effectiveUntil: null,
      id: "fixture:prices-v2",
    },
  ],
});

export const agentFixtureBasisMetadata = AnalysisBasisMetadataSchema.make({
  ...Struct.omit(agentFixtureBasis, [
    "retainedEvents",
    "interpretationInputs",
    "priceSheets",
  ]),
  interpretationBytes: Buffer.byteLength(
    agentFixtureBasis.interpretationInputs
  ),
  priceSheets: agentFixtureBasis.priceSheets.map((sheet) =>
    Struct.omit(sheet, ["content"])
  ),
  retainedDecodedBytes: Buffer.byteLength(
    JSON.stringify(agentFixtureBasis.retainedEvents)
  ),
  retainedEventCount: agentFixtureBasis.retainedEvents.length,
});

export const agentFixtureAmbiguousRef = AgentRefSchema.make({
  basisId: agentFixtureBasis.id,
  id: agentFixtureAmbiguousEvent.eventId,
  kind: "event",
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  version: EVENT_SCHEMA_VERSION,
});

export const agentFixtureMissingRef = AgentRefSchema.make({
  ...agentFixtureAmbiguousRef,
  id: "fixture:missing-evidence",
  kind: "evidence",
});

export const agentFixtureStaleRef = AgentRefSchema.make({
  ...agentFixtureAmbiguousRef,
  storeGeneration: 0,
});

export const agentFixtureFoundResolution = AgentRefResolutionSchema.make({
  reason: "Compile-only fixture event; account association remains ambiguous",
  ref: agentFixtureAmbiguousRef,
  state: "found",
});

export const agentFixtureMissingResolution = AgentRefResolutionSchema.make({
  reason: "The synthetic missing reference has no retained fixture evidence",
  ref: agentFixtureMissingRef,
  state: "missing-in-basis",
});

export const agentFixtureStaleResolution = AgentRefResolutionSchema.make({
  reason: "The synthetic handle belongs to fixture store generation 0, not 1",
  ref: agentFixtureStaleRef,
  state: "stale-generation",
});

export const agentFixtureApplicability = LearningApplicabilitySchema.make({
  coverageRequirements: [
    "Resolve fixture account association before assigning charges",
  ],
  metricDefinitions: [],
  scope: agentFixtureScope,
  sourceVersions: [{ id: "fixture:source", version: "fixture:source-v1" }],
  toolVersions: [{ id: "fixture:tool", version: "fixture:tool-v1" }],
  widerScope: false,
  window: agentFixtureWindow,
  workflowConditions: ["Compile-only fixture; no production learning record"],
});

export const agentFixtureInvestigation = InvestigationSchema.make({
  applicability: agentFixtureApplicability,
  authorKind: "agent",
  comparedBasisIds: [],
  conclusion: null,
  createdAt: agentFixtureWindow.resolvedAt,
  id: "fixture:investigation",
  inspectedRefs: [],
  kind: "investigation",
  limitations: ["Compile-only fixture; no query or investigation was executed"],
  nextQueryRefs: [agentFixtureAmbiguousRef],
  observedResultRefs: [],
  operationIds: [],
  question: "Which fixture account, if any, owns the ambiguous event?",
  revision: 0,
  schemaVersion: LEARNING_SCHEMA_VERSION,
  startingBasisId: agentFixtureBasis.id,
  state: "awaiting-evidence",
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  updatedAt: agentFixtureWindow.resolvedAt,
});

export const agentFixtureLesson = LessonSchema.make({
  applicability: agentFixtureApplicability,
  authorKind: "agent",
  claim:
    "Fixture hypothesis: account association requires an explicit ownership reference",
  claimKind: "hypothesis",
  contradictingRefs: [],
  createdAt: agentFixtureWindow.resolvedAt,
  criterion:
    "A fixture ownership reference identifies exactly one candidate account",
  id: "fixture:lesson",
  invalidationConditions: [
    "A second fixture account has the same ownership reference",
  ],
  kind: "lesson",
  limitations: [
    "Compile-only proposed fixture claim; no causal or savings conclusion",
  ],
  previousRevision: null,
  revision: 0,
  schemaVersion: LEARNING_SCHEMA_VERSION,
  status: "proposed",
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  supersededBy: null,
  supersedes: null,
  supportingRefs: [],
  updatedAt: agentFixtureWindow.resolvedAt,
});

export const agentFixtureEvaluation = EvaluationSchema.make({
  authorKind: "agent",
  basisIds: [],
  comparabilityLimitations: [
    "No evaluation was executed against these fixture records",
  ],
  comparedWindows: [],
  conclusion: "inconclusive",
  coverage: [],
  createdAt: agentFixtureWindow.resolvedAt,
  criterion: agentFixtureLesson.criterion,
  evidenceRefs: [],
  id: "fixture:evaluation",
  operationIds: [],
  originMix: [],
  outcome:
    "Compile-only fixture; evidence for the proposed ownership criterion is unavailable",
  relation: "descriptive-association",
  schemaVersion: LEARNING_SCHEMA_VERSION,
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  target: {
    id: agentFixtureLesson.id,
    kind: "lesson",
    revision: agentFixtureLesson.revision,
  },
});

export const agentFixtureInvestigationEvaluation = EvaluationSchema.make({
  ...agentFixtureEvaluation,
  id: "fixture:investigation-evaluation",
  target: {
    id: agentFixtureInvestigation.id,
    kind: "investigation",
    revision: agentFixtureInvestigation.revision,
  },
});

export const agentFixtureOperationDescriptor = OperationDescriptorSchema.make({
  authorization: "none",
  cancellation: "before-start-only",
  effects: {
    destructive: false,
    networkDestinations: [],
    reads: [],
    writes: [],
  },
  enabled: false,
  idempotency: "disabled",
  kind: "collect",
  reason: "Compile-only schema fixture; this fixture installs no executor",
  requiredInputs: [],
  version: "fixture:operation-descriptor-v1",
});

export const agentFixtureOperationPlan = OperationPlanSchema.make({
  arguments: {
    allowSourceGrowth: false,
    cursor: null,
    inputRefs: [agentFixtureAmbiguousRef],
    kind: "collect",
    parserVersion: "fixture:parser-v1",
    selectedRoots: ["fixture:source"],
    source: "fixture:source",
  },
  bounds: {
    maxBytes: 16_384,
    maxElapsedMs: 100,
    maxFiles: 1,
    maxRecords: 8,
    maxRequests: 0,
    maxRetries: 0,
  },
  consent: {
    reason: "Compile-only plan has no authorization",
    receiptIds: [],
    scopeDigest: "fixture:scope-digest",
    state: "required",
  },
  createdAt: agentFixtureWindow.resolvedAt,
  effects: {
    destructive: false,
    networkDestinations: [],
    reads: ["fixture:source"],
    writes: ["fixture:agent-store"],
  },
  expectedEvidenceImprovement:
    "Fixture plan describes a proposed ownership check; no improvement was observed",
  expiresAt: "2026-10-01T02:00:00.000Z",
  forecast: { bytes: null, cost: null, elapsedMs: null, requests: null },
  id: "fixture:operation-plan",
  kind: "collect",
  planDigest: "fixture:plan-digest",
  preconditions: [
    {
      allowAppend: false,
      expected: "1",
      kind: "store-generation",
      target: agentFixtureStore.storeId,
    },
  ],
  purpose: "Compile-only operation vocabulary; no source is read",
  resumeBoundary: "complete-record",
  schemaVersion: OPERATION_SCHEMA_VERSION,
  scope: agentFixtureScope,
  stopCondition: "Stop before exceeding any declared fixture work bound",
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  validity: "valid",
});

export const agentFixtureOperationReceipt = OperationReceiptSchema.make({
  afterRevision: null,
  beforeRevision: agentFixtureStore.revision,
  cancellationRequested: false,
  completedAt: null,
  effects: {
    backupArtifacts: [],
    backupIds: [],
    configDigest: null,
    evidenceIds: [],
    exportArtifacts: [],
    exports: [],
    filesChanged: [],
    remainingStoreGeneration: agentFixtureStore.storeGeneration,
    removalReason: null,
    removedCount: null,
    removedRefs: [],
  },
  executionState: "planned",
  id: "fixture:operation-receipt",
  idempotencyKey: "fixture:idempotency-key",
  planDigest: agentFixtureOperationPlan.planDigest,
  planId: agentFixtureOperationPlan.id,
  recovery: "none",
  resources: {
    bytesRead: null,
    elapsedMs: null,
    recordsDecoded: null,
    requests: null,
    retries: null,
  },
  resultingBasisId: null,
  revision: 0,
  schemaVersion: OPERATION_SCHEMA_VERSION,
  startedAt: null,
  steps: [],
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  verificationRefs: [],
  verificationState: "not-attempted",
});

export const agentFixtureOperationRecovery = OperationOutputSchema.make({
  action: "get",
  receipt: agentFixtureOperationReceipt,
  reviewedPlan: agentFixtureOperationPlan,
  reviewedPlanUnavailableReason: null,
});

export const agentFixtureOperationRecoveryUnavailable =
  OperationOutputSchema.make({
    action: "get",
    receipt: agentFixtureOperationReceipt,
    reviewedPlan: null,
    reviewedPlanUnavailableReason:
      "Compile-only fixture retained receipt has no reviewed plan",
  });

export const agentFixtureQuery = AgentQueryInputSchema.make({
  agent: {
    basisId: agentFixtureBasis.id,
    budget: agentFixtureBudget,
    detail: "summary",
    policies: agentFixturePolicies,
    previousBasisId: agentFixturePreviousBasis.id,
    profileVersion: AGENT_PROFILE_VERSION,
  },
  capability: "dx_evidence",
  refs: [
    agentFixtureAmbiguousRef,
    agentFixtureMissingRef,
    agentFixtureStaleRef,
  ],
  selectors: { origin: ["fixture"] },
});

export const agentFixtureCompleteness = AgentCompletenessSchema.make({
  aggregation: "partial",
  items: "complete",
  missingRefs: 2,
  omittedItems: 0,
  omittedSeries: 0,
  reason:
    "Fixture references include missing evidence and a stale store generation",
  series: "not-requested",
});

export const agentFixtureView = AgentViewSchema.make({
  disclosures: [
    "Compile-only fixture response; no query ran and no resource measurement exists",
  ],
  items: [
    {
      accountAssociation: "ambiguous",
      eventId: agentFixtureAmbiguousEvent.eventId,
      origin: "fixture",
    },
  ],
  nextCursor: null,
  nextSeriesCursor: null,
  series: [],
  summary: {
    accountAssociation: "ambiguous",
    charge: null,
    origin: "fixture",
    tokens: null,
  },
});

export const agentFixtureResult = AgentResultMetadataSchema.make({
  basisId: agentFixtureBasis.id,
  byteCount: Buffer.byteLength(JSON.stringify(agentFixtureView)),
  capability: agentFixtureQuery.capability,
  completeness: agentFixtureCompleteness,
  createdAt: agentFixtureWindow.resolvedAt,
  id: "fixture:query-result",
  itemCount: agentFixtureView.items.length,
  projectionVersion: "fixture:projection-v1",
  queryDigest: "fixture:query-digest",
  resultDigest: "fixture:result-digest",
  schemaVersion: AGENT_RESULT_VERSION,
  seriesCount: 0,
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
});

export const agentFixtureCursor = AgentCursorSchema.make({
  axis: "items",
  basisId: agentFixtureBasis.id,
  id: "fixture:items-cursor",
  kind: "output-page",
  position: 0,
  projectionVersion: agentFixtureResult.projectionVersion,
  queryDigest: agentFixtureResult.queryDigest,
  resultId: agentFixtureResult.id,
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  storeRevision: null,
});

export const agentFixtureResultPage = AgentResultPageSchema.make({
  decodedBytes: Buffer.byteLength(JSON.stringify(agentFixtureView)),
  factsExamined: agentFixtureBasis.retainedEvents.length,
  nextPosition: null,
  nextSeriesPosition: null,
  resolutions: [
    agentFixtureFoundResolution,
    agentFixtureMissingResolution,
    agentFixtureStaleResolution,
  ],
  view: agentFixtureView,
});

export const agentFixtureRetainedResult = AgentResultSchema.make({
  ...agentFixtureResult,
  orderedProjection: JSON.stringify(agentFixtureView),
  resolutions: [
    agentFixtureFoundResolution,
    agentFixtureMissingResolution,
    agentFixtureStaleResolution,
  ],
});

export const agentFixtureContext = AgentResponseContextSchema.make({
  basisId: agentFixtureBasis.id,
  completeness: agentFixtureCompleteness,
  coverage: [agentFixtureCoverage],
  effectivePolicies: agentFixturePolicies,
  effects: {
    acquisitionReceiptIds: [],
    basisWrites: 0,
    cacheWrites: 0,
    networkRequests: 0,
  },
  freshness: [
    {
      lastSuccess: null,
      observedAt: null,
      reason: "No acquisition was executed",
      source: "fixture:source",
    },
  ],
  id: "fixture:query-context",
  next: [agentFixtureAmbiguousRef],
  originMix: [{ count: 1, origin: "fixture" }],
  profileVersion: AGENT_PROFILE_VERSION,
  reproducibility: agentFixtureBasis.reproducibility,
  resources: {
    appliedLimits: agentFixtureBudget,
    continuation: null,
    decodedBytes: null,
    elapsedMs: null,
    factsExamined: null,
    limitReached: null,
    networkRequests: null,
    outputBytes: null,
  },
  resultDigest: agentFixtureResult.resultDigest,
  resultRef: AgentRefSchema.make({
    ...agentFixtureAmbiguousRef,
    id: agentFixtureResult.id,
    kind: "result",
    version: AGENT_RESULT_VERSION,
  }),
  revisions: {
    attribution: agentFixtureBasis.attributionVersion,
    config: agentFixtureBasis.configDigest,
    definitions: "fixture:definitions-v1",
    derivation: "fixture:derivation-v1",
    evidence: agentFixtureStore.revision,
    prices: "fixture:prices-v2",
  },
  schemaVersion: "dx.context.v1",
  scope: agentFixtureScope,
  storeGeneration: agentFixtureStore.storeGeneration,
  storeId: agentFixtureStore.storeId,
  window: agentFixtureWindow,
});

export const agentFixtureQueryOutput = AgentQueryOutputSchema.make({
  context: agentFixtureContext,
  difference: {
    changes: ["attribution", "prices"],
    comparable: true,
    currentBasisId: agentFixtureBasis.id,
    previousBasisId: agentFixturePreviousBasis.id,
    reasons: [
      "Only fixture interpretation versions differ; event and scope selection are unchanged",
    ],
  },
  resolutions: [
    agentFixtureFoundResolution,
    agentFixtureMissingResolution,
    agentFixtureStaleResolution,
  ],
  result: agentFixtureResult,
  view: agentFixtureView,
});

export const agentFixtureVocabulary = Schema.Struct({
  basis: AnalysisBasisSchema,
  basisMetadata: AnalysisBasisMetadataSchema,
  cursor: AgentCursorSchema,
  evaluation: EvaluationSchema,
  investigation: InvestigationSchema,
  investigationEvaluation: EvaluationSchema,
  lesson: LessonSchema,
  operationDescriptor: OperationDescriptorSchema,
  operationPlan: OperationPlanSchema,
  operationReceipt: OperationReceiptSchema,
  origin: Schema.Literal("fixture"),
  previousBasis: AnalysisBasisSchema,
  query: AgentQueryInputSchema,
  queryOutput: AgentQueryOutputSchema,
  resultPage: AgentResultPageSchema,
  retainedResult: AgentResultSchema,
}).make({
  basis: agentFixtureBasis,
  basisMetadata: agentFixtureBasisMetadata,
  cursor: agentFixtureCursor,
  evaluation: agentFixtureEvaluation,
  investigation: agentFixtureInvestigation,
  investigationEvaluation: agentFixtureInvestigationEvaluation,
  lesson: agentFixtureLesson,
  operationDescriptor: agentFixtureOperationDescriptor,
  operationPlan: agentFixtureOperationPlan,
  operationReceipt: agentFixtureOperationReceipt,
  origin: "fixture",
  previousBasis: agentFixturePreviousBasis,
  query: agentFixtureQuery,
  queryOutput: agentFixtureQueryOutput,
  resultPage: agentFixtureResultPage,
  retainedResult: agentFixtureRetainedResult,
});
