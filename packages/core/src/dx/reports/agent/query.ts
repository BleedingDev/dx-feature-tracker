import { DateTime, Effect, Schema } from "effect";

import type {
  AgentEventPage,
  AgentStoreFailure,
  AgentStoreService,
} from "../../contracts/agent-store.js";
import type { DxMetric } from "../../contracts/services.js";
import type { CostOptions } from "../../metrics/cost/metric.js";
import type {
  AgentHandle,
  AgentRefResolution,
  AgentScope,
  StoreIdentity,
} from "../../model/agent-common.js";
import { AGENT_RESULT_VERSION } from "../../model/agent-query.js";
import type {
  AgentBasisDifference,
  AgentCompleteness,
  AgentCursor,
  AgentQueryInput,
  AgentQueryOutput,
  AgentResult,
  AgentResultMetadata,
  AgentResultPage,
  AgentResultPageInput,
  AnalysisBasis,
  AnalysisBasisMetadata,
} from "../../model/agent-query.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { FlightIdSchema } from "../../model/ids.js";
import { AGENT_USAGE_DERIVATION_VERSION } from "../../usage/fact.js";
import { FILTER_DIMENSIONS, NONE_VALUE } from "../../usage/query.js";
import {
  AGENT_ATTRIBUTION_VERSION,
  AGENT_PROJECTION_VERSION,
  agentDigest,
  agentFailure,
  canonicalAgentJson,
  capturedCostOptions,
  createAgentBasis,
  decodeInterpretation,
  normalizedAgentBasisFilters,
  normalizedAgentFilters,
  resolveAgentSelection,
} from "./basis.js";
import type { AgentSelection } from "./basis.js";
import { compareAgentBases } from "./comparison.js";
import {
  buildAgentProjection,
  ProjectionSelectorsSchema,
} from "./projection.js";
import type { AgentProjection } from "./projection.js";
import { finishAgentResponse } from "./response.js";
import type { FinishAgentResponseArgs } from "./response.js";

export interface AgentQueryDependencies {
  readonly store: AgentStoreService;
  readonly metrics?: readonly DxMetric[];
  readonly descriptors?: readonly ModuleDescriptor[];
  readonly costOptions?: CostOptions | null;
  readonly defaultScope?: AgentScope;
  readonly now?: () => string;
}

interface QueryMeasurements {
  readonly factsExamined: number;
  readonly decodedBytes: number;
  readonly basisWrites: number;
  readonly cacheWrites: number;
}

interface QueryContext {
  readonly input: AgentQueryInput;
  readonly deps: AgentQueryDependencies;
  readonly identity: StoreIdentity;
  readonly queryDigest: string;
  readonly started: number;
  readonly now: string;
}

interface QueryBasis {
  readonly basis: AnalysisBasisMetadata;
  readonly fullBasis: AnalysisBasis | null;
  readonly result: AgentResultMetadata | null;
  readonly inputComplete: boolean;
  readonly measurements: QueryMeasurements;
}

interface QueryResult extends QueryBasis {
  readonly result: AgentResultMetadata;
  readonly projection: AgentProjection | null;
}

type QueryDecodedValue =
  | StoreIdentity
  | AgentCursor
  | AnalysisBasis
  | AnalysisBasisMetadata
  | AgentResultMetadata
  | readonly AgentRefResolution[];

const bytesOf = (value: QueryDecodedValue): number =>
  Buffer.byteLength(JSON.stringify(value), "utf-8");

const json = Schema.decodeUnknownSync(Schema.Json);

const semanticKeys = new Set([
  "groupBy",
  "sortBy",
  "metrics",
  "bucket",
  "stackBy",
  "limit",
  "evidenceMode",
  "metric",
  "finding",
  "request",
]);

const dimensionKeys = new Set<string>(FILTER_DIMENSIONS);

const sortedValues = (values: readonly string[]): string[] =>
  [...new Set(values)].toSorted();

export const agentViewQueryDigest = (input: AgentQueryInput): string =>
  agentDigest(
    json({
      capability: input.capability,
      refs: [...(input.refs ?? [])].toSorted((left, right) =>
        canonicalAgentJson(json(left)).localeCompare(
          canonicalAgentJson(json(right))
        )
      ),
      selectors: Object.fromEntries(
        Object.entries(input.selectors)
          .filter(([key]) => semanticKeys.has(key))
          .map(([key, values]) => [key, sortedValues(values)])
      ),
    })
  );

