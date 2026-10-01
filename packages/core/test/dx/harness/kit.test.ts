// @effect-diagnostics nodeBuiltinImport:off -- The kit tests create an owned temp folder with a git repository and a SQLite file to exercise the live layers.
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

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema } from "effect";

import type { EventWithoutBlocks } from "../../../src/dx/harness/collector-blocks.js";
import { collectorBlocks } from "../../../src/dx/harness/collector-blocks.js";
import {
  liveFileStore,
  memoryFileStore,
} from "../../../src/dx/harness/file-store.js";
import { GitRunner } from "../../../src/dx/harness/git.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { LocalSqlite } from "../../../src/dx/harness/local-sqlite.js";
import {
  inferProvider,
  inferVia,
  normalizeModel,
  providerFor,
} from "../../../src/dx/harness/provider.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../../src/dx/model/event.js";
import { EventIdSchema } from "../../../src/dx/model/ids.js";

const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-kit-")));

afterAll(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

describe("model provider and gateway", () => {
  it("names the model maker, not the gateway", () => {
    expect(inferProvider("claude-sonnet-4-5-20250929")).toBe("anthropic");
    expect(inferProvider("gpt-5.1-codex")).toBe("openai");
    expect(inferProvider("o3-mini")).toBe("openai");
    expect(inferProvider("gemini-2.5-pro")).toBe("google");
    expect(inferProvider("deepseek-v3.2")).toBe("deepseek");
    expect(inferProvider("grok-4")).toBe("xai");
    expect(inferProvider("kimi-k2")).toBe("moonshot");
    expect(inferProvider("glm-4.6")).toBe("zhipu");
    expect(inferProvider("qwen3-coder")).toBe("qwen");
    expect(inferProvider("devstral-medium")).toBe("mistral");
    expect(inferProvider("openrouter/anthropic/claude-opus-4")).toBe(
      "anthropic"
    );
    expect(inferProvider("ollama/llama3.1:8b")).toBe("local");
    expect(inferProvider("composer-1")).toBe("cursor");
    expect(inferProvider("auto")).toBe("cursor");
    expect(inferProvider("mystery-model")).toBe("unknown");
    expect(inferProvider(null)).toBe("unknown");
  });

  it("reads the gateway from the model path", () => {
    expect(inferVia("openrouter/anthropic/claude-opus-4")).toBe("openrouter");
    expect(inferVia("github-copilot/gpt-5")).toBe("github-copilot");
    expect(inferVia("copilot/gpt-5")).toBe("github-copilot");
    expect(inferVia("anthropic/claude-opus-4")).toBeNull();
    expect(inferVia("claude-opus-4")).toBeNull();
  });

  it("prefers an explicit provider hint", () => {
    expect(providerFor("big-pickle", "zhipuai")).toBe("zhipu");
    expect(providerFor("llama3", "ollama")).toBe("local");
  });

  it("normalizes the model name without its gateway or date stamp", () => {
    expect(normalizeModel("openrouter/anthropic/Claude-Opus-4-20250514")).toBe(
      "claude-opus-4"
    );
    expect(normalizeModel("claude-sonnet-4-5[1m]")).toBe("claude-sonnet-4-5");
    expect(normalizeModel(null)).toBeNull();
  });
});

describe("HarnessHome", () => {
  it.effect("puts every tool under HOME by default", () =>
    Effect.gen(function* defaults() {
      const home = yield* HarnessHome;

      expect(home.dirs).toStrictEqual({
        claudeCode: "/h/.claude",
        codex: "/h/.codex",
        cursor: "/h/.cursor",
        deepseek: "/h/.dsh",
        omp: "/h/.omp/agent",
        ompConfig: "/h/.omp",
        ompXdgData: null,
        opencodeConfig: "/h/.config/opencode",
        opencodeData: "/h/.local/share/opencode",
        pi: "/h/.pi/agent",
      });
      expect(home.rootOf("codex")).toBe("/h/.codex");
    }).pipe(Effect.provide(HarnessHome.at("/h")))
  );

  it.effect("honours each tool's own folder variable", () =>
    Effect.gen(function* overrides() {
      const home = yield* HarnessHome;

      expect(home.dirs.claudeCode).toBe("/c");
      expect(home.dirs.codex).toBe("/x");
      expect(home.dirs.pi).toBe("/p");
      expect(home.dirs.omp).toBe("/p");
      expect(home.dirs.ompConfig).toBe("/h/.omp-work");
      expect(home.dirs.ompXdgData).toBeNull();
      expect(home.dirs.deepseek).toBe("/d");
      expect(home.dirs.opencodeData).toBe("/data/opencode");
      expect(home.dirs.opencodeConfig).toBe("/config/opencode");
    }).pipe(
      Effect.provide(
        HarnessHome.at("/h", {
          CLAUDE_CONFIG_DIR: "/c",
          CODEX_HOME: "/x",
          DSH_HOME: "/d",
          PI_CODING_AGENT_DIR: "/p",
          PI_CONFIG_DIR: ".omp-work",
          XDG_CONFIG_HOME: "/config",
          XDG_DATA_HOME: "/data",
        })
      )
    )
  );

  it.effect("resolves OMP profiles and XDG data the way oh-my-pi does", () =>
    Effect.gen(function* ompProfile() {
      const home = yield* HarnessHome;

      expect(home.dirs.ompConfig).toBe("/h/.omp/profiles/work");
      expect(home.dirs.omp).toBe("/h/.omp/profiles/work/agent");
      expect(home.dirs.ompXdgData).toBe("/data/omp/profiles/work");
      expect(home.dirs.pi).toBe("/p");
    }).pipe(
      Effect.provide(
        HarnessHome.at("/h", {
          PI_CODING_AGENT_DIR: "/p",
          PI_PROFILE: "work",
          XDG_DATA_HOME: "/data",
        })
      )
    )
  );

  it.effect("keeps a sandbox home free of the user's folder variables", () =>
    Effect.gen(function* sandbox() {
      const home = yield* HarnessHome;

      expect(home.home).toBe("/sandbox");
      expect(home.dirs.codex).toBe("/sandbox/.codex");
      expect(home.dirs.opencodeData).toBe("/sandbox/.local/share/opencode");
    }).pipe(
      Effect.provide(
        HarnessHome.forHome("/sandbox").pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                CODEX_HOME: "/real/codex",
                HOME: "/real",
                XDG_DATA_HOME: "/real/data",
              })
            )
          )
        )
      )
    )
  );

  it.effect("applies the user's folder variables to the user's own home", () =>
    Effect.gen(function* userHome() {
      const home = yield* HarnessHome;

      expect(home.dirs.codex).toBe("/real/codex");
      expect(home.dirs.claudeCode).toBe("/real/.claude");
    }).pipe(
      Effect.provide(
        HarnessHome.forHome("/real").pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                CODEX_HOME: "/real/codex",
                HOME: "/real",
              })
            )
          )
        )
      )
    )
  );
});

