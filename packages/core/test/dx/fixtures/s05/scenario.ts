import { Effect } from "effect";

import type { EventStoreService } from "../../../../src/dx/contracts/services.js";
import type {
  AgentRef,
  AgentScope,
  AgentWindow,
  StoreIdentity,
} from "../../../../src/dx/model/agent-common.js";
import { AgentRequestSchema } from "../../../../src/dx/model/agent-common.js";
import type {
  Investigation,
  LearningApplicability,
  Lesson,
} from "../../../../src/dx/model/agent-learning.js";
import { LEARNING_SCHEMA_VERSION } from "../../../../src/dx/model/agent-learning.js";
import type { OperationBounds } from "../../../../src/dx/model/agent-operation.js";
import type { EventBatch } from "../../../../src/dx/model/event.js";
import { operationStep } from "../../../../src/dx/operations/ports.js";
import type { OperationAdapter } from "../../../../src/dx/operations/ports.js";
import { consumerEvent } from "../r00/consumer.js";

export const fixtureRepo = "/labelled-fixture/s05/repository";

export const fixtureScope: AgentScope = {
  branchSelection: { branches: ["fixture-main"], kind: "selected" },
  flightId: null,
  repoId: fixtureRepo,
  resolution: "Labelled S05 integration fixture; no live acquisition",
  sources: ["dx.harness.codex"],
  tools: ["codex"],
  worktreeId: fixtureRepo,
};

export const fixtureWindow: AgentWindow = {
  resolvedAt: "2026-10-02T12:00:00.000Z",
  sinceInclusive: "2026-10-02T00:00:00.000Z",
  timezone: "UTC",
  untilExclusive: "2026-10-03T00:00:00.000Z",
};

export const fixtureRequest = AgentRequestSchema.make({
  budget: {
    maxDecodedBytes: 1_048_576,
    maxElapsedMs: 5000,
    maxFacts: 1000,
    maxItems: 20,
    maxNetworkRequests: 0,
    maxOutputBytes: 131_072,
    maxSeriesBuckets: 32,
    maxStacks: 8,
  },
  detail: "expanded",
  policies: {
    acquisition: "recorded-only",
    derivation: "bounded-refresh",
    learning: "hidden",
    prices: "cached-only",
  },
  profileVersion: "dx.agent.v1",
});

export const fixtureBounds: OperationBounds = {
  maxBytes: 16_384,
  maxElapsedMs: 5000,
  maxFiles: 1,
  maxRecords: 1,
  maxRequests: 0,
  maxRetries: 0,
};

export const fixtureBatch = (id: string): EventBatch => {
  const event = consumerEvent(id);

  return {
    coverage: {
      adapterId: "dx.harness.codex",
      expectedItems: 1,
      gaps: [
        { code: "fixture-only", message: "Labelled fixture; no live source" },
      ],
      observedItems: 1,
      state: "partial",
      watermark: id,
      windowFrom: fixtureWindow.sinceInclusive,
      windowTo: fixtureWindow.untilExclusive,
    },
    cursor: null,
    events: [
      {
        ...event,
        ai: event.ai === null ? null : { ...event.ai, cwd: fixtureRepo },
        context: {
          ...event.context,
          branch: "fixture-main",
          repoCommonDir: fixtureRepo,
          worktreePath: fixtureRepo,
        },
      },
    ],
  };
};

export const fixtureRef = (
  identity: Pick<StoreIdentity, "storeId" | "storeGeneration">,
  id: string,
  kind: AgentRef["kind"],
  basisId: string | null = null
): AgentRef => ({
  basisId,
  id,
  kind,
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  version: kind === "operation" ? "dx.operation.v1" : "dx.event.v2",
});

export const fixtureApplicability = (): LearningApplicability => ({
  coverageRequirements: ["Labelled fixture only"],
  metricDefinitions: [],
  scope: fixtureScope,
  sourceVersions: [{ id: "dx.harness.codex", version: "labelled-fixture" }],
  toolVersions: [{ id: "codex", version: "labelled-fixture" }],
  widerScope: false,
  window: fixtureWindow,
  workflowConditions: ["S05 isolated integration fixture"],
});

