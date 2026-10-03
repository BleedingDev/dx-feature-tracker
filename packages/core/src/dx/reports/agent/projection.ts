import { Predicate, Result, Schema } from "effect";

import type { DxMetric, StoreSnapshot } from "../../contracts/services.js";
import { tokenCategoriesOf } from "../../metrics/ai-usage/typed.js";
import type { CostOptions } from "../../metrics/cost/metric.js";
import { computeCost, NO_COST_OPTIONS } from "../../metrics/cost/metric.js";
import { priceReading } from "../../metrics/cost/price-table.js";
import { extractReadings } from "../../metrics/cost/readings.js";
import {
  AgentRefResolutionSchema,
  AgentRefSchema,
} from "../../model/agent-common.js";
import type { AgentRef, AgentRefResolution } from "../../model/agent-common.js";
import type {
  AgentQueryInput,
  AnalysisBasis,
} from "../../model/agent-query.js";
import { ANALYSIS_BASIS_VERSION } from "../../model/agent-query.js";
import type { DxEventEnvelope } from "../../model/event.js";
import {
  EventIdSchema,
  FlightIdSchema,
  SnapshotIdSchema,
} from "../../model/ids.js";
import { deriveAgentUsageRows } from "../../usage/derive.js";
import { pricedRequestOf } from "../../usage/estimate.js";
import type { AgentDerivedUsageRows, UsageFact } from "../../usage/fact.js";
import {
  AGENT_USAGE_DERIVATION_VERSION,
  NO_REPO,
  USAGE_DERIVATION_VERSION,
} from "../../usage/fact.js";
import {
  DEFAULT_METRICS,
  FILTER_DIMENSIONS,
  USAGE_DIMENSIONS,
  USAGE_METRICS,
  dimensionValue,
  prepareFacts,
  queryUsage,
} from "../../usage/query.js";
import type { UsageFilters, UsageQuery } from "../../usage/query.js";
import { isTimeZone, zoneClock } from "../../usage/time.js";
import { composeAnalyzeReport } from "../analyze/compose.js";
import { redactText, truncate } from "../evidence/redact.js";
import { toEvidenceItem } from "../evidence/resolve.js";
import {
  buildTimeline,
  compareEvents,
  summarize,
} from "../explain/timeline.js";
import {
  AGENT_PROJECTION_VERSION,
  agentDigest,
  decodeInterpretation,
} from "./basis.js";

const ValuesSchema = Schema.Record(Schema.String, Schema.NullOr(Schema.Finite));

const RowSchema = Schema.Struct({
  facts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  key: Schema.String,
  values: ValuesSchema,
});

export const ProjectionItemSchema = Schema.Struct({
  conflicting: Schema.Array(AgentRefSchema),
  data: Schema.Json,
  ref: AgentRefSchema,
  supporting: Schema.Array(AgentRefSchema),
});

export type AgentProjectionItem = typeof ProjectionItemSchema.Type;

export const ProjectionSchema = Schema.Struct({
  disclosures: Schema.Array(Schema.String),
  items: Schema.Array(ProjectionItemSchema),
  resolutions: Schema.Array(AgentRefResolutionSchema),
  series: Schema.Array(
    Schema.Struct({
      bucket: Schema.String,
      stacks: Schema.Array(RowSchema),
      values: ValuesSchema,
    })
  ),
  summary: Schema.Json,
});

export type AgentProjection = typeof ProjectionSchema.Type;

export interface AgentProjectionDeps {
  readonly metrics?: readonly DxMetric[];
  readonly costOptions?: CostOptions | null;
}

const single = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).check(Schema.isLengthBetween(1, 1));

const strings = Schema.optional(Schema.Array(Schema.String));

const selectorFields = {
  agent: strings,
  attribution: strings,
  branch: strings,
  bucket: Schema.optional(single(Schema.Literals(["day", "week", "month"]))),
  channel: strings,
  effort: strings,
  evidenceMode: Schema.optional(
    single(Schema.Literals(["metadata", "hidden"]))
  ),
  finding: strings,
  flightId: Schema.optional(single(Schema.String)),
  groupBy: Schema.optional(single(Schema.Literals(USAGE_DIMENSIONS))),
  limit: Schema.optional(
    single(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ maximum: 500, minimum: 1 })
      )
    )
  ),
  metric: strings,
  metrics: Schema.optional(
    Schema.Array(Schema.Literals(USAGE_METRICS)).check(Schema.isMinLength(1))
  ),
  model: strings,
  parentSession: strings,
  provider: strings,
  repo: strings,
  request: strings,
  scope: Schema.optional(
    Schema.Array(Schema.Literals(["request", "account-bucket"]))
  ),
  session: strings,
  since: Schema.optional(single(Schema.String)),
  sortBy: Schema.optional(single(Schema.Literals(USAGE_METRICS))),
  sources: strings,
  stackBy: Schema.optional(single(Schema.Literals(USAGE_DIMENSIONS))),
  tool: strings,
  tz: Schema.optional(
    single(
      Schema.String.check(
        Schema.makeFilter(
          (value) => isTimeZone(value) || "Unsupported IANA timezone."
        )
      )
    )
  ),
  until: Schema.optional(single(Schema.String)),
  via: strings,
  worktree: strings,
};

