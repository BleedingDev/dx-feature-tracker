// @effect-diagnostics nodeBuiltinImport:off -- The persistence test opens the store file with node:sqlite to delete events behind the store's back.
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { accountUsageSummary } from "../../src/dx/account/summary.js";
import { EventStore } from "../../src/dx/contracts/event-store.js";
import { FakeEventStoreLayer } from "../../src/dx/contracts/fakes.js";
import { toClaim } from "../../src/dx/correlation/ai/claim.js";
import type { HarnessId } from "../../src/dx/harness/ids.js";
import { accountAiUsage } from "../../src/dx/metrics/ai-usage/ledger.js";
import type { AiTokens } from "../../src/dx/model/attribution.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { dxStoreLayer } from "../../src/dx/registry/runtime.js";
import { HarnessCursors } from "../../src/dx/storage/harness-cursors.js";
import { runUsageQuery } from "../../src/dx/usage/capability.js";
import { deriveUsageFacts } from "../../src/dx/usage/derive.js";
import type { UsageFact } from "../../src/dx/usage/fact.js";
import { NO_REPO } from "../../src/dx/usage/fact.js";
import { prepareFacts, queryUsage } from "../../src/dx/usage/query.js";
import type { UsageQuery } from "../../src/dx/usage/query.js";
import { UsageFactStore } from "../../src/dx/usage/store.js";
import { zoneClock } from "../../src/dx/usage/time.js";

const tokens = (input: number, output: number): AiTokens => ({
  ...unknownTokens,
  inputFresh: input,
  output,
});

const fact = (id: string, overrides: Partial<UsageFact>): UsageFact => ({
  agent: null,
  attribution: "harness-recorded",
  billed: null,
  branch: "main",
  channel: "session-file",
  channels: ["claude-code/session-file"],
  derivationVersion: 1,
  effort: null,
  factId: id,
  harness: "claude-code",
  harnessVersion: null,
  members: 1,
  model: "claude-sonnet-5",
  modelRaw: "claude-sonnet-5",
  occurredAt: "2026-09-30T10:00:00.000Z",
  occurredMs: Date.parse("2026-09-30T10:00:00.000Z"),
  parentSession: null,
  premiumRequests: null,
  provider: "anthropic",
  repo: "/home/user/app/.git",
  requestKey: id,
  requests: 1,
  scope: "request",
  serviceTier: null,
  session: "s1",
  speed: null,
  splitOf: null,
  tokens: tokens(100, 10),
  toolFigure: null,
  via: null,
  webSearchRequests: null,
  worktree: "/home/user/app",
  ...overrides,
});

const at = (iso: string) => ({ occurredAt: iso, occurredMs: Date.parse(iso) });

const baseQuery: UsageQuery = {
  bucket: "day",
  filters: {},
  groupBy: null,
  limit: 10,
  metrics: [
    "tokens",
    "requests",
    "sessions",
    "estimate",
    "billed",
    "toolFigure",
  ],
  sinceMs: null,
  sortBy: "tokens",
  stackBy: "tool",
  untilMs: null,
};

const run = (
  facts: readonly UsageFact[],
  query: Partial<UsageQuery>,
  tz = "UTC",
  estimate: (item: UsageFact) => number | null = () => null
) =>
  queryUsage(
    prepareFacts(facts, estimate),
    { ...baseQuery, ...query },
    zoneClock(tz)
  );

