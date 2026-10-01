import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ModelProvider } from "../../src/dx/harness/ids.js";
import { resolvePriceKey } from "../../src/dx/metrics/cost/price-book/aliases.js";
import type {
  PricedEstimate,
  PricedRequest,
  RequestEstimate,
} from "../../src/dx/metrics/cost/price-book/estimate.js";
import { PriceBook } from "../../src/dx/metrics/cost/price-book/service.js";
import type { PriceSheet } from "../../src/dx/metrics/cost/price-book/sheet.js";
import type {
  AiAttribution,
  AiTokens,
  AiUsage,
  ToolFigure,
} from "../../src/dx/model/attribution.js";
import { unknownTokens } from "../../src/dx/model/attribution.js";

const once = (rates: PriceSheet["models"][string][number]["rates"]) => [
  { effectiveFrom: null, rates },
];

const MAKER: PriceSheet = {
  id: "maker",
  models: {
    "claude-fable-5-1": [
      {
        effectiveFrom: null,
        rates: { "cached-input": 1, input: 10, output: 50 },
      },
      {
        effectiveFrom: "2026-09-15T00:00:00.000Z",
        rates: { "cached-input": 0.25, input: 10, output: 50 },
      },
    ],
    "claude-opus-5-5": once({
      "cache-write": 5,
      "cached-input": 0.2,
      input: 4,
      output: 20,
    }),
    "claude-sonnet-4-6": once({
      "cache-write": 3.75,
      "cached-input": 0.3,
      input: 3,
      output: 15,
    }),
    "claude-sonnet-5": once({
      "cache-write": 2.5,
      "cached-input": 0.2,
      input: 2,
      output: 10,
    }),
    "claude-sonnet-5-5": once({
      "cache-write": 3.75,
      "cached-input": 0.3,
      input: 3,
      output: 15,
    }),
    "gpt-5": once({ "cached-input": 0.125, input: 1.25, output: 10 }),
    "gpt-5.6-luna": once({
      "cache-write": 0.25,
      "cached-input": 0.02,
      input: 0.2,
      output: 1.2,
      tiers: [
        {
          aboveInputTokens: 272_000,
          "cache-write": 0.5,
          "cached-input": 0.04,
          input: 0.4,
          output: 1.8,
        },
      ],
    }),
    "gpt-6-astra": once({ "cached-input": 1, input: 10, output: 50 }),
    "gpt-6.1-sol": once({ "cached-input": 0.1, input: 2, output: 10 }),
  },
  source: "synthetic maker prices for tests",
  version: "2026-10-01",
};

const has = (key: string) => MAKER.models[key] !== undefined;

const tokens = (counts: Partial<AiTokens>): AiTokens => ({
  ...unknownTokens,
  ...counts,
});

interface RequestSpec {
  readonly at?: string;
  readonly figure?: ToolFigure;
  readonly harness?: AiAttribution["harness"];
  readonly model: string | null;
  readonly premiumRequests?: number;
  readonly provider: ModelProvider;
  readonly serviceTier?: string;
  readonly speed?: string;
  readonly tokens: Partial<AiTokens> | null;
  readonly via?: string;
  readonly webSearchRequests?: number;
}

const request = (spec: RequestSpec): PricedRequest => {
  const usage: AiUsage | null =
    spec.tokens === null && spec.figure === undefined
      ? null
      : {
          premiumRequests: spec.premiumRequests ?? null,
          requestKey: null,
          serviceTier: spec.serviceTier ?? null,
          speed: spec.speed ?? null,
          tokens: tokens(spec.tokens ?? {}),
          toolFigure: spec.figure ?? null,
          webSearchRequests: spec.webSearchRequests ?? null,
        };

  return {
    ai: {
      agentId: null,
      agentType: null,
      branchSource: "unassigned",
      channel: "session-file",
      cwd: null,
      effort: null,
      effortSource: null,
      harness: spec.harness ?? "claude-code",
      harnessVersion: null,
      model: spec.model,
      modelRaw: spec.model,
      parentSessionId: null,
      provider: spec.provider,
      sessionId: null,
      via: spec.via ?? null,
    },
    occurredAt: spec.at ?? "2026-10-01T10:00:00.000Z",
    usage,
  };
};