const handleOf = (identity: StoreIdentity, id: string): AgentHandle => ({
  id,
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
});

const metadataOf = (basis: AnalysisBasis): AnalysisBasisMetadata => {
  const { retainedEvents, interpretationInputs, priceSheets, ...metadata } =
    basis;

  return {
    ...metadata,
    interpretationBytes: Buffer.byteLength(interpretationInputs, "utf-8"),
    priceSheets: priceSheets.map(({ content: _content, ...sheet }) => sheet),
    retainedDecodedBytes: bytesOf(basis),
    retainedEventCount: retainedEvents.length,
  };
};

const resultMetadata = (result: AgentResult): AgentResultMetadata => {
  const {
    orderedProjection: _projection,
    resolutions: _resolutions,
    ...metadata
  } = result;

  return metadata;
};

const selectionOf = (basis: AnalysisBasisMetadata): AgentSelection => ({
  filters: Object.fromEntries(
    Object.entries(basis.normalizedFilters).filter(([key]) =>
      dimensionKeys.has(key)
    )
  ),
  scope: basis.scope,
  selector: {
    branch:
      basis.scope.branchSelection.branches.length === 1
        ? (basis.scope.branchSelection.branches[0] ?? null)
        : null,
    flightId:
      basis.scope.flightId === null
        ? null
        : FlightIdSchema.make(basis.scope.flightId),
    from: basis.window.sinceInclusive,
    repoCommonDir: basis.scope.repoId,
    to: basis.window.untilExclusive,
  },
  window: basis.window,
});

const measuredMetadata = (
  measurements: QueryMeasurements,
  value: QueryDecodedValue
): QueryMeasurements => ({
  ...measurements,
  decodedBytes: measurements.decodedBytes + bytesOf(value),
});

const measuredPage = (
  measurements: QueryMeasurements,
  page: Pick<AgentEventPage, "decodedBytes" | "factsExamined">
): QueryMeasurements => ({
  ...measurements,
  decodedBytes: measurements.decodedBytes + page.decodedBytes,
  factsExamined: measurements.factsExamined + page.factsExamined,
});

const eventMatchesScope = (
  event: DxEventEnvelope,
  scope: AgentScope
): boolean => {
  if (scope.repoId !== null && event.context.repoCommonDir !== scope.repoId) {
    return false;
  }

  if (
    scope.branchSelection.kind !== "all" &&
    scope.branchSelection.branches.length > 0 &&
    !scope.branchSelection.branches.includes(event.context.branch ?? NONE_VALUE)
  ) {
    return false;
  }

  if (
    scope.worktreeId !== null &&
    event.context.worktreePath !== scope.worktreeId
  ) {
    return false;
  }

  if (scope.flightId !== null && event.context.flightId !== scope.flightId) {
    return false;
  }

  if (
    scope.tools.length > 0 &&
    !scope.tools.includes(event.ai?.harness ?? NONE_VALUE)
  ) {
    return false;
  }

  return scope.sources.length === 0 || scope.sources.includes(event.adapterId);
};

const scopedEventPage = (
  page: AgentEventPage,
  scope: AgentScope
): AgentEventPage => ({
  ...page,
  coverage:
    scope.sources.length === 0
      ? page.coverage
      : page.coverage.filter((coverage) =>
          scope.sources.includes(coverage.adapterId)
        ),
  events: page.events.filter((event) => eventMatchesScope(event, scope)),
});

const checkBudget = Effect.fnUntraced(function* checkBudget(
  context: QueryContext,
  measurements: QueryMeasurements,
  additionalFacts = 0,
  additionalBytes = 0
): Effect.fn.Return<void, AgentStoreFailure> {
  const { budget } = context.input.agent;

  if (
    measurements.factsExamined + additionalFacts > budget.maxFacts ||
    measurements.decodedBytes + additionalBytes > budget.maxDecodedBytes ||
    performance.now() - context.started > budget.maxElapsedMs
  ) {
    return yield* agentFailure(
      "budget-exhausted",
      "The requested facts, decoded bytes or elapsed budget cannot contain this query work."
    );
  }

  return undefined;
});

