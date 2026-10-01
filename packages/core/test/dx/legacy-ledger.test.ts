import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CodexHarness } from "../../src/dx/harness/codex/index.js";
import { everywhere } from "../../src/dx/harness/contract.js";
import type { ReadInput, SessionRef } from "../../src/dx/harness/contract.js";
import { DeepseekHarness } from "../../src/dx/harness/deepseek/index.js";
import type { MemoryFile } from "../../src/dx/harness/file-store.js";
import { accountAiUsage } from "../../src/dx/metrics/ai-usage/ledger.js";
import { extractReadings } from "../../src/dx/metrics/cost/readings.js";
import type { TokenCategory } from "../../src/dx/model/ai.js";
import type { CollectCursor } from "../../src/dx/model/coverage.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { deriveUsageFacts } from "../../src/dx/usage/derive.js";
import {
  THREAD,
  memoryHarness as codexMemory,
  memoryRef,
  meta,
  readInput,
  record,
  sessionText,
  turnContext,
  turnStarted,
  usage,
} from "./harness/codex-support.js";
import {
  FIXTURES,
  batchesOf,
  fixtureSession,
  memoryFile,
  memoryHarness as deepseekMemory,
  zstdLog,
} from "./harness/deepseek-fixtures.js";

type Totals = Readonly<Record<TokenCategory, number>>;

const CATEGORIES: readonly TokenCategory[] = [
  "input",
  "cached-input",
  "cache-write",
  "output",
  "reasoning",
  "total",
];

const zero = (): Record<TokenCategory, number> => ({
  "cache-write": 0,
  "cached-input": 0,
  input: 0,
  other: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});

const usageTotals = (events: readonly DxEventEnvelope[]): Totals => {
  const sum = zero();

  for (const fact of deriveUsageFacts(events).facts) {
    const { tokens } = fact;
    sum.input += tokens.inputFresh ?? 0;
    sum["cached-input"] += tokens.cacheRead ?? 0;
    sum["cache-write"] += tokens.cacheWrite ?? 0;
    sum.output += tokens.output ?? 0;
    sum.reasoning += tokens.reasoning ?? 0;
    sum.total += tokens.total ?? 0;
  }

  return sum;
};

const readingTotals = (events: readonly DxEventEnvelope[]): Totals => {
  const sum = zero();

  for (const reading of extractReadings(events).tokens) {
    for (const category of CATEGORIES) {
      sum[category] += reading.tokens[category] ?? 0;
    }
  }

  return sum;
};

const ledgerTotals = (events: readonly DxEventEnvelope[]): Totals => {
  const sum = zero();

  for (const total of accountAiUsage(events).totals) {
    if (total.ledger === "tokens") {
      sum[total.category] += total.value;
    }
  }

  return sum;
};

const usageRequests = (events: readonly DxEventEnvelope[]): number =>
  deriveUsageFacts(events).facts.reduce((sum, fact) => sum + fact.requests, 0);

const expectAgreement = (events: readonly DxEventEnvelope[]) => {
  const expected = usageTotals(events);

  expect(readingTotals(events)).toStrictEqual(expected);
  expect(ledgerTotals(events)).toStrictEqual(expected);
  expect(accountAiUsage(events).requestCount).toBe(usageRequests(events));
  expect(
    extractReadings(events).tokens.filter(
      (reading) => Object.keys(reading.tokens).length > 0
    )
  ).toHaveLength(usageRequests(events));
};

const CODEX_FILE = `/home/user/.codex/sessions/2026/10/01/rollout-2026-10-01T12-54-00-${THREAD}.jsonl`;

const CODEX_TURN = "01a0f719-9000-7000-8000-000000000001";

const codexEvents = (text: string) =>
  Effect.gen(function* readCodex() {
    const harness = yield* CodexHarness;
    const batch = yield* harness.read(memoryRef(CODEX_FILE, text), readInput());

    return batch.events;
  }).pipe(
    Effect.provide(
      codexMemory({ files: [{ path: CODEX_FILE, text }], roots: [] })
    )
  );

const deepseekInput = (cursor: CollectCursor | null): ReadInput => ({
  context: emptyFlightContext,
  cursor,
  origin: "fixture",
});

