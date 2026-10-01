// @effect-diagnostics nodeBuiltinImport:off -- The OpenCode fixture tier owns a temp home holding a real SQLite file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type { Harness, SessionRef } from "../../../src/dx/harness/contract.js";
import { GitRunner } from "../../../src/dx/harness/git.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { LocalSqlite } from "../../../src/dx/harness/local-sqlite.js";
import type { MemoryTables } from "../../../src/dx/harness/local-sqlite.js";
import {
  OPENCODE_PLUGIN_EVENTS,
  OpencodeHarness,
  OpencodeStore,
  opencodeHookDecoder,
  opencodePluginSource,
} from "../../../src/dx/harness/opencode/index.js";
import {
  HarnessRegistryLive,
  registryWith,
} from "../../../src/dx/harness/registry.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { harnessConformance } from "./conformance.js";
import {
  FIXTURE_REPOS,
  REALDATA,
  loadFixtureTables,
  v2Message,
  v2Session,
  writeDatabase,
} from "./opencode-support.js";

const home = mkdtempSync(path.join(os.tmpdir(), "dft-opencode-harness-"));

const dataDir = path.join(home, ".local", "share", "opencode");

const fixtureTables = loadFixtureTables();

writeDatabase(path.join(dataDir, "opencode.db"), fixtureTables);

writeFileSync(path.join(dataDir, "auth.json"), "{}");

afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const fixtureLayer = Layer.fresh(OpencodeHarness.layer).pipe(
  Layer.provide(OpencodeStore.layer),
  Layer.provide(
    Layer.mergeAll(
      HarnessHome.at(home),
      LocalSqlite.layer,
      GitRunner.memory(FIXTURE_REPOS)
    )
  ),
  Layer.provide(NodeServices.layer)
);

const memoryLayer = (
  databases: Readonly<Record<string, MemoryTables>>,
  repos = FIXTURE_REPOS
) =>
  Layer.fresh(OpencodeHarness.layer).pipe(
    Layer.provide(
      OpencodeStore.memory({
        databases: Object.fromEntries(
          Object.entries(databases).map(([file, tables]) => [
            file,
            { mtimeMs: 1, tables },
          ])
        ),
        files: [],
        roots: ["/home/user/.local/share/opencode"],
      })
    ),
    Layer.provide(GitRunner.memory(repos))
  );

const repoScope = {
  ...everywhere,
  dftHome: path.join(home, ".dft"),
  worktrees: [`${REALDATA}/repo`, `${REALDATA}/wt-two`],
};

harnessConformance(
  "opencode",
  registryWith(memoryLayer({ "/m/opencode.db": fixtureTables })),
  {
    expectEvents: true,
    tier: "mock",
  }
);

harnessConformance("opencode", registryWith(fixtureLayer), {
  context: {
    ...emptyFlightContext,
    branch: "main",
    repoCommonDir: `${REALDATA}/repo/.git`,
    worktreePath: `${REALDATA}/repo`,
  },
  expectEvents: true,
  scope: repoScope,
  tier: "fixture",
});

harnessConformance("opencode", registryWith(fixtureLayer), {
  expectEvents: true,
  tier: "fixture",
});

harnessConformance(
  "opencode",
  HarnessRegistryLive.pipe(Layer.provide(NodeServices.layer)),
  { maxSessions: 25, tier: "live" }
);

const input = {
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture" as const,
};

const readAll = (harness: Harness, refs: readonly SessionRef[]) =>
  Effect.forEach((ref: SessionRef) => harness.read(ref, input))(refs).pipe(
    Effect.map((batches) => batches.flatMap((batch) => batch.events))
  );

const readEverything = Effect.gen(function* readEverything() {
  const harness = yield* OpencodeHarness;
  const refs = yield* harness.locate(everywhere);

  return yield* readAll(harness, refs);
});

const usageOf = (events: readonly DxEventEnvelope[], sessionId: string) =>
  events.filter(
    (event) => event.usage !== null && event.ai?.sessionId === sessionId
  );

const sum = (
  events: readonly DxEventEnvelope[],
  field: "inputFresh" | "output" | "reasoning" | "cacheRead" | "cacheWrite"
) =>
  events.reduce((total, event) => total + (event.usage?.tokens[field] ?? 0), 0);

