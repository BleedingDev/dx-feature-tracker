import { Effect } from "effect";

import type { AgentStoreService } from "../../../../src/dx/contracts/agent-store.js";
import { AgentError } from "../../../../src/dx/contracts/error-agent.js";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- The labelled fixture overrides the frozen compile-only storage port.
import { makeFakeAgentStore } from "../../../../src/dx/contracts/fake-agent-store.js";
import type {
  AgentRef,
  AgentRefResolution,
  AgentScope,
} from "../../../../src/dx/model/agent-common.js";
import type {
  Evaluation,
  Investigation,
  LearningApplicability,
  LearningRecord,
  Lesson,
} from "../../../../src/dx/model/agent-learning.js";
import type { AnalysisBasis } from "../../../../src/dx/model/agent-query.js";
import type { Origin } from "../../../../src/dx/model/common.js";

export const fixtureTime = "2026-10-02T12:00:00.000Z";

export const fixtureIdentity = {
  revision: "fixture-revision-1",
  storeGeneration: 1,
  storeId: "s04-labelled-fixture-store",
};

export const fixtureScope = (
  overrides: Partial<AgentScope> = {}
): AgentScope => ({
  branchSelection: { branches: ["fixture-main"], kind: "selected" },
  flightId: null,
  repoId: "fixture-repo",
  resolution: "Labelled fixture scope",
  sources: ["fixture-source"],
  tools: ["fixture-tool"],
  worktreeId: null,
  ...overrides,
});

export const fixtureApplicability = (
  overrides: Partial<LearningApplicability> = {}
): LearningApplicability => ({
  coverageRequirements: ["fixture-source"],
  metricDefinitions: [{ id: "fixture-token-count", version: "1" }],
  scope: fixtureScope(),
  sourceVersions: [{ id: "fixture-source", version: "1" }],
  toolVersions: [{ id: "fixture-tool", version: "1" }],
  widerScope: false,
  window: {
    resolvedAt: fixtureTime,
    sinceInclusive: "2026-10-01T00:00:00.000Z",
    timezone: "UTC",
    untilExclusive: fixtureTime,
  },
  workflowConditions: ["fixture-integration-test"],
  ...overrides,
});

export const fixtureRef = (
  id: string,
  kind: AgentRef["kind"] = "lesson",
  overrides: Partial<AgentRef> = {}
): AgentRef => ({
  basisId: kind === "basis" ? id : null,
  id,
  kind,
  storeGeneration: fixtureIdentity.storeGeneration,
  storeId: fixtureIdentity.storeId,
  version: kind === "basis" ? "dx.basis.v1" : "dx.learning.v1",
  ...overrides,
});

export const fixtureLesson = (
  id: string,
  overrides: Partial<Lesson> = {}
): Lesson => ({
  applicability: fixtureApplicability(),
  authorKind: "agent",
  claim: "The labelled fixture reports a repeated integration failure",
  claimKind: "descriptive",
  contradictingRefs: [],
  createdAt: fixtureTime,
  criterion: "The labelled fixture contains the integration failure",
  id,
  invalidationConditions: ["Metric definition changes"],
  kind: "lesson",
  limitations: ["Labelled fixture, no production observation"],
  previousRevision: null,
  revision: 0,
  schemaVersion: "dx.learning.v1",
  status: "proposed",
  storeGeneration: fixtureIdentity.storeGeneration,
  storeId: fixtureIdentity.storeId,
  supersededBy: null,
  supersedes: null,
  supportingRefs: [],
  updatedAt: fixtureTime,
  ...overrides,
});

export const fixtureInvestigation = (
  id: string,
  overrides: Partial<Investigation> = {}
): Investigation => ({
  applicability: fixtureApplicability(),
  authorKind: "agent",
  comparedBasisIds: [],
  conclusion: null,
  createdAt: fixtureTime,
  id,
  inspectedRefs: [fixtureRef("fixture-basis", "basis")],
  kind: "investigation",
  limitations: ["The fixture evidence is incomplete"],
  nextQueryRefs: [fixtureRef("fixture-basis", "basis")],
  observedResultRefs: [],
  operationIds: ["fixture-operation"],
  question: "Which labelled fixture failed the integration test?",
  revision: 0,
  schemaVersion: "dx.learning.v1",
  startingBasisId: "fixture-basis",
  state: "open",
  storeGeneration: fixtureIdentity.storeGeneration,
  storeId: fixtureIdentity.storeId,
  updatedAt: fixtureTime,
  ...overrides,
});

