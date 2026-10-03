import { DateTime, Effect, Option, Schema } from "effect";

import { AgentStore } from "../../contracts/agent-store.js";
import type { AgentStoreFailure } from "../../contracts/agent-store.js";
import {
  AGENT_CONTRACT_DIGEST,
  AGENT_CONTRACT_VERSION,
} from "../../contracts/agent-version.js";
import { AgentError } from "../../contracts/error-agent.js";
import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { AgentRequestSchema } from "../../model/agent-common.js";
import type {
  AgentRequest,
  AgentScope,
  StoreIdentity,
} from "../../model/agent-common.js";
import type {
  AgentCoveragePage,
  AgentResponseContext,
  AnalysisBasisMetadata,
} from "../../model/agent-query.js";
import type { StatusReport } from "../../model/report.js";
import { agentUnavailable } from "./agent-query.js";
import type { DxHandlerDeps } from "./deps.js";

const unresolvedScope = (): AgentScope => ({
  branchSelection: { branches: [], kind: "unresolved" },
  flightId: null,
  repoId: null,
  resolution: "No repository scope was configured.",
  sources: [],
  tools: [],
  worktreeId: null,
});

const budgetFailure = (identity: StoreIdentity) =>
  new AgentError({
    code: "budget-exhausted",
    currentRevision: identity.revision,
    expectedRevision: null,
    message:
      "The budget cannot fit the mandatory status metadata, context or elapsed work.",
    recovery: { action: "retry", ref: null },
    ref: null,
    retryable: true,
  });

const coverageLimit = (
  request: AgentRequest,
  coverage: AgentCoveragePage
): AgentResponseContext["resources"]["limitReached"] => {
  if (coverage.omitted === 0) {
    return null;
  }

  if (coverage.coverage.length < coverage.factsExamined) {
    return "decoded-bytes";
  }

  const sourceLimit = Math.min(
    256,
    request.budget.maxItems,
    request.budget.maxFacts
  );

  if (coverage.factsExamined < sourceLimit) {
    return null;
  }

  return request.budget.maxFacts <= Math.min(256, request.budget.maxItems)
    ? "facts"
    : "items";
};

const orientationReason = (
  request: AgentRequest,
  retained: AnalysisBasisMetadata | null,
  coverage: AgentCoveragePage
) => {
  const basisReason =
    retained === null
      ? "Orientation reads bounded current metadata. No retained basis is available for this exact scope."
      : "The resume reference retains its original scope and window; it does not represent a newly requested query window.";

  const omissionReason =
    coverage.omitted === 0
      ? ""
      : ` ${coverage.omitted} source coverage records are omitted; their gaps are unavailable in this response. ${
          coverageLimit(request, coverage) === null
            ? "Resolve a narrower repository, branch, source or tool scope."
            : "Repeat status with larger metadata limits or a narrower source scope."
        } Status metadata has no continuation cursor.`;

  return `${basisReason}${omissionReason} SQLite startup physical I/O is unmeasured; decoded metadata work is reported.`;
};

const metadataContext = (
  request: AgentRequest,
  identity: StoreIdentity,
  scope: AgentScope,
  retained: AnalysisBasisMetadata | null,
  coverage: AgentCoveragePage,
  elapsedMs: number,
  now: string
): AgentResponseContext => ({
  basisId: retained?.id ?? null,
  completeness: {
    aggregation: coverage.omitted > 0 ? "partial" : "complete",
    items: "complete",
    missingRefs: 0,
    omittedItems: coverage.omitted,
    omittedSeries: 0,
    reason: orientationReason(request, retained, coverage),
    series: "not-requested",
  },
  coverage: coverage.coverage,
  effectivePolicies: request.policies,
  effects: {
    acquisitionReceiptIds: [],
    basisWrites: 0,
    cacheWrites: 0,
    networkRequests: 0,
  },
  freshness: coverage.coverage.map((source) => ({
    lastSuccess: null,
    observedAt: null,
    reason:
      source.gaps.length === 0
        ? "Source observation times are unavailable in cached coverage metadata."
        : source.gaps
            .map((gap) => gap.message)
            .join("; ")
            .slice(0, 4096),
    source: source.adapterId,
  })),
  id: `orientation:${identity.storeId}:${identity.storeGeneration}`,
  next:
    retained === null
      ? []
      : [
          {
            basisId: retained.id,
            id: retained.id,
            kind: "basis",
            storeGeneration: retained.storeGeneration,
            storeId: retained.storeId,
            version: retained.schemaVersion,
          },
        ],
  originMix: retained?.originMix ?? [],
  profileVersion: request.profileVersion,
  reproducibility: retained?.reproducibility ?? "none",
  resources: {
    appliedLimits: request.budget,
    continuation: null,
    decodedBytes: coverage.decodedBytes,
    elapsedMs,
    factsExamined: coverage.factsExamined,
    limitReached: coverageLimit(request, coverage),
    networkRequests: 0,
    outputBytes: 0,
  },
  resultDigest: null,
  resultRef: null,
  revisions: {
    attribution: retained?.attributionVersion ?? "not-read",
    config: retained?.configDigest ?? "not-read",
    definitions: retained?.contractDigest ?? AGENT_CONTRACT_DIGEST,
    derivation: "not-read",
    evidence: identity.revision,
    prices: retained === null ? "not-read" : "retained-basis-metadata",
  },
  schemaVersion: "dx.context.v1",
  scope,
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  window: retained?.window ?? {
    resolvedAt: now,
    sinceInclusive: null,
    timezone: "UTC",
    untilExclusive: now,
  },
});

const addOutputSize = (
  response: StatusReport & { readonly context: AgentResponseContext }
) => ({
  ...response,
  context: {
    ...response.context,
    resources: {
      ...response.context.resources,
      outputBytes: Buffer.byteLength(JSON.stringify(response)),
    },
  },
});

