// @effect-diagnostics nodeBuiltinImport:off -- This test builds throwaway cursor-agent chat stores from a committed fixture in an owned temp directory.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  CURSOR_CLI_SOURCE,
  chatStoreSources,
  chatsDirFor,
} from "../../src/dx/collectors/cursor-chats-store/sources.js";
import {
  CURSOR_CLI_ADAPTER_ID,
  cursorCliCollector,
} from "../../src/dx/collectors/cursor-cli/collector.js";
import {
  aiTrackingDbPath,
  localDbSources,
} from "../../src/dx/collectors/cursor-local-db/sources.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { joinAccountRows } from "../../src/dx/correlation/branch-at-time/session-join.js";
import { cursorSources } from "../../src/dx/harness/cursor/sources.js";
import {
  EventBatchSchema,
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type {
  DxEventEnvelope,
  FlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const CANARY = "FIXTURE_SECRET_PROMPT_CANARY";

const ChatFixtureSchema = Schema.Struct({
  chats: Schema.Array(
    Schema.Struct({
      agentId: Schema.String,
      blobs: Schema.Array(
        Schema.Struct({ hex: Schema.String, id: Schema.String })
      ),
      meta: Schema.Array(
        Schema.Struct({ key: Schema.String, value: Schema.String })
      ),
      metaJson: Schema.Struct({ cwd: Schema.String }),
    })
  ),
  fixtureId: Schema.String,
  origin: Schema.Literal("fixture"),
});

const fixture = Schema.decodeSync(Schema.fromJsonString(ChatFixtureSchema))(
  readFileSync(
    path.join(
      import.meta.dirname,
      "fixtures",
      "cursor-chats-store",
      "chats.json"
    ),
    "utf-8"
  )
);

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "dft-chats-store-"));