export const ProjectionSelectorsSchema = Schema.Struct(selectorFields);

const decodeSelectors = Schema.decodeUnknownSync(ProjectionSelectorsSchema, {
  onExcessProperty: "error",
});

type ProjectionSelectors = typeof ProjectionSelectorsSchema.Type;

const text = (value: string): string =>
  truncate(redactText(value).text, 4096).text;

const jsonArray = Schema.is(Schema.Array(Schema.Json));

const redactJson = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) {
    return text(value);
  }

  if (jsonArray(value)) {
    return value.map(redactJson);
  }

  if (
    value === null ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [text(key), redactJson(child)])
  );
};

const json = Schema.decodeUnknownSync(Schema.Json);

const refOf = (
  basis: AnalysisBasis,
  kind: AgentRef["kind"],
  id: string,
  version = AGENT_PROJECTION_VERSION
): AgentRef => ({
  basisId: basis.id,
  id,
  kind,
  storeGeneration: basis.storeGeneration,
  storeId: basis.storeId,
  version,
});

const evidenceRefs = (
  basis: AnalysisBasis,
  ids: readonly string[]
): AgentRef[] =>
  [...new Set(ids)].map((id) => refOf(basis, "evidence", id, "dx.event.v2"));

const itemOf = (
  ref: AgentRef,
  data: Schema.Json,
  supporting: readonly AgentRef[] = [],
  conflicting: readonly AgentRef[] = []
): AgentProjectionItem => ({
  conflicting,
  data: redactJson(data),
  ref,
  supporting,
});

const snapshotOf = (basis: AnalysisBasis): StoreSnapshot => ({
  coverage: basis.coverage,
  events: basis.retainedEvents,
  manifest: {
    contractDigest: basis.contractDigest,
    contractVersion: basis.contractVersion,
    createdAt: basis.createdAt,
    enabledDescriptors: basis.descriptors,
    eventWatermark: basis.eventWatermark,
    metricDefinitions: basis.metricDefinitions,
    originMix: basis.originMix,
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
    snapshotId: SnapshotIdSchema.make(basis.id),
  },
});

const empty = (summary: Schema.Json): AgentProjection => ({
  disclosures: [],
  items: [],
  resolutions: [],
  series: [],
  summary: redactJson(summary),
});