const remainingMetadataBytes = Effect.fnUntraced(
  function* remainingMetadataBytes(
    context: QueryContext,
    measurements: QueryMeasurements
  ): Effect.fn.Return<number, AgentStoreFailure> {
    yield* checkBudget(context, measurements);

    if (measurements.factsExamined >= context.input.agent.budget.maxFacts) {
      return yield* agentFailure(
        "budget-exhausted",
        "The facts budget cannot contain another metadata record."
      );
    }

    const remaining =
      context.input.agent.budget.maxDecodedBytes - measurements.decodedBytes;

    if (remaining <= 0) {
      return yield* agentFailure(
        "budget-exhausted",
        "The decoded byte budget cannot contain another metadata record."
      );
    }

    return remaining;
  }
);

const readQueryBasisMetadata = Effect.fnUntraced(
  function* readQueryBasisMetadata(
    context: QueryContext,
    basisId: string,
    measurements: QueryMeasurements
  ): Effect.fn.Return<
    {
      readonly basis: AnalysisBasisMetadata;
      readonly measurements: QueryMeasurements;
    },
    AgentStoreFailure
  > {
    const maxDecodedBytes = yield* remainingMetadataBytes(
      context,
      measurements
    );

    const page = yield* context.deps.store.readBasisMetadata(
      handleOf(context.identity, basisId),
      maxDecodedBytes
    );

    const measured = measuredPage(measurements, page);
    yield* checkBudget(context, measured);

    if (page.metadata === null) {
      return yield* agentFailure(
        page.factsExamined > 0 ? "budget-exhausted" : "basis-not-found",
        page.factsExamined > 0
          ? "The basis metadata exceeds the remaining decoded byte budget."
          : "The requested analysis basis metadata is unavailable."
      );
    }

    return { basis: page.metadata, measurements: measured };
  }
);

const readQueryResultMetadata = Effect.fnUntraced(
  function* readQueryResultMetadata(
    context: QueryContext,
    basis: AnalysisBasisMetadata,
    cursor: AgentCursor | null,
    measurements: QueryMeasurements
  ): Effect.fn.Return<
    {
      readonly result: AgentResultMetadata | null;
      readonly measurements: QueryMeasurements;
    },
    AgentStoreFailure
  > {
    const maxDecodedBytes = yield* remainingMetadataBytes(
      context,
      measurements
    );

    const page =
      cursor?.kind === "work-continuation"
        ? yield* context.deps.store.readResultMetadata(
            handleOf(context.identity, cursor.resultId),
            maxDecodedBytes
          )
        : yield* context.deps.store.readMatchingResultMetadata(
            handleOf(context.identity, basis.id),
            context.input.capability,
            context.queryDigest,
            maxDecodedBytes
          );

    const measured = measuredPage(measurements, page);
    yield* checkBudget(context, measured);

    if (page.metadata === null && page.factsExamined > 0) {
      return yield* agentFailure(
        "budget-exhausted",
        "The result metadata exceeds the remaining decoded byte budget."
      );
    }

    return { measurements: measured, result: page.metadata };
  }
);

const validateQuery = Effect.fnUntraced(function* validateQuery(
  input: AgentQueryInput
): Effect.fn.Return<void, AgentStoreFailure> {
  if (input.capability === "dx_status") {
    return yield* agentFailure(
      "invalid-selector",
      "Status uses the cached orientation handler."
    );
  }

  if (
    input.agent.policies.acquisition !== "recorded-only" ||
    input.agent.policies.prices === "refresh-selected"
  ) {
    return yield* agentFailure(
      "source-unavailable",
      "Refresh requires a separately selected bounded acquisition or price operation."
    );
  }

  if (
    input.agent.policies.prices === "pinned" &&
    input.agent.basisId === undefined &&
    input.cursor === undefined
  ) {
    return yield* agentFailure(
      "invalid-selector",
      "Pinned prices require a retained basis or one of its cursors."
    );
  }

  yield* Schema.decodeUnknownEffect(ProjectionSelectorsSchema, {
    onExcessProperty: "error",
  })(input.selectors).pipe(
    Effect.mapError(() =>
      agentFailure("invalid-selector", "The query selectors are invalid.")
    )
  );

  return undefined;
});

