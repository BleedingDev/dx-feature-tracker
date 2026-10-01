// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed account-usage fixture.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { correlationKeysOf, sessionIdsOf } from "../../src/dx/account/keys.js";
import { accountUsageSummary } from "../../src/dx/account/summary.js";
import { parseCursorDashboardResponse } from "../../src/dx/collectors/cursor-dashboard-response/parse.js";
import { toApiEvent } from "../../src/dx/collectors/cursor-usage-api/collector.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  EVENT_SCHEMA_VERSION,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const fixtureText = readFileSync(
  fileURLToPath(
    new URL("fixtures/account-usage/dashboard-ids.json", import.meta.url)
  ),
  "utf-8"
);

const parseFixture = (text: string) =>
  parseCursorDashboardResponse(text, {
    context: emptyFlightContext,
    observedAt: "2026-09-30T12:00:00.000Z",
    origin: "fixture",
    sourceName: "account-usage-fixture",
  }).pipe(Effect.provide(NodeServices.layer));

const byModel = (events: readonly DxEventEnvelope[], model: string) =>
  events.find((event) => event.payload.model === model);

const present = (event: DxEventEnvelope | undefined) =>
  event === undefined
    ? Effect.die("fixture row missing")
    : Effect.succeed(event);

const usageRow = (
  id: string,
  overrides: {
    readonly adapterId?: string;
    readonly branch?: string | null;
    readonly charge?: number | null;
    readonly occurredAt: string;
    readonly sessionId?: string | null;
    readonly tokens?: Record<string, number>;
  }
): DxEventEnvelope => ({
  acquisition: "api",
  adapterId: overrides.adapterId ?? "cursor-usage-api",
  adapterVersion: "0.1.0",
  ai: null,
  context: {
    ...emptyFlightContext,
    branch: overrides.branch ?? null,
    repoCommonDir:
      overrides.branch === undefined || overrides.branch === null
        ? null
        : "/repo/.git",
  },
  eventId: EventIdSchema.make(id),
  evidence: { bounded: true, hash: null, ref: `fixture://${id}` },
  fieldSemantics: [],
  identity: {
    commitSha: null,
    generationId: null,
    githubAttempt: null,
    githubRunId: null,
    prNumber: null,
    requestId: null,
    sessionId: overrides.sessionId ?? null,
    turnId: null,
  },
  kind: "ai.usage",
  observedAt: "2026-09-30T12:00:00.000Z",
  occurredAt: overrides.occurredAt,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: {
    charge: overrides.charge === undefined ? 1 : overrides.charge,
    tokens: overrides.tokens ?? { input: 100, output: 20 },
  },
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: null,
  upstreamKey: id,
  usage: null,
});

describe("dashboard correlation keys (account-usage)", () => {
  it.effect(
    "emits every row id as a correlation key and prefers the local composer id",
    () =>
      Effect.gen(function* dashboardKeys() {
        const result = yield* parseFixture(fixtureText);
        const first = byModel(result.events, "claude-opus-5-5");
        const second = byModel(result.events, "gpt-6");

        expect(first?.identity).toMatchObject({
          generationId: "bubble-1",
          requestId: "req-1",
          sessionId: "composer-local-1",
          turnId: "composer-local-1:bubble-1",
        });

        expect(first?.payload.correlationKeys).toEqual([
          "request:req-1",
          "generation:bubble-1",
          "session:composer-local-1",
          "session:conv-dashboard-1",
        ]);

        expect(first?.payload.conversationId).toBe("conv-dashboard-1");

        expect(second?.identity).toMatchObject({
          generationId: "gen-2",
          requestId: "client-req-2",
          sessionId: "composer-local-2",
          turnId: "composer-local-2:gen-2",
        });

        expect(second?.payload.correlationKeys).toEqual([
          "request:client-req-2",
          "generation:gen-2",
          "session:composer-local-2",
        ]);

        expect(
          result.coverage.gaps.find(
            (gap) => gap.code === "request-key-unavailable"
          )?.message
        ).toMatch(/^1 row\(s\)/u);
      })
  );

  it.effect("keeps event ids stable for rows without the new id fields", () =>
    Effect.gen(function* stableIds() {
      const legacyOnly = JSON.stringify({
        usageEventsDisplay: [
          {
            conversationId: "conv-legacy",
            isChargeable: true,
            kind: "USAGE_EVENT_KIND_USAGE_BASED",
            model: "default",
            timestamp: "1790751600000",
            tokenUsage: { inputTokens: 50, outputTokens: 10, totalCents: 0.5 },
          },
        ],
      });

      const legacy = yield* parseFixture(legacyOnly);
      const full = yield* parseFixture(fixtureText);

      const match = full.events.find(
        (event) => event.identity.sessionId === "conv-legacy"
      );

      expect(match?.eventId).toBe(legacy.events[0]?.eventId);
      expect(match?.payload.correlationKeys).toEqual(["session:conv-legacy"]);
    })
  );

  it.effect(
    "usage API charges join by request id when the session key is the composer",
    () =>
      Effect.gen(function* apiCharge() {
        const result = yield* parseFixture(fixtureText);
        const first = yield* present(byModel(result.events, "claude-opus-5-5"));

        const legacy = yield* present(
          result.events.find(
            (event) => event.identity.sessionId === "conv-legacy"
          )
        );

        const charged = new Map([
          ["request:req-1", 13],
          [`${legacy.occurredAt ?? ""}|conv-legacy`, 1],
        ]);

        expect(toApiEvent(first, charged).payload.chargedUsd).toBe(0.13);
        expect(toApiEvent(legacy, charged).payload.chargedUsd).toBe(0.01);
      })
  );

  it.effect("correlationKeysOf merges identity and payload keys", () =>
    Effect.gen(function* mergedKeys() {
      const result = yield* parseFixture(fixtureText);
      const first = yield* present(byModel(result.events, "claude-opus-5-5"));

      expect(correlationKeysOf(first)).toEqual([
        "request:req-1",
        "generation:bubble-1",
        "session:composer-local-1",
        "session:conv-dashboard-1",
      ]);

      expect(sessionIdsOf(first)).toEqual([
        "composer-local-1",
        "conv-dashboard-1",
      ]);
    })
  );
});

