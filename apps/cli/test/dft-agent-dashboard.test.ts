import { Buffer } from "node:buffer";

import { describe, expect, it } from "@effect/vitest";
import {
  AgentQueryOutputSchema,
  AgentRequestSchema,
  AgentResponseContextSchema,
  buildRegistry,
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
  EventStore,
  makeDxCapabilities,
  makeDxQueryCapabilities,
} from "@rat-stack/core/dx";
import type { AgentQueryInput } from "@rat-stack/core/dx";
import { Effect } from "effect";
import { vi } from "vitest";

import { readAgentDashboardQuery } from "../src/dft-agent-dashboard.js";
import { capabilityAt } from "../src/dft-session.js";

const request = AgentRequestSchema.make({
  budget: {
    maxDecodedBytes: 16_384,
    maxElapsedMs: 5000,
    maxFacts: 64,
    maxItems: 8,
    maxNetworkRequests: 0,
    maxOutputBytes: 8192,
    maxSeriesBuckets: 7,
    maxStacks: 2,
  },
  detail: "summary",
  policies: {
    acquisition: "recorded-only",
    derivation: "ready-only",
    learning: "hidden",
    prices: "cached-only",
  },
  profileVersion: "dx.agent.v1",
});

const context = AgentResponseContextSchema.make({
  basisId: "fixture:dashboard-basis",
  completeness: {
    aggregation: "partial",
    items: "truncated",
    missingRefs: 1,
    omittedItems: 2,
    omittedSeries: 0,
    reason: "Synthetic fixture evidence is incomplete.",
    series: "not-requested",
  },
  coverage: [],
  effectivePolicies: request.policies,
  effects: {
    acquisitionReceiptIds: [],
    basisWrites: 0,
    cacheWrites: 0,
    networkRequests: 0,
  },
  freshness: [],
  id: "fixture:dashboard-context",
  next: [],
  originMix: [{ count: 1, origin: "fixture" }],
  profileVersion: "dx.agent.v1",
  reproducibility: "retained-results-only",
  resources: {
    appliedLimits: request.budget,
    continuation: null,
    decodedBytes: null,
    elapsedMs: null,
    factsExamined: null,
    limitReached: "items",
    networkRequests: 0,
    outputBytes: null,
  },
  resultDigest: "fixture:dashboard-result-digest",
  resultRef: null,
  revisions: {
    attribution: "fixture:attribution",
    config: "fixture:config",
    definitions: "fixture:definitions",
    derivation: "fixture:derivation",
    evidence: "fixture:evidence",
    prices: "fixture:prices",
  },
  schemaVersion: "dx.context.v1",
  scope: {
    branchSelection: { branches: ["fixture:branch"], kind: "selected" },
    flightId: null,
    repoId: "fixture:repo",
    resolution: "Synthetic dashboard read fixture.",
    sources: [],
    tools: [],
    worktreeId: "fixture:worktree",
  },
  storeGeneration: 1,
  storeId: "fixture:dashboard-store",
  window: {
    resolvedAt: "2026-10-01T01:00:00.000Z",
    sinceInclusive: "2026-10-01T00:00:00.000Z",
    timezone: "UTC",
    untilExclusive: "2026-10-01T01:00:00.000Z",
  },
});

const output = AgentQueryOutputSchema.make({
  context,
  difference: null,
  resolutions: [],
  result: {
    basisId: "fixture:dashboard-basis",
    byteCount: 256,
    capability: "dx_analyze",
    completeness: context.completeness,
    createdAt: context.window.resolvedAt,
    id: "fixture:dashboard-result",
    itemCount: 1,
    projectionVersion: "fixture:projection",
    queryDigest: "fixture:query-digest",
    resultDigest: "fixture:dashboard-result-digest",
    schemaVersion: "dx.result.v1",
    seriesCount: 0,
    storeGeneration: context.storeGeneration,
    storeId: context.storeId,
  },
  view: {
    disclosures: ["Synthetic dashboard read fixture; tokens are unavailable."],
    items: [{ origin: "fixture", tokens: null }],
    nextCursor: "fixture:next-page",
    nextSeriesCursor: null,
    series: [],
    summary: { origin: "fixture", tokens: null },
  },
});

