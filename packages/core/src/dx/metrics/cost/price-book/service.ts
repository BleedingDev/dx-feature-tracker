import { Config, Context, DateTime, Effect, Layer } from "effect";

import type { PriceProviderDeps } from "../price-catalog/provider.js";
import {
  catalogCacheDir,
  fetchJson,
  loadCatalogTimeline,
} from "../price-catalog/provider.js";
import type { PriceTable } from "../price-table.js";
import { BUNDLED_CATALOG } from "./bundled-catalog.js";
import type {
  PricedRequest,
  RequestEstimate,
  RequestLedgers,
  SheetLookup,
} from "./estimate.js";
import { estimateRequest, lookupPrice, requestLedgers } from "./estimate.js";
import { PRICING_RULES_SOURCE } from "./rules.js";
import type { PriceSheet } from "./sheet.js";
import { sheetFromCatalogs, sheetFromTable } from "./sheet.js";

export type PriceBookOrigin = "fresh" | "cache" | "bundled" | "memory";

export interface PriceBookApi {
  readonly estimate: (request: PricedRequest) => RequestEstimate;
  readonly label: string;
  readonly ledgers: (request: PricedRequest) => RequestLedgers;
  readonly lookup: (model: string | null, at: string | null) => SheetLookup;
  readonly origin: PriceBookOrigin;
  readonly rules: string;
  readonly sheets: readonly PriceSheet[];
  readonly warnings: readonly string[];
}

export const PriceOverrides = Context.Reference<readonly PriceSheet[]>(
  "dx/metrics/cost/PriceOverrides",
  { defaultValue: () => [] }
);

export const bookLabel = (sheets: readonly PriceSheet[]): string =>
  sheets.map((sheet) => `${sheet.id}@${sheet.version}`).join("+") ||
  "no prices";

export const priceBookOf = (
  sheets: readonly PriceSheet[],
  origin: PriceBookOrigin,
  warnings: readonly string[] = []
): PriceBookApi => ({
  estimate: (request) => estimateRequest(sheets, request),
  label: bookLabel(sheets),
  ledgers: (request) => requestLedgers(sheets, request),
  lookup: (model, at) => lookupPrice(sheets, model, at),
  origin,
  rules: PRICING_RULES_SOURCE,
  sheets,
  warnings,
});

const bundledSheet = (): PriceSheet => {
  const sheet = sheetFromCatalogs([BUNDLED_CATALOG]);

  return {
    id: "bundled",
    models: sheet?.models ?? {},
    source: `bundled snapshot of ${sheet?.source ?? "models.dev"}`,
    version: BUNDLED_CATALOG.fetchedAt.slice(0, 10),
  };
};

export const loadPriceBook = (
  deps: PriceProviderDeps
): Effect.Effect<PriceBookApi> =>
  Effect.gen(function* loadBook() {
    const overrides = yield* PriceOverrides;
    const timeline = yield* loadCatalogTimeline(deps);
    const catalogSheet = sheetFromCatalogs(timeline.catalogs);
    const bundled = bundledSheet();

    const sheets = [
      ...overrides,
      ...(catalogSheet === null ? [] : [catalogSheet]),
      bundled,
    ];

    return catalogSheet === null
      ? priceBookOf(sheets, "bundled", [
          ...timeline.warnings,
          `using the bundled catalog snapshot ${bundled.version}`,
        ])
      : priceBookOf(
          sheets,
          timeline.origin === "fresh" ? "fresh" : "cache",
          timeline.warnings
        );
  });

export class PriceBook extends Context.Service<PriceBook, PriceBookApi>()(
  "dx/metrics/cost/PriceBook",
  {
    make: Effect.gen(function* makePriceBook() {
      const home = yield* Config.String("HOME").pipe(Effect.orDie);
      const now = yield* DateTime.now;

      return yield* loadPriceBook({
        cacheDir: catalogCacheDir(home),
        fetchJson,
        nowMs: DateTime.toEpochMillis(now),
      });
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly fromCatalog = (
    deps: PriceProviderDeps
  ): Layer.Layer<PriceBook> => Layer.effect(this, loadPriceBook(deps));

  static readonly memory = (
    sheets: readonly PriceSheet[]
  ): Layer.Layer<PriceBook> =>
    Layer.succeed(this, priceBookOf(sheets, "memory"));

  static readonly fromTables = (
    tables: readonly PriceTable[]
  ): Layer.Layer<PriceBook> => this.memory(tables.map(sheetFromTable));
}