const readQueryCursor = Effect.fnUntraced(function* readQueryCursor(
  context: QueryContext,
  measurements: QueryMeasurements
): Effect.fn.Return<
  {
    readonly cursor: AgentCursor | null;
    readonly measurements: QueryMeasurements;
  },
  AgentStoreFailure
> {
  const { input, identity, deps, queryDigest } = context;

  if (input.cursor === undefined) {
    return { cursor: null, measurements };
  }

  const maxDecodedBytes = yield* remainingMetadataBytes(context, measurements);

  const page = yield* deps.store.readCursor(
    handleOf(identity, input.cursor),
    maxDecodedBytes
  );

  const measured = measuredPage(measurements, page);
  yield* checkBudget(context, measured);

  const { cursor } = page;

  if (cursor === null) {
    return yield* agentFailure(
      page.factsExamined > 0 ? "budget-exhausted" : "expired-cursor",
      page.factsExamined > 0
        ? "The cursor exceeds the remaining decoded byte work budget."
        : "The requested cursor is unavailable or expired."
    );
  }

  if (
    cursor.queryDigest !== queryDigest ||
    cursor.projectionVersion !== AGENT_PROJECTION_VERSION ||
    (input.agent.basisId !== undefined &&
      input.agent.basisId !== cursor.basisId) ||
    (cursor.kind === "work-continuation") !== (cursor.axis === "work")
  ) {
    return yield* agentFailure(
      "cursor-mismatch",
      "The cursor belongs to another basis, capability or normalized view."
    );
  }

  return { cursor, measurements: measured };
});

const checkPinnedWindow = Effect.fnUntraced(function* checkPinnedWindow(
  input: AgentQueryInput,
  basis: AnalysisBasisMetadata
): Effect.fn.Return<void, AgentStoreFailure> {
  const resolved = {
    since:
      basis.window.sinceInclusive === null ? [] : [basis.window.sinceInclusive],
    until:
      basis.window.untilExclusive === null ? [] : [basis.window.untilExclusive],
  };

  for (const [key, values] of Object.entries(resolved)) {
    const supplied = input.selectors[key];

    if (
      supplied !== undefined &&
      agentDigest(supplied) !==
        agentDigest(basis.normalizedFilters[key] ?? []) &&
      agentDigest(supplied) !== agentDigest(values)
    ) {
      return yield* agentFailure(
        "basis-incompatible",
        "A pinned query cannot replace the original or resolved basis window."
      );
    }
  }

  return undefined;
});

const checkPinnedSelectors = Effect.fnUntraced(function* checkPinnedSelectors(
  input: AgentQueryInput,
  basis: AnalysisBasisMetadata
): Effect.fn.Return<void, AgentStoreFailure> {
  const filters = normalizedAgentFilters(input);

  for (const key of FILTER_DIMENSIONS) {
    const supplied = filters[key];
    const expectedFilter = basis.normalizedFilters[key] ?? [];

    const recordedRepoAlias =
      key === "repo" &&
      basis.scope.repoId !== null &&
      expectedFilter.length === 1 &&
      expectedFilter[0] === basis.scope.repoId &&
      supplied?.length === 1 &&
      supplied[0] === basis.scope.worktreeId;

    if (
      supplied !== undefined &&
      !recordedRepoAlias &&
      agentDigest(supplied) !== agentDigest(expectedFilter)
    ) {
      return yield* agentFailure(
        "basis-incompatible",
        "A pinned query cannot replace the basis filters or scope."
      );
    }
  }

  const expected = {
    flightId: basis.scope.flightId === null ? [] : [basis.scope.flightId],
    sources: basis.scope.sources,
    tz: [basis.window.timezone],
  };

  for (const [key, values] of Object.entries(expected)) {
    const supplied = input.selectors[key];

    if (
      supplied !== undefined &&
      agentDigest(sortedValues(supplied)) !== agentDigest(sortedValues(values))
    ) {
      return yield* agentFailure(
        "basis-incompatible",
        "A pinned query cannot replace the basis interpretation scope."
      );
    }
  }

  yield* checkPinnedWindow(input, basis);

  return undefined;
});

