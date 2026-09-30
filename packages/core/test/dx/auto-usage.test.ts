// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed auto-usage fixture and uses a throwaway home dir in the OS temp dir.
// @effect-diagnostics asyncFunction:off -- The fakes implement the promise-based fetch seams the collector and price provider wrap in Effect.tryPromise.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { FetchLike } from "../../src/dx/collectors/cursor-usage-api/client.js";
import { redact } from "../../src/dx/collectors/cursor-usage-api/client.js";
import {
  makeCursorUsageApiCollector,
  statePath,
} from "../../src/dx/collectors/cursor-usage-api/collector.js";
import { sessionFromToken } from "../../src/dx/collectors/cursor-usage-api/session.js";
import type { CursorSession } from "../../src/dx/collectors/cursor-usage-api/session.js";
import {
  catalogPriceTable,
  expandForModels,
  parseLiteLlm,
  parseModelsDev,
  resolveModel,
} from "../../src/dx/metrics/cost/price-catalog/catalog.js";
import { loadPriceProvider } from "../../src/dx/metrics/cost/price-catalog/provider.js";
import {
  matchSlug,
  stripSlugParams,
} from "../../src/dx/metrics/cost/price-catalog/slug.js";
import { cursorPriceTable202609 } from "../../src/dx/metrics/cost/price-tables/cursor-2026-09.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { makeSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";

const fixturePages = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pages: Schema.Array(Schema.Json) }))
)(
  readFileSync(
    fileURLToPath(
      new URL("fixtures/auto-usage/api-pages.json", import.meta.url)
    ),
    "utf-8"
  )
);

const SentBodySchema = Schema.fromJsonString(
  Schema.Struct({ page: Schema.Finite, startDate: Schema.String })
);

type SentBody = typeof SentBodySchema.Type;

const fakeJwt = (sub: string): string =>
  [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(JSON.stringify({ sub })).toString("base64url"),
    "FIXTURESECRETSIGNATURE",
  ].join(".");

const TOKEN = fakeJwt("fixture-oauth|user_FIXTURE");

const SESSION: CursorSession = { accessToken: TOKEN, userId: "user_FIXTURE" };

interface Recorded {
  readonly bodies: SentBody[];
  readonly cookies: string[];
  readonly urls: string[];
}

const fakeFetch =
  (recorded: Recorded, status = 200): FetchLike =>
  async (url, init) => {
    recorded.urls.push(url);
    recorded.cookies.push(init.headers.cookie ?? "");
    const body = Schema.decodeUnknownSync(SentBodySchema)(init.body);
    recorded.bodies.push(body);

    await Promise.resolve();

    const page = fixturePages.pages[body.page - 1] ?? {
      totalUsageEventsCount: 3,
      usageEventsDisplay: [],
    };

    return {
      ok: status === 200,
      status,
      text: async () =>
        await Promise.resolve(
          status === 200 ? JSON.stringify(page) : `denied for ${TOKEN}`
        ),
    };
  };

const withHome = <A, E, R>(use: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "dft-auto-usage-"))),
    use,
    (home) =>
      Effect.sync(() => {
        rmSync(home, { force: true, recursive: true });
      })
  );

const collectWith = (
  home: string,
  recorded: Recorded,
  options: {
    readonly env?: Record<string, string>;
    readonly session?: CursorSession | null;
    readonly status?: number;
  } = {}
) =>
  makeCursorUsageApiCollector({
    env: options.env ?? {},
    fetchImpl: fakeFetch(recorded, options.status),
    home,
    pageSize: 2,
    readSession: () =>
      Effect.succeed(options.session === undefined ? SESSION : options.session),
  }).collect({
    adapterId: "cursor-usage-api",
    context: emptyFlightContext,
    cursor: null,
    origin: "live",
    scratchDir: null,
    selectedInput: null,
  });

const newRecorded = (): Recorded => ({ bodies: [], cookies: [], urls: [] });

