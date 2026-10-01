import { Context, Effect } from "effect";

import type { Catalog } from "../price-catalog/catalog.js";
import type { CatalogTimeline } from "../price-catalog/provider.js";
import { BUNDLED_CATALOG } from "./bundled-catalog.js";
import type {
  PricedRequest,
  RequestEstimate,
  RequestLedgers,
  SheetLookup,
} from "./estimate.js";
import { estimateRequest, lookupPrice, requestLedgers } from "./estimate.js";
import { makerSheet } from "./maker-sheet.js";
import { PRICING_RULES_SOURCE } from "./rules.js";
import type { PriceSheet } from "./sheet.js";
import { sheetFromCatalogs } from "./sheet.js";

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

export const bundledSheet = (): PriceSheet => {
  const sheet = sheetFromCatalogs([BUNDLED_CATALOG]);

  return {
    id: "bundled",
    models: sheet?.models ?? {},
    source: `bundled snapshot of ${sheet?.source ?? "models.dev"}`,
    version: BUNDLED_CATALOG.fetchedAt.slice(0, 10),
  };
};

export const publicSheets = (
  catalogSheet: PriceSheet | null
): readonly PriceSheet[] => [
  makerSheet(),
  ...(catalogSheet === null ? [] : [catalogSheet]),
  bundledSheet(),
];

const isBefore = (a: Catalog, b: Catalog): boolean =>
  a.fetchedAt.localeCompare(b.fetchedAt) < 0;

const withBundledHistory = (
  catalogs: readonly Catalog[]
): readonly Catalog[] => {
  const newest = catalogs
    .toSorted((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
    .at(-1);

  const predatesAll = catalogs
    .filter((catalog) => catalog.source === newest?.source)
    .every((catalog) => isBefore(BUNDLED_CATALOG, catalog));

  return newest?.source === BUNDLED_CATALOG.source && predatesAll
    ? [BUNDLED_CATALOG, ...catalogs]
    : catalogs;
};

export const catalogSheetOf = (
  catalogs: readonly Catalog[]
): PriceSheet | null => sheetFromCatalogs(withBundledHistory(catalogs));

export const bookFromTimeline = (
  timeline: CatalogTimeline
): Effect.Effect<PriceBookApi> =>
  Effect.gen(function* buildBook() {
    const overrides = yield* PriceOverrides;
    const catalogSheet = catalogSheetOf(timeline.catalogs);
    const bundled = bundledSheet();
    const sheets = [...overrides, ...publicSheets(catalogSheet)];

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