afterAll(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

const REPO = "/fixture/repo";

const writeStore = (dir: string, chat: (typeof fixture.chats)[number]) => {
  const chatDir = path.join(dir, chat.agentId);

  mkdirSync(chatDir, { recursive: true });
  writeFileSync(path.join(chatDir, "meta.json"), JSON.stringify(chat.metaJson));

  const db = new DatabaseSync(path.join(chatDir, "store.db"));

  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");

  for (const row of chat.meta) {
    db.prepare("insert into meta (key, value) values (?, ?)").run(
      row.key,
      row.value
    );
  }

  for (const blob of chat.blobs) {
    db.prepare("insert into blobs (id, data) values (?, ?)").run(
      blob.id,
      Buffer.from(blob.hex, "hex")
    );
  }

  db.close();

  return path.join(chatDir, "store.db");
};

const home = path.join(tempRoot, "home");

const chatsDir = chatsDirFor(home, REPO);

const stores = fixture.chats.map((chat) => writeStore(chatsDir, chat));

const context: FlightContext = {
  ...emptyFlightContext,
  branch: "feature/now",
  repoCommonDir: `${REPO}/.git`,
  worktreePath: REPO,
};

const accountRow = (occurredAt: string): DxEventEnvelope => ({
  acquisition: "api",
  adapterId: "cursor-usage-api",
  adapterVersion: "fixture",
  ai: null,
  context: emptyFlightContext,
  eventId: EventIdSchema.make(`sha256:account-${occurredAt}`),
  evidence: { bounded: true, hash: null, ref: "fixture" },
  fieldSemantics: [],
  identity: { ...emptyEventIdentity, sessionId: "fx-chat-1" },
  kind: "ai.usage",
  observedAt: occurredAt,
  occurredAt,
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: { sourceKind: "dashboard-json", tokens: { input: 10, output: 2 } },
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: `account-${occurredAt}`,
  usage: null,
});

const inputFor = (selectedInput: string): CollectInput => ({
  adapterId: CURSOR_CLI_ADAPTER_ID,
  context,
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const collect = (selectedInput: string) =>
  cursorCliCollector
    .collect(inputFor(selectedInput))
    .pipe(Effect.provide(NodeServices.layer));

const byKey = (events: readonly DxEventEnvelope[], upstreamKey: string) =>
  events.find((event) => event.upstreamKey === upstreamKey);

describe("cursor-agent chat store", () => {
  it.effect(
    "turns the chats folder of a worktree into chats and turns with the branch cursor-agent saw",
    () =>
      Effect.gen(function* chatsFolder() {
        const before = stores.map((file) => statSync(file).mtimeMs);
        const batch = yield* collect(chatsDir);

        yield* Schema.decodeEffect(EventBatchSchema)(batch);
        expect(stores.map((file) => statSync(file).mtimeMs)).toStrictEqual(
          before
        );
        expect(JSON.stringify(batch)).not.toContain(CANARY);
        expect(
          batch.events.map((event) => event.upstreamKey).toSorted()
        ).toStrictEqual([
          "chat:fx-chat-1",
          "chat:fx-chat-1:turn:fx-req-1",
          "chat:fx-chat-1:turn:fx-req-2",
          "chat:fx-chat-2",
          "chat:fx-chat-2:turn:fx-req-3",
        ]);
        expect(batch.coverage.gaps.map((gap) => gap.code)).toContain(
          "scope-excluded"
        );

        const first = byKey(batch.events, "chat:fx-chat-1:turn:fx-req-1");
        const second = byKey(batch.events, "chat:fx-chat-1:turn:fx-req-2");

        expect(first?.kind).toBe("ai.turn");
        expect(first?.identity).toMatchObject({
          requestId: "fx-req-1",
          sessionId: "fx-chat-1",
          turnId: "fx-msg-1",
        });
        expect(first?.context).toMatchObject({
          branch: "feature/one",
          worktreePath: REPO,
        });
        expect(first?.occurredAt).toBe("2026-09-30T13:04:12.050Z");
        expect(first?.payload).toMatchObject({
          branchSource: "cursor-agent-store",
          model: null,
          sourceKind: "cursor-cli-store",
          steps: 3,
          toolCalls: 1,
        });
        expect(first?.payload.measurements).toBeUndefined();
        expect(second?.context.branch).toBe("feature/two");
        expect(second?.payload.model).toBe("Fixture Model");

        const session = byKey(batch.events, "chat:fx-chat-1");

        expect(session?.kind).toBe("ai.session");
        expect(session?.context.branch).toBe("feature/one");
        expect(session?.payload).toMatchObject({
          contextMeter: { limitTokens: 256_000, notSpend: true },
          isSubagent: false,
          model: "fixture-model-high",
          parentSessionId: null,
          turns: 2,
        });

        expect(byKey(batch.events, "chat:fx-chat-2")?.payload).toMatchObject({
          isSubagent: true,
          model: "fixture-model-low",
          parentSessionId: "fx-chat-1",
          subagentType: "shell",
        });

        const again = yield* collect(chatsDir);

        expect(again.events.map((event) => event.eventId)).toStrictEqual(
          batch.events.map((event) => event.eventId)
        );
      })
  );

  it.effect(
    "puts Cursor account usage of a cursor-agent chat on the branch of the nearest turn",
    () =>
      Effect.gen(function* accountJoin() {
        const batch = yield* collect(chatsDir);

        const joined = joinAccountRows([
          ...batch.events,
          accountRow("2026-09-30T13:04:11.900Z"),
          accountRow("2026-09-30T13:05:52.000Z"),
        ]).filter((event) => event.adapterId === "cursor-usage-api");

        expect(
          joined.map((event) => [
            event.context.branch,
            event.context.worktreePath,
          ])
        ).toStrictEqual([
          ["feature/one", REPO],
          ["feature/two", REPO],
        ]);
      })
  );

  it.effect("reads one selected store.db file the same way", () =>
    Effect.gen(function* singleStore() {
      const [store] = stores;
      const batch = yield* collect(store ?? "");

      expect(
        batch.events.map((event) => event.identity.sessionId)
      ).toStrictEqual(["fx-chat-1", "fx-chat-1", "fx-chat-1"]);
      expect(batch.coverage.state).toBe("complete");
    })
  );

  it("locates the chats folder and the Cursor databases for every synced worktree", () => {
    const worktree = path.join(tempRoot, "wt");
    const aiTracking = aiTrackingDbPath(home);

    mkdirSync(worktree, { recursive: true });
    mkdirSync(chatsDirFor(home, worktree), { recursive: true });
    mkdirSync(path.dirname(aiTracking), { recursive: true });
    writeFileSync(aiTracking, "");

    expect(chatStoreSources(home, worktree)).toStrictEqual([
      { input: chatsDirFor(home, worktree), source: CURSOR_CLI_SOURCE },
    ]);
    expect(localDbSources(home)).toStrictEqual([
      { input: aiTracking, source: "cursor-local-db" },
    ]);

    const planned = cursorSources({
      dftHome: path.join(tempRoot, "dft-home"),
      home,
      repoCommonDir: null,
      worktrees: [worktree],
    }).map((step) => ({ input: step.input, source: step.source }));

    expect(planned).toContainEqual({
      input: chatsDirFor(home, worktree),
      source: CURSOR_CLI_SOURCE,
    });
    expect(planned).toContainEqual({
      input: aiTracking,
      source: "cursor-local-db",
    });
    expect(
      chatStoreSources(home, path.join(tempRoot, "elsewhere"))
    ).toStrictEqual([]);
  });
});