const checkReconstruction = Effect.fnUntraced(function* checkReconstruction(
  context: QueryContext,
  basis: AnalysisBasisMetadata,
  measurements: QueryMeasurements
): Effect.fn.Return<void, AgentStoreFailure> {
  const definitions = (context.deps.metrics ?? []).flatMap((metric) =>
    metric.definitions.map((definition) => ({
      id: definition.id,
      version: definition.version,
    }))
  );

  const descriptorMismatch = (context.deps.metrics ?? []).some((metric) => {
    const retained = basis.descriptors.find(
      (descriptor) => descriptor.id === metric.descriptor.id
    );

    return (
      retained !== undefined && retained.version !== metric.descriptor.version
    );
  });

  if (
    basis.attributionVersion !== AGENT_ATTRIBUTION_VERSION ||
    basis.reconciliationVersion !== AGENT_USAGE_DERIVATION_VERSION ||
    descriptorMismatch ||
    !basis.supportedResultVersions.includes(AGENT_PROJECTION_VERSION) ||
    agentDigest(definitions) !== agentDigest(basis.metricDefinitions)
  ) {
    return yield* agentFailure(
      "basis-incompatible",
      "Historical inputs cannot be interpreted by these metric, implementation, attribution or reconciliation versions; retained views remain available."
    );
  }

  yield* checkBudget(
    context,
    measurements,
    basis.retainedEventCount,
    basis.retainedDecodedBytes
  );

  return undefined;
});

const readRetainedInputs = Effect.fnUntraced(function* readRetainedInputs(
  context: QueryContext,
  basis: AnalysisBasisMetadata,
  measurements: QueryMeasurements
): Effect.fn.Return<QueryBasis, AgentStoreFailure> {
  yield* checkReconstruction(context, basis, measurements);

  const fullBasis = yield* context.deps.store.getBasis(
    handleOf(context.identity, basis.id)
  );

  const measured = {
    ...measuredMetadata(measurements, fullBasis),
    factsExamined: measurements.factsExamined + fullBasis.retainedEvents.length,
  };

  yield* checkBudget(context, measured);

  const interpretation = yield* Effect.try({
    catch: () =>
      agentFailure(
        "basis-incompatible",
        "The retained interpretation inputs are unavailable for this decoder."
      ),
    try: () => decodeInterpretation(fullBasis.interpretationInputs),
  });

  return {
    basis,
    fullBasis,
    inputComplete: interpretation.selectionComplete,
    measurements: measured,
    result: null,
  };
});

const createQueryBasis = Effect.fnUntraced(function* createQueryBasis(
  context: QueryContext,
  selection: AgentSelection,
  measurements: QueryMeasurements,
  prior: AnalysisBasis | null
): Effect.fn.Return<QueryBasis, AgentStoreFailure> {
  const { input, deps, identity } = context;
  const { budget } = input.agent;
  yield* checkBudget(context, measurements);
  const maxFacts = budget.maxFacts - measurements.factsExamined;
  const maxDecodedBytes = budget.maxDecodedBytes - measurements.decodedBytes;

  if (maxFacts <= 0 || maxDecodedBytes <= 0) {
    return yield* agentFailure(
      "budget-exhausted",
      "Increase the work budget to retain additional inputs at the saved watermark."
    );
  }

  const capturedInput = yield* Effect.try({
    catch: () =>
      agentFailure(
        "basis-incompatible",
        "The retained selector intent is unavailable for this decoder."
      ),
    try: () =>
      prior === null
        ? input
        : {
            ...input,
            selectors: decodeInterpretation(prior.interpretationInputs)
              .originalSelectors,
          },
  });

  const page = yield* deps.store.readEventPage({
    cursor: null,
    eventWatermark: prior?.eventWatermark ?? null,
    maxDecodedBytes,
    maxElapsedMs: Math.max(
      1,
      budget.maxElapsedMs - Math.floor(performance.now() - context.started)
    ),
    maxFacts,
    normalizedFilters: normalizedAgentBasisFilters(capturedInput, selection),
    scope: selection.scope,
    selector: selection.selector,
  });

  const measured = measuredPage(measurements, page);
  yield* checkBudget(context, measured);

  const fullBasis = yield* Effect.try({
    catch: () =>
      agentFailure(
        "invalid-selector",
        "The selected basis inputs are invalid."
      ),
    try: () =>
      createAgentBasis(
        capturedInput,
        identity,
        selection,
        scopedEventPage(page, selection.scope),
        prior?.window.resolvedAt ?? context.now,
        deps.metrics ?? [],
        deps.descriptors ?? [],
        prior === null ? (deps.costOptions ?? null) : capturedCostOptions(prior)
      ),
  });

  yield* deps.store.putBasis(fullBasis);

  return {
    basis: metadataOf(fullBasis),
    fullBasis,
    inputComplete: page.complete,
    measurements: { ...measured, basisWrites: measured.basisWrites + 1 },
    result: null,
  };
});