const measuredResponse = (
  base: StatusReport,
  context: AgentResponseContext
): StatusReport =>
  addOutputSize(addOutputSize(addOutputSize({ ...base, context })));

const fitResponse = (
  base: StatusReport,
  context: AgentResponseContext,
  request: AgentRequest
): StatusReport => {
  let descriptors = base.descriptors.slice(0, request.budget.maxItems);
  let response = measuredResponse({ ...base, descriptors }, context);

  while (
    (response.context?.resources.outputBytes ?? 0) >
      request.budget.maxOutputBytes &&
    descriptors.length > 0
  ) {
    descriptors = descriptors.slice(0, -1);

    response = measuredResponse(
      { ...base, descriptors },
      {
        ...context,
        completeness: {
          ...context.completeness,
          items: "truncated",
          omittedItems:
            context.completeness.omittedItems +
            base.descriptors.length -
            descriptors.length,
        },
        resources: { ...context.resources, limitReached: "output-bytes" },
      }
    );
  }

  if (
    descriptors.length < base.descriptors.length &&
    response.context?.resources.limitReached !== "output-bytes"
  ) {
    response = measuredResponse(
      { ...base, descriptors },
      {
        ...context,
        completeness: {
          ...context.completeness,
          items: "truncated",
          omittedItems:
            context.completeness.omittedItems +
            base.descriptors.length -
            descriptors.length,
        },
        resources: { ...context.resources, limitReached: "items" },
      }
    );
  }

  return response;
};

const readMetadata = (
  request: AgentRequest,
  scope: AgentScope,
  identity: StoreIdentity
) =>
  Effect.gen(function* cachedMetadata() {
    const store = yield* AgentStore;

    const header =
      request.basisId === undefined
        ? yield* store.readLatestBasisMetadataForScope(
            scope,
            request.budget.maxDecodedBytes
          )
        : yield* store.readBasisMetadata(
            {
              id: request.basisId,
              storeGeneration: identity.storeGeneration,
              storeId: identity.storeId,
            },
            request.budget.maxDecodedBytes
          );

    const retained = header.metadata;

    if (retained === null && header.factsExamined > 0) {
      return yield* budgetFailure(identity);
    }

    if (retained === null && request.basisId !== undefined) {
      return yield* new AgentError({
        code: "basis-not-found",
        currentRevision: identity.revision,
        expectedRevision: null,
        message: "The requested retained basis metadata is unavailable.",
        recovery: { action: "replan", ref: null },
        ref: null,
        retryable: false,
      });
    }

    if (retained !== null) {
      return {
        coverage: {
          coverage: retained.coverage,
          decodedBytes: header.decodedBytes,
          factsExamined: header.factsExamined,
          omitted: 0,
        },
        retained,
        scope: retained.scope,
      };
    }

    const coverage =
      scope.repoId === null && scope.branchSelection.kind !== "all"
        ? { coverage: [], decodedBytes: 0, factsExamined: 0, omitted: 0 }
        : yield* store.readCoverage(
            scope,
            Math.min(256, request.budget.maxItems, request.budget.maxFacts),
            request.budget.maxDecodedBytes
          );

    return { coverage, retained, scope };
  });

export const handleAgentStatus = (
  deps: DxHandlerDeps,
  base: StatusReport,
  input: AgentRequest,
  started: number
): Effect.Effect<StatusReport, AgentStoreFailure | InvalidInput> =>
  Effect.gen(function* agentStatus() {
    const request = yield* Schema.decodeUnknownEffect(AgentRequestSchema, {
      onExcessProperty: "error",
    })(input).pipe(
      Effect.mapError(
        () =>
          new InvalidInput({
            field: "agentQuery",
            message:
              "Unsupported or invalid agent profile, policies or budget.",
          })
      )
    );

    if (
      request.policies.acquisition !== "recorded-only" ||
      request.policies.prices === "refresh-selected"
    ) {
      return yield* agentUnavailable(
        "Status is a recorded metadata read. Select recorded-only acquisition and cached-only or pinned prices; source probes and refresh are explicit operations."
      );
    }

    const available = yield* Effect.serviceOption(AgentStore);

    if (Option.isNone(available)) {
      return yield* agentUnavailable(
        "The installed composition has no durable agent store."
      );
    }

    const identity = yield* available.value.identity;

    const scope =
      request.basisId === undefined
        ? (deps.resolveScope?.() ?? unresolvedScope())
        : unresolvedScope();

    const metadata = yield* readMetadata(request, scope, identity).pipe(
      Effect.provideService(AgentStore, available.value)
    );

    const now = yield* DateTime.now;
    const elapsedMs = DateTime.toEpochMillis(now) - started;

    const context = metadataContext(
      request,
      identity,
      metadata.scope,
      metadata.retained,
      metadata.coverage,
      elapsedMs,
      DateTime.formatIso(now)
    );

    const response = fitResponse(
      {
        ...base,
        contractDigest: AGENT_CONTRACT_DIGEST,
        contractVersion: AGENT_CONTRACT_VERSION,
      },
      context,
      request
    );

    const finished = yield* DateTime.now;
    const measuredContext = response.context ?? context;
    const finalElapsedMs = DateTime.toEpochMillis(finished) - started;

    const finalResponse = measuredResponse(response, {
      ...measuredContext,
      resources: {
        ...measuredContext.resources,
        elapsedMs: finalElapsedMs,
      },
    });

    if (
      (finalResponse.context?.resources.outputBytes ?? 0) >
        request.budget.maxOutputBytes ||
      finalElapsedMs > request.budget.maxElapsedMs
    ) {
      return yield* budgetFailure(identity);
    }

    return finalResponse;
  });
