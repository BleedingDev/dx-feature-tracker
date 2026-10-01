// @effect-diagnostics nodeBuiltinImport:off -- This test owns a temporary DFT_HOME and rewrites a backup file with node:sqlite into the version 1 layout.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { liveHome } from "../../src/dx/live/home.js";
import { resetStore, restoreBackup } from "../../src/dx/live/store-admin.js";
import { DxEventEnvelopeSchema } from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import { V1_EVENT_SCHEMA_VERSION } from "../../src/dx/storage/upgrade-v1.js";
import { emptySelector } from "./fakes.js";

const dftHome = mkdtempSync(path.join(os.tmpdir(), "dft-old-backup-"));

afterAll(() => {
  rmSync(dftHome, { force: true, recursive: true });
});

const home = liveHome(dftHome);

const fixtureEvents = (): readonly DxEventEnvelope[] => {
  const text = readFileSync(
    path.join(import.meta.dirname, "fixtures/c05/accounting-audit.json"),
    "utf-8"
  );

  const scenarios = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Record(Schema.String, Schema.Array(DxEventEnvelopeSchema))
    )
  )(text);

  return [
    ...new Map(
      Object.values(scenarios)
        .flat()
        .map((event) => [event.eventId, event])
    ).values(),
  ];
};

const withStore = <A, E>(
  use: (
    service: Effect.Success<ReturnType<typeof openSqliteEventStore>>["service"]
  ) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    openSqliteEventStore({ kind: "live", path: home.storePath }),
    (opened) => use(opened.service),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  );

const downgradeToV1 = (file: string): void => {
  const db = new DatabaseSync(file);
  const update = db.prepare("UPDATE events SET body = ? WHERE seq = ?");
  const RowSchema = Schema.Struct({ body: Schema.String, seq: Schema.Int });

  for (const raw of db.prepare("SELECT seq, body FROM events").all()) {
    const row = Schema.decodeUnknownSync(RowSchema)(raw);

    const {
      ai: _ai,
      usage: _usage,
      ...rest
    } = Schema.decodeUnknownSync(Schema.fromJsonString(DxEventEnvelopeSchema))(
      row.body
    );

    update.run(
      JSON.stringify({ ...rest, schemaVersion: V1_EVENT_SCHEMA_VERSION }),
      row.seq
    );
  }

  db.exec("PRAGMA user_version = 1");
  db.close();
};

const byId = (events: readonly DxEventEnvelope[]) =>
  [...events].toSorted((a, b) => a.eventId.localeCompare(b.eventId));

describe("restoring a backup made before the v2 store", () => {
  it.effect("upgrades the backup and brings every event back as v2", () =>
    Effect.gen(function* restoreOld() {
      const events = fixtureEvents();

      yield* withStore((store) =>
        store.append({
          coverage: {
            adapterId: "fixture",
            expectedItems: null,
            gaps: [],
            observedItems: events.length,
            state: "complete",
            watermark: null,
            windowFrom: null,
            windowTo: null,
          },
          cursor: null,
          events,
        })
      );

      const reset = yield* resetStore(home, "reset");

      downgradeToV1(reset.backup.path);

      yield* restoreBackup(home, reset.backup.id);

      const restored = yield* withStore((store) =>
        store.snapshot(emptySelector)
      );

      expect(byId(restored.events)).toStrictEqual(byId(events));
      expect(
        readdirSync(path.dirname(reset.backup.path)).filter((name) =>
          name.startsWith(".upgrade-")
        )
      ).toStrictEqual([]);
    })
  );
});