describe("usage query", () => {
  it("counts a session in every branch it touched but once in the total", () => {
    const result = run(
      [
        fact("a", { branch: "main", session: "s1" }),
        fact("b", { branch: "feature/x", session: "s1" }),
        fact("c", { branch: "feature/x", session: "s2" }),
      ],
      { groupBy: "branch", sortBy: "sessions" }
    );

    expect(
      result.groups.map((group) => [group.key, group.values.sessions])
    ).toEqual([
      ["feature/x", 2],
      ["main", 1],
    ]);
    expect(result.total.values.sessions).toBe(2);
    expect(result.total.values.tokens).toBe(330);
    expect(result.total.values.requests).toBe(3);
  });

  it("puts facts without the grouped value in the unattributed row, not in a group", () => {
    const result = run(
      [
        fact("a", { branch: "main" }),
        fact("b", { attribution: "unassigned", branch: null }),
      ],
      { groupBy: "branch" }
    );

    expect(result.groups.map((group) => group.key)).toEqual(["main"]);
    expect(result.unattributed).toMatchObject({
      facts: 1,
      values: { requests: 1, tokens: 110 },
    });
    expect(result.total.values.requests).toBe(2);
  });

  it("sums the groups past the limit into one Other row with recomputed distinct counts", () => {
    const facts = ["m1", "m2", "m3", "m4", "m5"].flatMap((model, index) => [
      fact(`${model}-a`, {
        model,
        session: "shared",
        tokens: tokens(100 * (index + 1), 0),
      }),
      fact(`${model}-b`, {
        model,
        session: `own-${model}`,
        tokens: tokens(100 * (index + 1), 0),
      }),
    ]);

    const result = run(facts, { groupBy: "model", limit: 2 });

    expect(result.groups.map((group) => group.key)).toEqual(["m5", "m4"]);
    expect(result.other).toMatchObject({
      facts: 6,
      groups: 3,
      values: { requests: 6, sessions: 4, tokens: 1200 },
    });
    expect(result.total.values).toMatchObject({
      requests: 10,
      sessions: 6,
      tokens: 3000,
    });
  });

  it("clips every figure to the window instead of reporting lifetime totals", () => {
    const facts = [
      fact("old", {
        ...at("2026-08-01T10:00:00.000Z"),
        tokens: tokens(9000, 0),
      }),
      fact("in", { ...at("2026-09-28T10:00:00.000Z") }),
      fact("late", { ...at("2026-10-02T10:00:00.000Z") }),
      fact("timeless", { occurredAt: null, occurredMs: null }),
    ];

    const result = run(facts, {
      sinceMs: Date.parse("2026-09-24T00:00:00.000Z"),
      untilMs: Date.parse("2026-10-01T00:00:00.000Z"),
    });

    expect(result.total).toMatchObject({ facts: 1, values: { tokens: 110 } });
    expect(result.withoutTime).toBe(1);
    expect(result.series.map((point) => point.bucket)).toEqual(["2026-09-28"]);
  });

  it("buckets days in the pinned time zone", () => {
    const facts = [fact("late-evening", at("2026-09-30T23:30:00.000Z"))];

    const utc = run(facts, { groupBy: "day" }, "UTC");
    const prague = run(facts, { groupBy: "day" }, "Europe/Prague");
    const honolulu = run(facts, { bucket: "week" }, "Pacific/Honolulu");

    expect(utc.groups.map((group) => group.key)).toEqual(["2026-09-30"]);
    expect(prague.groups.map((group) => group.key)).toEqual(["2026-10-01"]);
    expect(prague.series.map((point) => point.bucket)).toEqual(["2026-10-01"]);
    expect(honolulu.series.map((point) => point.bucket)).toEqual([
      "2026-09-28",
    ]);

    const kolkata = run(
      [
        fact("before-midnight", at("2026-09-30T18:20:00.000Z")),
        fact("after-midnight", at("2026-09-30T18:40:00.000Z")),
      ],
      { groupBy: "day" },
      "Asia/Kolkata"
    );

    expect(kolkata.groups.map((group) => [group.key, group.facts])).toEqual([
      ["2026-09-30", 1],
      ["2026-10-01", 1],
    ]);
  });

  it("starts a date at the end of the gap when the zone skips its midnight", () => {
    const starts = [
      ["America/Santiago", "2026-09-06"],
      ["America/Havana", "2026-03-08"],
      ["America/New_York", "2026-03-08"],
    ].map(([tz = "UTC", date = ""]) => zoneClock(tz).localMidnight(date));

    expect(starts).toStrictEqual([
      Date.parse("2026-09-06T04:00:00.000Z"),
      Date.parse("2026-03-08T05:00:00.000Z"),
      Date.parse("2026-03-08T05:00:00.000Z"),
    ]);
  });

  it("counts a tool session figure only where its whole session counts", () => {
    const figure = fact("figure", {
      ...at("2026-09-30T10:00:00.000Z"),
      branch: "feature/one",
      requests: 0,
      tokens: unknownTokens,
      toolFigure: { amount: 0.4, currency: "USD", kind: "api-equivalent" },
    });

    const facts = [
      fact("early", {
        ...at("2026-09-30T10:00:00.000Z"),
        branch: "feature/one",
      }),
      fact("late", {
        ...at("2026-09-30T11:00:00.000Z"),
        branch: "feature/two",
      }),
      figure,
    ];

    const whole = run(facts, { groupBy: "branch" });

    const clipped = run(facts, {
      untilMs: Date.parse("2026-09-30T10:30:00.000Z"),
    });

    const after = run(facts, {
      sinceMs: Date.parse("2026-09-30T10:30:00.000Z"),
    });

    const oneBranch = run([...facts.slice(0, 1), figure], {
      groupBy: "branch",
    });

    expect(whole.total.values.toolFigure).toBe(0.4);
    expect(whole.groups.map((group) => group.values.toolFigure)).toEqual([
      null,
      null,
    ]);
    expect(whole.unattributed?.values.toolFigure).toBe(0.4);
    expect(whole.notes).toEqual([
      "1 tool session figure(s) sit in (unattributed): the session spans several branch values and the figure is not split.",
    ]);
    expect(whole.series.map((point) => point.bucket)).toEqual(["2026-09-30"]);
    expect(clipped.total.values).toMatchObject({
      requests: 1,
      toolFigure: null,
    });
    expect(after.total.values).toMatchObject({ requests: 1, toolFigure: null });
    expect(clipped.notes).toEqual([
      "1 tool session figure(s) left out: the session runs past the time window or the filter, and the figure covers the whole session.",
    ]);
    expect(
      oneBranch.groups.map((group) => [group.key, group.values.toolFigure])
    ).toEqual([["feature/one", 0.4]]);
  });

  it("counts a split request once and keeps each share's figure on its own branch", () => {
    const facts = [
      fact("share-1", {
        branch: "main",
        splitOf: "orchestrate",
        toolFigure: { amount: 0.3, currency: "USD", kind: "api-equivalent" },
      }),
      fact("share-2", {
        branch: "feature/x",
        requests: 0,
        splitOf: "orchestrate",
        toolFigure: { amount: 0.1, currency: "USD", kind: "api-equivalent" },
      }),
    ];

    const result = run(facts, { groupBy: "branch", sortBy: "toolFigure" });

    expect(
      result.groups.map((group) => [
        group.key,
        group.values.requests,
        group.values.toolFigure,
      ])
    ).toEqual([
      ["main", 1, 0.3],
      ["feature/x", 0, 0.1],
    ]);
    expect(result.total.values.requests).toBe(1);
    expect(result.notes).toEqual([]);
  });

  it("places an unsplit session figure under the provider and gateway of its requests", () => {
    const facts = [
      fact("req", { provider: "anthropic", via: "openrouter" }),
      fact("figure", {
        model: null,
        modelRaw: null,
        provider: "unknown",
        requests: 0,
        tokens: unknownTokens,
        toolFigure: { amount: 0.4, currency: "USD", kind: "api-equivalent" },
      }),
    ];

    const byProvider = run(facts, { groupBy: "provider" });
    const byVia = run(facts, { groupBy: "via" });
    const anthropic = run(facts, { filters: { provider: ["anthropic"] } });

    expect(
      byProvider.groups.map((group) => [group.key, group.values.toolFigure])
    ).toEqual([["anthropic", 0.4]]);
    expect(
      byVia.groups.map((group) => [group.key, group.values.toolFigure])
    ).toEqual([["openrouter", 0.4]]);
    expect(anthropic.total.values.toolFigure).toBe(0.4);
  });

  it("keeps every money ledger apart and never adds them", () => {
    const facts = [
      fact("billed", {
        billed: { amount: 0.5, currency: "USD", kind: "charge" },
        harness: "cursor",
      }),
      fact("figure", {
        harness: "pi",
        toolFigure: { amount: 0.25, currency: "USD", kind: "api-equivalent" },
      }),
      fact("plain", {}),
    ];

    const result = run(facts, { groupBy: "tool" }, "UTC", (item) =>
      item.factId === "plain" ? null : 1
    );

    expect(result.total.values).toMatchObject({
      billed: 0.5,
      estimate: 2,
      toolFigure: 0.25,
    });
    expect(
      result.groups.map((group) => [
        group.key,
        group.values.billed,
        group.values.toolFigure,
        group.values.estimate,
      ])
    ).toEqual([
      ["claude-code", null, null, null],
      ["cursor", 0.5, null, 1],
      ["pi", null, 0.25, 1],
    ]);
    expect(result.unpricedInWindow).toBe(1);
  });

  it("filters by value lists and leaves account buckets out unless asked", () => {
    const facts = [
      fact("cc", {}),
      fact("codex", { harness: "codex", provider: "openai" }),
      fact("bucket", {
        harness: "cursor",
        repo: NO_REPO,
        scope: "account-bucket",
        session: null,
      }),
    ];

    const tools = run(facts, { filters: { tool: ["codex", "claude-code"] } });
    const openai = run(facts, { filters: { provider: ["openai"] } });

    const buckets = run(facts, {
      filters: { scope: ["account-bucket"] },
    });

    expect(tools.total.facts).toBe(2);
    expect(tools.accountBuckets.facts).toBe(0);
    expect(openai.total.facts).toBe(1);
    expect(run(facts, {}).accountBuckets.facts).toBe(1);
    expect(buckets.total.facts).toBe(1);
  });

  it("answers a grouped query over 200k facts in under 300 ms of CPU time", () => {
    const harnesses: readonly HarnessId[] = [
      "cursor",
      "claude-code",
      "codex",
      "opencode",
      "pi",
      "omp",
      "deepseek",
    ];

    const start = Date.parse("2026-07-01T00:00:00.000Z");

    const facts = Array.from({ length: 200_000 }, (_, index) =>
      fact(`f${String(index)}`, {
        branch: `branch-${String(index % 40)}`,
        harness: harnesses[index % harnesses.length] ?? "cursor",
        model: `model-${String(index % 25)}`,
        occurredAt: null,
        occurredMs: start + index * 45_000,
        session: `s${String(index % 3000)}`,
        tokens: tokens(index % 1000, index % 100),
      })
    );

    const prepared = prepareFacts(
      facts,
      (item) => (item.tokens.output ?? 0) / 1e6
    );

    const grouped = () => {
      const begin = process.cpuUsage();

      const result = queryUsage(
        prepared,
        {
          ...baseQuery,
          groupBy: "model",
          sinceMs: start + 86_400_000,
          stackBy: "tool",
        },
        zoneClock("Europe/Prague")
      );

      const spent = process.cpuUsage(begin);

      return { elapsed: (spent.user + spent.system) / 1000, result };
    };

    const runs = [grouped(), grouped(), grouped()];
    const { result } = runs[0] ?? grouped();
    const elapsed = Math.min(...runs.map((one) => one.elapsed));

    expect(result.groups).toHaveLength(10);
    expect(result.other?.groups).toBe(15);
    expect(elapsed).toBeLessThan(300);
  });
});

