// @effect-diagnostics nodeBuiltinImport:off -- The price catalog cache lives under ~/.dft/price-catalog and is read and written synchronously at the process boundary.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DateTime, Effect, Option, Schema } from "effect";

import type { PriceTable } from "../price-table.js";
import { cursorPriceTable202609 } from "../price-tables/cursor-2026-09.js";
import {
  CATALOG_URLS,
  CatalogSchema,
  catalogPriceTable,
  parseCatalog,
} from "./catalog.js";
import type { Catalog, CatalogSource } from "./catalog.js";

export const REFRESH_MS = 24 * 60 * 60 * 1000;

export const SOURCE_ORDER: readonly CatalogSource[] = ["models.dev", "litellm"];

export type CatalogFetch = (url: string) => Promise<string>;

export interface PriceProviderDeps {
  readonly cacheDir: string;
  readonly fetchJson: CatalogFetch;
  readonly nowMs: number;
}

export interface PriceProvider {
  readonly origin: "bundled" | "cache" | "fresh";
  readonly table: PriceTable;
  readonly warnings: readonly string[];
}

export const catalogCacheDir = (home: string): string =>
  path.join(home, ".dft", "price-catalog");

const cacheFile = (dir: string, catalog: Catalog): string =>
  path.join(dir, `${catalog.source}-${catalog.fetchedAt.slice(0, 10)}.json`);

const decodeCached = Schema.decodeUnknownOption(
  Schema.fromJsonString(CatalogSchema)
);

export const readCached = (dir: string): readonly Catalog[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          return Option.toArray(
            decodeCached(readFileSync(path.join(dir, name), "utf-8"))
          );
        } catch {
          return [];
        }
      })
      .toSorted(
        (a, b) =>
          b.fetchedAt.localeCompare(a.fetchedAt) ||
          SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
      );
  } catch {
    return [];
  }
};

const writeCache = (dir: string, catalog: Catalog): string | null => {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cacheFile(dir, catalog), `${JSON.stringify(catalog)}\n`);

    return null;
  } catch (error) {
    return `price catalog cache not written: ${String(error)}`;
  }
};

const fetchCatalog = (
  deps: PriceProviderDeps
): Effect.Effect<{
  readonly catalog: Catalog | null;
  readonly errors: readonly string[];
}> =>
  Effect.gen(function* fetchFirstSource() {
    const errors: string[] = [];

    const fetchedAt = Option.match(DateTime.make(deps.nowMs), {
      onNone: () => "1970-01-01T00:00:00.000Z",
      onSome: (at) => DateTime.formatIso(at),
    });

    for (const source of SOURCE_ORDER) {
      const result = yield* Effect.tryPromise(
        // @effect-diagnostics-next-line asyncFunction:off -- fetch is promise-only and Effect.tryPromise is its boundary.
        async () => await deps.fetchJson(CATALOG_URLS[source])
      ).pipe(
        Effect.map((body) => parseCatalog(source, body, fetchedAt)),
        Effect.orElseSucceed(() => null)
      );

      if (result !== null && Object.keys(result.models).length > 0) {
        return { catalog: result, errors };
      }

      errors.push(`${source} unavailable`);
    }

    return { catalog: null, errors };
  });

export const loadPriceProvider = (
  deps: PriceProviderDeps,
  bundled: PriceTable = cursorPriceTable202609
): Effect.Effect<PriceProvider> =>
  Effect.gen(function* loadProvider() {
    const cached = readCached(deps.cacheDir);
    const [newest] = cached;

    if (
      newest !== undefined &&
      deps.nowMs - Date.parse(newest.fetchedAt) < REFRESH_MS
    ) {
      return {
        origin: "cache" as const,
        table: catalogPriceTable(newest, bundled),
        warnings: [],
      };
    }

    const fetched = yield* fetchCatalog(deps);

    if (fetched.catalog !== null) {
      const warning = writeCache(deps.cacheDir, fetched.catalog);

      return {
        origin: "fresh" as const,
        table: catalogPriceTable(fetched.catalog, bundled),
        warnings: warning === null ? [] : [warning],
      };
    }

    if (newest !== undefined) {
      return {
        origin: "cache" as const,
        table: catalogPriceTable(newest, bundled),
        warnings: [
          `price catalog offline (${fetched.errors.join(", ")}); using cached ${newest.source} from ${newest.fetchedAt}`,
        ],
      };
    }

    return {
      origin: "bundled" as const,
      table: bundled,
      warnings: [
        `price catalog offline and no cache; using bundled ${bundled.id}@${bundled.version}`,
      ],
    };
  });

export interface CatalogTimeline {
  readonly catalogs: readonly Catalog[];
  readonly origin: "cache" | "fresh" | "none";
  readonly warnings: readonly string[];
}

export const loadCatalogTimeline = (
  deps: PriceProviderDeps
): Effect.Effect<CatalogTimeline> =>
  Effect.gen(function* loadTimeline() {
    const cached = readCached(deps.cacheDir);
    const [newest] = cached;

    if (
      newest !== undefined &&
      deps.nowMs - Date.parse(newest.fetchedAt) < REFRESH_MS
    ) {
      return { catalogs: cached, origin: "cache" as const, warnings: [] };
    }

    const fetched = yield* fetchCatalog(deps);

    if (fetched.catalog !== null) {
      const warning = writeCache(deps.cacheDir, fetched.catalog);

      return {
        catalogs: [fetched.catalog, ...cached],
        origin: "fresh" as const,
        warnings: warning === null ? [] : [warning],
      };
    }

    const offline = `price catalog offline (${fetched.errors.join(", ")})`;

    return newest === undefined
      ? {
          catalogs: [],
          origin: "none" as const,
          warnings: [`${offline} and no cache`],
        }
      : {
          catalogs: cached,
          origin: "cache" as const,
          warnings: [
            `${offline}; using cached ${newest.source} from ${newest.fetchedAt}`,
          ],
        };
  });

// @effect-diagnostics-next-line asyncFunction:off -- The public price catalog seam is the platform fetch; loadPriceProvider wraps it in Effect.tryPromise.
export const fetchJson: CatalogFetch = async (url) => {
  // @effect-diagnostics-next-line globalFetch:off -- Public, unauthenticated catalog GET at the process boundary.
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    throw new Error(`HTTP ${String(res.status)}`);
  }

  return await res.text();
};

export const defaultPriceProvider = (
  home: string = process.env.HOME ?? ""
): Effect.Effect<PriceProvider> =>
  DateTime.now.pipe(
    Effect.flatMap((now) =>
      loadPriceProvider({
        cacheDir: catalogCacheDir(home),
        fetchJson,
        nowMs: DateTime.toEpochMillis(now),
      })
    )
  );