const checkCachedResult = Effect.fnUntraced(function* checkCachedResult(
  context: QueryContext,
  basis: AnalysisBasisMetadata,
  result: AgentResultMetadata,
  cursor: AgentCursor | null
): Effect.fn.Return<void, AgentStoreFailure> {
  if (
    result.schemaVersion !== AGENT_RESULT_VERSION ||
    result.projectionVersion !== AGENT_PROJECTION_VERSION ||
    !basis.supportedResultVersions.includes(result.projectionVersion) ||
    result.basisId !== basis.id ||
    result.capability !== context.input.capability ||
    result.queryDigest !== context.queryDigest
  ) {
    return yield* agentFailure(
      "basis-incompatible",
      "The retained view has no supported decoder for this query."
    );
  }

  if (
    cursor !== null &&
    (cursor.resultId !== result.id ||
      cursor.projectionVersion !== result.projectionVersion)
  ) {
    return yield* agentFailure(
      "cursor-mismatch",
      "The cursor does not belong to the retained result."
    );
  }

  return undefined;
});

const readPinnedBasis = Effect.fnUntraced(function* readPinnedBasis(
  context: QueryContext,
  basisId: string,
  cursor: AgentCursor | null,
  measurements: QueryMeasurements
): Effect.fn.Return<QueryBasis, AgentStoreFailure> {
  const { input } = context;

  const selected = yield* readQueryBasisMetadata(
    context,
    basisId,
    measurements
  );

  const { basis } = selected;
  const measured = selected.measurements;
  yield* checkPinnedSelectors(input, basis);

  if (cursor?.kind === "work-continuation") {
    if (input.agent.policies.derivation === "ready-only") {
      return yield* agentFailure(
        "view-not-ready",
        "A work continuation requires an explicit bounded-refresh derivation policy."
      );
    }

    const prior = yield* readQueryResultMetadata(
      context,
      basis,
      cursor,
      measured
    );

    const priorResult = prior.result;

    if (priorResult === null) {
      return yield* agentFailure(
        "basis-content-unavailable",
        "The work cursor's retained result metadata is unavailable."
      );
    }

    yield* checkCachedResult(context, basis, priorResult, cursor);

    if (priorResult.completeness.aggregation !== "partial") {
      return yield* agentFailure(
        "cursor-mismatch",
        "A work continuation must belong to a partial retained result."
      );
    }

    const retained = yield* readRetainedInputs(
      context,
      basis,
      prior.measurements
    );

    if (retained.fullBasis === null) {
      return yield* agentFailure(
        "basis-content-unavailable",
        "Work continuation requires the retained inputs."
      );
    }

    return yield* createQueryBasis(
      context,
      selectionOf(basis),
      retained.measurements,
      retained.fullBasis
    );
  }

  const retained = yield* readQueryResultMetadata(
    context,
    basis,
    cursor,
    measured
  );

  const { result } = retained;

  if (result !== null) {
    yield* checkCachedResult(context, basis, result, cursor);

    return {
      basis,
      fullBasis: null,
      inputComplete: result.completeness.aggregation === "complete",
      measurements: retained.measurements,
      result,
    };
  }

  if (input.agent.policies.derivation === "ready-only") {
    return yield* agentFailure(
      "view-not-ready",
      "This view was not retained for the basis; request bounded-refresh to reconstruct it."
    );
  }

  if (cursor !== null) {
    return yield* agentFailure(
      "cursor-mismatch",
      "The cursor's retained result is unavailable."
    );
  }

  return yield* readRetainedInputs(context, basis, retained.measurements);
});

const selectQueryBasis = Effect.fnUntraced(function* selectQueryBasis(
  context: QueryContext,
  cursor: AgentCursor | null,
  measurements: QueryMeasurements
): Effect.fn.Return<QueryBasis, AgentStoreFailure> {
  const basisId = cursor?.basisId ?? context.input.agent.basisId;

  if (basisId !== undefined) {
    return yield* readPinnedBasis(context, basisId, cursor, measurements);
  }

  if (context.input.agent.policies.derivation === "ready-only") {
    return yield* agentFailure(
      "view-not-ready",
      "Select a retained basis for ready-only reads, or request a bounded basis derivation."
    );
  }

  const selection = yield* resolveAgentSelection(
    context.input,
    context.now,
    context.deps.defaultScope
  );

  return yield* createQueryBasis(context, selection, measurements, null);
});

const aggregationSeriesState = (
  complete: boolean
): AgentCompleteness["series"] => (complete ? "complete" : "partial");