const NOW = "2026-09-30T12:00:00.000Z";

const usageEvent = (
  id: string,
  harness: HarnessId,
  channel: "session-file" | "otel" | "hooks",
  output: number,
  model: string,
  branch: string,
  requestId = "req-1"
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: `harness.${harness}`,
  adapterVersion: "fixture",
  ai: {
    agentId: null,
    agentType: null,
    branchSource: "harness-recorded",
    channel,
    cwd: "/home/user/app",
    effort: null,
    effortSource: null,
    harness,
    harnessVersion: "1.0.0",
    model,
    modelRaw: model,
    parentSessionId: null,
    provider: "anthropic",
    sessionId: "session-1",
    via: null,
  },
  context: {
    ...emptyFlightContext,
    branch,
    repoCommonDir: "/home/user/app/.git",
    worktreePath: "/home/user/app",
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: {
    ...emptyEventIdentity,
    requestId,
    sessionId: "session-1",
  },
  kind: "ai.request",
  observedAt: NOW,
  occurredAt: "2026-09-30T09:00:00.000Z",
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {},
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: id,
  usage: {
    premiumRequests: null,
    requestKey: requestId,
    serviceTier: null,
    speed: null,
    tokens: tokens(1000, output),
    toolFigure: null,
  },
});

const sameRequestTwice = [
  usageEvent("from-otel", "claude-code", "otel", 90, "claude-opus-5", "main"),
  usageEvent(
    "from-file",
    "claude-code",
    "session-file",
    100,
    "claude-opus-5",
    "main"
  ),
];

