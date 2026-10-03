// @effect-diagnostics-next-line nodeBuiltinImport:off -- Content-addressed bases use synchronous SHA256 over canonical retained inputs.
import { createHash } from "node:crypto";

import { DateTime, Effect, Option, Predicate, Schema } from "effect";

import type { AgentEventPage } from "../../contracts/agent-store.js";
import {
  AGENT_CONTRACT_DIGEST,
  AGENT_CONTRACT_VERSION,
} from "../../contracts/agent-version.js";
import { AgentError } from "../../contracts/error-agent.js";
import type { DxMetric } from "../../contracts/services.js";
import { parseSince } from "../../history/compute.js";
import type { CostOptions } from "../../metrics/cost/metric.js";
import { priceBookOf } from "../../metrics/cost/price-book/book.js";
import { PriceSheetSchema } from "../../metrics/cost/price-book/sheet.js";
import { PriceTableSchema } from "../../metrics/cost/price-table.js";
import type { AgentScope, StoreIdentity } from "../../model/agent-common.js";
import type {
  AgentQueryInput,
  AnalysisBasis,
} from "../../model/agent-query.js";
import {
  AGENT_RESULT_VERSION,
  ANALYSIS_BASIS_VERSION,
} from "../../model/agent-query.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { FlightIdSchema } from "../../model/ids.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import { AGENT_USAGE_DERIVATION_VERSION } from "../../usage/fact.js";
import { FILTER_DIMENSIONS } from "../../usage/query.js";
import { isTimeZone, zoneClock } from "../../usage/time.js";

export const AGENT_PROJECTION_VERSION = "dx.projection.v1";

export const AGENT_ATTRIBUTION_VERSION = "recorded-context.v1";

export const agentFailure = (
  code: AgentError["code"],
  message: string
): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: {
      action:
        code === "budget-exhausted" || code === "view-not-ready"
          ? "refresh-view"
          : "select-scope",
      ref: null,
    },
    ref: null,
    retryable: false,
  });

const JsonValueSchema = Schema.Json;

const decodeJson = Schema.decodeUnknownSync(JsonValueSchema);

const orderedJson = (
  value: typeof JsonValueSchema.Type
): typeof JsonValueSchema.Type => {
  if (Array.isArray(value)) {
    return value.map(orderedJson);
  }

  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, orderedJson(decodeJson(item))])
    );
  }

  return value;
};

export const canonicalAgentJson = (value: Schema.Json): string =>
  JSON.stringify(orderedJson(decodeJson(value)));

export const agentDigest = (value: Schema.Json): string =>
  createHash("sha256").update(canonicalAgentJson(value)).digest("hex");

const VIEW_KEYS = [
  "since",
  "until",
  "tz",
  "groupBy",
  "sortBy",
  "metrics",
  "bucket",
  "stackBy",
  "limit",
  "sources",
  "flightId",
  "evidenceMode",
  "metric",
  "finding",
  "request",
];

const KEYS = new Set<string>([...FILTER_DIMENSIONS, ...VIEW_KEYS]);

const SINGLE_SELECTORS = [
  "repo",
  "branch",
  "worktree",
  "since",
  "until",
  "tz",
  "flightId",
];

const first = (input: AgentQueryInput, key: string): string | undefined =>
  input.selectors[key]?.[0];

export const normalizedAgentFilters = (
  input: AgentQueryInput
): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(
    FILTER_DIMENSIONS.flatMap((key) => {
      const values = input.selectors[key];

      if (values === undefined || values.length === 0) {
        return [];
      }

      const selected =
        key === "repo" || key === "branch"
          ? values.filter((value) => value !== "(all)")
          : values;

      return [[key, [...new Set(selected)].toSorted()]];
    })
  );

export interface AgentSelection {
  readonly scope: AgentScope;
  readonly window: AnalysisBasis["window"];
  readonly selector: SnapshotSelector;
  readonly filters: Readonly<Record<string, readonly string[]>>;
}

