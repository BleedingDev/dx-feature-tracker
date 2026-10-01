import { DatabaseSync } from "node:sqlite";

import { Context, Effect, Layer, Ref, Schema } from "effect";

import { StoreError } from "../contracts/error-store-error.js";
import { EventStore } from "../contracts/event-store.js";
import type { StoreFailure } from "../contracts/services.js";
import type { DerivedUsage, UsageDisagreement, UsageFact } from "./fact.js";
import {
  USAGE_DERIVATION_VERSION,
  UsageDisagreementSchema,
  UsageFactSchema,
} from "./fact.js";

export interface StoredUsageMeta {
  readonly builtAt: string;
  readonly unresolved: number;
  readonly watermark: string;
}

export interface DisagreementCount {
  readonly count: number;
  readonly field: string;
  readonly tool: string | null;
}

export interface UsageFactStoreApi {
  readonly disagreements: Effect.Effect<
    readonly DisagreementCount[],
    StoreFailure
  >;
  readonly facts: Effect.Effect<readonly UsageFact[], StoreFailure>;
  readonly meta: Effect.Effect<StoredUsageMeta | null, StoreFailure>;
  readonly replace: (
    derived: DerivedUsage,
    watermark: string,
    builtAt: string
  ) => Effect.Effect<void, StoreFailure>;
  readonly watermark: Effect.Effect<string | null, StoreFailure>;
}

const decodeFacts = Schema.decodeUnknownSync(
  Schema.Array(Schema.fromJsonString(UsageFactSchema))
);

const decodeMetaRow = Schema.decodeUnknownSync(
  Schema.Struct({ key: Schema.String, value: Schema.String })
);

const decodeBodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const decodeMarkRow = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Int, top: Schema.NullOr(Schema.Int) })
);

const decodeCountRow = Schema.decodeUnknownSync(
  Schema.Struct({
    field: Schema.String,
    harness: Schema.NullOr(Schema.String),
    n: Schema.Int,
  })
);

const encodeFact = Schema.encodeSync(Schema.fromJsonString(UsageFactSchema));

const encodeDisagreement = Schema.encodeSync(
  Schema.fromJsonString(UsageDisagreementSchema)
);

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const attempt = <A>(
  operation: string,
  body: () => A
): Effect.Effect<A, StoreFailure> =>
  Effect.try({
    catch: (cause) =>
      Schema.is(StoreError)(cause)
        ? cause
        : new StoreError({ message: messageOf(cause), operation }),
    try: body,
  });

export const usageWatermark = (events: number, top: number | null): string =>
  `usage:v${String(USAGE_DERIVATION_VERSION)}:events:${String(events)}:${String(top ?? 0)}`;

const META_KEYS = ["builtAt", "unresolved", "watermark"] as const;

export const countDisagreements = (
  rows: readonly UsageDisagreement[]
): readonly DisagreementCount[] => {
  const counts = new Map<string, DisagreementCount>();

  for (const row of rows) {
    const key = `${row.harness ?? ""}|${row.field}`;
    const seen = counts.get(key);

    counts.set(key, {
      count: (seen?.count ?? 0) + 1,
      field: row.field,
      tool: row.harness,
    });
  }

  return [...counts.values()].toSorted(
    (a, b) =>
      (a.tool ?? "").localeCompare(b.tool ?? "") ||
      a.field.localeCompare(b.field)
  );
};