const storageAccess = Effect.die(
  new Error("The dashboard dispatcher accessed fixture storage.")
);

const unavailableStorage = EventStore.of({
  append: () => storageAccess,
  coverage: () => storageAccess,
  getSnapshot: () => storageAccess,
  latestSnapshotId: () => storageAccess,
  putSnapshotManifest: () => storageAccess,
  snapshot: () => storageAccess,
  snapshotCount: storageAccess,
  storePath: "fixture:dashboard-store",
});

const fixtures = () => {
  const base = capabilityAt(
    makeDxCapabilities({
      collectors: [],
      defaultRepo: "/fixture/dashboard-repo",
      registry: buildRegistry([], [], []),
      storePath: "/fixture/dashboard-store.db",
    })
  );

  const query = vi.fn((_input: AgentQueryInput) => Effect.succeed(output));

  const [status, analyze, explain, evidence] = makeDxQueryCapabilities({
    agentQuery: query,
    descriptors: [],
    metrics: [],
  });

  const caps = { ...base, analyze, evidence, explain, status };

  const statusOutput = caps.status.contract.output.make({
    context,
    contractDigest: CONTRACT_DIGEST,
    contractVersion: CONTRACT_VERSION,
    descriptors: [],
    snapshotCount: 0,
    storePath: "fixture:dashboard-store",
  });

  const statusHandler = vi
    .spyOn(caps.status, "handler")
    .mockImplementation(() => Effect.succeed(statusOutput));

  const usageHandler = vi
    .spyOn(caps.usage, "handler")
    .mockImplementation(() => Effect.succeed(output));

  return { caps, query, statusHandler, statusOutput, usageHandler };
};

const readCapabilities = [
  "dx_status",
  "dx_analyze",
  "dx_usage",
  "dx_explain",
  "dx_evidence",
];