const completenessOf = (
  complete: boolean,
  resolutions: readonly AgentRefResolution[],
  series: boolean
): AgentCompleteness => ({
  aggregation: complete ? "complete" : "partial",
  items: "complete",
  missingRefs: resolutions.filter((resolution) => resolution.state !== "found")
    .length,
  omittedItems: 0,
  omittedSeries: 0,
  reason: complete
    ? null
    : "The input work budget stopped selection. Totals cover only the retained subset. A work continuation restarts this same watermark and window with the next requested budget.",
  series: series ? aggregationSeriesState(complete) : "not-requested",
});

const deriveQueryResult = Effect.fnUntraced(function* deriveQueryResult(
  context: QueryContext,
  selected: QueryBasis
): Effect.fn.Return<QueryResult, AgentStoreFailure> {
  if (selected.result !== null) {
    return { ...selected, projection: null, result: selected.result };
  }

  const { fullBasis, basis } = selected;

  if (fullBasis === null) {
    return yield* agentFailure(
      "basis-content-unavailable",
      "No retained inputs are available for this basis."
    );
  }

  const projection = yield* Effect.try({
    catch: () =>
      agentFailure("invalid-selector", "The requested projection is invalid."),
    try: () =>
      buildAgentProjection(
        {
          ...context.input,
          agent: { ...context.input.agent, detail: "expanded" },
        },
        fullBasis,
        {
          costOptions: capturedCostOptions(fullBasis),
          metrics: context.deps.metrics ?? [],
        }
      ),
  });

  yield* checkBudget(context, selected.measurements);
  const orderedProjection = canonicalAgentJson(json(projection));
  const byteCount = Buffer.byteLength(orderedProjection, "utf-8");

  if (byteCount > 4_194_304) {
    return yield* agentFailure(
      "budget-exhausted",
      "The retained projection exceeds the content budget; select a smaller scope or window."
    );
  }

  const resultDigest = agentDigest(
    json({
      basisId: basis.id,
      capability: context.input.capability,
      complete: selected.inputComplete,
      projection,
      projectionVersion: AGENT_PROJECTION_VERSION,
      queryDigest: context.queryDigest,
    })
  );

  const stored: AgentResult = {
    basisId: basis.id,
    byteCount,
    capability: context.input.capability,
    completeness: completenessOf(
      selected.inputComplete,
      projection.resolutions,
      projection.series.length > 0
    ),
    createdAt: fullBasis.window.resolvedAt,
    id: `result_${resultDigest.slice(0, 48)}`,
    itemCount: projection.items.length,
    orderedProjection,
    projectionVersion: AGENT_PROJECTION_VERSION,
    queryDigest: context.queryDigest,
    resolutions: projection.resolutions,
    resultDigest,
    schemaVersion: AGENT_RESULT_VERSION,
    seriesCount: projection.series.length,
    storeGeneration: context.identity.storeGeneration,
    storeId: context.identity.storeId,
  };

  yield* context.deps.store.putResult(stored);

  return {
    ...selected,
    measurements: {
      ...selected.measurements,
      cacheWrites: selected.measurements.cacheWrites + 1,
    },
    projection,
    result: resultMetadata(stored),
  };
});

const localPage = (
  projection: AgentProjection,
  input: AgentQueryInput,
  position: number,
  seriesPosition: number
): AgentResultPage => {
  const itemEnd = Math.min(
    projection.items.length,
    position + input.agent.budget.maxItems
  );

  const seriesEnd = Math.min(
    projection.series.length,
    seriesPosition + input.agent.budget.maxSeriesBuckets
  );

  return {
    decodedBytes: 0,
    factsExamined: 0,
    nextPosition: itemEnd < projection.items.length ? itemEnd : null,
    nextSeriesPosition: seriesEnd < projection.series.length ? seriesEnd : null,
    resolutions: projection.resolutions,
    view: {
      disclosures: [...projection.disclosures],
      items: projection.items
        .slice(position, itemEnd)
        .map((item) => json(item)),
      nextCursor: null,
      nextSeriesCursor: null,
      series: projection.series
        .slice(seriesPosition, seriesEnd)
        .map((point) => json(point)),
      summary: json(projection.summary),
    },
  };
};