export const fixtureBasis = (
  id = "fixture-basis",
  origins: readonly Origin[] = ["fixture"]
): AnalysisBasis => ({
  acquisitionReceiptIds: [],
  attributionVersion: "fixture-attribution-1",
  configDigest: "fixture-config",
  contractDigest: "fixture-contract-digest",
  contractVersion: "fixture-contract-v1",
  coverage: [
    {
      adapterId: "fixture-source",
      expectedItems: 1,
      gaps: [],
      observedItems: 1,
      state: "complete",
      watermark: "fixture-events-1",
      windowFrom: "2026-10-01T00:00:00.000Z",
      windowTo: fixtureTime,
    },
  ],
  createdAt: fixtureTime,
  descriptors: [{ id: "fixture-source", version: "1" }],
  eventWatermark: "fixture-events-1",
  id,
  interpretationInputs: "{}",
  metricDefinitions: [{ id: "fixture-token-count", version: "1" }],
  normalizedFilters: {},
  originMix: origins.map((origin) => ({ count: 1, origin })),
  priceSheets: [],
  queryKey: "fixture-query",
  reconciliationVersion: "fixture-reconciliation-1",
  reproducibility: "retained-inputs",
  retainedEvents: [],
  schemaVersion: "dx.basis.v1",
  scope: fixtureScope(),
  selectedEventDigest: "fixture-event-digest",
  storeGeneration: fixtureIdentity.storeGeneration,
  storeId: fixtureIdentity.storeId,
  supportedResultVersions: ["dx.result.v1"],
  window: fixtureApplicability().window,
});

export const fixtureEvaluation = (
  id: string,
  record: LearningRecord,
  overrides: Partial<Evaluation> = {}
): Evaluation => ({
  authorKind: "agent",
  basisIds: ["fixture-basis"],
  comparabilityLimitations: ["Fixture result is descriptive"],
  comparedWindows: [fixtureApplicability().window],
  conclusion: "supports",
  coverage: fixtureBasis().coverage,
  createdAt: fixtureTime,
  criterion: record.kind === "lesson" ? record.criterion : record.question,
  evidenceRefs: [fixtureRef("fixture-basis", "basis")],
  id,
  operationIds: [],
  originMix: [{ count: 1, origin: "fixture" }],
  outcome: "The labelled fixture contains the integration failure",
  relation: "descriptive-association",
  schemaVersion: "dx.learning.v1",
  storeGeneration: fixtureIdentity.storeGeneration,
  storeId: fixtureIdentity.storeId,
  target: { id: record.id, kind: record.kind, revision: record.revision },
  ...overrides,
});

export const fixtureError = (code: AgentError["code"], message: string) =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "none", ref: null },
    ref: null,
    retryable: false,
  });

interface FixtureStoreOptions {
  readonly records?: readonly LearningRecord[];
  readonly evaluations?: readonly Evaluation[];
  readonly bases?: readonly AnalysisBasis[];
  readonly resolution?: ReadonlyMap<string, AgentRefResolution["state"]>;
}

