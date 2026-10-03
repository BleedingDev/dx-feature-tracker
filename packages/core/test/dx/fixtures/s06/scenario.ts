import { Effect } from "effect";

import type { CostOptions } from "../../../../src/dx/metrics/cost/metric.js";
import type {
  AgentBudget,
  AgentReadPolicies,
  AgentRef,
  AgentScope,
  AgentWindow,
  StoreIdentity,
} from "../../../../src/dx/model/agent-common.js";
import type {
  Evaluation,
  Investigation,
  Lesson,
  LearningApplicability,
} from "../../../../src/dx/model/agent-learning.js";
import type { OperationBounds } from "../../../../src/dx/model/agent-operation.js";
import type { AgentQueryInput } from "../../../../src/dx/model/agent-query.js";
import { unknownTokens } from "../../../../src/dx/model/attribution.js";
import type { SourceCoverage } from "../../../../src/dx/model/coverage.js";
import type {
  DxEventEnvelope,
  EventBatch,
} from "../../../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../../../src/dx/model/event.js";
import { EventIdSchema } from "../../../../src/dx/model/ids.js";
import type {
  OperationAdapter,
  OperationEffectResult,
} from "../../../../src/dx/operations/ports.js";
import { operationStep } from "../../../../src/dx/operations/ports.js";

export const FIXTURE_ID = "s06-connected-agent-audit";

export const FIXTURE_TIME = "2026-10-02T10:00:00.000Z";

export const FIXTURE_REPO = "/fixture/s06/repo/.git";

export const FIXTURE_WORKTREE = "/fixture/s06/repo";

export const scope: AgentScope = {
  branchSelection: { branches: ["feature/audit"], kind: "selected" },
  flightId: null,
  repoId: FIXTURE_REPO,
  resolution: "Explicit labelled S06 fixture repository and branch",
  sources: [],
  tools: ["codex"],
  worktreeId: FIXTURE_WORKTREE,
};

export const window: AgentWindow = {
  resolvedAt: FIXTURE_TIME,
  sinceInclusive: "2026-10-01T00:00:00.000Z",
  timezone: "UTC",
  untilExclusive: "2026-10-03T00:00:00.000Z",
};

export const budget: AgentBudget = {
  maxDecodedBytes: 1_048_576,
  maxElapsedMs: 10_000,
  maxFacts: 100,
  maxItems: 20,
  maxNetworkRequests: 0,
  maxOutputBytes: 131_072,
  maxSeriesBuckets: 20,
  maxStacks: 10,
};

export const policies: AgentReadPolicies = {
  acquisition: "recorded-only",
  derivation: "bounded-refresh",
  learning: "hidden",
  prices: "cached-only",
};

export const operationBounds: OperationBounds = {
  maxBytes: 100_000,
  maxElapsedMs: 10_000,
  maxFiles: 2,
  maxRecords: 10,
  maxRequests: 0,
  maxRetries: 0,
};

export const coverage: SourceCoverage = {
  adapterId: "fixture.s06",
  expectedItems: null,
  gaps: [
    {
      code: "missing-source",
      message: "Fixture account source is intentionally unavailable",
    },
  ],
  observedItems: null,
  state: "partial",
  watermark: null,
  windowFrom: window.sinceInclusive,
  windowTo: window.untilExclusive,
};

export const fixtureEvent = (
  id: string,
  overrides: Partial<DxEventEnvelope> = {}
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: "fixture.s06",
  adapterVersion: "1-fixture",
  ai: {
    agentId: null,
    agentType: null,
    branchSource: "session-recorded",
    channel: "session-file",
    cwd: FIXTURE_WORKTREE,
    effort: null,
    effortSource: null,
    harness: "codex",
    harnessVersion: "1-fixture",
    model: "gpt-6",
    modelRaw: "gpt-6",
    parentSessionId: null,
    provider: "openai",
    sessionId: "fixture-session",
    via: null,
  },
  context: {
    ...emptyFlightContext,
    branch: "feature/audit",
    headSha: "fixture-head-a",
    repoCommonDir: FIXTURE_REPO,
    worktreePath: FIXTURE_WORKTREE,
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:s06:${id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    requestId: id,
    sessionId: "fixture-session",
  },
  kind: "ai.request",
  observedAt: FIXTURE_TIME,
  occurredAt: FIXTURE_TIME,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: { fixtureId: FIXTURE_ID },
  schemaVersion: "dx.event.v2",
  sourceVersion: "1-fixture",
  upstreamKey: id,
  usage: {
    premiumRequests: null,
    requestKey: id,
    serviceTier: null,
    speed: null,
    tokens: { ...unknownTokens, inputFresh: 100, output: 10 },
    toolFigure: null,
  },
  ...overrides,
});

export const batch = (events: readonly DxEventEnvelope[]): EventBatch => ({
  coverage: { ...coverage, observedItems: events.length },
  cursor: null,
  events,
});

export const ref = (
  identity: StoreIdentity,
  id: string,
  kind: AgentRef["kind"] = "event",
  basisId: string | null = null
): AgentRef => ({
  basisId,
  id,
  kind,
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  version: "1",
});

export const applicability: LearningApplicability = {
  coverageRequirements: [],
  metricDefinitions: [],
  scope,
  sourceVersions: [{ id: "fixture.s06", version: "1-fixture" }],
  toolVersions: [{ id: "codex", version: "1-fixture" }],
  widerScope: false,
  window,
  workflowConditions: ["Labelled fixture audit"],
};

