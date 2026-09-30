// @effect-diagnostics nodeBuiltinImport:off -- This test builds throwaway SQLite files from committed fixtures in an owned temp directory.
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { cursorLocalDbCollector } from "../../src/dx/collectors/cursor-local-db/collector.js";
import { CURSOR_LOCAL_DB_FIXTURE_IDS } from "../../src/dx/collectors/cursor-local-db/descriptor.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../src/dx/model/event.js";

const CANARY = "B06_SECRET_PROMPT_CANARY";

const DDL = new Map([
  [
    "ItemTable",
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  ],
  [
    "ai_code_hashes",
    "CREATE TABLE ai_code_hashes (hash TEXT PRIMARY KEY, source TEXT NOT NULL, fileExtension TEXT, fileName TEXT, requestId TEXT, conversationId TEXT, timestamp INTEGER, model TEXT, createdAt INTEGER NOT NULL)",
  ],
  [
    "composerHeaders",
    "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, subagentTypeName TEXT, value TEXT)",
  ],
  [
    "conversation_summaries",
    "CREATE TABLE conversation_summaries (conversationId TEXT PRIMARY KEY, title TEXT, tldr TEXT, overview TEXT, summaryBullets TEXT, model TEXT, mode TEXT, updatedAt INTEGER NOT NULL)",
  ],
  [
    "cursorDiskKV",
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  ],
  [
    "scored_commits",
    "CREATE TABLE scored_commits (commitHash TEXT NOT NULL, branchName TEXT NOT NULL, scoredAt INTEGER NOT NULL, linesAdded INTEGER, linesDeleted INTEGER, tabLinesAdded INTEGER, tabLinesDeleted INTEGER, composerLinesAdded INTEGER, composerLinesDeleted INTEGER, humanLinesAdded INTEGER, humanLinesDeleted INTEGER, blankLinesAdded INTEGER, blankLinesDeleted INTEGER, commitMessage TEXT, commitDate TEXT, v1AiPercentage TEXT, v2AiPercentage TEXT, PRIMARY KEY (commitHash, branchName))",
  ],
]);

const CellSchema = Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]));

const FixtureSchema = Schema.Struct({
  fixtureId: Schema.String,
  origin: Schema.Literal("fixture"),
  tables: Schema.Array(Schema.String),
});

const RowsSchema = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Record(Schema.String, CellSchema))
);

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "dxfr-b06-"));