describe("accountUsageSummary (account-usage)", () => {
  it("splits account rows into linked and unlinked totals", () => {
    const summary = accountUsageSummary(
      [
        usageRow("a", {
          branch: "feature/x",
          charge: 0.5,
          occurredAt: "2026-09-29T10:00:00.000Z",
          sessionId: "c1",
        }),
        usageRow("b", {
          charge: 0.25,
          occurredAt: "2026-09-29T11:00:00.000Z",
          sessionId: "c2",
        }),
        usageRow("c", {
          charge: null,
          occurredAt: "2026-09-29T12:00:00.000Z",
          sessionId: "c2",
          tokens: { total: 900 },
        }),
        usageRow("d", {
          charge: 0.1,
          occurredAt: "2026-09-29T13:00:00.000Z",
          sessionId: "c3",
        }),
        usageRow("b", {
          charge: 0.25,
          occurredAt: "2026-09-29T11:00:00.000Z",
          sessionId: "c2",
        }),
        {
          ...usageRow("hook", { occurredAt: "2026-09-29T12:30:00.000Z" }),
          adapterId: "cursor-hooks",
          kind: "ai.turn",
        },
      ],
      { since: null }
    );

    expect(summary.linked).toEqual({
      billedRows: 1,
      billedUsd: 0.5,
      requests: 1,
      tokens: 120,
    });

    expect(summary.unlinked).toEqual({
      billedRows: 2,
      billedUsd: 0.35,
      conversations: 2,
      requests: 3,
      tokens: 1140,
    });

    expect(summary.window).toEqual({
      from: "2026-09-29T10:00:00.000Z",
      since: null,
      sources: ["cursor-usage-api"],
      to: "2026-09-29T13:00:00.000Z",
    });
  });

  it("applies since and prefers a linked copy of a duplicated row", () => {
    const summary = accountUsageSummary(
      [
        usageRow("old", { charge: 9, occurredAt: "2026-09-01T00:00:00.000Z" }),
        usageRow("x", { charge: 0.2, occurredAt: "2026-09-29T10:00:00.000Z" }),
        usageRow("x", {
          branch: "main",
          charge: 0.2,
          occurredAt: "2026-09-29T10:00:00.000Z",
        }),
      ],
      { since: "2026-09-23T00:00:00.000Z" }
    );

    expect(summary.linked.requests).toBe(1);
    expect(summary.unlinked.requests).toBe(0);
    expect(summary.window.since).toBe("2026-09-23T00:00:00.000Z");
  });

  it("uses CSV export rows only before the dashboard coverage starts", () => {
    const summary = accountUsageSummary(
      [
        usageRow("csv-old", {
          adapterId: "cursor-usage-export",
          charge: 1,
          occurredAt: "2026-09-20T00:00:00.000Z",
        }),
        usageRow("csv-overlap", {
          adapterId: "cursor-usage-export",
          charge: 1,
          occurredAt: "2026-09-29T11:00:00.000Z",
        }),
        usageRow("api", {
          charge: 0.5,
          occurredAt: "2026-09-29T10:00:00.000Z",
        }),
      ],
      { since: null }
    );

    expect(summary.unlinked.requests).toBe(2);
    expect(summary.unlinked.billedUsd).toBe(1.5);
    expect(summary.window.sources).toEqual([
      "cursor-usage-api",
      "cursor-usage-export",
    ]);
  });

  it.effect(
    "summarises parsed dashboard fixture rows as unlinked account spend",
    () =>
      Effect.gen(function* parsedSummary() {
        const result = yield* parseFixture(fixtureText);
        const summary = accountUsageSummary(result.events, { since: null });

        expect(summary.linked.requests).toBe(0);
        expect(summary.unlinked).toMatchObject({
          billedRows: 3,
          billedUsd: 0.17,
          conversations: 3,
          requests: 4,
          tokens: 2560,
        });
      })
  );
});
