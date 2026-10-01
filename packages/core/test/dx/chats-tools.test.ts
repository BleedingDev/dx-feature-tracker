// @effect-diagnostics nodeBuiltinImport:off -- Committed harness fixtures are read from disk into each tool's in-memory store.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { ChatsReportSchema } from "../../src/dx/chats/contract.js";
import type { ChatNode, ChatsReport } from "../../src/dx/chats/contract.js";
import { buildChatTree } from "../../src/dx/chats/tree.js";
import type { ChatTreeOptions } from "../../src/dx/chats/tree.js";
import {
  ClaudeCodeHarness,
  ClaudeCodeStore,
} from "../../src/dx/harness/claude-code/index.js";
import { CodexHarness, CodexStore } from "../../src/dx/harness/codex/index.js";
import { everywhere } from "../../src/dx/harness/contract.js";
import type { Harness } from "../../src/dx/harness/contract.js";
import { DeepseekHarness } from "../../src/dx/harness/deepseek/harness.js";
import { GitRunner } from "../../src/dx/harness/git.js";
import type { HarnessId } from "../../src/dx/harness/ids.js";
import { OmpHarness, OmpStore } from "../../src/dx/harness/omp/index.js";
import {
  OpencodeHarness,
  OpencodeStore,
} from "../../src/dx/harness/opencode/index.js";
import { PiHarness, PiStore } from "../../src/dx/harness/pi/index.js";
import { knownTokenTotal } from "../../src/dx/metrics/ai-usage/typed.js";
import { emptyFlightContext } from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { deriveUsageFacts } from "../../src/dx/usage/derive.js";
import {
  FIXTURES as DEEPSEEK_FIXTURES,
  batchesOf,
  fixtureSession,
  memoryFile,
  memoryHarness as deepseekHarness,
  zstdLog,
} from "./harness/deepseek-fixtures.js";
import {
  FIXTURE_REPOS,
  loadFixtureTables,
} from "./harness/opencode-support.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "harness");

const CLAUDE_TITLED = "649817f1-146b-4bab-a7c9-a05757db4f34";

interface TextFile {
  readonly mtimeMs: number;
  readonly path: string;
  readonly text: string;
}