const resolveWindowPoint = Effect.fnUntraced(function* resolveWindowPoint(
  value: string | undefined,
  nowMs: number,
  timezone: string
) {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  const midnight = zoneClock(timezone).localMidnight(value);

  const parsed =
    midnight === null ? parseSince(value, nowMs) : { ms: midnight, ok: true };

  if (!parsed.ok) {
    return yield* agentFailure(
      "invalid-selector",
      "The absolute half-open query window is invalid."
    );
  }

  const point = DateTime.make(parsed.ms);

  if (Option.isNone(point)) {
    return yield* agentFailure(
      "invalid-selector",
      "The absolute half-open query window is invalid."
    );
  }

  return point.value;
});

const validateAgentSelectors = Effect.fnUntraced(
  function* validateAgentSelectors(input: AgentQueryInput) {
    for (const key of Object.keys(input.selectors)) {
      if (!KEYS.has(key)) {
        return yield* agentFailure(
          "invalid-selector",
          "Unsupported query selector."
        );
      }
    }

    if (
      SINGLE_SELECTORS.some((key) => (input.selectors[key]?.length ?? 0) > 1)
    ) {
      return yield* agentFailure(
        "invalid-selector",
        "Repository, branch, worktree and window selectors each accept one value."
      );
    }

    return input;
  }
);

const selectedBranches = (
  branch: string | undefined,
  defaultScope?: AgentScope
): AgentScope["branchSelection"] => {
  if (branch === "(all)") {
    return { branches: [], kind: "all" };
  }

  if (branch === undefined) {
    const inherited: AgentScope["branchSelection"] =
      defaultScope?.branchSelection ?? {
        branches: [],
        kind: "unresolved",
      };

    return {
      branches: [...new Set(inherited.branches)].toSorted(),
      kind: inherited.kind,
    };
  }

  return { branches: [branch], kind: "selected" };
};

const scopeForRepo = (
  input: AgentQueryInput,
  repo: string,
  ambient?: AgentScope
): AgentScope => ({
  branchSelection: selectedBranches(first(input, "branch"), ambient),
  flightId: first(input, "flightId") ?? ambient?.flightId ?? null,
  repoId: repo === "(all)" ? null : repo,
  resolution:
    first(input, "repo") === undefined
      ? "Omitted repository uses the resolved caller scope; no broader repository selection was granted."
      : "Repository selection is explicit; branch labels retain their recorded interpretation.",
  sources: [...new Set(input.selectors.sources ?? ambient?.sources)].toSorted(),
  tools: [...new Set(input.selectors.tool ?? ambient?.tools)].toSorted(),
  worktreeId: first(input, "worktree") ?? ambient?.worktreeId ?? null,
});

const resolveAgentScope = Effect.fnUntraced(function* resolveAgentScope(
  input: AgentQueryInput,
  defaultScope?: AgentScope
) {
  const repo = first(input, "repo") ?? defaultScope?.repoId;

  if (repo === undefined || repo === null) {
    return yield* agentFailure(
      "scope-denied",
      "Select a repository or provide a resolved default scope."
    );
  }

  const ambient =
    first(input, "repo") === undefined || repo === defaultScope?.repoId
      ? defaultScope
      : undefined;

  return scopeForRepo(input, repo, ambient);
});

const resolveAgentWindow = Effect.fnUntraced(function* resolveAgentWindow(
  input: AgentQueryInput,
  now: string
) {
  const timezone = first(input, "tz") ?? "UTC";

  if (!isTimeZone(timezone)) {
    return yield* agentFailure(
      "invalid-selector",
      "Select a supported IANA timezone."
    );
  }

  const instant = DateTime.make(now);

  if (Option.isNone(instant)) {
    return yield* agentFailure(
      "invalid-selector",
      "The query resolution timestamp is invalid."
    );
  }

  const nowMs = DateTime.toEpochMillis(instant.value);

  const since = yield* resolveWindowPoint(
    first(input, "since"),
    nowMs,
    timezone
  );

  const until =
    (yield* resolveWindowPoint(first(input, "until"), nowMs, timezone)) ??
    instant.value;

  if (
    since !== null &&
    DateTime.toEpochMillis(since) >= DateTime.toEpochMillis(until)
  ) {
    return yield* agentFailure(
      "invalid-selector",
      "The absolute half-open query window is invalid."
    );
  }

  return {
    resolvedAt: now,
    sinceInclusive: since === null ? null : DateTime.formatIso(since),
    timezone,
    untilExclusive: DateTime.formatIso(until),
  } satisfies AnalysisBasis["window"];
});