describe("usage facts", () => {
  it("dedupes a request seen by two channels and keeps the most precise source", () => {
    const derived = deriveUsageFacts(sameRequestTwice);

    expect(derived.facts).toHaveLength(1);
    expect(derived.facts[0]).toMatchObject({
      channel: "session-file",
      channels: ["claude-code/otel", "claude-code/session-file"],
      members: 2,
      repo: "/home/user/app/.git",
      tokens: { inputFresh: 1000, output: 100 },
    });
    expect(derived.disagreements).toEqual([
      {
        factId: derived.facts[0]?.factId,
        field: "tokens.output",
        harness: "claude-code",
        values: [
          { channel: "claude-code/session-file", value: "100" },
          { channel: "claude-code/otel", value: "90" },
        ],
      },
    ]);
  });

  it("counts a new tool's request in the ledger, the claims and nowhere twice", () => {
    const account = accountAiUsage(sameRequestTwice);

    expect(account.uncovered).toEqual([]);
    expect(account.requestCount).toBe(1);
    expect(
      account.totals.map((total) => [total.category, total.value])
    ).toEqual([
      ["input", 1000],
      ["output", 100],
    ]);
    expect(account.totals[0]?.sources).toEqual(["claude-code/session-file"]);

    const [, fromFile] = sameRequestTwice;
    const claim = fromFile === undefined ? null : toClaim(fromFile);

    expect(claim?.sourceKind).toBe("claude-code/session-file");
    expect(claim?.amounts).toEqual([
      { category: "input", currency: null, ledger: "tokens", value: 1000 },
      { category: "output", currency: null, ledger: "tokens", value: 100 },
    ]);
    expect(
      accountUsageSummary(sameRequestTwice, { since: null }).linked.requests
    ).toBe(0);
  });

  it("keeps only the latest cumulative session figure and counts it as no request", () => {
    const sessionCost = (id: string, amount: number): DxEventEnvelope => {
      const base = usageEvent(
        id,
        "claude-code",
        "session-file",
        0,
        "claude-opus-5",
        "main"
      );

      return {
        ...base,
        identity: { ...emptyEventIdentity, sessionId: "session-1" },
        kind: "ai.session",
        usage: {
          premiumRequests: null,
          requestKey: null,
          serviceTier: null,
          speed: null,
          tokens: unknownTokens,
          toolFigure: { amount, currency: "USD", kind: "api-equivalent" },
        },
      };
    };

    const derived = deriveUsageFacts([
      ...sameRequestTwice,
      sessionCost("cost-early", 0.5),
      sessionCost("cost-late", 0.8),
    ]);

    const result = run(derived.facts, {});

    expect(derived.facts).toHaveLength(2);
    expect(result.total.values).toMatchObject({
      requests: 1,
      tokens: 1100,
      toolFigure: 0.8,
    });
  });

  it("splits a session figure by the models its cost state lists", () => {
    const base = usageEvent(
      "cost",
      "claude-code",
      "session-file",
      0,
      "claude-opus-5",
      "main"
    );

    const derived = deriveUsageFacts([
      {
        ...base,
        ai: base.ai === null ? null : { ...base.ai, model: null },
        identity: { ...emptyEventIdentity, sessionId: "session-1" },
        kind: "ai.session",
        payload: {
          costState: {
            models: {
              "claude-haiku-4-5-20251001": { costUsd: 0.25 },
              "claude-opus-5": { costUsd: 0.5 },
            },
          },
        },
        usage: {
          premiumRequests: null,
          requestKey: null,
          serviceTier: null,
          speed: null,
          tokens: unknownTokens,
          toolFigure: {
            amount: 0.75,
            currency: "USD",
            kind: "api-equivalent",
          },
        },
      },
    ]);

    const byModel = run(derived.facts, { groupBy: "model" });

    expect(
      byModel.groups.map((group) => [group.key, group.values.toolFigure])
    ).toEqual([
      ["claude-haiku-4-5", 0.25],
      ["claude-opus-5", 0.5],
    ]);
    expect(byModel.unattributed).toBeNull();
    expect(byModel.total.values.toolFigure).toBe(0.75);
  });

  it("keeps a split session figure under the provider of each model", () => {
    const base = usageEvent(
      "cost",
      "claude-code",
      "session-file",
      0,
      "claude-opus-5",
      "main"
    );

    const request = usageEvent(
      "req",
      "claude-code",
      "session-file",
      100,
      "claude-opus-5",
      "main"
    );

    const derived = deriveUsageFacts([
      {
        ...request,
        identity: { ...emptyEventIdentity, sessionId: "session-1" },
      },
      {
        ...base,
        ai:
          base.ai === null
            ? null
            : { ...base.ai, model: null, provider: "unknown" },
        identity: { ...emptyEventIdentity, sessionId: "session-1" },
        kind: "ai.session",
        payload: {
          costState: { models: { "claude-opus-5": { costUsd: 0.75 } } },
        },
        usage: {
          premiumRequests: null,
          requestKey: null,
          serviceTier: null,
          speed: null,
          tokens: unknownTokens,
          toolFigure: {
            amount: 0.75,
            currency: "USD",
            kind: "api-equivalent",
          },
        },
      },
    ]);

    const byProvider = run(derived.facts, { groupBy: "provider" });

    const anthropic = run(derived.facts, {
      filters: { provider: ["anthropic"] },
    });

    expect(
      byProvider.groups.map((group) => [
        group.key,
        group.values.requests,
        group.values.toolFigure,
      ])
    ).toEqual([["anthropic", 1, 0.75]]);
    expect(byProvider.unattributed).toBeNull();
    expect(anthropic.total.values).toMatchObject({
      requests: 1,
      toolFigure: 0.75,
    });
  });

  it("leaves out an OpenTelemetry row without a request id when the session file has the session", () => {
    const fromFile = usageEvent(
      "codex-file",
      "codex",
      "session-file",
      50,
      "gpt-5.6-luna",
      "main",
      "resp_1"
    );

    const base = usageEvent(
      "codex-otel",
      "codex",
      "otel",
      50,
      "gpt-5.6-luna",
      "main"
    );

    const fromOtel: DxEventEnvelope = {
      ...base,
      identity: { ...base.identity, requestId: null },
      usage: base.usage === null ? null : { ...base.usage, requestKey: null },
    };

    const derived = deriveUsageFacts([fromFile, fromOtel]);

    expect(derived.facts.map((item) => item.requestKey)).toStrictEqual([
      "resp_1",
    ]);
    expect(derived.unresolved).toBe(1);
  });

  it("keeps a session's figure on its cumulative total when OpenTelemetry prices each request too", () => {
    const priced = (id: string, requestId: string): DxEventEnvelope => {
      const base = usageEvent(
        id,
        "claude-code",
        "otel",
        100,
        "claude-opus-5",
        "main",
        requestId
      );

      return {
        ...base,
        usage:
          base.usage === null
            ? null
            : {
                ...base.usage,
                toolFigure: {
                  amount: 0.4,
                  currency: "USD",
                  kind: "list-price",
                },
              },
      };
    };

    const costState = usageEvent(
      "cost-state",
      "claude-code",
      "session-file",
      0,
      "claude-opus-5",
      "main"
    );

    const derived = deriveUsageFacts([
      priced("otel-a", "req-a"),
      priced("otel-b", "req-b"),
      usageEvent(
        "file-a",
        "claude-code",
        "session-file",
        100,
        "claude-opus-5",
        "main",
        "req-a"
      ),
      usageEvent(
        "file-b",
        "claude-code",
        "session-file",
        100,
        "claude-opus-5",
        "main",
        "req-b"
      ),
      {
        ...costState,
        identity: { ...emptyEventIdentity, sessionId: "session-1" },
        kind: "ai.session",
        usage: {
          premiumRequests: null,
          requestKey: null,
          serviceTier: null,
          speed: null,
          tokens: unknownTokens,
          toolFigure: { amount: 0.8, currency: "USD", kind: "api-equivalent" },
        },
      },
    ]);

    expect(run(derived.facts, {}).total.values).toMatchObject({
      requests: 2,
      tokens: 2200,
      toolFigure: 0.8,
    });
  });

  it("counts a Codex session once when a 0.1 import and the Codex harness both read it", () => {
    const keyed = usageEvent(
      "harness-row",
      "codex",
      "session-file",
      50,
      "gpt-5.6-luna",
      "main",
      "source:codex-session:session:session-1:turn:tc-1100-1000-50"
    );

    const legacy = usageEvent(
      "imported-row",
      "codex",
      "session-file",
      50,
      "gpt-5.6-luna",
      "main"
    );

    const derived = deriveUsageFacts([
      keyed,
      {
        ...legacy,
        adapterId: "codex-session",
        identity: { ...legacy.identity, requestId: null },
        usage:
          legacy.usage === null ? null : { ...legacy.usage, requestKey: null },
      },
    ]);

    expect(run(derived.facts, {}).total.values).toMatchObject({
      requests: 1,
      tokens: 1050,
    });
    expect(derived.unresolved).toBe(1);
  });

  it("counts a request once when a later reading replaces its usage", () => {
    const first = usageEvent(
      "first-reading",
      "deepseek",
      "session-file",
      40,
      "gpt-5.6-luna",
      "main",
      "req-a"
    );

    const replacement = {
      ...usageEvent(
        "second-reading",
        "deepseek",
        "session-file",
        70,
        "gpt-5.6-luna",
        "main",
        "req-a2"
      ),
      payload: { replacesRequestKey: "req-a" },
    };

    const derived = deriveUsageFacts([first, replacement]);

    expect(derived.facts.map((item) => item.requestKey)).toStrictEqual([
      "req-a2",
    ]);
    expect(derived.facts[0]?.tokens.output).toBe(70);
  });

  it.effect("serves dx_usage from stored events and caches the facts", () =>
    Effect.gen(function* usageQuery() {
      const store = yield* EventStore;

      yield* store.append({
        coverage: {
          adapterId: "harness.claude-code",
          expectedItems: null,
          gaps: [],
          observedItems: 2,
          state: "complete",
          watermark: null,
          windowFrom: null,
          windowTo: null,
        },
        cursor: null,
        events: sameRequestTwice,
      });

      const output = yield* runUsageQuery({ groupBy: "model", tz: "UTC" });

      expect(output.total.values).toMatchObject({ requests: 1, tokens: 1100 });
      expect(output.groups.map((group) => group.key)).toEqual([
        "claude-opus-5",
      ]);
      expect(output.coverage.disagreements).toEqual([
        { count: 1, field: "tokens.output", tool: "claude-code" },
      ]);
      expect(output.coverage.tools).toEqual(["claude-code"]);

      const invalid = yield* Effect.flip(runUsageQuery({ tz: "Mars/Olympus" }));

      expect(invalid._tag).toBe("InvalidInput");
    }).pipe(
      Effect.provide(Layer.merge(FakeEventStoreLayer, UsageFactStore.memory))
    )
  );
});