afterAll(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

const fixtureText = (name: string) =>
  readFileSync(
    path.join(import.meta.dirname, "fixtures", "b06", name),
    "utf-8"
  );

const buildDb = (name: string) => {
  const text = fixtureText(name);

  const fixture = Schema.decodeUnknownSync(
    Schema.fromJsonString(FixtureSchema)
  )(text);

  const rows = Schema.decodeUnknownSync(Schema.fromJsonString(RowsSchema))(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
          )(text)
        ).filter(([key]) => fixture.tables.includes(key))
      )
    )
  );

  const dbPath = path.join(
    mkdtempSync(path.join(tempRoot, "db-")),
    `${fixture.fixtureId}.db`
  );

  const db = new DatabaseSync(dbPath);

  for (const table of fixture.tables) {
    db.exec(DDL.get(table) ?? "");

    for (const row of rows[table] ?? []) {
      const columns = Object.keys(row);

      db.prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`
      ).run(...columns.map((column) => row[column] ?? null));
    }
  }

  db.close();

  return { dbPath, fixtureId: fixture.fixtureId };
};

const scratch = () => mkdtempSync(path.join(tempRoot, "scratch-"));

const inputFor = (
  selectedInput: string | null,
  context: FlightContext = emptyFlightContext,
  scratchDir: string | null = scratch()
): CollectInput => ({
  adapterId: "cursor-local-db",
  context,
  cursor: null,
  origin: "fixture",
  scratchDir,
  selectedInput,
});

const repoContext: FlightContext = {
  ...emptyFlightContext,
  branch: "feature/fx",
  worktreePath: "/fixture/repo",
};

const byKey = (events: readonly DxEventEnvelope[], upstreamKey: string) =>
  events.find((event) => event.upstreamKey === upstreamKey);

describe("B06 cursor-local-db collector", () => {
  it("exposes a schema-valid descriptor whose fixture IDs are all committed", () => {
    const descriptor = Schema.decodeUnknownSync(ModuleDescriptorSchema)(
      cursorLocalDbCollector.descriptor
    );

    expect(descriptor.readiness).toBe("degraded");
    expect(
      [
        "state-vscdb-headers.json",
        "state-vscdb-legacy-itemtable.json",
        "ai-tracking.json",
      ].map((name) => buildDb(name).fixtureId)
    ).toStrictEqual([...CURSOR_LOCAL_DB_FIXTURE_IDS]);
  });

  it.effect(
    "reads a scoped composerHeaders snapshot without content, keeping context meters apart from spend",
    () =>
      Effect.gen(function* composerHeadersCase() {
        const { dbPath } = buildDb("state-vscdb-headers.json");
        const before = statSync(dbPath).mtimeMs;
        const scratchDir = scratch();

        const batch = yield* cursorLocalDbCollector.collect(
          inputFor(dbPath, repoContext, scratchDir)
        );

        yield* Schema.decodeUnknownEffect(EventBatchSchema)(batch);
        expect(statSync(dbPath).mtimeMs).toBe(before);
        expect(readdirSync(scratchDir)).toStrictEqual([]);
        expect(JSON.stringify(batch)).not.toContain(CANARY);
        expect(
          batch.events.map((event) => event.upstreamKey).toSorted()
        ).toStrictEqual([
          "bubble:fx-c1:b1",
          "bubble:fx-c1:b2",
          "composer:fx-c1",
          "composer:fx-c1:usage:fixture-model",
        ]);
        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "scope-excluded"
        );
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "unreadable-rows"
        );

        const session = byKey(batch.events, "composer:fx-c1");

        expect(session?.kind).toBe("ai.session");
        expect(session?.context.branch).toBe("feature/fx");
        expect(session?.payload).toMatchObject({
          contextMeter: { notSpend: true, tokensUsed: 45_000 },
          linesAdded: 40,
          model: "fixture-model",
        });

        const usage = byKey(batch.events, "composer:fx-c1:usage:fixture-model");

        expect(usage?.payload).toMatchObject({
          measurements: [{ currency: "USD", ledger: "metered", value: 12.5 }],
          requests: 3,
        });

        const turn = byKey(batch.events, "bubble:fx-c1:b2");

        expect(turn?.identity.requestId).toBe("fx-req-2");
        expect(turn?.payload).toMatchObject({
          measurements: [
            { category: "input", method: "source-reported", value: 1200 },
            { category: "output", method: "source-reported", value: 300 },
          ],
          toolName: "edit_file",
        });
        expect(byKey(batch.events, "bubble:fx-c1:b1")?.payload).toMatchObject({
          measurements: [],
          role: "user",
        });

        const again = yield* cursorLocalDbCollector.collect(
          inputFor(dbPath, repoContext)
        );

        expect(again.events.map((event) => event.eventId)).toStrictEqual(
          batch.events.map((event) => event.eventId)
        );
      })
  );

  it.effect(
    "reads legacy ItemTable composer indexes when no headers table exists",
    () =>
      Effect.gen(function* legacyCase() {
        const { dbPath } = buildDb("state-vscdb-legacy-itemtable.json");
        const batch = yield* cursorLocalDbCollector.collect(inputFor(dbPath));

        expect(batch.coverage.state).toBe("complete");
        expect(batch.events.map((event) => event.sourceVersion)).toStrictEqual([
          "state-vscdb/itemtable",
          "state-vscdb/itemtable",
        ]);
        expect(JSON.stringify(batch)).not.toContain(CANARY);
        expect(byKey(batch.events, "bubble:fx-l1:b1")?.occurredAt).toBe(
          "2026-09-21T14:31:40.000Z"
        );
      })
  );

  it.effect(
    "reads ai-tracking attribution for the selected branch and repo only",
    () =>
      Effect.gen(function* aiTrackingCase() {
        const { dbPath } = buildDb("ai-tracking.json");

        const batch = yield* cursorLocalDbCollector.collect(
          inputFor(dbPath, repoContext)
        );

        expect(batch.events.map((event) => event.upstreamKey)).toStrictEqual([
          "ai-code-hash:fxh1",
          "scored-commit:fxsha1:feature/fx",
        ]);
        expect(JSON.stringify(batch)).not.toContain(CANARY);
        expect(JSON.stringify(batch)).not.toContain("/fixture/repo/src/a.ts");
        expect(batch.events[1]?.payload).toMatchObject({
          linesBySource: { composer: { added: 40 }, human: { added: 5 } },
        });
      })
  );

  it.effect(
    "fails typed for missing input, missing file and unknown schema",
    () =>
      Effect.gen(function* failureCases() {
        const unknownPath = path.join(tempRoot, "unknown.db");
        const db = new DatabaseSync(unknownPath);

        db.exec("create table other (x integer)");
        db.close();

        const tags = yield* Effect.forEach(
          [
            inputFor(null),
            inputFor(path.join(tempRoot, "absent.db")),
            inputFor(unknownPath),
            inputFor(unknownPath, emptyFlightContext, null),
          ],
          (input) =>
            cursorLocalDbCollector.collect(input).pipe(
              Effect.flip,
              Effect.map((error) => error._tag)
            )
        );

        expect(tags).toStrictEqual([
          "InvalidInput",
          "SourceUnavailable",
          "UnsupportedSource",
          "InvalidInput",
        ]);
      })
  );
});