const sqliteUsageStore = (db: DatabaseSync): UsageFactStoreApi => ({
  disagreements: attempt("usage.disagreements", () =>
    db
      .prepare(
        "SELECT harness, field, COUNT(*) AS n FROM usage_disagreements GROUP BY harness, field ORDER BY harness, field"
      )
      .all()
      .map((raw) => {
        const row = decodeCountRow(raw);

        return { count: row.n, field: row.field, tool: row.harness };
      })
  ),
  facts: attempt("usage.facts", () =>
    decodeFacts(
      db
        .prepare("SELECT body FROM usage_facts ORDER BY occurred_ms, fact_id")
        .all()
        .map((raw) => decodeBodyRow(raw).body)
    )
  ),
  meta: attempt("usage.meta", () => {
    const meta = new Map(
      db
        .prepare("SELECT key, value FROM usage_meta")
        .all()
        .map((raw) => {
          const row = decodeMetaRow(raw);

          return [row.key, row.value] as const;
        })
    );

    const watermark = meta.get("watermark");
    const builtAt = meta.get("builtAt");

    if (watermark === undefined || builtAt === undefined) {
      return null;
    }

    return {
      builtAt,
      unresolved: Number(meta.get("unresolved") ?? "0"),
      watermark,
    };
  }),
  replace: (derived, watermark, builtAt) =>
    attempt("usage.replace", () => {
      db.exec("BEGIN IMMEDIATE");

      try {
        db.exec("DELETE FROM usage_facts");
        db.exec("DELETE FROM usage_disagreements");
        db.exec("DELETE FROM usage_meta");

        const fact = db.prepare(
          "INSERT OR REPLACE INTO usage_facts (fact_id, harness, repo, branch, occurred_ms, scope, body) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );

        for (const item of derived.facts) {
          fact.run(
            item.factId,
            item.harness,
            item.repo,
            item.branch,
            item.occurredMs,
            item.scope,
            encodeFact(item)
          );
        }

        const disagreement = db.prepare(
          "INSERT OR REPLACE INTO usage_disagreements (fact_id, harness, field, body) VALUES (?, ?, ?, ?)"
        );

        for (const item of derived.disagreements) {
          disagreement.run(
            item.factId,
            item.harness,
            item.field,
            encodeDisagreement(item)
          );
        }

        const meta = db.prepare(
          "INSERT INTO usage_meta (key, value) VALUES (?, ?)"
        );

        const values: Readonly<Record<(typeof META_KEYS)[number], string>> = {
          builtAt,
          unresolved: String(derived.unresolved),
          watermark,
        };

        for (const key of META_KEYS) {
          meta.run(key, values[key]);
        }

        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }

        throw error;
      }
    }),
  watermark: attempt("usage.watermark", () => {
    const row = decodeMarkRow(
      db.prepare("SELECT COUNT(*) AS n, MAX(seq) AS top FROM events").get()
    );

    return usageWatermark(row.n, row.top);
  }),
});

interface MemoryState {
  readonly derived: DerivedUsage | null;
  readonly meta: StoredUsageMeta | null;
}

const memoryUsageStore = (state: Ref.Ref<MemoryState>): UsageFactStoreApi => ({
  disagreements: Ref.get(state).pipe(
    Effect.map((current) =>
      countDisagreements(current.derived?.disagreements ?? [])
    )
  ),
  facts: Ref.get(state).pipe(
    Effect.map((current) => current.derived?.facts ?? [])
  ),
  meta: Ref.get(state).pipe(Effect.map((current) => current.meta)),
  replace: (derived, watermark, builtAt) =>
    Ref.set(state, {
      derived,
      meta: { builtAt, unresolved: derived.unresolved, watermark },
    }),
  watermark: Effect.succeed(null),
});

export class UsageFactStore extends Context.Service<
  UsageFactStore,
  UsageFactStoreApi
>()("@rat-stack/core/dx/UsageFactStore") {
  static readonly sqlite = (
    path: string
  ): Layer.Layer<UsageFactStore, StoreFailure, EventStore> =>
    Layer.effect(
      this,
      Effect.gen(function* openUsageStore() {
        yield* EventStore;

        const db = yield* Effect.acquireRelease(
          attempt(
            "usage.open",
            () => new DatabaseSync(path, { timeout: 5000 })
          ),
          (opened) =>
            Effect.sync(() => {
              opened.close();
            })
        );

        return sqliteUsageStore(db);
      })
    );

  static readonly memory: Layer.Layer<UsageFactStore> = Layer.effect(
    this,
    Effect.map(
      Ref.make<MemoryState>({ derived: null, meta: null }),
      memoryUsageStore
    )
  );
}
