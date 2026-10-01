import { Context, Effect, Layer } from "effect";

import type { PriceBookApi } from "../../src/dx/metrics/cost/price-book/book.js";
import {
  bookFromTimeline,
  priceBookOf,
} from "../../src/dx/metrics/cost/price-book/book.js";
import type { PriceSheet } from "../../src/dx/metrics/cost/price-book/sheet.js";
import { loadCatalogTimeline } from "../../src/dx/metrics/cost/price-catalog/provider.js";
import type { PriceProviderDeps } from "../../src/dx/metrics/cost/price-catalog/provider.js";

export class PriceBook extends Context.Service<PriceBook, PriceBookApi>()(
  "test/dx/PriceBook"
) {
  static readonly fromCatalog = (
    deps: PriceProviderDeps
  ): Layer.Layer<PriceBook> =>
    Layer.effect(
      this,
      loadCatalogTimeline(deps).pipe(Effect.flatMap(bookFromTimeline))
    );

  static readonly memory = (
    sheets: readonly PriceSheet[]
  ): Layer.Layer<PriceBook> =>
    Layer.succeed(this, priceBookOf(sheets, "memory"));
}