const filesUnder = (dir: string, mount: string): TextFile[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap(
    (entry) => {
      const file = path.join(entry.parentPath, entry.name);

      return entry.isFile()
        ? [
            {
              mtimeMs: 1,
              path: path.join(mount, path.relative(dir, file)),
              text: readFileSync(file, "utf-8"),
            },
          ]
        : [];
    }
  );

const withTitleRow = (file: TextFile): TextFile =>
  file.path.endsWith(`/${CLAUDE_TITLED}.jsonl`)
    ? {
        ...file,
        text: `${file.text}${JSON.stringify({
          aiTitle: "Fixture claude title",
          sessionId: CLAUDE_TITLED,
          type: "ai-title",
        })}\n`,
      }
    : file;

const claudeLayer = Layer.fresh(ClaudeCodeHarness.layer).pipe(
  Layer.provide(
    ClaudeCodeStore.memory({
      files: filesUnder(
        path.join(FIXTURES, "claude-code", "claude-home"),
        "/home/user/.claude"
      ).map(withTitleRow),
      home: "/home/user",
      roots: ["/home/user/.claude/projects"],
    })
  )
);

const codexHome = path.join(FIXTURES, "codex", "home", ".codex");

const codexLayer = CodexHarness.layer.pipe(
  Layer.provide(
    CodexStore.memory({
      files: filesUnder(codexHome, "/home/user/.codex").filter(
        (file) => !file.path.endsWith("session_index.jsonl")
      ),
      home: "/home/user",
      roots: [
        "/home/user/.codex/sessions",
        "/home/user/.codex/archived_sessions",
      ],
      sessionIndex: readFileSync(
        path.join(codexHome, "session_index.jsonl"),
        "utf-8"
      ),
    })
  )
);

const ompLayer = Layer.effect(OmpHarness, OmpHarness.make).pipe(
  Layer.provide(
    OmpStore.memory({
      files: filesUnder(
        path.join(FIXTURES, "omp", "sessions"),
        "/home/user/.omp/agent/sessions"
      ),
      roots: ["/home/user/.omp/agent/sessions"],
    })
  )
);

const piHome = path.join(FIXTURES, "pi", "home");

const piLayer = PiHarness.layer.pipe(
  Layer.provide(
    PiStore.memory({
      agentDir: "/home/user/.pi/agent",
      files: [
        ...filesUnder(path.join(piHome, ".pi"), "/home/user/.pi"),
        ...filesUnder(
          path.join(piHome, "pi-sessions"),
          "/home/user/pi-sessions"
        ),
      ],
      roots: ["/home/user/.pi/agent/sessions", "/home/user/pi-sessions"],
    })
  ),
  Layer.provide(GitRunner.memory([])),
  Layer.provide(NodeServices.layer)
);

const deepseekLayer = deepseekHarness(
  DEEPSEEK_FIXTURES.map((name) => {
    const session = fixtureSession(name);

    return memoryFile(session, zstdLog(batchesOf(session.lines)));
  })
);

const opencodeLayer = Layer.fresh(OpencodeHarness.layer).pipe(
  Layer.provide(
    OpencodeStore.memory({
      databases: {
        "/home/user/.local/share/opencode/opencode.db": {
          mtimeMs: 1,
          tables: loadFixtureTables(),
        },
      },
      files: [],
      roots: ["/home/user/.local/share/opencode"],
    })
  ),
  Layer.provide(GitRunner.memory(FIXTURE_REPOS))
);

const readHarness = (harness: Harness) =>
  Effect.gen(function* readAll() {
    const refs = yield* harness.locate(everywhere);
    const events: DxEventEnvelope[] = [];

    for (const ref of refs) {
      const batch = yield* harness.read(ref, {
        context: emptyFlightContext,
        cursor: null,
        origin: "fixture",
      });

      events.push(...batch.events);
    }

    return events;
  });

type Tool = Exclude<HarnessId, "cursor">;

const TOOLS: readonly Tool[] = [
  "claude-code",
  "codex",
  "deepseek",
  "omp",
  "opencode",
  "pi",
];

const TOOL_EVENTS = {
  "claude-code": () =>
    Effect.gen(function* claudeCodeHarnessEvents() {
      return yield* readHarness(yield* ClaudeCodeHarness);
    }).pipe(Effect.provide(claudeLayer)),
  codex: () =>
    Effect.gen(function* codexHarnessEvents() {
      return yield* readHarness(yield* CodexHarness);
    }).pipe(Effect.provide(codexLayer)),
  deepseek: () =>
    Effect.gen(function* deepseekHarnessEvents() {
      return yield* readHarness(yield* DeepseekHarness);
    }).pipe(Effect.provide(deepseekLayer)),
  omp: () =>
    Effect.gen(function* ompHarnessEvents() {
      return yield* readHarness(yield* OmpHarness);
    }).pipe(Effect.provide(ompLayer)),
  opencode: () =>
    Effect.gen(function* opencodeHarnessEvents() {
      return yield* readHarness(yield* OpencodeHarness);
    }).pipe(Effect.provide(opencodeLayer)),
  pi: () =>
    Effect.gen(function* piHarnessEvents() {
      return yield* readHarness(yield* PiHarness);
    }).pipe(Effect.provide(piLayer)),
};

const toolEvents = (tool: Tool) => TOOL_EVENTS[tool]();

const allTools = Effect.gen(function* allTools() {
  const events: DxEventEnvelope[] = [];

  for (const tool of TOOLS) {
    events.push(...(yield* toolEvents(tool)));
  }

  return events;
});

const everyChat = (
  events: readonly DxEventEnvelope[],
  options: ChatTreeOptions = {}
): ChatsReport =>
  buildChatTree(
    events,
    { branch: null, repoCommonDir: null, since: null },
    events,
    options
  );

const chatOf = (report: ChatsReport, sessionId: string): ChatNode => {
  const chat = report.chats.find((c) => c.sessionId === sessionId);

  if (chat === undefined) {
    throw new Error(`no chat ${sessionId}`);
  }

  return chat;
};

const turnsOf = (chat: ChatNode) =>
  [
    ...new Set(chat.modelTimeline.map((t) => `${t.model} ${t.effort ?? "-"}`)),
  ].toSorted();

interface Expected {
  readonly child: string;
  readonly childAgent: string;
  readonly modelChange: string;
  readonly models: readonly string[];
  readonly parent: string;
  readonly title: string;
  readonly titled: string;
}

const EXPECTED: Readonly<Record<Tool, Expected>> = {
  "claude-code": {
    child: `${CLAUDE_TITLED}:agent-a468bc16361b4ba95`,
    childAgent: "general-purpose",
    modelChange: "eb8c4f30-f77f-4a64-b631-eabf0af2359e",
    models: ["claude-haiku-4-5 -", "claude-sonnet-5 medium"],
    parent: CLAUDE_TITLED,
    title: "Fixture claude title",
    titled: CLAUDE_TITLED,
  },
  codex: {
    child: "01a0f71d-900e-7100-8988-195a203ff357",
    childAgent: "worker",
    modelChange: "01a0f798-461b-7401-af5c-67f1a919955a",
    models: ["gpt-5.6-luna high", "gpt-6.1-sol low"],
    parent: "01a0f71d-2ce1-7010-8395-f432e17bdb4e",
    title: "Fixture title one",
    titled: "01a0f719-884c-7ba1-b80a-4ffb1432cfad",
  },
  deepseek: {
    child: "45407152-a4c2-4e8b-a200-343fdcebcd34",
    childAgent: "spawn",
    modelChange: "session-a379e7bf-aca1-43ae-a96c-e5b5af909af8",
    models: [
      "claude-deepseek-factory -",
      "claude-deepseek-flash -",
      "claude-luna -",
      "gpt-5.6-luna -",
      "gpt-5.6-terra -",
    ],
    parent: "session-11a14875-8a9b-4376-ae3d-b0aa029e2331",
    title: "Fixture title 2",
    titled: "session-c4146155-f82b-4362-833d-d2f41b8fc90d",
  },
  omp: {
    child: "01a0f77f-dd48-77f6-9f6e-286c5415486f",
    childAgent: "scout",
    modelChange: "01a0f780-692d-73cc-b01f-1f3ab464e3cd",
    models: ["glm-5.3-flash medium", "gpt-5.6-luna low"],
    parent: "01a0f77f-cc09-73bb-b346-9376f668018b",
    title: "Fixture session",
    titled: "01a0f780-692d-73cc-b01f-1f3ab464e3cd",
  },
  opencode: {
    child: "ses_f08e51e3dffeHNPcOJtvHpq4yG",
    childAgent: "explore",
    modelChange: "ses_fb371ac7dffe0uMzq1nvNPymd5",
    models: ["hy4-preview -", "nemotron-3-ultra-free -"],
    parent: "ses_f08e529bdffeoPol7ZgPl8JcZK",
    title: "Fixture session 4: orchestrator with a subagent",
    titled: "ses_f08e529bdffeoPol7ZgPl8JcZK",
  },
  pi: {
    child: "01a0f771-edc0-738d-b214-0210226da223/call_fixture_012#0",
    childAgent: "scout",
    modelChange: "01a0f770-e20d-720d-aac8-adce5c737183",
    models: ["claude-sonnet-4-6 medium", "gpt-5.6-luna low"],
    parent: "01a0f771-edc0-738d-b214-0210226da223",
    title: "Fixture session 1",
    titled: "01a0f718-e330-7250-b94b-fc0576b8089d",
  },
};

const requestFacts = (events: readonly DxEventEnvelope[], session: string) =>
  deriveUsageFacts(events).facts.filter(
    (fact) => fact.session === session && fact.scope === "request"
  );

describe("dx_chats across tools", () => {
  for (const tool of TOOLS) {
    const expected = EXPECTED[tool];

    it.effect(`${tool}: title, per-turn model and effort, subagent tree`, () =>
      Effect.gen(function* chatsOfTool() {
        const events = yield* toolEvents(tool);
        const report = everyChat(events);

        expect(Schema.is(ChatsReportSchema)(report)).toBe(true);
        expect(report.tools).toEqual([tool]);
        expect(report.chats.every((chat) => chat.tool === tool)).toBe(true);
        expect(chatOf(report, expected.titled).title?.value).toBe(
          expected.title
        );

        const child = chatOf(report, expected.child);
        const parent = chatOf(report, expected.parent);

        expect(child).toMatchObject({
          agentType: expected.childAgent,
          isSubagent: true,
          parentSessionId: expected.parent,
        });
        expect(parent.childSessionIds).toContain(expected.child);
        expect(report.rootSessionIds).toContain(expected.parent);
        expect(report.rootSessionIds).not.toContain(expected.child);
        expect(turnsOf(chatOf(report, expected.modelChange))).toEqual(
          expected.models
        );

        const facts = requestFacts(events, expected.parent);

        expect(parent.usage.requests).toBe(
          facts.reduce((sum, fact) => sum + fact.requests, 0)
        );
        expect(parent.usage.tokens.total).toBe(
          facts.reduce(
            (sum, fact) => sum + (knownTokenTotal(fact.tokens) ?? 0),
            0
          )
        );
      })
    );
  }

  it.effect("lists every tool in one tree and filters like dft usage", () =>
    Effect.gen(function* oneList() {
      const events = yield* allTools;
      const everything = everyChat(events);

      expect(everything.tools).toEqual([...TOOLS]);

      const codexOnly = everyChat(events, { filters: { tool: ["codex"] } });

      expect(codexOnly.tools).toEqual(["codex"]);
      expect(codexOnly.chats.length).toBe(
        everything.chats.filter((chat) => chat.tool === "codex").length
      );

      const luna = everyChat(events, { filters: { model: ["gpt-5.6-luna"] } });

      const lunaFacts = deriveUsageFacts(events).facts.filter(
        (fact) =>
          fact.scope === "request" &&
          fact.session !== null &&
          fact.model === "gpt-5.6-luna"
      );

      expect(new Set(luna.chats.map((chat) => chat.sessionId))).toEqual(
        new Set(lunaFacts.map((fact) => fact.session))
      );
      expect(luna.totals.requests).toBe(
        lunaFacts.reduce((sum, fact) => sum + fact.requests, 0)
      );
      expect(
        luna.chats.every((chat) =>
          chat.modelTimeline.some((turn) => turn.model === "gpt-5.6-luna")
        )
      ).toBe(true);

      const anthropic = everyChat(events, {
        filters: { provider: ["anthropic"], tool: ["claude-code", "pi"] },
      });

      expect(anthropic.tools).toEqual(["claude-code", "pi"]);
      expect(
        anthropic.chats.every((chat) => chat.providers.includes("anthropic"))
      ).toBe(true);
    })
  );

  it.effect("adds each chat's estimate and counts unpriced requests", () =>
    Effect.gen(function* estimates() {
      const events = yield* toolEvents("codex");

      const report = everyChat(events, {
        estimate: (fact) => (fact.model === "gpt-6.1-sol" ? null : 0.5),
        estimateLabel: "fixture prices",
      });

      const mixed = chatOf(report, "01a0f798-461b-7401-af5c-67f1a919955a");

      const sol = requestFacts(events, mixed.sessionId).filter(
        (fact) => fact.model === "gpt-6.1-sol"
      ).length;

      expect(report.estimateLabel).toBe("fixture prices");
      expect(sol).toBeGreaterThan(0);
      expect(mixed.usage.unpriced).toBe(sol);
      expect(mixed.usage.estimate).toBe(
        (mixed.usage.requests - mixed.usage.unpriced) * 0.5
      );
      expect(mixed.usage.toolFigure).toBeNull();
    })
  );
});
