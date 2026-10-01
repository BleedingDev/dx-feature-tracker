// @effect-diagnostics nodeBuiltinImport:off -- This test builds a version 1 dft store on disk with node:sqlite and an owned temp folder.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { emptySelector, fakeManifest } from "../../src/dx/contracts/fakes.js";
import { accountAiUsage } from "../../src/dx/metrics/ai-usage/ledger.js";
import { normalizeAiUsage } from "../../src/dx/metrics/ai-usage/normalize.js";
import { computeCost } from "../../src/dx/metrics/cost/metric.js";
import type { TokenCategory } from "../../src/dx/model/ai.js";
import type { AiTokens } from "../../src/dx/model/attribution.js";
import { DxEventEnvelopeSchema } from "../../src/dx/model/event.js";
import type { DxEventEnvelope, EventBatch } from "../../src/dx/model/event.js";
import { STORE_MIGRATIONS } from "../../src/dx/storage/migrations.js";
import { drainSpool } from "../../src/dx/storage/spool.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import { V1_EVENT_SCHEMA_VERSION } from "../../src/dx/storage/upgrade-v1.js";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "dft-store-v2-"));

afterAll(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

const ScenariosSchema = Schema.Record(
  Schema.String,
  Schema.Array(DxEventEnvelopeSchema)
);

const fixtureEvents = (): readonly DxEventEnvelope[] => {
  const text = readFileSync(
    path.join(import.meta.dirname, "fixtures/c05/accounting-audit.json"),
    "utf-8"
  );

  const scenarios = Schema.decodeUnknownSync(
    Schema.fromJsonString(ScenariosSchema)
  )(text);

  const unique = new Map<string, DxEventEnvelope>();

  for (const event of Object.values(scenarios).flat()) {
    unique.set(event.eventId, event);
  }

  return [...unique.values()];
};

const asV1Body = (event: DxEventEnvelope): string => {
  const { ai: _ai, usage: _usage, ...rest } = event;

  return JSON.stringify({ ...rest, schemaVersion: V1_EVENT_SCHEMA_VERSION });
};

const writeV1Store = (
  file: string,
  events: readonly DxEventEnvelope[]
): void => {
  const db = new DatabaseSync(file);
  const [first] = STORE_MIGRATIONS;

  for (const statement of first?.statements ?? []) {
    db.exec(statement);
  }

  db.exec("PRAGMA user_version = 1");
  db.prepare(
    "INSERT INTO store_meta (key, value) VALUES ('store_kind', 'live')"
  ).run();

  const insert = db.prepare(
    "INSERT INTO events (event_id, adapter_id, kind, origin, flight_id, repo_common_dir, branch, occurred_at, observed_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (const event of events) {
    insert.run(
      event.eventId,
      event.adapterId,
      event.kind,
      event.origin,
      event.context.flightId,
      event.context.repoCommonDir,
      event.context.branch,
      event.occurredAt,
      event.observedAt,
      asV1Body(event)
    );
  }

  db.close();
};

const snapshotOf = (events: readonly DxEventEnvelope[]) => ({
  coverage: [],
  events,
  manifest: fakeManifest("store-v2-migration"),
});

const byId = (events: readonly DxEventEnvelope[]) =>
  [...events].toSorted((a, b) => a.eventId.localeCompare(b.eventId));

const LEDGER_BUCKETS: ReadonlyMap<TokenCategory, keyof AiTokens> = new Map([
  ["input", "inputFresh"],
  ["cached-input", "cacheRead"],
  ["cache-write", "cacheWrite"],
  ["output", "output"],
  ["reasoning", "reasoning"],
  ["total", "total"],
]);

const ledgerBuckets = (event: DxEventEnvelope) => {
  const buckets = new Map<keyof AiTokens, number>();

  for (const row of normalizeAiUsage([event]).rows) {
    const bucket = LEDGER_BUCKETS.get(row.category);

    if (row.ledger === "tokens" && bucket !== undefined) {
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + row.value);
    }
  }

  return buckets;
};

const typedBuckets = (event: DxEventEnvelope) =>
  new Map(
    [...LEDGER_BUCKETS.values()].flatMap((bucket) => {
      const value = event.usage?.tokens[bucket] ?? null;

      return value === null ? [] : [[bucket, value] as const];
    })
  );