export const fixtureInvestigation = (
  identity: StoreIdentity,
  basisId: string
): Investigation => ({
  applicability: fixtureApplicability(),
  authorKind: "agent",
  comparedBasisIds: [],
  conclusion: null,
  createdAt: fixtureWindow.resolvedAt,
  id: "fixture:s05:investigation",
  inspectedRefs: [
    fixtureRef(identity, "fixture:s05:missing", "evidence", basisId),
  ],
  kind: "investigation",
  limitations: ["Missing fixture evidence prevents an ownership conclusion"],
  nextQueryRefs: [],
  observedResultRefs: [],
  operationIds: [],
  question:
    "Which fixture observation supports the selected branch allocation?",
  revision: 0,
  schemaVersion: LEARNING_SCHEMA_VERSION,
  startingBasisId: basisId,
  state: "awaiting-evidence",
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  updatedAt: fixtureWindow.resolvedAt,
});

export const fixtureLesson = (
  identity: StoreIdentity,
  basisId: string
): Lesson => ({
  applicability: fixtureApplicability(),
  authorKind: "agent",
  claim:
    "Fixture hypothesis: inspect the request reference before allocating a charge",
  claimKind: "hypothesis",
  contradictingRefs: [],
  createdAt: fixtureWindow.resolvedAt,
  criterion: "A retained fixture reference identifies the allocation owner",
  id: "fixture:s05:lesson",
  invalidationConditions: [
    "A different fixture account claims the same reference",
  ],
  kind: "lesson",
  limitations: ["Fixture observations imply no live or causal savings"],
  previousRevision: null,
  revision: 0,
  schemaVersion: LEARNING_SCHEMA_VERSION,
  status: "proposed",
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  supersededBy: null,
  supersedes: null,
  supportingRefs: [
    fixtureRef(identity, "fixture:s05:missing", "evidence", basisId),
  ],
  updatedAt: fixtureWindow.resolvedAt,
});

export const fixtureCollectAdapter = (
  store: EventStoreService,
  onExecute: () => void
): OperationAdapter => ({
  authorize: (plan, input) =>
    Effect.succeed(
      plan.consent.state === "authorized" &&
        input.consentReceiptIds.includes("fixture:s05:enrollment")
    ),
  descriptor: {
    authorization: "existing-enrollment",
    cancellation: "between-records",
    effects: {
      destructive: false,
      networkDestinations: [],
      reads: ["fixture:s05:selected-input"],
      writes: ["fixture:s05:sqlite"],
    },
    enabled: true,
    idempotency: "durable-key",
    kind: "collect",
    reason: null,
    requiredInputs: ["Labelled fixture input"],
    version: "fixture:s05:v1",
  },
  execute: (plan, step) =>
    Effect.gen(function* collectFixture() {
      const batch = fixtureBatch("fixture:s05:collected");
      const appended = yield* store.append(batch);
      yield* Effect.sync(onExecute);

      return {
        effects: {
          backupArtifacts: [],
          backupIds: [],
          configDigest: null,
          evidenceIds: batch.events.map((event) => event.eventId),
          exportArtifacts: [],
          exports: [],
          filesChanged: [],
          remainingStoreGeneration: plan.storeGeneration,
          removalReason: null,
          removedCount: null,
          removedRefs: [],
        },
        resources: {
          bytesRead: Buffer.byteLength(JSON.stringify(batch)),
          elapsedMs: 0,
          recordsDecoded: 1,
          requests: 0,
          retries: 0,
        },
        step: {
          ...step,
          committedThrough: "fixture:s05:collected",
          duplicates: appended.duplicates,
          inserted: appended.inserted,
          safeCursor: "fixture:s05:complete-record",
          state: "committed" as const,
        },
        verificationRefs: [fixtureRef(plan, "fixture:s05:collected", "event")],
      };
    }),
  prepare: (input) =>
    Effect.succeed({
      arguments: input.arguments,
      consent: {
        reason: "Existing consent for this labelled fixture input only",
        receiptIds: ["fixture:s05:enrollment"],
        scopeDigest: "assigned-by-operation-service",
        state: "authorized",
      },
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: ["fixture:s05:selected-input"],
        writes: ["fixture:s05:sqlite"],
      },
      expectedEvidenceImprovement:
        "One selected fixture observation can be committed",
      forecast: { bytes: 16_384, cost: null, elapsedMs: null, requests: 0 },
      preconditions: [],
      resumeBoundary: "complete-record",
      stopCondition: "Stop after the single labelled fixture record",
    }),
  probe: () => Effect.succeed({ state: "absent" }),
  replay: "safe",
  steps: () => [operationStep("fixture:s05:collect-step", "dx.harness.codex")],
  validate: () => Effect.succeed([]),
});