const batchOf = (events: readonly DxEventEnvelope[]) => ({
  coverage: {
    adapterId: "harness.claude-code",
    expectedItems: null,
    gaps: [],
    observedItems: events.length,
    state: "complete" as const,
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events,
});

const storeAt = (file: string) =>
  dxStoreLayer({ kind: "live", path: file, source: "flag" });

const session = {
  channel: "session-file" as const,
  harness: "claude-code" as const,
  id: "session-1",
  mtimeMs: 5,
  path: "/home/user/.claude/projects/app/session-1.jsonl",
  sessionId: "session-1",
  size: 10,
  source: "harness.claude-code",
  worktree: "/home/user/app",
};

const secondRequest = usageEvent(
  "second",
  "claude-code",
  "session-file",
  5,
  "claude-haiku-5",
  "feature/x",
  "req-2"
);

describe("usage facts in the store", () => {
  it.effect(
    "keeps derived facts until new events arrive and forgets cursors of deleted events",
    () =>
      Effect.gen(function* persisted() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "dft.db");

        yield* Effect.gen(function* firstRun() {
          const store = yield* EventStore;
          const cursors = yield* HarnessCursors;

          yield* store.append(batchOf(sameRequestTwice));

          const first = yield* runUsageQuery({ tz: "UTC" });
          const cached = yield* runUsageQuery({ tz: "UTC" });

          expect(first.total.values.requests).toBe(1);
          expect(cached.coverage.derivedAt).toBe(first.coverage.derivedAt);

          yield* cursors.put(session, {
            cursor: null,
            lastEventId: "from-file",
            mtimeMs: 5,
            size: 10,
          });

          expect(yield* cursors.get(session)).toMatchObject({ size: 10 });

          yield* store.append(batchOf([secondRequest]));

          const grown = yield* runUsageQuery({ groupBy: "branch", tz: "UTC" });

          expect(grown.total.values.requests).toBe(2);
          expect(grown.groups.map((group) => group.key)).toEqual([
            "main",
            "feature/x",
          ]);
        }).pipe(Effect.provide(storeAt(file)));

        yield* Effect.sync(() => {
          const db = new DatabaseSync(file);
          db.exec("DELETE FROM events");
          db.close();
        });

        yield* Effect.gen(function* afterReset() {
          const cursors = yield* HarnessCursors;
          const empty = yield* runUsageQuery({ tz: "UTC" });

          expect(yield* cursors.get(session)).toBeNull();
          expect(empty.total.facts).toBe(0);
        }).pipe(Effect.provide(storeAt(file)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
