// @effect-diagnostics nodeBuiltinImport:off -- This test owns temporary price catalog cache folders.
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PriceOverrides } from "../../src/dx/metrics/cost/price-book/book.js";
import type {
  PricedRequest,
  RequestEstimate,
} from "../../src/dx/metrics/cost/price-book/estimate.js";
import type { Catalog } from "../../src/dx/metrics/cost/price-catalog/catalog.js";
import { parseModelsDev } from "../../src/dx/metrics/cost/price-catalog/catalog.js";
import type { CatalogFetch } from "../../src/dx/metrics/cost/price-catalog/provider.js";
import type { AiTokens } from "../../src/dx/model/attribution.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";
import { PriceBook } from "./price-book-layer.js";

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

interface TierSpec {
  readonly at?: string;
  readonly model: string;
  readonly provider: "anthropic" | "deepseek" | "openai";
  readonly serviceTier?: string;
  readonly speed?: string;
  readonly tokens?: Partial<AiTokens>;
}

const MILLION_EACH = { inputFresh: 1_000_000, output: 1_000_000 };

const tiered = (spec: TierSpec): PricedRequest => {
  const base = request(
    "codex",
    "openai",
    spec.model,
    spec.tokens ?? MILLION_EACH,
    spec.at ?? "2026-10-01T12:00:00.000Z"
  );

  return {
    ...base,
    ai: base.ai === null ? null : { ...base.ai, provider: spec.provider },
    usage:
      base.usage === null
        ? null
        : {
            ...base.usage,
            serviceTier: spec.serviceTier ?? "standard",
            speed: spec.speed ?? "standard",
          },
  };
};

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
        expect(book.label).toBe("maker@2026-10-01+bundled@2026-10-01");
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

  test.effect(
    "prices models the catalog lacks or misprices at the maker's page",
    () =>
      Effect.gen(function* makerPrices() {
        const book = yield* PriceBook;

        const at = (model: string, provider: TierSpec["provider"]) =>
          usdOf(book.estimate(tiered({ model, provider })));

        expect({
          codexMini: at("gpt-5-codex-mini", "openai"),
          haiku35: at("claude-3-5-haiku-20241022", "anthropic"),
          opus4: at("claude-opus-4-20250514", "anthropic"),
          opus41: at("claude-opus-4-1-20250805", "anthropic"),
          sonnet4: at("claude-sonnet-4-20250514", "anthropic"),
          v4pro: at("deepseek-v4-pro", "deepseek"),
        }).toEqual({
          codexMini: 2.25,
          haiku35: 4.8,
          opus4: 90,
          opus41: 90,
          sonnet4: 18,
          v4pro: 2.64,
        });
      })
  );

  test.effect("doubles DeepSeek prices in its weekday peak hours", () =>
    Effect.gen(function* deepseekPeak() {
      const book = yield* PriceBook;

      const at = (model: string, when: string) =>
        book.estimate(tiered({ at: when, model, provider: "deepseek" }));

      const peak = at("deepseek-v4-pro", "2026-10-01T07:30:00.000Z");

      expect(peak).toMatchObject({ serviceTier: "peak", usd: 5.28 });
      expect(
        [
          "2026-10-01T02:00:00.000Z",
          "2026-10-01T05:00:00.000Z",
          "2026-10-01T09:59:00.000Z",
          "2026-10-01T10:00:00.000Z",
          "2026-10-03T07:30:00.000Z",
        ].map((when) => usdOf(at("deepseek-flash", when)))
      ).toEqual([1.5, 0.75, 1.5, 0.75, 0.75]);
    })
  );

  test.effect("uses each model's published fast mode price", () =>
    Effect.gen(function* fastMode() {
      const book = yield* PriceBook;

      const fast = (model: string) =>
        book.estimate(tiered({ model, provider: "anthropic", speed: "fast" }));

      expect(fast("claude-opus-4-8")).toMatchObject({
        complete: true,
        usd: 60,
      });
      expect(fast("claude-opus-4-6")).toMatchObject({
        complete: true,
        usd: 30,
      });
    })
  );

  test.effect(
    "prices Opus 4.6 and 4.7 fast requests at the fast price in force when they ran",
    () =>
      Effect.gen(function* retiredFastMode() {
        const book = yield* PriceBook;

        const fast = (model: string, at: string) =>
          book.estimate(
            tiered({ at, model, provider: "anthropic", speed: "fast" })
          );

        expect(
          [
            fast("claude-opus-4-6", "2026-02-10T12:00:00.000Z"),
            fast("claude-opus-4-6", "2026-03-10T12:00:00.000Z"),
            fast("claude-opus-4-6", "2026-07-10T12:00:00.000Z"),
            fast("claude-opus-4-7", "2026-05-20T12:00:00.000Z"),
          ].map((estimate) => ({
            complete: estimate.kind === "priced" && estimate.complete,
            usd: usdOf(estimate),
          }))
        ).toEqual([
          { complete: true, usd: 90 },
          { complete: true, usd: 180 },
          { complete: true, usd: 30 },
          { complete: true, usd: 180 },
        ]);
      })
  );

  test.effect("uses each OpenAI model's own Fast and Ultrafast price", () =>
    Effect.gen(function* openaiTiers() {
      const book = yield* PriceBook;

      const tokens = { inputFresh: 100_000, output: 100_000 };

      const at = (model: string, serviceTier: string) =>
        usdOf(
          book.estimate(
            tiered({ model, provider: "openai", serviceTier, tokens })
          )
        );

      expect([
        at("gpt-5.5", "priority"),
        at("gpt-5.5", "fast"),
        at("gpt-5.6-sol", "priority"),
        at("o4-mini", "fast"),
        at("gpt-4o", "fast"),
        at("gpt-6-astra", "ultrafast"),
      ]).toEqual([8.75, 8.75, 4.8, 1, 2.125, 36]);
      expect(
        book.estimate(
          tiered({
            model: "gpt-5.5",
            provider: "openai",
            serviceTier: "ultrafast",
            tokens,
          })
        )
      ).toMatchObject({ complete: false, usd: 3.5 });
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

const laterCache = folder("later");

fs.writeFileSync(
  path.join(laterCache, "models.dev-2027-01-05.json"),
  JSON.stringify(catalogOn("2027-01-05T08:00:00.000Z", 4))
);

it.layer(
  PriceBook.fromCatalog({
    cacheDir: laterCache,
    fetchJson: offline,
    nowMs: Date.parse("2027-01-05T12:00:00.000Z"),
  })
)("PriceBook whose first catalog came after a price change", (test) => {
  test.effect(
    "prices earlier requests at the bundled snapshot, not the newer price",
    () =>
      Effect.gen(function* firstFetch() {
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

        expect([
          at("2026-10-15T00:00:00.000Z"),
          at("2027-02-01T00:00:00.000Z"),
        ]).toEqual([2, 4]);
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
          "user@2026-10-01+maker@2026-10-01+models.dev@2026-09-20+bundled@2026-10-01"
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
