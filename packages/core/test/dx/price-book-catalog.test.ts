// @effect-diagnostics nodeBuiltinImport:off -- This test owns temporary price catalog cache folders.
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type {
  PricedRequest,
  RequestEstimate,
} from "../../src/dx/metrics/cost/price-book/estimate.js";
import {
  PriceBook,
  PriceOverrides,
} from "../../src/dx/metrics/cost/price-book/service.js";
import type { Catalog } from "../../src/dx/metrics/cost/price-catalog/catalog.js";
import { parseModelsDev } from "../../src/dx/metrics/cost/price-catalog/catalog.js";
import type { CatalogFetch } from "../../src/dx/metrics/cost/price-catalog/provider.js";
import type { AiTokens } from "../../src/dx/model/attribution.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dft-price-book-"));

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const folder = (name: string): string => {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });

  return dir;
};

const fetches: string[] = [];

// @effect-diagnostics-next-line asyncFunction:off -- CatalogFetch is the platform fetch seam and is promise-shaped.
const offline: CatalogFetch = async (url) => {
  fetches.push(url);

  return await Promise.reject(new Error("tests never reach the network"));
};

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

const request = (
  harness: "claude-code" | "codex",
  provider: "anthropic" | "openai",
  model: string,
  counts: Partial<AiTokens>,
  occurredAt = "2026-10-01T10:53:00.000Z"
): PricedRequest => ({
  ai: {
    agentId: null,
    agentType: null,
    branchSource: "harness-recorded",
    channel: "session-file",
    cwd: null,
    effort: null,
    effortSource: null,
    harness,
    harnessVersion: null,
    model,
    modelRaw: model,
    parentSessionId: null,
    provider,
    sessionId: null,
    via: null,
  },
  occurredAt,
  usage: {
    premiumRequests: null,
    requestKey: null,
    serviceTier: "standard",
    speed: "standard",
    tokens: { ...unknownTokens, ...counts },
    toolFigure: null,
  },
});

const usdOf = (estimate: RequestEstimate) =>
  estimate.kind === "priced" ? estimate.usd : null;

it.layer(
  PriceBook.fromCatalog({
    cacheDir: folder("empty"),
    fetchJson: offline,
    nowMs: NOW,
  })
)("PriceBook over the bundled catalog snapshot", (test) => {
  test.effect(
    "falls back to the bundled snapshot when offline with no cache",
    () =>
      Effect.gen(function* bundled() {
        const book = yield* PriceBook;

        expect(book.origin).toBe("bundled");
        expect(book.label).toBe("bundled@2026-10-01");
        expect(book.warnings.join(" ")).toContain("bundled catalog snapshot");
        expect(fetches.length).toBeGreaterThan(0);
      })
  );

  test.effect(
    "matches Claude Code's own figure for a real session's totals",
    () =>
      Effect.gen(function* claudeCode() {
        const book = yield* PriceBook;

        const estimate = book.estimate(
          request("claude-code", "anthropic", "claude-sonnet-5", {
            cacheRead: 304_536,
            cacheWrite: 28_712,
            cacheWrite1h: 28_712,
            cacheWrite5m: 0,
            inputFresh: 12,
            output: 996,
          })
        );

        expect(usdOf(estimate)).toBe(0.1857392);
      })
  );

  test.effect("prices a real Codex run on its catalog key", () =>
    Effect.gen(function* codex() {
      const book = yield* PriceBook;

      const estimate = book.estimate(
        request("codex", "openai", "gpt-5.6-luna", {
          cacheRead: 55_296,
          inputFresh: 28_048,
          output: 686,
          reasoning: 225,
        })
      );

      expect(usdOf(estimate)).toBe(0.00753872);
    })
  );

  test.effect("reads long-context tiers from the snapshot", () =>
    Effect.gen(function* tiers() {
      const book = yield* PriceBook;

      const estimate = book.estimate(
        request("codex", "openai", "gpt-6.1-sol", {
          inputFresh: 300_000,
          output: 0,
        })
      );

      expect(estimate).toMatchObject({ contextTier: 272_000, usd: 1.2 });
    })
  );
});