const RowSchema = Schema.Struct({ id: Schema.Int, model: Schema.String });

describe("LocalSqlite", () => {
  it.effect("runs real SQL over in-memory tables", () =>
    Effect.gen(function* memory() {
      const sqlite = yield* LocalSqlite;

      const rows = yield* sqlite.query(
        "/db/one.sqlite",
        "SELECT id, model FROM message WHERE id > ? ORDER BY id",
        RowSchema,
        [1]
      );

      expect(rows).toStrictEqual([{ id: 2, model: "glm-4.6" }]);
      expect(yield* sqlite.exists("/db/none.sqlite")).toBe(false);

      const missing = yield* Effect.flip(
        sqlite.query("/db/none.sqlite", "SELECT 1", RowSchema)
      );

      expect(missing._tag).toBe("SourceUnavailable");
    }).pipe(
      Effect.provide(
        LocalSqlite.memory({
          "/db/one.sqlite": {
            message: [
              { id: 1, model: "gpt-5" },
              { id: 2, model: "glm-4.6" },
            ],
          },
        })
      )
    )
  );

  it.effect("reads a copy of a live database and never writes the source", () =>
    Effect.gen(function* live() {
      const file = path.join(tempRoot, "tool.db");
      const db = new DatabaseSync(file);

      db.exec("CREATE TABLE message (id INTEGER, model TEXT)");
      db.exec("INSERT INTO message VALUES (1, 'claude-opus-4')");
      db.close();

      const before = readFileSync(file);
      const sqlite = yield* LocalSqlite;

      const rows = yield* sqlite.query(
        file,
        "SELECT id, model FROM message",
        RowSchema
      );

      expect(rows).toStrictEqual([{ id: 1, model: "claude-opus-4" }]);
      expect(readFileSync(file)).toStrictEqual(before);
    }).pipe(
      Effect.provide(LocalSqlite.layer.pipe(Layer.provide(NodeServices.layer)))
    )
  );
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

describe("GitRunner", () => {
  it.effect(
    "reports toplevel, common dir, branch and worktrees of a real repo",
    () =>
      Effect.gen(function* liveGit() {
        const repo = path.join(tempRoot, "repo");
        const linked = path.join(tempRoot, "linked");

        mkdirSync(path.join(repo, "src"), { recursive: true });
        git(repo, "init", "-q", "-b", "main");
        git(
          repo,
          "-c",
          "user.email=t@example.invalid",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init"
        );
        git(repo, "worktree", "add", "-q", "-b", "feature/x", linked);

        const runner = yield* GitRunner;
        const atMain = yield* runner.at(path.join(repo, "src"));
        const atLinked = yield* runner.at(linked);

        expect(atMain.worktreePath).toBe(repo);
        expect(atMain.branch).toBe("main");
        expect(atMain.repoCommonDir).toBe(path.join(repo, ".git"));
        expect(atMain.headSha).toMatch(/^[0-9a-f]{40}$/u);
        expect(atLinked.branch).toBe("feature/x");
        expect(atLinked.repoCommonDir).toBe(path.join(repo, ".git"));

        const worktrees = yield* runner.worktrees(repo);

        expect(worktrees.map((w) => [w.path, w.branch])).toStrictEqual([
          [repo, "main"],
          [linked, "feature/x"],
        ]);

        expect(yield* runner.at(os.tmpdir())).toStrictEqual({
          branch: null,
          headSha: null,
          repoCommonDir: null,
          worktreePath: null,
        });
      }).pipe(
        Effect.provide(GitRunner.layer.pipe(Layer.provide(NodeServices.layer)))
      )
  );

  it.effect("answers from a memory repo map", () =>
    Effect.gen(function* memoryGit() {
      const runner = yield* GitRunner;
      const at = yield* runner.at("/w/feature/src/deep");

      expect(at).toStrictEqual({
        branch: "feature",
        headSha: "b",
        repoCommonDir: "/w/main/.git",
        worktreePath: "/w/feature",
      });
      expect((yield* runner.worktrees("/w/main")).length).toBe(2);
    }).pipe(
      Effect.provide(
        GitRunner.memory([
          {
            repoCommonDir: "/w/main/.git",
            worktrees: [
              { branch: "main", headSha: "a", path: "/w/main" },
              { branch: "feature", headSha: "b", path: "/w/feature" },
            ],
          },
        ])
      )
    )
  );
});

describe("file stores", () => {
  it.effect("lists sessions with mtime and size, live and in memory", () =>
    Effect.gen(function* stores() {
      const root = path.join(tempRoot, "sessions");

      mkdirSync(path.join(root, "a"), { recursive: true });
      writeFileSync(path.join(root, "a", "one.jsonl"), "{}\n");
      writeFileSync(path.join(root, "a", "skip.txt"), "x");

      const live = yield* liveFileStore({
        harness: "pi",
        isSession: (relative) => relative.endsWith(".jsonl"),
        roots: Effect.succeed([root, path.join(tempRoot, "absent")]),
        version: Effect.succeed("1.0.0"),
      });

      const sessions = yield* live.listSessions;

      expect(sessions.map((s) => [s.path, s.size])).toStrictEqual([
        [path.join(root, "a", "one.jsonl"), 3],
      ]);
      expect(sessions[0]?.mtimeMs).toBeGreaterThan(0);
      expect(yield* live.readText(path.join(root, "a", "one.jsonl"))).toBe(
        "{}\n"
      );

      const memory = memoryFileStore("pi", {
        files: [{ mtimeMs: 5, path: "/m/x.jsonl", text: "ab" }],
        roots: ["/m"],
      });

      expect(yield* memory.listSessions).toStrictEqual([
        { mtimeMs: 5, path: "/m/x.jsonl", size: 2 },
      ]);
      expect((yield* Effect.flip(memory.readText("/m/none")))._tag).toBe(
        "SourceUnavailable"
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

const aiEvent = (
  adapterId: string,
  payload: EventWithoutBlocks["payload"]
): EventWithoutBlocks => ({
  acquisition: "file-import",
  adapterId,
  adapterVersion: "test",
  context: { ...emptyFlightContext, branch: "main" },
  eventId: EventIdSchema.make(`id-${adapterId}`),
  evidence: { bounded: true, hash: null, ref: "test" },
  fieldSemantics: [],
  identity: { ...emptyEventIdentity, sessionId: "s1" },
  kind: "ai.usage",
  observedAt: "2026-10-01T00:00:00Z",
  occurredAt: null,
  occurredAtPrecision: "unknown",
  origin: "fixture",
  payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: "2.1.0",
  upstreamKey: adapterId,
});

describe("collector blocks", () => {
  it("attributes Claude Code rows and keeps unknown tokens null", () => {
    const { ai, usage } = collectorBlocks(
      aiEvent("claude-jsonl", {
        branchSource: "claude-jsonl",
        model: "claude-opus-4-5-20251101",
        requestKey: "source:claude-jsonl:request:r1",
        tokens: {
          "cache-write": 10,
          "cached-input": 20,
          input: 5,
          output: 7,
        },
      })
    );

    expect(ai).toMatchObject({
      branchSource: "harness-recorded",
      channel: "session-file",
      harness: "claude-code",
      harnessVersion: "2.1.0",
      model: "claude-opus-4-5",
      provider: "anthropic",
      sessionId: "s1",
      via: null,
    });
    expect(usage?.tokens).toStrictEqual({
      cacheRead: 20,
      cacheWrite: 10,
      cacheWrite1h: null,
      cacheWrite5m: null,
      inputFresh: 5,
      output: 7,
      reasoning: null,
      total: null,
    });
    expect(usage?.toolFigure).toBeNull();
  });

  it("takes cached tokens out of Codex input", () => {
    const { usage } = collectorBlocks(
      aiEvent("codex-session", {
        effort: "high",
        model: "gpt-5.1-codex",
        tokens: {
          cachedInput: 300,
          input: 1000,
          output: 50,
          reasoning: 20,
          total: 1050,
        },
      })
    );

    expect(usage?.tokens.inputFresh).toBe(700);
    expect(usage?.tokens.cacheRead).toBe(300);
    expect(usage?.tokens.reasoning).toBe(20);
  });

  it("reads Cursor effort from the model suffix and keeps the charge", () => {
    const { ai, usage } = collectorBlocks(
      aiEvent("cursor-usage-export", {
        charge: 0.42,
        model: "gpt-5-high",
        tokens: { input: 1, output: 2 },
      })
    );

    expect(ai).toMatchObject({
      effort: "high",
      effortSource: "model-suffix",
      harness: "cursor",
      model: "gpt-5",
      modelRaw: "gpt-5-high",
      provider: "openai",
      via: "cursor",
    });
    expect(usage?.toolFigure).toStrictEqual({
      amount: 0.42,
      currency: "USD",
      kind: "charge",
    });
  });

  it("derives fresh input from an unverified stop hook", () => {
    const { usage } = collectorBlocks(
      aiEvent("cursor-hooks", {
        rawUsage: {
          cache_read_tokens: 30,
          cache_write_tokens: 10,
          input_tokens: 100,
          output_tokens: 5,
        },
        sourceKind: "hooks-stop",
      })
    );

    expect(usage?.tokens).toMatchObject({
      cacheRead: 30,
      cacheWrite: 10,
      inputFresh: 60,
      output: 5,
    });
  });

  it("leaves non-AI events without blocks", () => {
    expect(
      collectorBlocks({ ...aiEvent("git-history", {}), kind: "git.commit" })
    ).toStrictEqual({ ai: null, usage: null });
  });
});