const deepseekEvents = (files: readonly MemoryFile[]) =>
  Effect.gen(function* readDeepseek() {
    const harness = yield* DeepseekHarness;
    const refs = yield* harness.locate(everywhere);

    const batches = yield* Effect.forEach((ref: SessionRef) =>
      harness.read(ref, deepseekInput(null))
    )(refs);

    return batches.flatMap((batch) => batch.events);
  }).pipe(Effect.provide(deepseekMemory(files)));

const T0 = 1_790_000_000_000;

const SESSION = { cwd: "/home/user/work/repo", id: "session-a" };

type Json = string | number | boolean | null | readonly Json[] | JsonObject;

interface JsonObject {
  readonly [key: string]: Json;
}

const row = (seq: number, type: string, data: JsonObject): string =>
  JSON.stringify({ data, seq, time: T0 + seq * 1000, type });

const failedAttempt = (seq: number, input: number, cached: number) =>
  row(seq, "assistant/attempt", {
    step: 1,
    stream: [
      {
        chunk: {
          type: "usage",
          usage: {
            cacheReadTokens: cached,
            inputTokens: input,
            outputTokens: 5,
            totalTokens: input + cached + 5,
          },
        },
        time: T0 + seq * 1000,
        type: "chunk",
      },
      {
        chunk: {
          reason: { failure: { code: "PROVIDER_ERROR", message: "x" } },
          type: "finish",
        },
        time: T0 + seq * 1000,
        type: "chunk",
      },
    ],
    turn: 1,
  });

const replacedRows = [
  row(1, "turn/start", { turn: 1 }),
  row(2, "request/header", {
    header: {
      config: {
        model: "deepseek-flash",
        provider: "deepseek-official",
        reasoningEffort: "high",
      },
    },
    reason: "initial",
  }),
  failedAttempt(3, 10, 100),
  failedAttempt(4, 20, 200),
  row(91, "turn/end", { reason: { kind: "completed" }, turn: 1 }),
];

const header = JSON.stringify({
  createdAt: T0,
  cwd: SESSION.cwd,
  delegationDepth: 0,
  id: SESSION.id,
  isSeeded: false,
  type: "session",
  version: 4,
});

const readSplit = (bytes: Uint8Array, cursor: CollectCursor | null) =>
  Effect.gen(function* readOnce() {
    const harness = yield* DeepseekHarness;
    const [ref] = yield* harness.locate(everywhere);

    if (ref === undefined) {
      return yield* Effect.die("no session located");
    }

    return yield* harness.read(ref, deepseekInput(cursor));
  }).pipe(
    Effect.provide(
      deepseekMemory([
        memoryFile(SESSION, bytes, undefined, cursor === null ? 1 : 2),
      ])
    )
  );

describe("legacy ledger reads the same usage as dft usage", () => {
  it.effect("reads a Codex request's fresh input, not its raw input", () =>
    Effect.gen(function* codex() {
      const events = yield* codexEvents(
        sessionText(
          meta(0),
          turnStarted(1, CODEX_TURN),
          turnContext(2, CODEX_TURN),
          record(3, "resp_a", usage(1000, 800, 40)),
          record(4, "resp_b", usage(2000, 1500, 60))
        )
      );

      expect(usageTotals(events)).toMatchObject({
        "cached-input": 2300,
        input: 700,
        output: 100,
      });
      expectAgreement(events);
    })
  );

  it.effect("drops a DeepSeek request whose usage a later read replaced", () =>
    Effect.gen(function* replaced() {
      const before = zstdLog([[header], replacedRows.slice(0, 3)]);

      const after = zstdLog([
        [header],
        replacedRows.slice(0, 3),
        replacedRows.slice(3),
      ]);

      const first = yield* readSplit(before, null);
      const second = yield* readSplit(after, first.cursor);
      const events = [...first.events, ...second.events];

      expect(
        events.some((event) => event.payload.replacesRequestKey !== undefined)
      ).toBe(true);
      expect(usageTotals(events).total).toBe(225);
      expectAgreement(events);
    })
  );

  it.effect("agrees with usage facts on every DeepSeek fixture", () =>
    Effect.gen(function* fixtures() {
      const events = yield* deepseekEvents(
        FIXTURES.map((name) => {
          const session = fixtureSession(name);

          return memoryFile(session, zstdLog(batchesOf(session.lines)));
        })
      );

      expect(usageTotals(events).total).toBeGreaterThan(0);
      expectAgreement(events);
    })
  );
});