const snapshotEvents = (file: string) =>
  Effect.acquireUseRelease(
    openSqliteEventStore({ kind: "live", path: file }),
    (opened) => opened.service.snapshot(emptySelector),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  ).pipe(Effect.map((snapshot) => snapshot.events));

describe("store migration to dx.event.v2", () => {
  it.effect(
    "rewrites v1 rows so every event decodes as v2 with the same totals",
    () =>
      Effect.gen(function* migrateStore() {
        const expected = fixtureEvents();
        const file = path.join(tempRoot, "v1.db");

        writeV1Store(file, expected);

        const migrated = yield* snapshotEvents(file);

        expect(byId(migrated)).toStrictEqual(byId(expected));
        expect(accountAiUsage(migrated).totals).toStrictEqual(
          accountAiUsage(expected).totals
        );
        expect(computeCost(snapshotOf(migrated))).toStrictEqual(
          computeCost(snapshotOf(expected))
        );

        const versions = new DatabaseSync(file, { readOnly: true })
          .prepare(
            "SELECT json_extract(body, '$.schemaVersion') AS v FROM events"
          )
          .all()
          .map((row) => row.v);

        expect(new Set(versions)).toStrictEqual(new Set(["dx.event.v2"]));
      })
  );

  it.effect("keeps Cursor attribution and token counts after the upgrade", () =>
    Effect.gen(function* cursorBlocks() {
      const file = path.join(tempRoot, "cursor.db");

      writeV1Store(file, fixtureEvents());

      const migrated = yield* snapshotEvents(file);

      const cursor = migrated.filter(
        (event) =>
          event.kind.startsWith("ai.") && event.adapterId.startsWith("cursor-")
      );

      expect(cursor.length).toBeGreaterThan(0);

      for (const event of cursor) {
        expect(event.ai?.harness).toBe("cursor");
        expect(event.ai?.via).toBe("cursor");
      }

      const withTokens = cursor.filter((event) => event.usage !== null);

      expect(withTokens.length).toBeGreaterThan(0);
    })
  );

  it.effect(
    "fills typed token buckets that match the ledger every migrated event had",
    () =>
      Effect.gen(function* typedMatchesLedger() {
        const file = path.join(tempRoot, "ledger.db");

        writeV1Store(file, fixtureEvents());

        const migrated = (yield* snapshotEvents(file)).filter((event) =>
          event.kind.startsWith("ai.")
        );

        const counted = migrated.filter(
          (event) => ledgerBuckets(event).size > 0
        );

        expect(counted.some((event) => event.ai?.harness === "cursor")).toBe(
          true
        );

        for (const event of migrated) {
          expect(typedBuckets(event), event.eventId).toStrictEqual(
            ledgerBuckets(event)
          );
        }
      })
  );

  it.effect("upgrades a pending v1 spool batch while draining it", () =>
    Effect.gen(function* drainV1() {
      const [event] = fixtureEvents();
      const spoolDir = path.join(tempRoot, "spool");
      const file = path.join(tempRoot, "spool.db");

      expect(event).toBeDefined();

      if (event === undefined) {
        return;
      }

      const batch: EventBatch = {
        coverage: {
          adapterId: event.adapterId,
          expectedItems: null,
          gaps: [],
          observedItems: 1,
          state: "complete",
          watermark: null,
          windowFrom: null,
          windowTo: null,
        },
        cursor: null,
        events: [event],
      };

      const text = JSON.stringify({
        ...batch,
        events: [JSON.parse(asV1Body(event))],
      });

      mkdirSync(spoolDir, { recursive: true });
      writeFileSync(path.join(spoolDir, "a.batch.json"), text);

      const result = yield* Effect.acquireUseRelease(
        openSqliteEventStore({ kind: "live", path: file }),
        (opened) => drainSpool(opened.service, spoolDir),
        (opened) =>
          Effect.sync(() => {
            opened.close();
          })
      );

      expect(result.rejected).toStrictEqual([]);
      expect(result.inserted).toBe(1);

      const stored = yield* snapshotEvents(file);

      expect(stored).toStrictEqual([event]);
    })
  );
});
