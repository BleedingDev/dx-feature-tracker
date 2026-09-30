// @effect-diagnostics nodeBuiltinImport:off -- This test scripts a throwaway git repo with a nested linked worktree and builds Cursor SQLite files from committed fixtures in a scratch directory.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { cursorLocalDbCollector } from "../../src/dx/collectors/cursor-local-db/collector.js";
import {
  normalizePath,
  ownerOf,
} from "../../src/dx/collectors/cursor-local-db/scope.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { EventBatchSchema } from "../../src/dx/model/event.js";
import type { FlightContext } from "../../src/dx/model/event.js";
import { contextForRepo } from "../../src/dx/registry/runtime.js";

const CANARY = "SCOPE_SECRET_PROMPT_CANARY";

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
    "cursorDiskKV",
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  ],
  [
    "scored_commits",
    "CREATE TABLE scored_commits (commitHash TEXT NOT NULL, branchName TEXT NOT NULL, scoredAt INTEGER NOT NULL, linesAdded INTEGER, linesDeleted INTEGER, tabLinesAdded INTEGER, tabLinesDeleted INTEGER, composerLinesAdded INTEGER, composerLinesDeleted INTEGER, humanLinesAdded INTEGER, humanLinesDeleted INTEGER, commitDate TEXT, PRIMARY KEY (commitHash, branchName))",
  ],
]);

const CellSchema = Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]));

const FixtureSchema = Schema.Struct({
  tables: Schema.Array(Schema.String),
  workspaceFolders: Schema.optional(
    Schema.Record(Schema.String, Schema.String)
  ),
});

const RowsSchema = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Record(Schema.String, CellSchema))
);

const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-scope-")));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const MAIN = path.join(scratch, "app");

const NESTED = path.join(MAIN, ".worktrees", "wt-a");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
    },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

mkdirSync(MAIN, { recursive: true });

git(MAIN, "init", "-q", "-b", "main");

writeFileSync(path.join(MAIN, "a.ts"), "a");

git(MAIN, "add", "a.ts");

git(MAIN, "commit", "-q", "--no-gpg-sign", "-m", "a");

git(MAIN, "worktree", "add", "-q", "-b", "feature/wt", NESTED);

const HEAD = git(MAIN, "rev-parse", "HEAD");

const fixtureText = (name: string) =>
  readFileSync(
    path.join(import.meta.dirname, "fixtures", "cursor-local-db-scope", name),
    "utf-8"
  )
    .replaceAll("__MAIN__", MAIN)
    .replaceAll("__HEAD__", HEAD);

const buildDb = (name: string, dbPath: string) => {
  const text = fixtureText(name);
  const fixture = Schema.decodeSync(Schema.fromJsonString(FixtureSchema))(text);

  const rows = Schema.decodeSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
  )(text);

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  for (const table of fixture.tables) {
    db.exec(DDL.get(table) ?? "");

    const tableRows = Schema.decodeUnknownSync(RowsSchema)({
      [table]: rows[table] ?? [],
    })[table];

    for (const row of tableRows ?? []) {
      const columns = Object.keys(row);

      db.prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`
      ).run(...columns.map((column) => row[column] ?? null));
    }
  }

  db.close();

  for (const [id, folder] of Object.entries(fixture.workspaceFolders ?? {})) {
    const dir = path.join(
      path.dirname(path.dirname(dbPath)),
      "workspaceStorage",
      id
    );

    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ folder }));
  }

  return dbPath;
};

const statePath = buildDb(
  "state.json",
  path.join(scratch, "cursor", "User", "globalStorage", "state.vscdb")
);

const trackingPath = buildDb(
  "tracking.json",
  path.join(scratch, "home", ".cursor", "ai-tracking", "ai-code-tracking.db")
);

const inputFor = (
  selectedInput: string,
  context: FlightContext
): CollectInput => ({
  adapterId: "cursor-local-db",
  context,
  cursor: null,
  origin: "live",
  scratchDir: null,
  selectedInput,
});

const keysOf = (selectedInput: string, repo: string) =>
  Effect.gen(function* collectKeys() {
    const batch = yield* cursorLocalDbCollector.collect(
      inputFor(selectedInput, contextForRepo(repo))
    );

    yield* Schema.decodeEffect(EventBatchSchema)(batch);
    expect(JSON.stringify(batch)).not.toContain(CANARY);

    return {
      batch,
      keys: batch.events.map((event) => event.upstreamKey).toSorted(),
    };
  });

describe("Cursor local DB auto-sync scope", () => {
  it("matches paths on folder boundaries and file URIs", () => {
    expect(normalizePath("file:///fixture/my%20repo/")).toBe(
      "/fixture/my repo"
    );
    expect(normalizePath("relative/path")).toBeNull();
    expect(ownerOf("/fixture/repo-other/a.ts", ["/fixture/repo"])).toBeNull();
    expect(
      ownerOf("/fixture/repo/.worktrees/wt/a.ts", [
        "/fixture/repo",
        "/fixture/repo/.worktrees/wt",
      ])
    ).toBe("/fixture/repo/.worktrees/wt");
    expect(ownerOf("/tmp/x/a.ts", ["/private/tmp/x"])).toBe("/private/tmp/x");
  });

  it.effect(
    "gives each worktree only its own composers, including the nested worktree and workspace folders",
    () =>
      Effect.gen(function* stateScope() {
        const main = yield* keysOf(statePath, MAIN);
        const nested = yield* keysOf(statePath, NESTED);

        expect(main.keys).toStrictEqual([
          "bubble:sc-folder:b1",
          "bubble:sc-main:b1",
          "composer:sc-folder",
          "composer:sc-main",
        ]);
        expect(nested.keys).toStrictEqual([
          "bubble:sc-nested:b1",
          "composer:sc-nested",
        ]);
        expect(main.batch.coverage.state).toBe("complete");
        expect(main.batch.events[0]?.context.branch).toBe("main");
        expect(nested.batch.events[0]?.context.branch).toBe("feature/wt");
      })
  );

  it.effect(
    "keeps edits under the worktree and scored commits that exist in the repo",
    () =>
      Effect.gen(function* trackingScope() {
        const main = yield* keysOf(trackingPath, MAIN);
        const nested = yield* keysOf(trackingPath, NESTED);

        expect(main.keys).toStrictEqual([
          "ai-code-hash:h-main",
          `scored-commit:${HEAD}:main`,
        ]);
        expect(nested.keys).toStrictEqual(["ai-code-hash:h-nested"]);
      })
  );
});