describe("cursor usage API collector (auto-usage)", () => {
  it.effect("paginates, maps dashboard-json events and stores a cursor", () =>
    withHome((home) =>
      Effect.gen(function* paged() {
        const recorded = newRecorded();
        const batch = yield* collectWith(home, recorded);
        yield* Schema.decodeEffect(EventBatchSchema)(batch);

        expect(recorded.urls).toHaveLength(2);
        expect(
          recorded.urls.every((url) => url.startsWith("https://cursor.com/"))
        ).toBe(true);
        expect(batch.events).toHaveLength(3);
        const [auto, opus] = batch.events;
        expect(auto?.payload.sourceKind).toBe("dashboard-json");
        expect(auto?.acquisition).toBe("api");
        expect(auto?.context.worktreePath).toBeNull();
        expect(auto?.context.repoCommonDir).toBeNull();
        expect(auto?.payload.model).toBe("default");
        expect(auto?.payload.chargedUsd).toBe(0.1141);
        expect(auto?.identity.sessionId).toBe("conv-fixture-1");
        expect(opus?.payload.model).toBe("claude-opus-5-5-high-thinking");
        expect(opus?.payload.tokens).toEqual({ input: 500, output: 100 });
        expect(batch.cursor?.value).toBe("1790748000000");
        expect(readFileSync(statePath(home), "utf-8")).toContain(
          "1790748000000"
        );

        const again = newRecorded();
        const second = yield* collectWith(home, again);
        const firstIds = batch.events.map((event) => event.eventId);
        expect(second.events.map((event) => event.eventId)).toEqual(firstIds);
        const startDate = Number(again.bodies[0]?.startDate);
        expect(startDate).toBe(1_790_748_000_000 - 60 * 60 * 1000);
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("never lets the token reach events, coverage or errors", () =>
    withHome((home) =>
      Effect.gen(function* redaction() {
        const recorded = newRecorded();
        const batch = yield* collectWith(home, recorded);
        expect(JSON.stringify(batch)).not.toContain("FIXTURESECRETSIGNATURE");
        expect(readFileSync(statePath(home), "utf-8")).not.toContain(TOKEN);
        expect(recorded.cookies[0]).toBe(
          `WorkosCursorSessionToken=user_FIXTURE%3A%3A${TOKEN}`
        );

        const failure = yield* collectWith(home, newRecorded(), {
          status: 401,
        }).pipe(Effect.flip);

        expect(JSON.stringify(failure)).not.toContain("FIXTURESECRETSIGNATURE");
        expect(failure.message).toContain("not logged in");
        expect(redact(`x ${TOKEN} y`, SESSION)).toBe("x <redacted> y");
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("reports not logged in and honours DFT_CURSOR_USAGE=off", () =>
    withHome((home) =>
      Effect.gen(function* gates() {
        const recorded = newRecorded();

        const missing = yield* collectWith(home, recorded, {
          session: null,
        }).pipe(Effect.flip);

        expect(missing.message).toBe("unavailable: not logged in");

        const off = yield* collectWith(home, recorded, {
          env: { DFT_CURSOR_USAGE: "off" },
        }).pipe(Effect.flip);

        expect(off.message).toContain("DFT_CURSOR_USAGE=off");
        expect(recorded.urls).toHaveLength(0);
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it("derives the user id from the JWT sub claim", () => {
    expect(sessionFromToken(`"${TOKEN}"`)).toEqual(SESSION);
    expect(sessionFromToken("not-a-jwt")).toBeNull();
    expect(sessionFromToken(null)).toBeNull();
  });
});

const MODELS_DEV = {
  anthropic: {
    models: {
      "claude-haiku-9": {
        cost: { cache_read: 0.1, cache_write: 1.25, input: 1, output: 5 },
      },
      "claude-opus-5-5": {
        cost: { cache_read: 0.3, cache_write: 6, input: 6, output: 30 },
      },
    },
  },
  openai: { models: { "gpt-9.1-test": { cost: { input: 2, output: 16 } } } },
  "random-reseller": {
    models: { "claude-haiku-9": { cost: { input: 99, output: 99 } } },
  },
};

describe("price catalog (auto-usage)", () => {
  it("strips effort, thinking, fast and bracket params from slugs", () => {
    expect(stripSlugParams("claude-opus-5-5-high-thinking")).toBe(
      "claude-opus-5-5"
    );
    expect(stripSlugParams("gpt-9.1-test[effort=high,fast=true]")).toBe(
      "gpt-9.1-test"
    );
    expect(stripSlugParams("gpt-5-high-fast")).toBe("gpt-5");
  });

  it("maps slugs to catalog ids and never guesses", () => {
    const ids = new Set([
      "claude-opus-5-5",
      "gpt-9.1-test",
      "claude-sonnet-4-5",
    ]);

    expect(matchSlug("claude-opus-5-5-high", ids)).toEqual({
      catalogId: "claude-opus-5-5",
      kind: "matched",
    });
    expect(matchSlug("claude-4.5-sonnet-thinking", ids)).toEqual({
      catalogId: "claude-sonnet-4-5",
      kind: "matched",
    });
    expect(matchSlug("default", ids).kind).toBe("unavailable");
    const mystery = matchSlug("mystery-model-7", ids);

    expect(mystery.kind === "unavailable" ? mystery.reason : "").toContain(
      "not guessed"
    );
  });

  it("parses models.dev first-party providers and LiteLLM per-token rates", () => {
    const catalog = parseModelsDev(
      JSON.stringify(MODELS_DEV),
      "2026-09-30T10:00:00.000Z"
    );

    expect(catalog.models["claude-haiku-9"]?.input).toBe(1);
    expect(catalog.models["gpt-9.1-test"]?.["cached-input"]).toBeNull();

    const lite = parseLiteLlm(
      JSON.stringify({
        "bedrock/claude-haiku-9": { input_cost_per_token: 1 },
        "claude-haiku-9": {
          cache_read_input_token_cost: 1e-7,
          input_cost_per_token: 1e-6,
          output_cost_per_token: 5e-6,
        },
      }),
      "2026-09-30T10:00:00.000Z"
    );

    expect(lite.models["claude-haiku-9"]).toMatchObject({
      "cached-input": 0.1,
      input: 1,
      output: 5,
    });
    expect(Object.keys(lite.models)).toEqual(["claude-haiku-9"]);
  });

  it("lets the bundled Cursor table win and fills gaps from the catalog", () => {
    const table = catalogPriceTable(
      parseModelsDev(JSON.stringify(MODELS_DEV), "2026-09-30T10:00:00.000Z"),
      cursorPriceTable202609
    );

    expect(table.id).toBe("models.dev");
    expect(table.version).toBe("2026-09-30");
    const opus = resolveModel(table, "claude-opus-5-5-high-thinking");
    expect(opus).toMatchObject({ kind: "priced", rates: { input: 4 } });
    const sol = resolveModel(table, "gpt-9.1-test-high");
    expect(sol).toMatchObject({ kind: "priced", rates: { input: 2 } });
    expect(resolveModel(table, "default").kind).toBe("unavailable");
    const expanded = expandForModels(table, ["gpt-9.1-test-high", "default"]);
    expect(expanded.models["gpt-9.1-test-high"]?.output).toBe(16);
    expect(expanded.models.default).toBeUndefined();
  });

  it.effect("refreshes after 24h, falls back to cache, then to bundled", () =>
    withHome((home) =>
      Effect.gen(function* selection() {
        const cacheDir = path.join(home, "price-catalog");
        const day = Date.parse("2026-09-30T10:00:00.000Z");
        let calls = 0;

        const online = async () => {
          calls += 1;

          return await Promise.resolve(JSON.stringify(MODELS_DEV));
        };

        const offline = async () => {
          calls += 1;

          await Promise.resolve();

          throw new Error("offline");
        };

        const fresh = yield* loadPriceProvider({
          cacheDir,
          fetchJson: online,
          nowMs: day,
        });

        expect(fresh.origin).toBe("fresh");
        expect(
          readFileSync(
            path.join(cacheDir, "models.dev-2026-09-30.json"),
            "utf-8"
          )
        ).toContain("claude-haiku-9");

        const cached = yield* loadPriceProvider({
          cacheDir,
          fetchJson: offline,
          nowMs: day + 1000,
        });

        expect(cached.origin).toBe("cache");
        expect(calls).toBe(1);

        const stale = yield* loadPriceProvider({
          cacheDir,
          fetchJson: offline,
          nowMs: day + 25 * 60 * 60 * 1000,
        });

        expect(stale.origin).toBe("cache");
        expect(stale.warnings[0]).toContain("offline");

        const bundled = yield* loadPriceProvider({
          cacheDir: path.join(home, "empty"),
          fetchJson: offline,
          nowMs: day,
        });

        expect(bundled.origin).toBe("bundled");
        expect(bundled.table.id).toBe("cursor");
      })
    )
  );

  it.effect(
    "migrates an old-key store once: replaces adapter rows, no double count",
    () =>
      withHome((home) =>
        Effect.gen(function* migrated() {
          const opened = makeSqliteEventStore({
            kind: "live",
            path: path.join(home, "store.sqlite"),
          });

          const fresh = yield* collectWith(home, newRecorded());

          const collapsed = {
            ...fresh,
            events: fresh.events.map((event) => ({
              ...event,
              eventId: EventIdSchema.make(
                `old-${event.identity.sessionId ?? ""}`
              ),
            })),
          };

          yield* opened.service.append(collapsed);
          mkdirSync(path.dirname(statePath(home)), { recursive: true });
          writeFileSync(
            statePath(home),
            `${JSON.stringify({ lastTimestampMs: 1_790_748_000_000 })}\n`
          );

          const migration = yield* collectWith(home, newRecorded());
          expect(migration.replace?.adapterId).toBe("cursor-usage-api");
          const first = yield* opened.service.append(migration);
          expect(first.inserted).toBe(3);
          expect(readFileSync(statePath(home), "utf-8")).toContain(
            '"version":2'
          );

          const again = yield* collectWith(home, newRecorded());
          expect(again.replace).toBeUndefined();
          const second = yield* opened.service.append(again);
          expect(second.inserted).toBe(0);

          const snapshot = yield* opened.service.snapshot({
            branch: null,
            flightId: null,
            from: null,
            repoCommonDir: null,
            to: null,
          });

          const ids = snapshot.events.map((event) => event.eventId);
          expect(ids.some((id) => id.startsWith("old-"))).toBe(false);
          expect(ids).toHaveLength(3);
          opened.close();
        }).pipe(Effect.provide(NodeServices.layer))
      )
  );
});
