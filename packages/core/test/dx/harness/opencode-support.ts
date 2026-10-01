// @effect-diagnostics nodeBuiltinImport:off -- The OpenCode fixture tier writes a real SQLite database into an owned temp home with node:sqlite and node:fs.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

import type { MemoryRepo } from "../../../src/dx/harness/git.js";
import type {
  MemoryTables,
  SqlValue,
} from "../../../src/dx/harness/local-sqlite.js";

const SqlValueSchema = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Null,
]);

const FixtureSchema = Schema.Struct({
  tables: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Record(Schema.String, SqlValueSchema))
  ),
});

export const FIXTURE_FILE = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "harness",
  "opencode",
  "opencode-db.json"
);

export const loadFixtureTables = (): MemoryTables =>
  Schema.decodeUnknownSync(Schema.fromJsonString(FixtureSchema))(
    readFileSync(FIXTURE_FILE, "utf-8")
  ).tables;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const writeDatabase = (file: string, tables: MemoryTables): void => {
  mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);

  try {
    for (const [table, rows] of Object.entries(tables)) {
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

      if (columns.length > 0) {
        db.exec(
          `CREATE TABLE ${quote(table)} (${columns.map(quote).join(", ")})`
        );

        const insert = db.prepare(
          `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
        );

        for (const row of rows) {
          insert.run(...columns.map((column): SqlValue => row[column] ?? null));
        }
      }
    }
  } finally {
    db.close();
  }
};

export const REALDATA = "/home/user/realdata/opencode";

export const FIXTURE_REPOS: readonly MemoryRepo[] = [
  {
    repoCommonDir: `${REALDATA}/repo/.git`,
    worktrees: [
      { branch: "main", headSha: "a1", path: `${REALDATA}/repo` },
      {
        branch: "feat/opencode-two",
        headSha: "b2",
        path: `${REALDATA}/wt-two`,
      },
    ],
  },
  {
    repoCommonDir: "/home/user/projects/p1/.git",
    worktrees: [
      { branch: "main", headSha: "c3", path: "/home/user/projects/p1" },
    ],
  },
];

export interface SessionSeed {
  readonly cost?: number;
  readonly directory: string;
  readonly forkOf?: string | null;
  readonly id: string;
  readonly parentId?: string | null;
  readonly title?: string;
  readonly tokens?: readonly [number, number, number, number, number];
  readonly agent?: string | null;
}

export const v2Session = (seed: SessionSeed) => {
  const [input, output, reasoning, cacheRead, cacheWrite] = seed.tokens ?? [
    0, 0, 0, 0, 0,
  ];

  return {
    agent: seed.agent ?? null,
    cost: seed.cost ?? 0,
    directory: seed.directory,
    fork_session_id: seed.forkOf ?? null,
    id: seed.id,
    model: JSON.stringify({ id: "gpt-5.6-luna", providerID: "opencode-go" }),
    parent_id: seed.parentId ?? null,
    project_id: "proj_fixture",
    slug: "fixture",
    time_archived: null,
    time_created: 1_790_000_000_000,
    time_updated: 1_790_000_100_000,
    title: seed.title ?? "Synthetic session",
    tokens_cache_read: cacheRead,
    tokens_cache_write: cacheWrite,
    tokens_input: input,
    tokens_output: output,
    tokens_reasoning: reasoning,
    version: "2.0.20",
  };
};

export interface MessageSeed {
  readonly at: number;
  readonly completed?: boolean;
  readonly cost?: number;
  readonly error?: string;
  readonly id: string;
  readonly model?: string;
  readonly paths?: readonly string[];
  readonly provider?: string;
  readonly seq: number;
  readonly sessionId: string;
  readonly tokens?: readonly [number, number, number, number, number];
  readonly type?: string;
  readonly variant?: string;
}

export const v2Message = (seed: MessageSeed) => {
  const type = seed.type ?? "assistant";

  const [input, output, reasoning, read, write] = seed.tokens ?? [
    0, 0, 0, 0, 0,
  ];

  const time =
    seed.completed === false
      ? { created: seed.at }
      : { completed: seed.at + 500, created: seed.at };

  const data =
    type === "assistant"
      ? {
          agent: "build",
          content: (seed.paths ?? []).map((filePath, index) => ({
            id: `call_${index}`,
            name: "read",
            state: { input: { filePath }, status: "completed" },
            type: "tool",
          })),
          cost: seed.cost ?? 0,
          error:
            seed.error === undefined
              ? null
              : { message: "synthetic", type: seed.error },
          finish: seed.completed === false ? null : "stop",
          model: {
            id: seed.model ?? "gpt-5.6-luna",
            providerID: seed.provider ?? "opencode-go",
            variant: seed.variant ?? "default",
          },
          time,
          tokens: { cache: { read, write }, input, output, reasoning },
        }
      : { files: [], text: "synthetic", time: { created: seed.at } };

  return {
    data: JSON.stringify(data),
    id: seed.id,
    seq: seed.seq,
    session_id: seed.sessionId,
    time_created: seed.at,
    time_updated: seed.at + 600,
    type,
  };
};