const analyzeProjection = (
  basis: AnalysisBasis,
  selectors: ProjectionSelectors,
  deps: AgentProjectionDeps
): AgentProjection => {
  const snapshot = snapshotOf(basis);

  const report = composeAnalyzeReport(
    snapshot,
    (deps.metrics ?? []).map((metric) =>
      metric.descriptor.id === "dx.metric.cost"
        ? computeCost(snapshot, deps.costOptions ?? NO_COST_OPTIONS)
        : metric.compute(snapshot)
    )
  );

  const metrics = report.metrics.filter(
    (metric) =>
      selectors.metric === undefined ||
      selectors.metric.includes(metric.metricId)
  );

  const findings = report.findings.filter(
    (finding) =>
      selectors.finding === undefined ||
      selectors.finding.includes(finding.findingId)
  );

  const counts = new Map<string, number>();

  for (const metric of metrics) {
    const key = `${metric.metricId}:${metric.checkpoint ?? "all"}:${metric.definition.version}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const positions = new Map<string, number>();

  const metricItems = metrics.map((metric) => {
    const key = `${metric.metricId}:${metric.checkpoint ?? "all"}:${metric.definition.version}`;
    const position = positions.get(key) ?? 0;
    positions.set(key, position + 1);
    const id = (counts.get(key) ?? 0) > 1 ? `${key}:${position}` : key;

    return itemOf(
      refOf(basis, "metric", id, metric.definition.version),
      json({
        arithmetic: {
          denominator: metric.denominator,
          numerator: metric.numerator,
          unit: metric.unit,
          value: metric.value,
        },
        metric,
      }),
      evidenceRefs(basis, metric.evidenceIds)
    );
  });

  const linkedMetricItems = metricItems.map((item, index) => ({
    ...item,
    conflicting: metricItems
      .filter(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          metrics[candidateIndex]?.metricId === metrics[index]?.metricId &&
          metrics[candidateIndex]?.checkpoint === metrics[index]?.checkpoint &&
          candidate.ref.version === item.ref.version
      )
      .map((candidate) => candidate.ref),
  }));

  const findingItems = findings.map((finding) =>
    itemOf(refOf(basis, "finding", finding.findingId), json(finding), [
      ...evidenceRefs(basis, finding.evidenceIds),
      ...metricItems
        .filter((item) =>
          finding.metricIds.some((id) => item.ref.id.startsWith(`${id}:`))
        )
        .map((item) => item.ref),
    ])
  );

  return {
    ...empty(
      json({
        coverage: report.coverage,
        findingCount: findings.length,
        flightId: report.flightId,
        metricCount: metrics.length,
        schemaVersion: report.schemaVersion,
        snapshot: report.snapshot,
      })
    ),
    disclosures: report.notes.map(text),
    items: [...linkedMetricItems, ...findingItems],
  };
};

const filtersOf = (basis: AnalysisBasis): UsageFilters =>
  Object.fromEntries(
    FILTER_DIMENSIONS.flatMap((dimension) => {
      const values = basis.normalizedFilters[dimension];

      return values === undefined || values.length === 0
        ? []
        : [[dimension, values]];
    })
  );

const usageQueryOf = (
  basis: AnalysisBasis,
  selectors: ProjectionSelectors
): UsageQuery => {
  const metrics = [...new Set(selectors.metrics ?? DEFAULT_METRICS)];
  const sortBy = selectors.sortBy?.[0] ?? metrics[0] ?? "tokens";

  return {
    bucket: selectors.bucket?.[0] ?? "day",
    filters: filtersOf(basis),
    groupBy: selectors.groupBy?.[0] ?? null,
    limit: selectors.limit?.[0] ?? 10,
    metrics: metrics.includes(sortBy) ? metrics : [...metrics, sortBy],
    sinceMs:
      basis.window.sinceInclusive === null
        ? null
        : Date.parse(basis.window.sinceInclusive),
    sortBy,
    stackBy: selectors.stackBy?.[0] ?? "tool",
    untilMs: Date.parse(basis.window.untilExclusive),
  };
};

const tablePriceOf = (fact: UsageFact, table: CostOptions["priceTable"]) =>
  table === null
    ? null
    : priceReading(
        {
          adapterId: fact.harness ?? "unknown",
          branch: fact.branch,
          dedupeKey: fact.factId,
          eventId: fact.factId,
          model: fact.model ?? fact.modelRaw,
          occurredAt: fact.occurredAt,
          requests: fact.requests,
          sourceKind: null,
          tokens: Object.fromEntries(tokenCategoriesOf(fact.tokens)),
        },
        table
      );

const pricingOf = (fact: UsageFact, options: CostOptions | null) => {
  const book = options?.priceBook ?? null;
  const table = options?.priceTable ?? null;
  const estimate = book?.estimate(pricedRequestOf(fact)) ?? null;

  const useTable =
    estimate === null ||
    (estimate.kind === "no-price" && estimate.reason === "model-unpriced");

  const tableOutcome = useTable ? tablePriceOf(fact, table) : null;
  let usd: number | null = null;

  if (estimate?.kind === "priced") {
    ({ usd } = estimate);
  } else if (tableOutcome?.kind === "priced") {
    ({ usd } = tableOutcome);
  }

  return {
    billed: fact.billed,
    estimate,
    estimateUsd: usd,
    reason:
      estimate === null && tableOutcome === null
        ? "No retained price book or table selected."
        : null,
    rules: book?.rules ?? null,
    table:
      table === null
        ? null
        : {
            effectiveFrom: table.effectiveFrom,
            id: table.id,
            outcome: tableOutcome,
            version: table.version,
          },
    toolFigure: fact.toolFigure,
  };
};

const selectedFact = (fact: UsageFact, query: UsageQuery): boolean => {
  if (
    fact.occurredMs === null &&
    (query.sinceMs !== null || query.untilMs !== null)
  ) {
    return false;
  }

  if (
    fact.occurredMs !== null &&
    ((query.sinceMs !== null && fact.occurredMs < query.sinceMs) ||
      (query.untilMs !== null && fact.occurredMs >= query.untilMs))
  ) {
    return false;
  }

  return FILTER_DIMENSIONS.every((dimension) => {
    const wanted = query.filters[dimension];

    return (
      wanted === undefined ||
      wanted.length === 0 ||
      wanted.includes(dimensionValue(fact, dimension) ?? "(none)")
    );
  });
};

const SEMANTIC_DIMENSIONS = FILTER_DIMENSIONS.filter(
  (dimension) => !["repo", "branch", "worktree", "tool"].includes(dimension)
);

const hasSemanticFilters = (query: UsageQuery): boolean =>
  SEMANTIC_DIMENSIONS.some(
    (dimension) => (query.filters[dimension]?.length ?? 0) > 0
  );

const matchesSelection = (
  values: readonly string[],
  value: string | null,
  missing = "(none)"
): boolean => values.length === 0 || values.includes(value ?? missing);

const sourceScopeMatches = (
  event: DxEventEnvelope,
  basis: AnalysisBasis
): boolean => {
  const { scope } = basis;

  const scopeValues: readonly (readonly [
    readonly string[],
    string | null,
    string,
  ])[] = [
    [
      scope.repoId === null ? [] : [scope.repoId],
      event.context.repoCommonDir,
      NO_REPO,
    ],
    [scope.branchSelection.branches, event.context.branch, "(none)"],
    [
      scope.worktreeId === null ? [] : [scope.worktreeId],
      event.context.worktreePath,
      "(none)",
    ],
    [
      scope.flightId === null ? [] : [scope.flightId],
      event.context.flightId,
      "(none)",
    ],
    [scope.tools, event.ai?.harness ?? null, "(none)"],
    [scope.sources, event.adapterId, "(none)"],
    [basis.normalizedFilters.repo ?? [], event.context.repoCommonDir, NO_REPO],
    [basis.normalizedFilters.branch ?? [], event.context.branch, "(none)"],
    [
      basis.normalizedFilters.worktree ?? [],
      event.context.worktreePath,
      "(none)",
    ],
    [basis.normalizedFilters.tool ?? [], event.ai?.harness ?? null, "(none)"],
    [basis.normalizedFilters.sources ?? [], event.adapterId, "(none)"],
    [basis.normalizedFilters.flightId ?? [], event.context.flightId, "(none)"],
  ];

  return scopeValues.every(([values, value, missing]) =>
    matchesSelection(values, value, missing)
  );
};

const selectedUsageRows = (
  derived: AgentDerivedUsageRows,
  query: UsageQuery
): AgentDerivedUsageRows => {
  const rows = derived.derived.rows.filter(({ fact }) =>
    selectedFact(fact, query)
  );

  const factIds = new Set(rows.map(({ fact }) => fact.factId));
  const sourceIds = new Set(rows.flatMap((row) => row.sources));

  const allocated = derived.accountLedger.allocated.filter((allocation) =>
    factIds.has(allocation.turnFactId)
  );

  for (const allocation of allocated) {
    for (const id of allocation.accountEventIds) {
      sourceIds.add(id);
    }
  }

  const observed = derived.accountLedger.observed.filter((event) =>
    sourceIds.has(event.eventId)
  );

  const accountIds = new Set(observed.map((event) => event.eventId));

  const allocatedIds = new Set(
    allocated.flatMap((allocation) => allocation.accountEventIds)
  );

  const associations = derived.associations
    .filter((association) =>
      association.accountEventIds.some((id) =>
        accountIds.has(EventIdSchema.make(id))
      )
    )
    .map((association) => {
      const candidates = association.candidates.filter((candidate) =>
        factIds.has(candidate.turnFactId)
      );

      const selectedTurnFactId =
        association.selectedTurnFactId !== null &&
        factIds.has(association.selectedTurnFactId)
          ? association.selectedTurnFactId
          : null;

      return {
        ...association,
        candidates,
        reason:
          candidates.length === association.candidates.length
            ? association.reason
            : "Association candidates outside the normalized fact selection are withheld; unresolved or excluded associations remain in the selected account remainder.",
        selectedTurnFactId,
      };
    });

  return {
    accountLedger: {
      allocated,
      observed,
      remainder: observed.filter((event) => !allocatedIds.has(event.eventId)),
    },
    associations,
    derived: {
      disagreements: derived.derived.disagreements.filter((disagreement) =>
        factIds.has(disagreement.factId)
      ),
      rows,
      unresolved: hasSemanticFilters(query)
        ? derived.derived.unresolved.filter((id) => sourceIds.has(id))
        : derived.derived.unresolved,
    },
    explanations: derived.explanations.filter((explanation) =>
      factIds.has(explanation.factId)
    ),
  };
};

interface ProjectionSelection {
  readonly sourceBasis: AnalysisBasis;
  readonly semanticBasis: AnalysisBasis;
  readonly derived: AgentDerivedUsageRows | undefined;
}

const selectProjectionInputs = (
  input: AgentQueryInput,
  basis: AnalysisBasis,
  selectors: ProjectionSelectors
): ProjectionSelection => {
  const events = basis.retainedEvents.filter((event) =>
    sourceScopeMatches(event, basis)
  );

  const sourceBasis = {
    ...basis,
    coverage: basis.coverage.filter((coverage) =>
      matchesSelection(basis.scope.sources, coverage.adapterId)
    ),
    retainedEvents: events,
  };

  const query = usageQueryOf(sourceBasis, selectors);
  const semanticFilters = hasSemanticFilters(query);

  const needsUsage =
    input.capability === "dx_usage" ||
    input.refs?.some(
      (ref) =>
        ref.kind === "request" ||
        ref.kind === "attribution" ||
        ref.id.startsWith("usage:")
    ) === true;

  const derived =
    semanticFilters || needsUsage ? deriveAgentUsageRows(events) : undefined;

  if (!semanticFilters || derived === undefined) {
    return { derived, semanticBasis: sourceBasis, sourceBasis };
  }

  const selected = selectedUsageRows(derived, query);

  const selectedIds = new Set([
    ...selected.derived.rows.flatMap((row) => row.sources),
    ...selected.accountLedger.observed.map((event) => event.eventId),
  ]);

  return {
    derived,
    semanticBasis: {
      ...sourceBasis,
      retainedEvents: events.filter((event) => selectedIds.has(event.eventId)),
    },
    sourceBasis,
  };
};

const evidenceOf = (event: DxEventEnvelope, expanded: boolean) => {
  const item = toEvidenceItem(
    event.eventId,
    event,
    expanded ? "metadata" : "hidden"
  );

  const excerpt = item.excerpt === null ? null : redactText(item.excerpt);
  const reference = redactText(item.ref);

  return {
    ...item,
    excerpt: excerpt?.text ?? null,
    redacted: item.redacted || reference.redacted || excerpt?.redacted === true,
    ref: reference.text,
  };
};

const eventMetadata = (event: DxEventEnvelope, expanded: boolean) => ({
  eventId: event.eventId,
  evidence: evidenceOf(event, expanded),
  kind: event.kind,
  observedAt: event.observedAt,
  occurredAt: event.occurredAt,
  occurredAtPrecision: event.occurredAtPrecision,
  origin: event.origin,
  usage: event.usage,
});

const accountSummary = (events: readonly DxEventEnvelope[]) => ({
  eventCount: events.length,
  money: extractReadings(events).money.map((reading) => ({
    eventId: reading.eventId,
    ledger: reading.ledger,
    occurredAt: reading.occurredAt,
    sourceKind: reading.sourceKind,
    usd: reading.usd,
  })),
});

const usageItems = (
  basis: AnalysisBasis,
  selectors: ProjectionSelectors,
  derived: AgentDerivedUsageRows,
  query: UsageQuery,
  prices: ReadonlyMap<string, ReturnType<typeof pricingOf>>,
  expanded: boolean
): AgentProjectionItem[] => {
  const explanations = new Map(
    derived.explanations.map((explanation) => [explanation.factId, explanation])
  );

  const requestItems = derived.derived.rows
    .filter(
      ({ fact }) =>
        selectedFact(fact, query) &&
        (selectors.request === undefined ||
          selectors.request.includes(fact.factId))
    )
    .map(({ fact, sources }) => {
      const explanation = explanations.get(fact.factId);

      const conflicting =
        explanation?.fields
          .filter((field) => field.disagreement)
          .flatMap((field) =>
            field.candidates
              .filter((candidate) => candidate.eventId !== field.winnerEventId)
              .map((candidate) => candidate.eventId)
          ) ?? [];

      return itemOf(
        refOf(basis, "request", fact.factId, AGENT_USAGE_DERIVATION_VERSION),
        json({
          fact,
          pricing: prices.get(fact.factId) ?? null,
          reconciliation: expanded
            ? (explanation ?? null)
            : {
                fields:
                  explanation?.fields.map((field) => ({
                    disagreement: field.disagreement,
                    field: field.field,
                    rule: field.rule,
                    semantics: field.semantics,
                    winnerEventId: field.winnerEventId,
                  })) ?? [],
              },
        }),
        evidenceRefs(basis, sources),
        evidenceRefs(basis, conflicting)
      );
    });

  const associations = derived.associations.map((association) =>
    itemOf(
      refOf(
        basis,
        "attribution",
        `${association.accountFactId}:account`,
        basis.attributionVersion
      ),
      json(association),
      evidenceRefs(basis, [
        ...association.accountEventIds,
        ...association.candidates
          .filter((candidate) => candidate.selected)
          .flatMap((candidate) => candidate.eventIds),
      ]),
      evidenceRefs(
        basis,
        association.candidates
          .filter((candidate) => !candidate.selected)
          .flatMap((candidate) => candidate.eventIds)
      )
    )
  );

  const observed = derived.accountLedger.observed.map((event) =>
    itemOf(
      refOf(basis, "evidence", event.eventId, event.schemaVersion),
      json({ ledger: "observed-account", ...eventMetadata(event, expanded) }),
      evidenceRefs(basis, [event.eventId])
    )
  );

  const allocated = derived.accountLedger.allocated.map((allocation) =>
    itemOf(
      refOf(
        basis,
        "attribution",
        `allocation:${agentDigest({ accountEventIds: allocation.accountEventIds, turnFactId: allocation.turnFactId })}`,
        basis.attributionVersion
      ),
      json({ allocation, ledger: "allocated-account" }),
      evidenceRefs(basis, [
        ...allocation.accountEventIds,
        ...allocation.turnEventIds,
      ])
    )
  );

  const remainder = derived.accountLedger.remainder.map((event) =>
    itemOf(
      refOf(
        basis,
        "attribution",
        `remainder:${event.eventId}`,
        basis.attributionVersion
      ),
      json({ ledger: "account-remainder", ...eventMetadata(event, expanded) }),
      evidenceRefs(basis, [event.eventId])
    )
  );

  return [
    ...requestItems,
    ...associations,
    ...observed,
    ...allocated,
    ...remainder,
  ];
};

const usageProjection = (
  basis: AnalysisBasis,
  selectors: ProjectionSelectors,
  deps: AgentProjectionDeps,
  expanded: boolean,
  retainedDerived?: AgentDerivedUsageRows
): AgentProjection => {
  const allDerived =
    retainedDerived ?? deriveAgentUsageRows(basis.retainedEvents);

  const query = usageQueryOf(basis, selectors);
  const derived = selectedUsageRows(allDerived, query);
  const options = deps.costOptions ?? null;

  const prices = new Map(
    allDerived.derived.rows.map(({ fact }) => [
      fact.factId,
      pricingOf(fact, options),
    ])
  );

  const prepared = prepareFacts(
    allDerived.derived.rows.map(({ fact }) => fact),
    (fact) => prices.get(fact.factId)?.estimateUsd ?? null
  );

  const result = queryUsage(prepared, query, zoneClock(basis.window.timezone));

  const foreignMoney = derived.derived.rows.filter(({ fact }) =>
    [fact.billed, fact.toolFigure].some(
      (figure) => figure !== null && figure.currency.toUpperCase() !== "USD"
    )
  ).length;

  const allocatedIds = new Set(
    derived.accountLedger.allocated.flatMap(
      (allocation) => allocation.accountEventIds
    )
  );

  const groupItems = result.groups.map((row) =>
    itemOf(
      refOf(basis, "metric", `usage:group:${agentDigest(row.key)}`),
      json(row),
      [refOf(basis, "basis", basis.id, ANALYSIS_BASIS_VERSION)]
    )
  );

  const disclosures = [
    ...result.notes,
    "Billed charges, list-price estimates, tool figures and account allocations are separate ledgers and are never added together.",
    "Account allocations retain the source amount and association evidence; they do not create an observed per-request charge.",
    "Diagnostics and account ledgers follow the normalized fact selection; account observations linked only to excluded turns remain in the selected-view remainder.",
    ...(foreignMoney > 0
      ? [
          `${foreignMoney} non-USD money figure(s) excluded from USD aggregates.`,
        ]
      : []),
    ...(result.unpricedInWindow > 0
      ? [
          `${result.unpricedInWindow} matched request fact(s) have unavailable list-price estimates.`,
        ]
      : []),
    ...(derived.derived.unresolved.length > 0
      ? [
          `${derived.derived.unresolved.length} retained event(s) could not be reconciled.`,
        ]
      : []),
  ];

  return {
    disclosures: disclosures.map(text),
    items: [
      ...groupItems,
      ...usageItems(basis, selectors, derived, query, prices, expanded),
    ],
    resolutions: [],
    series: result.series,
    summary: json({
      accountBuckets: result.accountBuckets,
      accountLedger: {
        allocated: accountSummary(
          derived.accountLedger.observed.filter((event) =>
            allocatedIds.has(event.eventId)
          )
        ),
        observed: accountSummary(derived.accountLedger.observed),
        remainder: accountSummary(derived.accountLedger.remainder),
      },
      bucket: query.bucket,
      coverage: basis.coverage,
      derivationVersion: AGENT_USAGE_DERIVATION_VERSION,
      disagreements: derived.derived.disagreements,
      groupBy: query.groupBy,
      legacyDerivationVersion: USAGE_DERIVATION_VERSION,
      matched: result.matched,
      metrics: query.metrics,
      other: result.other,
      pricing: {
        priceBook:
          options?.priceBook === null || options?.priceBook === undefined
            ? null
            : {
                label: options.priceBook.label,
                rules: options.priceBook.rules,
                sheets: basis.priceSheets.map((sheet) => ({
                  contentHash: sheet.contentHash,
                  effectiveFrom: sheet.effectiveFrom,
                  effectiveUntil: sheet.effectiveUntil,
                  id: sheet.id,
                })),
                warnings: options.priceBook.warnings,
              },
        priceTable: options?.priceTable ?? null,
      },
      stackBy: query.stackBy,
      total: result.total,
      unattributed: result.unattributed,
      unpricedInWindow: result.unpricedInWindow,
      unresolved: derived.derived.unresolved.length,
      window: basis.window,
      withoutTime: result.withoutTime,
    }),
  };
};

const explainProjection = (
  basis: AnalysisBasis,
  expanded: boolean
): AgentProjection => {
  const timeline = buildTimeline(snapshotOf(basis), {
    cursor: null,
    limit: 500,
  });

  if (Result.isFailure(timeline)) {
    throw timeline.failure;
  }

  const known = new Map(
    timeline.success.entries.map((entry) => [entry.eventId, entry])
  );

  const items = basis.retainedEvents.toSorted(compareEvents).map((event) => {
    const entry = known.get(event.eventId) ?? {
      eventId: event.eventId,
      evidenceIds: [event.eventId],
      kind: event.kind,
      lane: event.adapterId,
      occurredAt: event.occurredAt,
      occurredAtPrecision: event.occurredAtPrecision,
      orderingUncertain: true,
      origin: event.origin,
      summary: summarize(event),
    };

    return itemOf(
      refOf(basis, "event", event.eventId, event.schemaVersion),
      json({
        ...entry,
        evidence: evidenceOf(event, expanded),
        summary: text(entry.summary),
      }),
      evidenceRefs(basis, [event.eventId])
    );
  });

  return {
    ...empty(
      json({
        lanes: timeline.success.lanes.map(text),
        total: timeline.success.total,
      })
    ),
    disclosures: [
      "Timeline ordering uses recorded timestamps and source precision; proximity does not establish causation.",
      ...(items.length > 500
        ? [
            "Ordering uncertainty is conservative after the first 500 retained timeline entries.",
          ]
        : []),
      ...(items.some((item) =>
        Schema.is(
          Schema.Struct({
            evidence: Schema.Struct({ redacted: Schema.Literal(true) }),
          })
        )(item.data)
      )
        ? [
            "Evidence excerpts are redacted and bounded; raw event payloads are withheld.",
          ]
        : []),
    ],
    items,
  };
};

const requestedResolution = (
  basis: AnalysisBasis,
  ref: AgentRef
): AgentRefResolution | null => {
  if (ref.id.trim() === "" || ref.id.trim() !== ref.id) {
    return {
      reason:
        "Reference IDs must be nonempty and have no surrounding whitespace.",
      ref,
      state: "invalid",
    };
  }

  if (
    ref.storeId !== basis.storeId ||
    ref.storeGeneration !== basis.storeGeneration
  ) {
    return {
      reason: "The reference belongs to another store or generation.",
      ref,
      state: "stale-generation",
    };
  }

  if (ref.basisId !== null && ref.basisId !== basis.id) {
    return {
      reason: "The reference is bound to a different analysis basis.",
      ref,
      state: "invalid",
    };
  }

  return null;
};

interface RefProjectionResolution {
  readonly item: AgentProjectionItem | null;
  readonly resolution: AgentRefResolution;
}

const resolvedRef = (
  ref: AgentRef,
  state: AgentRefResolution["state"],
  reason: string | null,
  item: AgentProjectionItem | null = null
): RefProjectionResolution => ({ item, resolution: { reason, ref, state } });

const resolveEventRef = (
  basis: AnalysisBasis,
  ref: AgentRef,
  event: DxEventEnvelope | undefined,
  expanded: boolean
): RefProjectionResolution => {
  if (event === undefined) {
    return resolvedRef(
      ref,
      "missing-in-basis",
      "The retained basis contains no matching event or evidence hash."
    );
  }

  if (ref.version === event.schemaVersion) {
    return resolvedRef(
      ref,
      "found",
      null,
      itemOf(
        ref,
        json(eventMetadata(event, expanded)),
        evidenceRefs(basis, [event.eventId])
      )
    );
  }

  return resolvedRef(
    ref,
    "invalid",
    "The reference version does not match the retained event schema."
  );
};

const resolveBasisRef = (
  basis: AnalysisBasis,
  ref: AgentRef
): RefProjectionResolution => {
  if (ref.id !== basis.id) {
    return resolvedRef(
      ref,
      "missing-in-basis",
      "The requested basis is not this retained basis."
    );
  }

  if (ref.version === ANALYSIS_BASIS_VERSION) {
    return resolvedRef(
      ref,
      "found",
      null,
      itemOf(
        ref,
        json({
          coverage: basis.coverage,
          eventWatermark: basis.eventWatermark,
          originMix: basis.originMix,
          reproducibility: basis.reproducibility,
          scope: basis.scope,
          window: basis.window,
        })
      )
    );
  }

  return resolvedRef(ref, "invalid", "Unsupported analysis basis version.");
};

const resolveSemanticRef = (
  ref: AgentRef,
  item: AgentProjectionItem | undefined
): RefProjectionResolution => {
  if (item === undefined) {
    return resolvedRef(
      ref,
      "missing-in-basis",
      "The reference has no projection in the retained basis."
    );
  }

  if (item.ref.version === ref.version) {
    return resolvedRef(ref, "found", null, { ...item, ref });
  }

  return resolvedRef(
    ref,
    "invalid",
    "The reference version does not match the retained derivation."
  );
};

const resolveRequestedRef = (
  basis: AnalysisBasis,
  ref: AgentRef,
  events: ReadonlyMap<string, DxEventEnvelope>,
  semantic: ReadonlyMap<string, AgentProjectionItem>,
  expanded: boolean
): RefProjectionResolution => {
  const invalid = requestedResolution(basis, ref);

  if (invalid !== null) {
    return { item: null, resolution: invalid };
  }

  switch (ref.kind) {
    case "event":
    case "evidence": {
      return resolveEventRef(basis, ref, events.get(ref.id), expanded);
    }

    case "basis": {
      return resolveBasisRef(basis, ref);
    }

    case "metric":
    case "finding":
    case "request":
    case "attribution": {
      return resolveSemanticRef(ref, semantic.get(`${ref.kind}:${ref.id}`));
    }

    case "evaluation":
    case "investigation":
    case "lesson":
    case "operation":
    case "result": {
      return resolvedRef(
        ref,
        "withheld",
        "This reference requires a separate retained store record and is withheld from evidence-only projection."
      );
    }

    default: {
      return resolvedRef(ref, "invalid", "Unsupported reference kind.");
    }
  }
};

const evidenceProjection = (
  input: AgentQueryInput,
  selection: ProjectionSelection,
  selectors: ProjectionSelectors,
  deps: AgentProjectionDeps
): AgentProjection => {
  const basis = selection.semanticBasis;
  const hidden = selectors.evidenceMode?.[0] === "hidden";

  const expanded = input.agent.detail === "expanded" && !hidden;

  const items: AgentProjectionItem[] = [];
  const resolutions: AgentRefResolution[] = [];
  const refs = input.refs ?? [];
  const events = new Map<string, DxEventEnvelope>();

  for (const event of basis.retainedEvents) {
    if (event.evidence.hash !== null && !events.has(event.evidence.hash)) {
      events.set(event.evidence.hash, event);
    }
  }

  for (const event of basis.retainedEvents) {
    events.set(event.eventId, event);
  }

  const wantsAnalysis = refs.some(
    (ref) =>
      (ref.kind === "metric" && !ref.id.startsWith("usage:")) ||
      ref.kind === "finding"
  );

  const wantsUsage = refs.some(
    (ref) =>
      ref.kind === "request" ||
      ref.kind === "attribution" ||
      (ref.kind === "metric" && ref.id.startsWith("usage:"))
  );

  const lookupSelectors = {
    ...selectors,
    finding: undefined,
    metric: undefined,
    request: undefined,
  };

  const semantic = [
    ...(wantsAnalysis
      ? analyzeProjection(basis, lookupSelectors, deps).items
      : []),
    ...(wantsUsage
      ? usageProjection(
          selection.sourceBasis,
          lookupSelectors,
          deps,
          expanded,
          selection.derived
        ).items
      : []),
  ];

  const index = new Map(
    semantic.map((item) => [`${item.ref.kind}:${item.ref.id}`, item])
  );

  for (const ref of refs) {
    const resolved = resolveRequestedRef(basis, ref, events, index, expanded);

    if (hidden && resolved.resolution.state === "found") {
      resolutions.push({
        reason:
          "Evidence expansion is withheld by the explicit hidden evidence policy.",
        ref,
        state: "withheld",
      });
      continue;
    }

    if (resolved.item !== null) {
      items.push(resolved.item);
    }

    resolutions.push(resolved.resolution);
  }

  return {
    ...empty(json({ requested: refs.length, returned: items.length })),
    disclosures: [
      "Evidence returns bounded metadata and permitted redacted excerpts; raw event payloads are never returned.",
      ...(expanded
        ? []
        : [
            "Payload excerpts are withheld at the requested detail or evidence policy.",
          ]),
      ...(resolutions.some((resolution) => resolution.state !== "found")
        ? [
            "Every requested reference has an explicit resolution; unavailable references are not silently omitted.",
          ]
        : []),
    ],
    items,
    resolutions,
  };
};

export const buildAgentProjection = (
  input: AgentQueryInput,
  basis: AnalysisBasis,
  deps: AgentProjectionDeps = {}
): AgentProjection => {
  const selectors = decodeSelectors(input.selectors);
  const expanded = input.agent.detail === "expanded";
  const selection = selectProjectionInputs(input, basis, selectors);
  let projection: AgentProjection;

  switch (input.capability) {
    case "dx_analyze": {
      projection = analyzeProjection(selection.semanticBasis, selectors, deps);
      break;
    }

    case "dx_usage": {
      projection = usageProjection(
        selection.sourceBasis,
        selectors,
        deps,
        expanded,
        selection.derived
      );
      break;
    }

    case "dx_explain": {
      projection = explainProjection(selection.semanticBasis, expanded);
      break;
    }

    case "dx_evidence": {
      projection = evidenceProjection(input, selection, selectors, deps);
      break;
    }

    case "dx_status": {
      projection = empty(
        json({
          contractDigest: basis.contractDigest,
          contractVersion: basis.contractVersion,
          coverage: basis.coverage,
          descriptors: basis.descriptors,
          retainedEventCount: selection.semanticBasis.retainedEvents.length,
          scope: basis.scope,
          window: basis.window,
        })
      );
      break;
    }

    default: {
      projection = empty(
        json({ reason: "Unsupported query capability.", state: "unavailable" })
      );
    }
  }

  const aggregation = decodeInterpretation(basis.interpretationInputs)
    .selectionComplete
    ? "complete"
    : "partial";

  return Schema.decodeUnknownSync(ProjectionSchema)({
    ...projection,
    series: projection.series.map((point) => ({
      ...point,
      bucket: text(point.bucket),
      stacks: point.stacks.map((row) => ({ ...row, key: text(row.key) })),
    })),
    summary: redactJson({
      ...Schema.decodeUnknownSync(Schema.JsonObject)(projection.summary),
      aggregation,
    }),
  });
};