export const lesson = (
  identity: StoreIdentity,
  id: string,
  supportingRefs: readonly AgentRef[] = []
): Lesson => ({
  ...identity,
  applicability,
  authorKind: "agent",
  claim:
    "Inspect request-level evidence before allocating the fixture account amount",
  claimKind: "hypothesis",
  contradictingRefs: [],
  createdAt: FIXTURE_TIME,
  criterion:
    "A recorded exact request key resolves the ambiguous fixture amount",
  id,
  invalidationConditions: ["Changed attribution or metric definition"],
  kind: "lesson",
  limitations: ["Fixture observations cannot support live conclusions"],
  previousRevision: null,
  revision: 0,
  schemaVersion: "dx.learning.v1",
  status: "proposed",
  supersededBy: null,
  supersedes: null,
  supportingRefs,
  updatedAt: FIXTURE_TIME,
});

export const evaluation = (
  identity: StoreIdentity,
  lessonId: string,
  id: string,
  evidenceRefs: readonly AgentRef[],
  conclusion: Evaluation["conclusion"]
): Evaluation => ({
  ...identity,
  authorKind: "agent",
  basisIds: [],
  comparabilityLimitations: ["Synthetic fixture only"],
  comparedWindows: [window],
  conclusion,
  coverage: [coverage],
  createdAt: FIXTURE_TIME,
  criterion:
    "A recorded exact request key resolves the ambiguous fixture amount",
  evidenceRefs,
  id,
  operationIds: [],
  originMix: [{ count: evidenceRefs.length, origin: "fixture" }],
  outcome: "The fixture retains competing attribution candidates",
  relation: "descriptive-association",
  schemaVersion: "dx.learning.v1",
  target: { id: lessonId, kind: "lesson", revision: 0 },
});

export const fixtureAdapter = (
  execute: OperationAdapter["execute"],
  validate: OperationAdapter["validate"] = () => Effect.succeed([]),
  steps = [operationStep("fixture-complete-record", "fixture.s06")]
): OperationAdapter => ({
  authorize: () => Effect.succeed(true),
  descriptor: {
    authorization: "existing-enrollment",
    cancellation: "between-records",
    effects: {
      destructive: false,
      networkDestinations: [],
      reads: ["fixture.s06"],
      writes: ["fixture-store"],
    },
    enabled: true,
    idempotency: "durable-key",
    kind: "collect",
    reason: null,
    requiredInputs: ["source"],
    version: "1-fixture",
  },
  execute,
  prepare: (input) =>
    Effect.succeed({
      arguments: input.arguments,
      consent: {
        reason: "Explicit fixture-only authorization",
        receiptIds: ["fixture-enrollment"],
        scopeDigest: "pending",
        state: "authorized",
      },
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: ["fixture.s06"],
        writes: ["fixture-store"],
      },
      expectedEvidenceImprovement:
        "Append selected labelled S06 fixture records",
      forecast: { bytes: null, cost: null, elapsedMs: null, requests: 0 },
      preconditions: [],
      resumeBoundary: "complete-record",
      stopCondition:
        "Complete the selected labelled fixture records within bounds",
    }),
  probe: () => Effect.succeed({ state: "absent" }),
  replay: "safe",
  steps: () => steps,
  validate,
});

export const investigation = (
  identity: StoreIdentity,
  id: string
): Investigation => ({
  ...identity,
  applicability,
  authorKind: "agent",
  comparedBasisIds: [],
  conclusion: null,
  createdAt: FIXTURE_TIME,
  id,
  inspectedRefs: [],
  kind: "investigation",
  limitations: ["Labelled S06 fixture investigation"],
  nextQueryRefs: [],
  observedResultRefs: [],
  operationIds: [],
  question: "Which evidence would resolve the fixture account allocation?",
  revision: 0,
  schemaVersion: "dx.learning.v1",
  startingBasisId: null,
  state: "open",
  updatedAt: FIXTURE_TIME,
});

export const query = (
  capability: AgentQueryInput["capability"],
  overrides: Partial<AgentQueryInput> = {}
): AgentQueryInput => ({
  agent: {
    budget,
    detail: "expanded",
    policies,
    profileVersion: "dx.agent.v1",
  },
  capability,
  selectors: {
    branch: ["feature/audit"],
    repo: [FIXTURE_REPO],
    since: ["2026-10-01"],
    tool: ["codex"],
    tz: ["UTC"],
    until: ["2026-10-03"],
    worktree: [FIXTURE_WORKTREE],
  },
  ...overrides,
});

export const prices = (version: string, rate: number): CostOptions => ({
  priceTable: {
    currency: "USD",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    id: "s06-fixture-price-table",
    models: { "gpt-6": { input: rate, output: rate } },
    source: "fixture:s06:prices",
    unit: "usd-per-million-tokens",
    version,
  },
  subscription: null,
});

export const committedFixtureStep = (id: string): OperationEffectResult => ({
  resources: {
    bytesRead: 200,
    elapsedMs: 1,
    recordsDecoded: 1,
    requests: 0,
    retries: 0,
  },
  step: {
    ...operationStep(id, "fixture.s06"),
    committedThrough: "fixture-record-1",
    inserted: 1,
    safeCursor: "fixture-record-1",
    state: "committed",
  },
});