const resolvedAgentFilters = (
  input: AgentQueryInput,
  scope: AgentScope
): AgentSelection["filters"] => {
  const filters = {
    ...normalizedAgentFilters(input),
  };

  if (scope.repoId !== null) {
    filters.repo = [scope.repoId];
  }

  if (scope.branchSelection.branches.length > 0) {
    filters.branch = scope.branchSelection.branches;
  }

  if (scope.worktreeId !== null) {
    filters.worktree = [scope.worktreeId];
  }

  if (scope.tools.length > 0) {
    filters.tool = scope.tools;
  }

  return Object.fromEntries(
    Object.entries(filters).flatMap(([key, values]) =>
      values.length === 0 ? [] : [[key, [...new Set(values)].toSorted()]]
    )
  );
};

export const resolveAgentSelection = Effect.fn("resolveAgentSelection")(
  function* resolveAgentSelection(
    input: AgentQueryInput,
    now: string,
    defaultScope?: AgentScope
  ) {
    yield* validateAgentSelectors(input);
    const scope = yield* resolveAgentScope(input, defaultScope);
    const window = yield* resolveAgentWindow(input, now);
    const { branches } = scope.branchSelection;

    return {
      filters: resolvedAgentFilters(input, scope),
      scope,
      selector: {
        branch: branches.length === 1 ? (branches[0] ?? null) : null,
        flightId:
          scope.flightId === null ? null : FlightIdSchema.make(scope.flightId),
        from: window.sinceInclusive,
        repoCommonDir: scope.repoId,
        to: window.untilExclusive,
      },
      window,
    } satisfies AgentSelection;
  }
);

export const CapturedPricesSchema = Schema.Struct({
  rules: Schema.NullOr(Schema.String),
  sheets: Schema.Array(PriceSheetSchema),
  subscription: Schema.NullOr(
    Schema.Struct({
      amountUsd: Schema.Finite,
      basis: Schema.Literals(["requests", "tokens"]),
      periodFrom: Schema.String,
      periodTo: Schema.String,
      periodUsageTotal: Schema.NullOr(Schema.Finite),
      planId: Schema.String,
    })
  ),
  table: Schema.NullOr(PriceTableSchema),
});

export const InterpretationSchema = Schema.Struct({
  originalSelectors: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  prices: CapturedPricesSchema,
  selectionComplete: Schema.Boolean,
});

export const decodeInterpretation = Schema.decodeUnknownSync(
  Schema.fromJsonString(InterpretationSchema)
);

export const capturedCostOptions = (basis: AnalysisBasis): CostOptions => {
  const { prices } = decodeInterpretation(basis.interpretationInputs);

  return {
    priceBook:
      prices.rules === null
        ? null
        : { ...priceBookOf(prices.sheets, "memory"), rules: prices.rules },
    priceTable: prices.table,
    subscription: prices.subscription,
  };
};

export const normalizedAgentBasisFilters = (
  input: AgentQueryInput,
  selection: AgentSelection
): AnalysisBasis["normalizedFilters"] => {
  const intent = Object.fromEntries(
    ["since", "until"].flatMap((key) => {
      const values = input.selectors[key];

      return values === undefined ? [] : [[key, values]];
    })
  );

  return {
    ...selection.filters,
    ...intent,
    flightId:
      selection.scope.flightId === null ? [] : [selection.scope.flightId],
    sources: selection.scope.sources,
    tz: [selection.window.timezone],
  };
};

