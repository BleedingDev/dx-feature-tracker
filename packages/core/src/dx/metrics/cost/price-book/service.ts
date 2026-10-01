import { Config, Context, DateTime, Effect, Layer } from "effect";

import type { PriceProviderDeps } from "../price-catalog/provider.js";
import {
  catalogCacheDir,
  fetchJson,
  loadCatalogTimeline,
} from "../price-catalog/provider.js";
import type { PriceTable } from "../price-table.js";
import type { PriceBookApi } from "./book.js";
import { bookFromTimeline, priceBookOf } from "./book.js";
import type { PriceSheet } from "./sheet.js";
import { sheetFromTable } from "./sheet.js";

export const loadPriceBook = (
  deps: PriceProviderDeps
): Effect.Effect<PriceBookApi> =>
  loadCatalogTimeline(deps).pipe(Effect.flatMap(bookFromTimeline));

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