const readQueryPage = Effect.fnUntraced(function* readQueryPage(
  context: QueryContext,
  derived: QueryResult,
  position: number,
  seriesPosition: number,
  cursor: AgentCursor | null
): Effect.fn.Return<AgentResultPage, AgentStoreFailure> {
  const { projection } = derived;

  if (projection !== null) {
    return yield* Effect.try({
      catch: () =>
        agentFailure("invalid-selector", "The requested page is invalid."),
      try: () => localPage(projection, context.input, position, seriesPosition),
    });
  }

  const { budget } = context.input.agent;
  const maxFacts = budget.maxFacts - derived.measurements.factsExamined;

  const maxDecodedBytes =
    budget.maxDecodedBytes - derived.measurements.decodedBytes;

  yield* checkBudget(context, derived.measurements);

  if (maxFacts <= 0 || maxDecodedBytes <= 0) {
    return yield* agentFailure(
      "budget-exhausted",
      "The remaining facts or decoded byte work budget cannot contain a retained page."
    );
  }

  const pageInput: AgentResultPageInput = {
    maxDecodedBytes,
    maxElapsedMs: Math.max(
      1,
      budget.maxElapsedMs - Math.floor(performance.now() - context.started)
    ),
    maxFacts,
    maxItems: Math.min(budget.maxItems, maxFacts),
    maxSeriesBuckets: budget.maxSeriesBuckets,
    maxStacks: budget.maxStacks,
    position,
    seriesPosition,
  };

  if (cursor !== null && cursor.axis !== "work") {
    Object.assign(pageInput, { axis: cursor.axis });
  }

  return yield* context.deps.store.readResultPage(
    handleOf(context.identity, derived.result.id),
    pageInput
  );
});

const queryDifference = Effect.fnUntraced(function* queryDifference(
  context: QueryContext,
  basis: AnalysisBasisMetadata,
  measurements: QueryMeasurements
): Effect.fn.Return<
  {
    readonly difference: AgentBasisDifference | null;
    readonly measurements: QueryMeasurements;
  },
  AgentStoreFailure
> {
  const { previousBasisId } = context.input.agent;

  if (previousBasisId === undefined) {
    return { difference: null, measurements };
  }

  const previous = yield* readQueryBasisMetadata(
    context,
    previousBasisId,
    measurements
  );

  return {
    difference: compareAgentBases(previous.basis, basis),
    measurements: previous.measurements,
  };
});

export const runAgentQuery = Effect.fn("runAgentQuery")(function* runAgentQuery(
  input: AgentQueryInput,
  deps: AgentQueryDependencies
): Effect.fn.Return<AgentQueryOutput, AgentStoreFailure> {
  const started = performance.now();
  yield* validateQuery(input);
  const identity = yield* deps.store.identity;

  const now =
    deps.now === undefined
      ? DateTime.formatIso(yield* DateTime.now)
      : deps.now();

  const context: QueryContext = {
    deps,
    identity,
    input,
    now,
    queryDigest: agentViewQueryDigest(input),
    started,
  };

  const measurements: QueryMeasurements = {
    basisWrites: 0,
    cacheWrites: 0,
    decodedBytes: bytesOf(identity),
    factsExamined: 0,
  };

  const cursorRead = yield* readQueryCursor(context, measurements);
  const { cursor } = cursorRead;

  const selected = yield* selectQueryBasis(
    context,
    cursor,
    cursorRead.measurements
  );

  const derived = yield* deriveQueryResult(context, selected);
  const measured = derived.measurements;
  yield* checkBudget(context, measured);
  const positioned = { ...derived, measurements: measured };
  const itemPosition = cursor?.axis === "items" ? cursor.position : 0;
  const seriesPosition = cursor?.axis === "series" ? cursor.position : 0;

  const page = yield* readQueryPage(
    context,
    positioned,
    itemPosition,
    seriesPosition,
    cursor
  );

  const pageMeasurements = measuredPage(measured, page);
  yield* checkBudget(context, pageMeasurements);

  const { resolutions } = page;

  const compared = yield* queryDifference(
    context,
    derived.basis,
    pageMeasurements
  );

  const responseArgs: FinishAgentResponseArgs = {
    basis: derived.basis,
    difference: compared.difference,
    identity,
    input,
    itemPosition,
    measurements: { ...compared.measurements, started },
    page,
    resolutions,
    result: derived.result,
    retainedSeriesCount: derived.result.seriesCount,
    seriesPosition,
    store: deps.store,
  };

  if (cursor !== null) {
    Object.assign(responseArgs, { cursorAxis: cursor.axis });
  }

  return yield* finishAgentResponse(responseArgs);
});
