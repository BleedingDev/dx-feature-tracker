import { Schema } from "effect";

import type { Catalog } from "../price-catalog/catalog.js";
import { CATALOG_URLS } from "../price-catalog/catalog.js";
import type { ModelRates, PriceTable } from "../price-table.js";
import { ModelRatesSchema } from "../price-table.js";

export const ModelPriceVersionSchema = Schema.Struct({
  effectiveFrom: Schema.NullOr(Schema.String),
  rates: ModelRatesSchema,
});

export type ModelPriceVersion = typeof ModelPriceVersionSchema.Type;

export const PriceSheetSchema = Schema.Struct({
  id: Schema.String,
  models: Schema.Record(Schema.String, Schema.Array(ModelPriceVersionSchema)),
  source: Schema.String,
  version: Schema.String,
});

export type PriceSheet = typeof PriceSheetSchema.Type;

export const decodePriceSheet = Schema.decodeUnknownSync(PriceSheetSchema);

const timeOf = (iso: string | null): number =>
  iso === null ? Number.NEGATIVE_INFINITY : Date.parse(iso);

export const versionAt = (
  versions: readonly ModelPriceVersion[],
  at: string | null
): ModelPriceVersion | undefined => {
  const ordered = versions.toSorted(
    (a, b) => timeOf(a.effectiveFrom) - timeOf(b.effectiveFrom)
  );

  const when = at === null ? Number.NaN : Date.parse(at);

  if (!Number.isFinite(when)) {
    return ordered.at(-1);
  }

  return (
    ordered.findLast((version) => timeOf(version.effectiveFrom) <= when) ??
    ordered[0]
  );
};

const sameBaseRates = (a: ModelRates, b: ModelRates): boolean =>
  a.input === b.input &&
  a.output === b.output &&
  a["cached-input"] === b["cached-input"] &&
  a["cache-write"] === b["cache-write"];

export const sheetFromCatalogs = (
  catalogs: readonly Catalog[]
): PriceSheet | null => {
  const newest = catalogs
    .toSorted((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
    .at(-1);

  if (newest === undefined) {
    return null;
  }

  const ordered = catalogs
    .filter((catalog) => catalog.source === newest.source)
    .toSorted((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));

  const models: Record<string, ModelPriceVersion[]> = {};

  for (const [index, catalog] of ordered.entries()) {
    for (const [key, rates] of Object.entries(catalog.models)) {
      const versions = models[key] ?? [];
      const last = versions.at(-1);

      if (last === undefined || !sameBaseRates(last.rates, rates)) {
        versions.push({
          effectiveFrom:
            index === 0 || last === undefined ? null : catalog.fetchedAt,
          rates,
        });
      } else {
        versions[versions.length - 1] = { ...last, rates };
      }

      models[key] = versions;
    }
  }

  return {
    id: newest.source,
    models,
    source: `${newest.source} public price catalog (${CATALOG_URLS[newest.source]}); ${String(ordered.length)} snapshot(s) from ${ordered[0]?.fetchedAt ?? newest.fetchedAt} to ${newest.fetchedAt}`,
    version: newest.fetchedAt.slice(0, 10),
  };
};

export const sheetFromTable = (table: PriceTable): PriceSheet => ({
  id: table.id,
  models: Object.fromEntries(
    Object.entries(table.models).map(([key, rates]) => [
      key.toLowerCase(),
      [{ effectiveFrom: table.effectiveFrom, rates }],
    ])
  ),
  source: table.source,
  version: table.version,
});