const SESSION_TOTAL_FIELDS = [
  ["inputFresh", "tokens_input"],
  ["reasoning", "tokens_reasoning"],
  ["cacheRead", "tokens_cache_read"],
  ["cacheWrite", "tokens_cache_write"],
] as const;

const sessionTotal = (id: string, column: string): number =>
  Math.max(
    ...[
      ...(fixtureTables.session_v2 ?? []),
      ...(fixtureTables.session ?? []),
    ].flatMap((row) => (row.id === id ? [Number(row[column] ?? 0)] : []))
  );

describe("OpenCode harness over redacted real sessions", () => {
  it.effect("reproduces every session total with per-request usage", () =>
    Effect.gen(function* totals() {
      const events = yield* readEverything;

      for (const session of fixtureTables.session_v2 ?? []) {
        const id = yield* Schema.decodeUnknownEffect(Schema.String)(session.id);
        const usage = usageOf(events, id);

        for (const [field, column] of SESSION_TOTAL_FIELDS) {
          expect(sum(usage, field), `${id} ${field}`).toBe(
            sessionTotal(id, column)
          );
        }

        expect(sum(usage, "output"), id).toBe(
          sessionTotal(id, "tokens_output") +
            sessionTotal(id, "tokens_reasoning")
        );
      }
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("keeps one event per request key", () =>
    Effect.gen(function* keys() {
      const events = yield* readEverything;

      const keyed = events.flatMap((event) =>
        event.usage?.requestKey === null || event.usage === null
          ? []
          : [event.usage.requestKey]
      );

      expect(new Set(keyed).size).toBe(keyed.length);
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("attributes model maker, gateway, version and effort", () =>
    Effect.gen(function* attribution() {
      const events = yield* readEverything;

      const request = events.find(
        (event) =>
          event.kind === "ai.usage" &&
          event.ai?.sessionId === "ses_f08e7aec2ffe0oeQUnmmLJuPVj" &&
          event.payload.scope === "request"
      );

      expect(request?.ai).toMatchObject({
        channel: "local-db",
        harness: "opencode",
        harnessVersion: "2.0.19",
        model: "gpt-5.6-luna",
        modelRaw: "opencode-go/gpt-5.6-luna",
        provider: "openai",
        via: "opencode-go",
      });
      expect(request?.usage?.toolFigure?.kind).toBe("api-equivalent");

      const efforts = new Set(
        events.flatMap((event) =>
          event.ai?.effort === null || event.ai === null
            ? []
            : [event.ai.effort]
        )
      );

      expect(efforts.size).toBeGreaterThan(0);
      expect(efforts.has("default")).toBe(false);
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("keeps a subagent apart from its orchestrator", () =>
    Effect.gen(function* subagent() {
      const events = yield* readEverything;
      const child = usageOf(events, "ses_f08e51e3dffeHNPcOJtvHpq4yG");

      expect(child.length).toBe(2);

      for (const event of child) {
        expect(event.ai).toMatchObject({
          agentId: "ses_f08e51e3dffeHNPcOJtvHpq4yG",
          agentType: "explore",
          parentSessionId: "ses_f08e529bdffeoPol7ZgPl8JcZK",
        });
      }

      expect(sum(child, "inputFresh")).toBe(6);
      expect(
        sum(usageOf(events, "ses_f08e529bdffeoPol7ZgPl8JcZK"), "inputFresh")
      ).toBe(558);
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("keeps every turn of a resumed session in one chat", () =>
    Effect.gen(function* resumed() {
      const events = yield* readEverything;
      const id = "ses_f08e68d65ffeyNOITtsH0DU1py";

      const turns = events.filter(
        (event) => event.kind === "ai.turn" && event.ai?.sessionId === id
      );

      expect(turns.length).toBe(3);
      expect(
        turns.every((turn) => turn.payload.model === "opencode-go/gpt-5.6-luna")
      ).toBe(true);
      expect(
        usageOf(events, id).filter((event) => event.payload.scope === "request")
          .length
      ).toBe(8);

      const session = events.find(
        (event) => event.kind === "ai.session" && event.ai?.sessionId === id
      );

      expect(session?.payload.title).toBe(
        "Fixture session 2: resumed across a branch switch"
      );
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("places worktree, repository and folder-only sessions", () =>
    Effect.gen(function* placement() {
      const events = yield* readEverything;

      const worktree = usageOf(events, "ses_f08e5b272ffeNAkdLwA4f0IQWo");

      expect(
        worktree.every((event) => event.context.branch === "feat/opencode-two")
      ).toBe(true);
      expect(
        worktree.every((event) => event.ai?.branchSource === "cwd-inferred")
      ).toBe(true);

      const outside = usageOf(events, "ses_f08e4cf12ffeDLvx10XiwR5nKk");

      expect(outside.length).toBeGreaterThan(0);
      expect(
        outside.every((event) => event.ai?.branchSource === "unassigned")
      ).toBe(true);
      expect(
        outside.every((event) => event.context.worktreePath === null)
      ).toBe(true);
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("reads only the scoped worktree from a shared database", () =>
    Effect.gen(function* scoped() {
      const harness = yield* OpencodeHarness;

      const refs = yield* harness.locate({
        ...everywhere,
        worktrees: [`${REALDATA}/wt-two`],
      });

      expect(refs.map((ref) => ref.worktree)).toStrictEqual([
        `${REALDATA}/wt-two`,
      ]);

      const events = yield* readAll(harness, refs);
      const sessions = new Set(events.map((event) => event.ai?.sessionId));

      expect([...sessions]).toStrictEqual(["ses_f08e5b272ffeNAkdLwA4f0IQWo"]);
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("reports a failed request without inventing tokens", () =>
    Effect.gen(function* failed() {
      const events = yield* readEverything;

      const failures = events.filter(
        (event) =>
          event.ai?.sessionId === "ses_3644c3d3effeCV3Dnfy21dQTiv" &&
          event.kind === "ai.request"
      );

      expect(failures.length).toBeGreaterThan(0);
      expect(failures.every((event) => event.usage === null)).toBe(true);
      expect(failures.every((event) => event.payload.failed === true)).toBe(
        true
      );
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("records a model change inside one session", () =>
    Effect.gen(function* modelChange() {
      const events = yield* readEverything;

      const models = new Set(
        events.flatMap((event) =>
          event.ai?.sessionId === "ses_fb371ac7dffe0uMzq1nvNPymd5" &&
          event.ai.modelRaw !== null &&
          event.kind !== "ai.session"
            ? [event.ai.modelRaw]
            : []
        )
      );

      expect(models.size).toBeGreaterThan(1);
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("reads sessions that exist only in the v1 tables", () =>
    Effect.gen(function* legacy() {
      const events = yield* readEverything;
      const usage = usageOf(events, "ses_fc20f7d03ffeZuJA7lQf8k7yeu");

      expect(usage.length).toBeGreaterThan(0);
      expect(
        usage.every(
          (event) => event.ai?.cwd?.startsWith("/home/user/") === true
        )
      ).toBe(true);
    }).pipe(Effect.provide(fixtureLayer))
  );

  it.effect("finds databases under XDG_DATA_HOME and channel names", () =>
    Effect.gen(function* discovery() {
      const harness = yield* OpencodeHarness;
      const found = yield* harness.discover;

      expect(found.present).toBe(true);
      expect(found.roots).toStrictEqual([path.join(home, "xdg", "opencode")]);
      expect(found.sessions).toBe(2 * 12);

      const refs = yield* harness.locate(everywhere);

      expect(refs.map((ref) => path.basename(ref.path))).toStrictEqual([
        "opencode-local.db",
        "opencode.db",
      ]);
    }).pipe(
      Effect.provide(
        Layer.fresh(OpencodeHarness.layer).pipe(
          Layer.provide(OpencodeStore.layer),
          Layer.provide(
            Layer.mergeAll(
              HarnessHome.at(home, { XDG_DATA_HOME: path.join(home, "xdg") }),
              LocalSqlite.layer,
              GitRunner.memory([])
            )
          ),
          Layer.provide(NodeServices.layer)
        )
      )
    )
  );
});

writeDatabase(path.join(home, "xdg", "opencode", "opencode.db"), fixtureTables);

writeDatabase(
  path.join(home, "xdg", "opencode", "opencode-local.db"),
  fixtureTables
);

writeFileSync(path.join(home, "xdg", "opencode", "opencode.db.bak"), "");

const DIR = `${REALDATA}/repo`;

const S = "ses_parent";

const read = (tables: MemoryTables, repos = FIXTURE_REPOS) =>
  readEverything.pipe(
    Effect.provide(memoryLayer({ "/m/opencode.db": tables }, repos))
  );

describe("OpenCode dedupe rules", () => {
  it.effect("counts a v1 row copied into session_message once", () =>
    Effect.gen(function* copied() {
      const message = v2Message({
        at: 10,
        id: "msg_a",
        seq: 1,
        sessionId: S,
        tokens: [5, 6, 0, 7, 0],
      });

      const events = yield* read({
        message: [
          {
            data: JSON.stringify({
              modelID: "gpt-5.6-luna",
              providerID: "opencode-go",
              role: "assistant",
              time: { completed: 11, created: 10 },
              tokens: {
                cache: { read: 7, write: 0 },
                input: 5,
                output: 6,
                reasoning: 0,
              },
            }),
            id: "msg_a",
            session_id: S,
            time_created: 10,
            time_updated: 11,
          },
        ],
        session_message: [message],
        session_v2: [
          v2Session({ directory: DIR, id: S, tokens: [5, 6, 0, 7, 0] }),
        ],
      });

      const usage = usageOf(events, S);

      expect(usage.map((event) => event.usage?.requestKey)).toStrictEqual([
        "opencode:msg_a",
      ]);
      expect(usage[0]?.payload.storedIn).toBe("session_message");
    })
  );

  it.effect(
    "prefers the finished copy when the v2 copy was taken mid-stream",
    () =>
      Effect.gen(function* staleCopy() {
        const stale = v2Message({
          at: 10,
          completed: false,
          id: "msg_a",
          seq: 1,
          sessionId: S,
          tokens: [0, 0, 0, 0, 0],
        });

        const later = v2Message({
          at: 30,
          id: "msg_b",
          seq: 2,
          sessionId: S,
          tokens: [2, 2, 0, 0, 0],
        });

        const finished = {
          data: JSON.stringify({
            modelID: "gpt-5.6-luna",
            providerID: "opencode-go",
            role: "assistant",
            time: { completed: 20, created: 10 },
            tokens: {
              cache: { read: 0, write: 0 },
              input: 9,
              output: 4,
              reasoning: 0,
            },
          }),
          id: "msg_a",
          session_id: S,
          time_created: 10,
          time_updated: 20,
        };

        const events = yield* read({
          message: [finished],
          session: [
            v2Session({ directory: DIR, id: S, tokens: [11, 6, 0, 0, 0] }),
          ],
          session_message: [stale, later],
          session_v2: [
            v2Session({ directory: DIR, id: S, tokens: [2, 2, 0, 0, 0] }),
          ],
        });

        const usage = usageOf(events, S);

        expect(
          usage.map((event) => [
            event.usage?.requestKey,
            event.payload.storedIn,
          ])
        ).toStrictEqual([
          ["opencode:msg_a", "message"],
          ["opencode:msg_b", "session_message"],
        ]);
        expect(sum(usage, "inputFresh")).toBe(11);
      })
  );

  it.effect(
    "skips a request that is still streaming and reads it once finished",
    () =>
      Effect.gen(function* streaming() {
        const session = v2Session({
          directory: DIR,
          id: S,
          tokens: [5, 6, 0, 0, 0],
        });

        const first = v2Message({
          at: 10,
          id: "msg_a",
          seq: 1,
          sessionId: S,
          tokens: [5, 6, 0, 0, 0],
        });

        const streamingRow = v2Message({
          at: 20,
          completed: false,
          id: "msg_b",
          seq: 2,
          sessionId: S,
          tokens: [0, 0, 0, 0, 0],
        });

        const during = usageOf(
          yield* read({
            session_message: [first, streamingRow],
            session_v2: [session],
          }),
          S
        );

        expect(during.map((event) => event.usage?.requestKey)).toStrictEqual([
          "opencode:msg_a",
        ]);

        const done = v2Message({
          at: 20,
          id: "msg_b",
          seq: 2,
          sessionId: S,
          tokens: [1, 2, 0, 0, 0],
        });

        const after = usageOf(
          yield* read({
            session_message: [first, done],
            session_v2: [
              v2Session({ directory: DIR, id: S, tokens: [6, 8, 0, 0, 0] }),
            ],
          }),
          S
        );

        expect(after.map((event) => event.usage?.requestKey)).toStrictEqual([
          "opencode:msg_a",
          "opencode:msg_b",
        ]);
        expect(after[0]?.eventId).toBe(during[0]?.eventId);
      })
  );

  it.effect("drops history a fork replays from its source session", () =>
    Effect.gen(function* forked() {
      const original = v2Message({
        at: 10,
        id: "msg_a",
        seq: 1,
        sessionId: S,
        tokens: [5, 6, 0, 0, 0],
      });

      const replayedSameId = {
        ...original,
        id: "msg_a_copy",
        session_id: "ses_fork",
      };

      const own = v2Message({
        at: 30,
        id: "msg_c",
        seq: 3,
        sessionId: "ses_fork",
        tokens: [1, 1, 0, 0, 0],
      });

      const events = yield* read({
        session_message: [original, replayedSameId, own],
        session_v2: [
          v2Session({ directory: DIR, id: S, tokens: [5, 6, 0, 0, 0] }),
          v2Session({
            directory: DIR,
            forkOf: S,
            id: "ses_fork",
            tokens: [1, 1, 0, 0, 0],
          }),
        ],
      });

      expect(
        usageOf(events, "ses_fork").map((event) => event.usage?.requestKey)
      ).toStrictEqual(["opencode:msg_c"]);
      expect(sum(usageOf(events, S), "inputFresh")).toBe(5);
    })
  );

  it.effect("never folds a subagent into its parent total", () =>
    Effect.gen(function* subagents() {
      const events = yield* read({
        session_message: [
          v2Message({
            at: 10,
            id: "msg_p",
            seq: 1,
            sessionId: S,
            tokens: [5, 5, 0, 0, 0],
          }),
          v2Message({
            at: 20,
            id: "msg_c",
            seq: 1,
            sessionId: "ses_child",
            tokens: [3, 3, 0, 0, 0],
          }),
        ],
        session_v2: [
          v2Session({ directory: DIR, id: S, tokens: [5, 5, 0, 0, 0] }),
          v2Session({
            agent: "general",
            directory: DIR,
            id: "ses_child",
            parentId: S,
            tokens: [3, 3, 0, 0, 0],
          }),
        ],
      });

      expect(sum(usageOf(events, S), "inputFresh")).toBe(5);
      expect(sum(usageOf(events, "ses_child"), "inputFresh")).toBe(3);
      expect(usageOf(events, "ses_child")[0]?.ai?.agentType).toBe("general");
    })
  );

  it.effect(
    "adds title and compaction calls missing from messages as one overhead row",
    () =>
      Effect.gen(function* overhead() {
        const events = yield* read({
          session_message: [
            v2Message({
              at: 10,
              id: "msg_a",
              seq: 1,
              sessionId: S,
              tokens: [5, 6, 1, 0, 0],
            }),
          ],
          session_v2: [
            v2Session({
              cost: 0.5,
              directory: DIR,
              id: S,
              tokens: [530, 14, 1, 0, 0],
            }),
          ],
        });

        const rows = usageOf(events, S).filter(
          (event) => event.payload.scope === "session-overhead"
        );

        expect(rows.map((event) => event.usage?.requestKey)).toStrictEqual([
          `opencode:${S}:overhead`,
        ]);
        expect(rows[0]?.usage?.tokens.inputFresh).toBe(525);
        expect(rows[0]?.usage?.tokens.output).toBe(8);
        expect(rows[0]?.usage?.toolFigure?.amount).toBe(0.5);

        const exact = yield* read({
          session_message: [
            v2Message({
              at: 10,
              id: "msg_a",
              seq: 1,
              sessionId: S,
              tokens: [5, 6, 1, 0, 0],
            }),
          ],
          session_v2: [
            v2Session({ directory: DIR, id: S, tokens: [5, 6, 1, 0, 0] }),
          ],
        });

        expect(
          usageOf(exact, S).map((event) => event.payload.scope)
        ).toStrictEqual(["request"]);
      })
  );

  it.effect("gives the same message in two databases the same event id", () =>
    Effect.gen(function* twoDatabases() {
      const tables = {
        session_message: [
          v2Message({
            at: 10,
            id: "msg_a",
            seq: 1,
            sessionId: S,
            tokens: [5, 6, 0, 0, 0],
          }),
        ],
        session_v2: [
          v2Session({ directory: DIR, id: S, tokens: [5, 6, 0, 0, 0] }),
        ],
      };

      const events = yield* readEverything.pipe(
        Effect.provide(
          memoryLayer({
            "/m/opencode-local.db": tables,
            "/m/opencode.db": tables,
          })
        )
      );

      const ids = usageOf(events, S).map((event) => event.eventId);

      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(1);
    })
  );

  it.effect(
    "credits a folder-only turn to the one repository its tools touched",
    () =>
      Effect.gen(function* toolCalls() {
        const events = yield* read({
          session_message: [
            v2Message({
              at: 5,
              id: "msg_u",
              seq: 1,
              sessionId: S,
              type: "user",
            }),
            v2Message({
              at: 10,
              id: "msg_a",
              paths: [`${REALDATA}/wt-two/main.py`],
              seq: 2,
              sessionId: S,
              tokens: [5, 6, 0, 0, 0],
            }),
            v2Message({
              at: 20,
              id: "msg_b",
              seq: 3,
              sessionId: S,
              tokens: [1, 1, 0, 0, 0],
            }),
          ],
          session_v2: [
            v2Session({
              directory: "/home/user/scratch",
              id: S,
              tokens: [6, 7, 0, 0, 0],
            }),
          ],
        });

        const usage = usageOf(events, S);

        expect(usage.map((event) => event.ai?.branchSource)).toStrictEqual([
          "tool-calls",
          "tool-calls",
        ]);
        expect(
          usage.every((event) => event.context.branch === "feat/opencode-two")
        ).toBe(true);
      })
  );

  it.effect(
    "splits a folder-only orchestrator across its subagents' repositories by tokens",
    () =>
      Effect.gen(function* split() {
        const events = yield* read({
          session_message: [
            v2Message({
              at: 10,
              id: "msg_p",
              seq: 1,
              sessionId: S,
              tokens: [101, 10, 0, 0, 0],
            }),
            v2Message({
              at: 20,
              id: "msg_c1",
              seq: 1,
              sessionId: "ses_c1",
              tokens: [30, 0, 0, 0, 0],
            }),
            v2Message({
              at: 30,
              id: "msg_c2",
              seq: 1,
              sessionId: "ses_c2",
              tokens: [10, 0, 0, 0, 0],
            }),
          ],
          session_v2: [
            v2Session({
              directory: "/home/user/scratch",
              id: S,
              tokens: [101, 10, 0, 0, 0],
            }),
            v2Session({
              directory: `${REALDATA}/repo`,
              id: "ses_c1",
              parentId: S,
              tokens: [30, 0, 0, 0, 0],
            }),
            v2Session({
              directory: "/home/user/projects/p1",
              id: "ses_c2",
              parentId: S,
              tokens: [10, 0, 0, 0, 0],
            }),
          ],
        });

        const pieces = usageOf(events, S);

        expect(pieces.map((event) => event.ai?.branchSource)).toStrictEqual([
          "subagent-split",
          "subagent-split",
        ]);
        expect(pieces.map((event) => event.context.worktreePath)).toStrictEqual(
          [`${REALDATA}/repo`, "/home/user/projects/p1"]
        );
        expect(sum(pieces, "inputFresh")).toBe(101);
        expect(sum(pieces, "output")).toBe(10);
        expect(
          new Set(pieces.map((event) => event.usage?.requestKey)).size
        ).toBe(2);
      })
  );

  it.effect("follows a session that moved to another folder", () =>
    Effect.gen(function* moved() {
      const events = yield* read({
        session_message: [
          v2Message({
            at: 10,
            id: "msg_a",
            seq: 1,
            sessionId: S,
            tokens: [5, 6, 0, 0, 0],
          }),
          {
            data: JSON.stringify({
              location: { directory: `${REALDATA}/wt-two` },
              previous: { location: { directory: `${REALDATA}/repo` } },
              time: { created: 15 },
            }),
            id: "msg_move",
            seq: 2,
            session_id: S,
            time_created: 15,
            time_updated: 15,
            type: "location-switched",
          },
          v2Message({
            at: 20,
            id: "msg_b",
            seq: 3,
            sessionId: S,
            tokens: [1, 1, 0, 0, 0],
          }),
        ],
        session_v2: [
          v2Session({
            directory: `${REALDATA}/wt-two`,
            id: S,
            tokens: [6, 7, 0, 0, 0],
          }),
        ],
      });

      expect(
        usageOf(events, S).map((event) => event.context.branch)
      ).toStrictEqual(["main", "feat/opencode-two"]);
    })
  );

  it.effect(
    "skips an unchanged database and reads only newer rows after a cursor",
    () =>
      Effect.gen(function* incremental() {
        const harness = yield* OpencodeHarness;
        const [located] = yield* harness.locate(everywhere);

        expect(located).toBeDefined();

        const ref = located ?? {
          channel: "local-db" as const,
          harness: "opencode" as const,
          id: "missing",
          mtimeMs: null,
          path: "missing",
          sessionId: null,
          size: null,
          source: "harness.opencode",
          worktree: null,
        };

        const first = yield* harness.read(ref, input);

        expect(first.events.length).toBeGreaterThan(0);

        const again = yield* harness.read(ref, {
          ...input,
          cursor: first.cursor,
        });

        expect(again.events).toStrictEqual([]);

        const moved = yield* harness.read(
          { ...ref, mtimeMs: 2 },
          { ...input, cursor: first.cursor }
        );

        expect(
          moved.events.filter((event) => event.kind === "ai.usage")
        ).toStrictEqual([]);
      }).pipe(
        Effect.provide(
          memoryLayer({
            "/m/opencode.db": {
              session_message: [
                v2Message({
                  at: 10,
                  id: "msg_a",
                  seq: 1,
                  sessionId: S,
                  tokens: [5, 6, 0, 0, 0],
                }),
              ],
              session_v2: [
                v2Session({ directory: DIR, id: S, tokens: [5, 6, 0, 0, 0] }),
              ],
            },
          })
        )
      )
  );
});

describe("OpenCode plugin observations", () => {
  it("decodes the events the plugin forwards", () => {
    const step = JSON.stringify({
      properties: {
        assistantMessageID: "msg_a",
        model: {
          id: "gpt-5.6-luna",
          providerID: "opencode-go",
          variant: "high",
        },
        sessionID: "ses_x",
      },
      type: "session.step.ended",
    });

    expect(
      opencodeHookDecoder.decode(step, "session.step.ended")
    ).toMatchObject({
      effort: "high",
      model: "opencode-go/gpt-5.6-luna",
      sessionId: "ses_x",
      turnId: "msg_a",
    });

    const created = JSON.stringify({
      properties: {
        info: {
          directory: "/home/user/repo",
          id: "ses_child",
          parentID: "ses_parent",
        },
      },
      type: "session.created",
    });

    expect(
      opencodeHookDecoder.decode(created, "session.created")
    ).toMatchObject({
      cwd: "/home/user/repo",
      parentSessionId: "ses_parent",
      sessionId: "ses_child",
      turnId: null,
    });

    const prompt = JSON.stringify({
      properties: {
        info: {
          id: "msg_u",
          modelID: "claude-sonnet-5",
          providerID: "anthropic",
          role: "user",
          sessionID: "ses_x",
        },
      },
      type: "message.updated",
    });

    expect(opencodeHookDecoder.decode(prompt, "message.updated")).toMatchObject(
      {
        model: "anthropic/claude-sonnet-5",
        sessionId: "ses_x",
        turnId: "msg_u",
      }
    );

    expect(opencodeHookDecoder.decode("not json", "session.idle")).toBeNull();
  });

  it("maps every forwarded event to an event kind", () => {
    for (const event of OPENCODE_PLUGIN_EVENTS) {
      expect(opencodeHookDecoder.kind(event), event).not.toBe("other");
    }

    expect(opencodeHookDecoder.kind("session.created")).toBe("ai.session");
    expect(opencodeHookDecoder.kind("session.idle")).toBe("ai.turn");
    expect(opencodeHookDecoder.kind("session.step.ended")).toBe("ai.request");
    expect(opencodeHookDecoder.kind("tui.toast.show")).toBe("other");
    expect(opencodeHookDecoder.respond("session.idle")).toBe("");
  });

  it("writes a plugin that calls dft hook opencode", () => {
    const source = opencodePluginSource("/usr/local/bin/dft");

    expect(source).toContain('const DFT = "/usr/local/bin/dft";');
    expect(source).toContain('["hook", "opencode", event.type]');
    expect(source).toContain("export default DftUsage;");
  });
});