const priced = (estimate: RequestEstimate): PricedEstimate => {
  if (estimate.kind !== "priced") {
    throw new Error(`expected a price, got ${estimate.reason}`);
  }

  return estimate;
};

const usd = (estimate: RequestEstimate) => priced(estimate).usd;

const ONE_MILLION_IN_OUT = { inputFresh: 1_000_000, output: 1_000_000 };

describe("price key aliases", () => {
  it.each([
    ["claude-sonnet-5", "claude-sonnet-5"],
    ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["claude-sonnet-5.5", "claude-sonnet-5-5"],
    ["claude-sonnet-5-5[1m]", "claude-sonnet-5-5"],
    ["claude-sonnet-5-5-20260928", "claude-sonnet-5-5"],
    ["claude-5-5-sonnet-thinking", "claude-sonnet-5-5"],
    ["anthropic/claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["us.anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5"],
    ["cliproxy/factory/claude-sonnet-5", "claude-sonnet-5"],
    ["cliproxy/antigravity/claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["claude-fable-5.1", "claude-fable-5-1"],
    ["gpt-5.6-luna", "gpt-5.6-luna"],
    ["opencode-go/gpt-5.6-luna", "gpt-5.6-luna"],
    ["gpt-5-6-luna", "gpt-5.6-luna"],
    ["gpt-6.1-sol-xhigh", "gpt-6.1-sol"],
    ["gpt-6-astra", "gpt-6-astra"],
    ["gpt-5-codex", "gpt-5"],
  ])("%s prices as %s", (raw, key) => {
    expect(resolvePriceKey(raw, has)).toMatchObject({ key, kind: "key" });
  });

  it("reads a -fast suffix as fast mode on the base model", () => {
    expect(resolvePriceKey("factory/claude-opus-5-5-fast", has)).toEqual({
      impliedSpeed: "fast",
      key: "claude-opus-5-5",
      kind: "key",
    });
  });

  it.each([
    ["codex-auto-review", "OpenAI publishes no price"],
    ["auto", "no fixed model"],
    ["claude-luna", "router profile"],
    ["deepseek-v4.1-flash", "not guessed"],
    ["sonnet", "not guessed"],
  ])("%s stays unpriced", (raw, reason) => {
    const resolved = resolvePriceKey(raw, has);

    expect(resolved.kind).toBe("unpriced");
    expect(resolved.kind === "unpriced" ? resolved.reason : "").toContain(
      reason
    );
  });
});

it.layer(PriceBook.memory([MAKER]))("PriceBook estimate", (test) => {
  test.effect(
    "prices every Anthropic token part; reasoning stays inside output",
    () =>
      Effect.gen(function* pricesParts() {
        const book = yield* PriceBook;

        const estimate = priced(
          book.estimate(
            request({
              model: "claude-sonnet-5",
              provider: "anthropic",
              tokens: {
                cacheRead: 10_000,
                cacheWrite: 3000,
                cacheWrite1h: 1000,
                cacheWrite5m: 2000,
                inputFresh: 1000,
                output: 500,
                reasoning: 200,
              },
            })
          )
        );

        expect(
          estimate.lines.map((line) => [line.part, line.quantity, line.usd])
        ).toEqual([
          ["input", 1000, 0.002],
          ["cache-read", 10_000, 0.002],
          ["cache-write-5m", 2000, 0.005],
          ["cache-write-1h", 1000, 0.004],
          ["output", 500, 0.005],
        ]);
        expect(estimate.usd).toBe(0.018);
        expect(estimate.method).toBe("maker-price");
        expect(estimate.complete).toBe(true);
        expect(estimate.price).toEqual({
          effectiveFrom: null,
          key: "claude-sonnet-5",
          sheet: "maker",
          version: "2026-10-01",
        });
      })
  );

  test.effect("prices an unsplit cache write at the 5 minute rate", () =>
    Effect.gen(function* unsplitWrite() {
      const book = yield* PriceBook;

      const estimate = book.estimate(
        request({
          model: "claude-sonnet-5",
          provider: "anthropic",
          tokens: { cacheWrite: 1_000_000, inputFresh: 0, output: 0 },
        })
      );

      expect(usd(estimate)).toBe(2.5);
    })
  );

  test.effect("keeps claude-sonnet-5 and claude-sonnet-5-5 apart", () =>
    Effect.gen(function* separateModels() {
      const book = yield* PriceBook;

      const five = book.estimate(
        request({
          model: "claude-sonnet-5",
          provider: "anthropic",
          tokens: ONE_MILLION_IN_OUT,
        })
      );

      const fiveFive = book.estimate(
        request({
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          tokens: ONE_MILLION_IN_OUT,
        })
      );

      expect([usd(five), usd(fiveFive)]).toEqual([12, 18]);
    })
  );

  test.effect("switches the whole request to the long-context tier", () =>
    Effect.gen(function* longContext() {
      const book = yield* PriceBook;

      const short = priced(
        book.estimate(
          request({
            harness: "codex",
            model: "gpt-5.6-luna",
            provider: "openai",
            tokens: { cacheRead: 72_000, inputFresh: 200_000, output: 1000 },
          })
        )
      );

      const long = priced(
        book.estimate(
          request({
            harness: "codex",
            model: "gpt-5.6-luna",
            provider: "openai",
            tokens: { cacheRead: 72_001, inputFresh: 200_000, output: 1000 },
          })
        )
      );

      expect(short.contextTier).toBeNull();
      expect(short.usd).toBe(0.04264);
      expect(long.contextTier).toBe(272_000);
      expect(long.usd).toBe(0.08468004);
    })
  );

  test.effect(
    "applies the fast mode multiplier only where it is published",
    () =>
      Effect.gen(function* fastMode() {
        const book = yield* PriceBook;

        const field = priced(
          book.estimate(
            request({
              model: "claude-opus-5-5",
              provider: "anthropic",
              speed: "fast",
              tokens: ONE_MILLION_IN_OUT,
            })
          )
        );

        const suffix = book.estimate(
          request({
            model: "factory/claude-opus-5-5-fast",
            provider: "anthropic",
            tokens: ONE_MILLION_IN_OUT,
            via: "cliproxy",
          })
        );

        const unpublished = priced(
          book.estimate(
            request({
              model: "claude-sonnet-5",
              provider: "anthropic",
              speed: "fast",
              tokens: ONE_MILLION_IN_OUT,
            })
          )
        );

        expect([field.usd, field.multiplier, field.serviceTier]).toEqual([
          48,
          2,
          "fast",
        ]);
        expect(usd(suffix)).toBe(48);
        expect(unpublished.usd).toBe(12);
        expect(unpublished.complete).toBe(false);
        expect(unpublished.notes.join(" ")).toContain("fast tier");
      })
  );

  test.effect("applies Codex service tiers", () =>
    Effect.gen(function* serviceTiers() {
      const book = yield* PriceBook;

      const at = (serviceTier: string) =>
        usd(
          book.estimate(
            request({
              harness: "codex",
              model: "gpt-6.1-sol",
              provider: "openai",
              serviceTier,
              tokens: ONE_MILLION_IN_OUT,
            })
          )
        );

      expect(["default", "priority", "flex", "fast"].map(at)).toEqual([
        12, 24, 6, 24,
      ]);
    })
  );

  test.effect("prices Claude web searches per request", () =>
    Effect.gen(function* webSearch() {
      const book = yield* PriceBook;

      const claude = priced(
        book.estimate(
          request({
            model: "claude-sonnet-5",
            provider: "anthropic",
            tokens: { inputFresh: 0, output: 0 },
            webSearchRequests: 3,
          })
        )
      );

      const codex = priced(
        book.estimate(
          request({
            harness: "codex",
            model: "gpt-6.1-sol",
            provider: "openai",
            tokens: { inputFresh: 0, output: 0 },
            webSearchRequests: 2,
          })
        )
      );

      expect(claude.lines).toEqual([
        {
          part: "web-search",
          quantity: 3,
          unit: "requests",
          usd: 0.03,
          usdPerUnit: 0.01,
        },
      ]);
      expect(codex.usd).toBe(0);
      expect(codex.notes.join(" ")).toContain("no public price for openai");
    })
  );

  test.effect(
    "prices a gateway request at the maker's price, not the gateway's",
    () =>
      Effect.gen(function* gateway() {
        const book = yield* PriceBook;

        const direct = book.estimate(
          request({
            harness: "pi",
            model: "gpt-5.6-luna",
            provider: "openai",
            tokens: ONE_MILLION_IN_OUT,
          })
        );

        const viaGateway = priced(
          book.estimate(
            request({
              harness: "pi",
              model: "cliproxy/gpt-5.6-luna",
              provider: "openai",
              tokens: ONE_MILLION_IN_OUT,
              via: "cliproxy",
            })
          )
        );

        expect(viaGateway.usd).toBe(usd(direct));
        expect(viaGateway.notes).toContain(
          "priced at the maker's public price, not cliproxy's"
        );
      })
  );

  test.effect("counts Copilot premium requests beside the maker price", () =>
    Effect.gen(function* copilot() {
      const book = yield* PriceBook;

      const withTokens = priced(
        book.estimate(
          request({
            harness: "omp",
            model: "claude-sonnet-5",
            premiumRequests: 1,
            provider: "anthropic",
            tokens: ONE_MILLION_IN_OUT,
            via: "github-copilot",
          })
        )
      );

      const premiumOnly = priced(
        book.estimate(
          request({
            harness: "omp",
            model: "claude-sonnet-5",
            premiumRequests: 2,
            provider: "anthropic",
            tokens: { total: 0 },
            via: "github-copilot",
          })
        )
      );

      expect([withTokens.method, withTokens.usd]).toEqual(["maker-price", 12]);
      expect(withTokens.premiumRequests).toEqual({ count: 1, usd: 0.04 });
      expect([premiumOnly.method, premiumOnly.usd]).toEqual([
        "copilot-premium-request",
        0.08,
      ]);
    })
  );

  test.effect("costs nothing on a local runtime and says so", () =>
    Effect.gen(function* local() {
      const book = yield* PriceBook;

      const ollama = priced(
        book.estimate(
          request({
            harness: "opencode",
            model: "qwen3-coder",
            provider: "qwen",
            tokens: ONE_MILLION_IN_OUT,
            via: "ollama",
          })
        )
      );

      const unknownMaker = priced(
        book.estimate(
          request({
            harness: "pi",
            model: "my-finetune",
            provider: "local",
            tokens: ONE_MILLION_IN_OUT,
          })
        )
      );

      expect([ollama.method, ollama.usd]).toEqual(["local", 0]);
      expect(ollama.notes).toEqual(["runs locally on ollama; costs 0"]);
      expect([unknownMaker.method, unknownMaker.usd]).toEqual(["local", 0]);
    })
  );

  test.effect(
    "never guesses a price for an unknown model or a bare total",
    () =>
      Effect.gen(function* noPrice() {
        const book = yield* PriceBook;

        expect(
          book.estimate(
            request({
              harness: "deepseek",
              model: "deepseek-v4.1-flash",
              provider: "deepseek",
              tokens: ONE_MILLION_IN_OUT,
            })
          )
        ).toEqual({
          detail: "no public price for deepseek-v4.1-flash; not guessed",
          kind: "no-price",
          premiumRequests: null,
          reason: "model-unpriced",
        });

        expect(
          book.estimate(
            request({
              model: "claude-sonnet-5",
              provider: "anthropic",
              tokens: { total: 5000 },
            })
          )
        ).toMatchObject({ kind: "no-price", reason: "total-only" });
      })
  );

  test.effect("uses the price in force at the request's time", () =>
    Effect.gen(function* dated() {
      const book = yield* PriceBook;

      const at = (when: string) =>
        priced(
          book.estimate(
            request({
              at: when,
              model: "claude-fable-5-1",
              provider: "anthropic",
              tokens: { cacheRead: 1_000_000, inputFresh: 0, output: 0 },
            })
          )
        );

      const before = at("2026-09-01T00:00:00.000Z");
      const after = at("2026-09-20T00:00:00.000Z");

      expect([before.usd, after.usd]).toEqual([1, 0.25]);
      expect(after.price?.effectiveFrom).toBe("2026-09-15T00:00:00.000Z");
    })
  );

  test.effect("keeps Cursor's list price for Auto", () =>
    Effect.gen(function* cursorAuto() {
      const book = yield* PriceBook;

      const estimate = priced(
        book.estimate(
          request({
            figure: { amount: 0.12, currency: "USD", kind: "list-price" },
            harness: "cursor",
            model: "auto",
            provider: "cursor",
            tokens: ONE_MILLION_IN_OUT,
            via: "cursor",
          })
        )
      );

      expect([estimate.method, estimate.usd]).toEqual([
        "cursor-list-price",
        0.12,
      ]);
    })
  );

  test.effect(
    "keeps estimate, tool's figure and billed in separate ledgers",
    () =>
      Effect.gen(function* ledgers() {
        const book = yield* PriceBook;

        const pi = book.ledgers(
          request({
            figure: { amount: 0.5, currency: "USD", kind: "api-equivalent" },
            harness: "pi",
            model: "gpt-6-astra",
            provider: "openai",
            tokens: ONE_MILLION_IN_OUT,
          })
        );

        const billed = book.ledgers(
          request({
            figure: { amount: 0.07, currency: "USD", kind: "charge" },
            harness: "cursor",
            model: "claude-sonnet-5",
            provider: "anthropic",
            tokens: ONE_MILLION_IN_OUT,
          })
        );

        expect(usd(pi.estimate)).toBe(60);
        expect(pi.toolFigure).toEqual({
          amount: 0.5,
          currency: "USD",
          kind: "api-equivalent",
        });
        expect(pi.billed).toBeNull();
        expect(usd(billed.estimate)).toBe(12);
        expect(billed.toolFigure).toBeNull();
        expect(billed.billed?.amount).toBe(0.07);
      })
  );
});

const USER: PriceSheet = {
  id: "user",
  models: {
    "claude-sonnet-5": once({ input: 1, output: 5 }),
  },
  source: "user-supplied prices",
  version: "2026-10-01",
};

it.layer(PriceBook.memory([USER, MAKER]))("PriceBook sheet order", (test) => {
  test.effect("lets an earlier sheet such as user prices win", () =>
    Effect.gen(function* userWins() {
      const book = yield* PriceBook;

      const sonnet = priced(
        book.estimate(
          request({
            model: "claude-sonnet-5",
            provider: "anthropic",
            tokens: ONE_MILLION_IN_OUT,
          })
        )
      );

      expect([sonnet.usd, sonnet.price?.sheet]).toEqual([6, "user"]);
      expect(book.lookup("gpt-6-astra", null)).toMatchObject({
        kind: "found",
        price: { sheet: "maker" },
      });
      expect(book.label).toBe("user@2026-10-01+maker@2026-10-01");
    })
  );
});