describe("dashboard agent capability reads", () => {
  for (const item of [
    {
      capability: "dx_analyze",
      expected: {
        agent: request,
        capability: "dx_analyze",
        selectors: { repo: ["fixture:repo"] },
      },
      input: { repo: "fixture:repo" },
    },
    {
      capability: "dx_explain",
      expected: {
        agent: request,
        capability: "dx_explain",
        cursor: "fixture:cursor",
        selectors: { flight: ["fixture:flight"], limit: ["2"] },
      },
      input: { cursor: "fixture:cursor", flight: "fixture:flight", limit: 2 },
    },
    {
      capability: "dx_evidence",
      expected: {
        agent: request,
        capability: "dx_evidence",
        selectors: { evidenceIds: ["fixture:evidence"] },
      },
      input: { evidenceIds: ["fixture:evidence"] },
    },
  ]) {
    it.effect(
      `${item.capability} preserves the full shared query response`,
      () => {
        const fixture = fixtures();

        return Effect.gen(function* forwardedQuery() {
          const result = yield* readAgentDashboardQuery(
            fixture.caps,
            item.capability,
            JSON.stringify({ ...item.input, agentQuery: request })
          );

          expect(result).toBe(output);
          expect(fixture.query).toHaveBeenCalledExactlyOnceWith(item.expected);
        }).pipe(Effect.provideService(EventStore, unavailableStorage));
      }
    );
  }

  it.effect("status keeps its shared metadata and response context", () => {
    const fixture = fixtures();

    return Effect.gen(function* forwardedStatus() {
      const result = yield* readAgentDashboardQuery(
        fixture.caps,
        "dx_status",
        JSON.stringify({ agentQuery: request, detail: "detailed" })
      );

      expect(result).toBe(fixture.statusOutput);
      expect(fixture.statusHandler).toHaveBeenCalledExactlyOnceWith({
        agentQuery: request,
        detail: "detailed",
      });
    }).pipe(Effect.provideService(EventStore, unavailableStorage));
  });

  it.effect("usage forwards the schema-decoded request unchanged", () => {
    const fixture = fixtures();

    const input = {
      agentQuery: request,
      groupBy: "tool",
      limit: 2,
      repo: ["fixture:repo"],
    };

    return Effect.gen(function* forwardedUsage() {
      const result = yield* readAgentDashboardQuery(
        fixture.caps,
        "dx_usage",
        JSON.stringify(input)
      );

      expect(result).toBe(output);
      expect(fixture.usageHandler).toHaveBeenCalledExactlyOnceWith(input);
    }).pipe(Effect.provideService(EventStore, unavailableStorage));
  });

  it.effect(
    "every read requires a nested agent profile before dispatch",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* missingProfile() {
        for (const capability of readCapabilities) {
          const error = yield* Effect.flip(
            readAgentDashboardQuery(
              fixture.caps,
              capability,
              JSON.stringify(
                capability === "dx_evidence" ? { evidenceIds: [] } : {}
              )
            )
          );

          expect(error._tag).toBe("InvalidInput");
          expect(error).toMatchObject({ field: "agentQuery" });
        }

        expect(fixture.query).not.toHaveBeenCalled();
        expect(fixture.statusHandler).not.toHaveBeenCalled();
        expect(fixture.usageHandler).not.toHaveBeenCalled();
      }).pipe(Effect.provideService(EventStore, unavailableStorage));
    }
  );

  it.effect(
    "write and unrelated capabilities are rejected before dispatch",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* unsupportedCapabilities() {
        for (const capability of [
          "dx_collect",
          "dx_mark",
          "dx_operation",
          "dx_learning",
          "dx_history",
          "dx_chats",
          "unknown",
        ]) {
          const error = yield* Effect.flip(
            readAgentDashboardQuery(
              fixture.caps,
              capability,
              JSON.stringify({ agentQuery: request })
            )
          );

          expect(error._tag).toBe("InvalidInput");
          expect(error).toMatchObject({ field: "capability" });
        }

        expect(fixture.query).not.toHaveBeenCalled();
        expect(fixture.statusHandler).not.toHaveBeenCalled();
        expect(fixture.usageHandler).not.toHaveBeenCalled();
      }).pipe(Effect.provideService(EventStore, unavailableStorage));
    }
  );

  it.effect(
    "invalid JSON, profiles and capability inputs use InvalidInput",
    () => {
      const fixture = fixtures();

      return Effect.gen(function* invalidBodies() {
        for (const item of [
          { capability: "dx_analyze", input: "{" },
          {
            capability: "dx_analyze",
            input: JSON.stringify({
              agentQuery: { ...request, profileVersion: "dx.agent.v0" },
            }),
          },
          {
            capability: "dx_analyze",
            input: JSON.stringify({
              agentQuery: {
                ...request,
                policies: { ...request.policies, autoRefresh: true },
              },
            }),
          },
          {
            capability: "dx_analyze",
            input: JSON.stringify({ agentQuery: request, autoSync: true }),
          },
          {
            capability: "dx_usage",
            input: JSON.stringify({ agentQuery: request, limit: 0 }),
          },
          {
            capability: "dx_evidence",
            input: JSON.stringify({ agentQuery: request, evidenceIds: [42] }),
          },
        ]) {
          const error = yield* Effect.flip(
            readAgentDashboardQuery(fixture.caps, item.capability, item.input)
          );

          expect(error._tag).toBe("InvalidInput");
          expect(error).toMatchObject({ field: "input" });
        }

        expect(fixture.query).not.toHaveBeenCalled();
        expect(fixture.usageHandler).not.toHaveBeenCalled();
      }).pipe(Effect.provideService(EventStore, unavailableStorage));
    }
  );

  it.effect("the input bound counts UTF-8 bytes before decoding", () => {
    const fixture = fixtures();

    const input = JSON.stringify({
      agentQuery: request,
      repo: "€".repeat(22_000),
    });

    return Effect.gen(function* oversizedInput() {
      expect(input.length).toBeLessThan(65_536);
      expect(Buffer.byteLength(input, "utf-8")).toBeGreaterThan(65_536);

      const error = yield* Effect.flip(
        readAgentDashboardQuery(fixture.caps, "dx_analyze", input)
      );

      expect(error._tag).toBe("InvalidInput");
      expect(error).toMatchObject({ field: "input" });
      expect(error.message).toContain("64 KiB");
      expect(fixture.query).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(EventStore, unavailableStorage));
  });
});