const catalogOn = (fetchedAt: string, input: number): Catalog => ({
  fetchedAt,
  models: {
    "claude-sonnet-5": {
      "cache-write": input * 1.25,
      "cached-input": input / 10,
      input,
      output: input * 5,
      reasoning: 0,
      tiers: [],
    },
  },
  source: "models.dev",
});

const versionedCache = folder("versioned");

for (const catalog of [
  catalogOn("2026-09-01T08:00:00.000Z", 3),
  catalogOn("2026-09-20T08:00:00.000Z", 2),
]) {
  fs.writeFileSync(
    path.join(
      versionedCache,
      `models.dev-${catalog.fetchedAt.slice(0, 10)}.json`
    ),
    JSON.stringify(catalog)
  );
}

const versionedBook = PriceBook.fromCatalog({
  cacheDir: versionedCache,
  fetchJson: offline,
  nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
});

it.layer(versionedBook)("PriceBook over cached catalog snapshots", (test) => {
  test.effect("prices each request at the snapshot in force at its time", () =>
    Effect.gen(function* versions() {
      const book = yield* PriceBook;

      const at = (when: string) =>
        usdOf(
          book.estimate(
            request(
              "claude-code",
              "anthropic",
              "claude-sonnet-5",
              { inputFresh: 1_000_000, output: 0 },
              when
            )
          )
        );

      expect(book.origin).toBe("cache");
      expect([
        at("2026-08-01T00:00:00.000Z"),
        at("2026-09-10T00:00:00.000Z"),
        at("2026-09-25T00:00:00.000Z"),
      ]).toEqual([3, 3, 2]);
    })
  );
});

const userPrices = Layer.succeed(PriceOverrides, [
  {
    id: "user",
    models: {
      "claude-sonnet-5": [
        { effectiveFrom: null, rates: { input: 1, output: 1 } },
      ],
    },
    source: "user-supplied prices",
    version: "2026-10-01",
  },
]);

it.layer(versionedBook.pipe(Layer.provide(userPrices)))(
  "PriceBook user price hook",
  (test) => {
    test.effect("puts user-supplied prices ahead of the catalog", () =>
      Effect.gen(function* overrides() {
        const book = yield* PriceBook;

        expect(book.label).toBe(
          "user@2026-10-01+models.dev@2026-09-20+bundled@2026-10-01"
        );
        expect(
          usdOf(
            book.estimate(
              request("claude-code", "anthropic", "claude-sonnet-5", {
                inputFresh: 1_000_000,
                output: 0,
              })
            )
          )
        ).toBe(1);
      })
    );
  }
);

describe("models.dev catalog parsing", () => {
  it("keeps long-context tiers and first-party makers only", () => {
    const raw = JSON.stringify({
      anthropic: {
        models: {
          "claude-opus-5-5": {
            cost: { cache_read: 0.2, cache_write: 5, input: 4, output: 20 },
          },
        },
      },
      openai: {
        models: {
          "gpt-6.1-sol": {
            cost: {
              cache_read: 0.1,
              input: 2,
              output: 10,
              tiers: [
                {
                  cache_read: 0.2,
                  input: 4,
                  output: 15,
                  tier: { size: 272_000, type: "context" },
                },
              ],
            },
          },
        },
      },
      openrouter: {
        models: {
          "gpt-6.1-sol": { cost: { input: 9, output: 99 } },
        },
      },
    });

    const catalog = parseModelsDev(raw, "2026-10-01T00:00:00.000Z");

    expect(Object.keys(catalog.models).toSorted()).toEqual([
      "claude-opus-5-5",
      "gpt-6.1-sol",
    ]);
    expect(catalog.models["gpt-6.1-sol"]?.tiers).toEqual([
      {
        aboveInputTokens: 272_000,
        "cache-write": null,
        "cached-input": 0.2,
        input: 4,
        output: 15,
      },
    ]);
  });
});