export const makeLearningFixtureStore = (options: FixtureStoreOptions = {}) => {
  const records = new Map(
    (options.records ?? []).map((record) => [record.id, record])
  );

  const history: LearningRecord[] = [];
  const evaluations = [...(options.evaluations ?? [])];

  const bases = new Map(
    (options.bases ?? [fixtureBasis()]).map((basis) => [basis.id, basis])
  );

  const basisReads: string[] = [];

  const writes = new Map<string, { payload: string; record: LearningRecord }>();

  const appends = new Map<
    string,
    { payload: string; evaluation: Evaluation }
  >();

  const listLimits: number[] = [];
  const evaluationLimits: number[] = [];
  const resolutionScopes: (AgentScope | undefined)[] = [];
  const sideEffects: string[] = [];

  const write = Effect.fnUntraced(function* write(
    record: LearningRecord,
    expectedRevision: number | null,
    key: string
  ) {
    const payload = JSON.stringify({ expectedRevision, record });
    const existing = writes.get(key);

    if (existing !== undefined) {
      if (existing.payload !== payload) {
        return yield* fixtureError(
          "idempotency-conflict",
          "Fixture idempotency key already has another payload"
        );
      }

      return { record: existing.record, reused: true };
    }

    const current = records.get(record.id);

    if (
      (expectedRevision === null && current !== undefined) ||
      (expectedRevision !== null && current?.revision !== expectedRevision)
    ) {
      return yield* fixtureError(
        "revision-conflict",
        "Fixture revision check failed"
      );
    }

    if (current !== undefined) {
      history.push(current);
    }

    records.set(record.id, record);
    writes.set(key, { payload, record });

    return { record, reused: false };
  });

  const store: AgentStoreService = makeFakeAgentStore({
    appendEvaluation: Effect.fnUntraced(
      function* s04FixtureEffect1(evaluation, key) {
        const payload = JSON.stringify(evaluation);
        const existing = appends.get(key);

        if (existing) {
          if (existing.payload !== payload) {
            return yield* fixtureError(
              "idempotency-conflict",
              "Fixture evaluation key has another payload"
            );
          }

          return { evaluation: existing.evaluation, reused: true };
        }

        const record = records.get(evaluation.target.id);

        if (
          !record ||
          record.kind !== evaluation.target.kind ||
          record.revision !== evaluation.target.revision
        ) {
          return yield* fixtureError(
            "revision-conflict",
            "Fixture evaluation revision changed"
          );
        }

        evaluations.push(evaluation);
        appends.set(key, { evaluation, payload });

        return { evaluation, reused: false };
      }
    ),
    createLearning: (record, key) => write(record, null, key),
    getBasis: Effect.fnUntraced(function* s04FixtureEffect2(handle) {
      basisReads.push(handle.id);
      const basis = bases.get(handle.id);

      if (basis === undefined) {
        return yield* fixtureError("basis-not-found", "Fixture basis absent");
      }

      return basis;
    }),
    getEvaluation: Effect.fnUntraced(function* fixtureEvaluationById(handle) {
      const evaluation = evaluations.find((item) => item.id === handle.id);

      if (evaluation === undefined) {
        return yield* fixtureError(
          "learning-not-found",
          "Fixture evaluation absent"
        );
      }

      return evaluation;
    }),
    getLearning: Effect.fnUntraced(function* s04FixtureEffect3(handle) {
      const record = records.get(handle.id);

      if (record === undefined) {
        return yield* fixtureError(
          "learning-not-found",
          "Fixture record absent"
        );
      }

      return record;
    }),
    identity: Effect.succeed(fixtureIdentity),
    listEvaluations: (lesson, limit) =>
      Effect.sync(() => {
        evaluationLimits.push(limit);

        const selected = evaluations.filter(
          (evaluation) => evaluation.target.id === lesson.id
        );

        return {
          evaluations: selected.slice(-limit).toReversed(),
          omitted: Math.max(0, selected.length - limit),
        };
      }),
    listLearning: (filter) =>
      Effect.sync(() => {
        listLimits.push(filter.limit);

        const selected = [...records.values()].filter(
          (record) =>
            (filter.kinds.length === 0 || filter.kinds.includes(record.kind)) &&
            (filter.includeSuperseded ||
              record.kind !== "lesson" ||
              record.status !== "superseded")
        );

        const cursorIndex =
          filter.cursor === null
            ? 0
            : selected.findIndex((record) => record.id === filter.cursor) + 1;

        const page = selected.slice(cursorIndex, cursorIndex + filter.limit);

        return {
          excluded: records.size - selected.length,
          nextCursor:
            selected.length > cursorIndex + page.length
              ? (page.at(-1)?.id ?? null)
              : null,
          records: page,
        };
      }),
    readEventPage: () =>
      Effect.sync(() => {
        sideEffects.push("readEventPage");

        return {
          complete: true,
          coverage: [],
          decodedBytes: 0,
          eventWatermark: "fixture-events-1",
          events: [],
          factsExamined: 0,
          nextCursor: null,
        };
      }),
    resolveRefs: (refs, scope) =>
      Effect.sync(() => {
        resolutionScopes.push(scope);

        return refs.map((ref): AgentRefResolution => {
          if (ref.storeGeneration !== fixtureIdentity.storeGeneration) {
            return {
              reason: "Fixture generation changed",
              ref,
              state: "stale-generation",
            };
          }

          const state =
            options.resolution?.get(ref.id) ??
            (bases.has(ref.id) ||
            records.has(ref.id) ||
            evaluations.some((item) => item.id === ref.id)
              ? "found"
              : "missing-in-basis");

          return {
            reason: state === "found" ? null : "Fixture evidence inaccessible",
            ref,
            state,
          };
        });
      }),
    updateLearning: (record, revision, key) => write(record, revision, key),
  });

  return {
    bases,
    basisReads,
    evaluationLimits,
    evaluations,
    history,
    listLimits,
    records,
    resolutionScopes,
    sideEffects,
    store,
  };
};
