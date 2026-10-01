// @effect-diagnostics nodeBuiltinImport:off -- The test reads the committed a07 capture fixtures by path.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { buildChatTree } from "../../../src/dx/chats/tree.js";
import { cursorCliCollector } from "../../../src/dx/collectors/cursor-cli/collector.js";
import { cursorDashboardResponseCollector } from "../../../src/dx/collectors/cursor-dashboard-response/collector.js";
import { toApiEvent } from "../../../src/dx/collectors/cursor-usage-api/collector.js";
import { accountAiUsage } from "../../../src/dx/metrics/ai-usage/ledger.js";
import { knownTokenTotal } from "../../../src/dx/metrics/ai-usage/typed.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { EventIdSchema } from "../../../src/dx/model/ids.js";
import { deriveUsageFacts } from "../../../src/dx/usage/derive.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "a07-live");

const SESSION = "487a09d4-1638-4add-a548-db653635a61b";

const ROW_AT = "2026-09-30T12:32:44.710Z";

const BRANCH = "feature/a07-live-demo";

const TOKENS = 34_384 + 66_304 + 710;

const streamEvents = cursorCliCollector
  .collect({
    adapterId: "cursor-cli",
    context: {
      ...emptyFlightContext,
      branch: BRANCH,
      repoCommonDir: "/tmp/a07-demo/.git",
      worktreePath: "/tmp/a07-demo",
    },
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput: path.join(FIXTURES, "cursor-cli.stream.jsonl"),
  })
  .pipe(Effect.map((batch) => batch.events));

const accountRows = cursorDashboardResponseCollector
  .collect({
    adapterId: "cursor-dashboard-response",
    context: emptyFlightContext,
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput: path.join(FIXTURES, "cursor-dashboard.json"),
  })
  .pipe(
    Effect.map((batch) =>
      batch.events.map((event) =>
        toApiEvent(event, new Map([[`${ROW_AT}|${SESSION}`, 6.3816]]))
      )
    )
  );

const laterRow = (row: DxEventEnvelope): DxEventEnvelope => ({
  ...row,
  eventId: EventIdSchema.make(`${row.eventId}-later`),
  occurredAt: "2026-09-30T12:45:00.000Z",
  upstreamKey: `${row.upstreamKey ?? ""}-later`,
  usage:
    row.usage === null
      ? null
      : { ...row.usage, requestKey: `${SESSION}@2026-09-30T12:45:00.000Z` },
});

const capture = Effect.all([streamEvents, accountRows]).pipe(
  Effect.map(([stream, rows]) => [...stream, ...rows]),
  Effect.provide(NodeServices.layer)
);

const everyChat = (events: readonly DxEventEnvelope[]) =>
  buildChatTree(events, { branch: null, repoCommonDir: null, since: null });

describe("a Cursor request seen by cursor-agent and the account", () => {
  it.effect(
    "counts one request in usage, chats and history when the account row falls in the stream's turn",
    () =>
      Effect.gen(function* oneRequest() {
        const events = yield* capture;
        const { facts } = deriveUsageFacts(events);

        expect(
          facts.map((fact) => ({
            billed: fact.billed?.amount,
            branch: fact.branch,
            requests: fact.requests,
            tokens: knownTokenTotal(fact.tokens),
          }))
        ).toStrictEqual([
          { billed: 0.063816, branch: BRANCH, requests: 1, tokens: TOKENS },
        ]);

        const [chat] = everyChat(events).chats;

        expect(chat?.usage.requests).toBe(1);
        expect(chat?.usage.tokens.total).toBe(TOKENS);
        expect(chat?.modelTimeline).toHaveLength(1);

        const history = accountAiUsage(events);

        expect(history.requestCount).toBe(1);
        expect(
          history.totals
            .filter((total) => total.ledger === "tokens")
            .reduce((sum, total) => sum + total.value, 0)
        ).toBe(TOKENS);
      })
  );

  it.effect(
    "keeps an account row outside the stream's turn as its own request",
    () =>
      Effect.gen(function* twoRequests() {
        const events = yield* capture;
        const row = events.find((event) => event.ai?.channel === "usage-api");
        const all = row === undefined ? events : [...events, laterRow(row)];
        const { facts } = deriveUsageFacts(all);

        expect(facts.map((fact) => fact.requests)).toStrictEqual([1, 1]);
        expect(accountAiUsage(all).requestCount).toBe(2);
      })
  );
});