const capturedPriceEntry = (
  id: string,
  content: Schema.Json,
  effectiveFrom: string | null
): AnalysisBasis["priceSheets"][number] => ({
  content: canonicalAgentJson(content),
  contentHash: agentDigest(content),
  effectiveFrom,
  effectiveUntil: null,
  id,
});

const capturedPriceEntries = (
  prices: typeof CapturedPricesSchema.Type
): AnalysisBasis["priceSheets"] => {
  const entries = prices.sheets.map((sheet) =>
    capturedPriceEntry(`${sheet.id}@${sheet.version}`, decodeJson(sheet), null)
  );

  if (prices.table !== null) {
    const effectiveFrom = Option.match(
      DateTime.make(prices.table.effectiveFrom),
      {
        onNone: () => null,
        onSome: DateTime.formatIso,
      }
    );

    entries.push(
      capturedPriceEntry(
        `${prices.table.id}@${prices.table.version}:table`,
        decodeJson(prices.table),
        effectiveFrom
      )
    );
  }

  if (prices.rules !== null) {
    entries.push(capturedPriceEntry("price-rules", prices.rules, null));
  }

  return entries;
};

export const createAgentBasis = (
  input: AgentQueryInput,
  identity: StoreIdentity,
  selection: AgentSelection,
  page: AgentEventPage,
  now: string,
  metrics: readonly DxMetric[],
  descriptors: readonly ModuleDescriptor[],
  costOptions: CostOptions | null
): AnalysisBasis => {
  const prices = {
    rules: costOptions?.priceBook?.rules ?? null,
    sheets: costOptions?.priceBook?.sheets ?? [],
    subscription: costOptions?.subscription ?? null,
    table: costOptions?.priceTable ?? null,
  };

  const priceSheets = capturedPriceEntries(prices);
  const pricesJson = decodeJson(prices);

  const { events } = page;

  const originMix = [...new Set(events.map((event) => event.origin))]
    .toSorted()
    .map((origin) => ({
      count: events.filter((event) => event.origin === origin).length,
      origin,
    }));

  const body: Omit<AnalysisBasis, "id"> = {
    acquisitionReceiptIds: [],
    attributionVersion: AGENT_ATTRIBUTION_VERSION,
    configDigest: agentDigest(pricesJson),
    contractDigest: AGENT_CONTRACT_DIGEST,
    contractVersion: AGENT_CONTRACT_VERSION,
    coverage: page.coverage,
    createdAt: now,
    descriptors: descriptors.map((descriptor) => ({
      id: descriptor.id,
      version: descriptor.version,
    })),
    eventWatermark: page.eventWatermark,
    interpretationInputs: canonicalAgentJson({
      originalSelectors: input.selectors,
      prices: pricesJson,
      selectionComplete: page.complete,
    }),
    metricDefinitions: metrics.flatMap((metric) =>
      metric.definitions.map((definition) => ({
        id: definition.id,
        version: definition.version,
      }))
    ),
    normalizedFilters: normalizedAgentBasisFilters(input, selection),
    originMix,
    priceSheets,
    queryKey: agentDigest({
      filters: selection.filters,
      scope: selection.scope,
      window: selection.window,
    }),
    reconciliationVersion: AGENT_USAGE_DERIVATION_VERSION,
    reproducibility: "retained-inputs",
    retainedEvents: events,
    schemaVersion: ANALYSIS_BASIS_VERSION,
    scope: selection.scope,
    selectedEventDigest: agentDigest(decodeJson(events)),
    storeGeneration: identity.storeGeneration,
    storeId: identity.storeId,
    supportedResultVersions: [AGENT_RESULT_VERSION, AGENT_PROJECTION_VERSION],
    window: selection.window,
  };

  return {
    ...body,
    id: `basis_${agentDigest(decodeJson({ ...body, createdAt: null })).slice(0, 48)}`,
  };
};
