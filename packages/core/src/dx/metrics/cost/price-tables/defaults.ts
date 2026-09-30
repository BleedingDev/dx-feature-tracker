import { Effect, FileSystem, Result, Schema } from "effect";

import type { CostOptions, SubscriptionPlan } from "../metric.js";
import type { PriceTable } from "../price-table.js";
import { PriceTableSchema } from "../price-table.js";
import { cursorPriceTable202609 } from "./cursor-2026-09.js";

export const USER_PRICES_FILE = "prices.json" as const;

export const defaultPriceTables = (): readonly PriceTable[] => [
  cursorPriceTable202609,
];

export const userPricesPath = (dftHome: string): string =>
  `${dftHome.replace(/\/+$/u, "")}/${USER_PRICES_FILE}`;

export type UserPriceTableLoad =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "invalid"; readonly path: string; readonly reason: string }
  | {
      readonly kind: "loaded";
      readonly path: string;
      readonly table: PriceTable;
    };

const decodeUserTable = Schema.decodeUnknownResult(
  Schema.fromJsonString(PriceTableSchema)
);

export const parseUserPriceTable = (
  path: string,
  text: string
): UserPriceTableLoad => {
  const decoded = decodeUserTable(text);

  return Result.isSuccess(decoded)
    ? { kind: "loaded", path, table: decoded.success }
    : {
        kind: "invalid",
        path,
        reason: `does not match PriceTableSchema: ${String(decoded.failure)}`,
      };
};

export const loadUserPriceTable = (
  dftHome: string
): Effect.Effect<UserPriceTableLoad, never, FileSystem.FileSystem> =>
  Effect.gen(function* loadUserPrices() {
    const fs = yield* FileSystem.FileSystem;
    const path = userPricesPath(dftHome);

    const exists = yield* fs
      .exists(path)
      .pipe(Effect.orElseSucceed(() => false));

    if (!exists) {
      return { kind: "absent", path } satisfies UserPriceTableLoad;
    }

    return yield* fs.readFileString(path).pipe(
      Effect.map((text) => parseUserPriceTable(path, text)),
      Effect.orElseSucceed((): UserPriceTableLoad => ({
        kind: "invalid",
        path,
        reason: "could not be read",
      }))
    );
  });

export interface PriceTableSelection {
  readonly origin: "bundled" | "user";
  readonly table: PriceTable;
  readonly warning: string | null;
}

export const selectPriceTable = (
  user: UserPriceTableLoad | null = null
): PriceTableSelection => {
  const [bundled] = defaultPriceTables();
  const fallback = bundled ?? cursorPriceTable202609;

  if (user?.kind === "loaded") {
    return { origin: "user", table: user.table, warning: null };
  }

  return {
    origin: "bundled",
    table: fallback,
    warning:
      user?.kind === "invalid"
        ? `User price table ${user.path} ignored (${user.reason}); using bundled ${fallback.id}@${fallback.version}.`
        : null,
  };
};

export const defaultCostOptions = (
  user: UserPriceTableLoad | null = null,
  subscription: SubscriptionPlan | null = null
): CostOptions => ({
  priceTable: selectPriceTable(user).table,
  subscription,
});
