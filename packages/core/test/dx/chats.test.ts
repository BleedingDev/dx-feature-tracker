import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  makeDxChatsCapability,
  resolveSince,
} from "../../src/dx/chats/capability.js";
import { ChatsReportSchema } from "../../src/dx/chats/contract.js";
import { parseModelEffort } from "../../src/dx/chats/effort.js";
import { buildChatTree } from "../../src/dx/chats/tree.js";
import { mapStateDb } from "../../src/dx/collectors/cursor-local-db/map-state.js";
import { EventStore } from "../../src/dx/contracts/event-store.js";
import { makeFakeEventStore } from "../../src/dx/contracts/fakes.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";

const BRANCH = "feature/chats-fixture";

const CHAT = "fixture-composer-1";

const CHILD = "fixture-composer-1-sub-a";

interface EventSeed {
  readonly adapterId: string;
  readonly at: string | null;
  readonly generationId?: string;
  readonly kind: DxEventEnvelope["kind"];
  readonly payload: DxEventEnvelope["payload"];
  readonly requestId?: string;
  readonly sessionId: string | null;
  readonly branch?: string;
  readonly key: string;
}

const eventOf = (seed: EventSeed): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: seed.adapterId,
  adapterVersion: "fixture",
  ai: null,
  context: {
    branch: seed.branch ?? BRANCH,
    flightId: null,
    headSha: null,
    repoCommonDir: "/fixture/.git",
    worktreePath: "/fixture",
  },
  eventId: EventIdSchema.make(`fixture-${seed.key}`),
  evidence: { bounded: true, hash: null, ref: `fixture:${seed.key}` },
  fieldSemantics: [],
  identity: {
    commitSha: null,
    generationId: seed.generationId ?? null,
    githubAttempt: null,
    githubRunId: null,
    prNumber: null,
    requestId: seed.requestId ?? null,
    sessionId: seed.sessionId,
    turnId:
      seed.sessionId !== null && seed.generationId !== undefined
        ? `${seed.sessionId}:${seed.generationId}`
        : null,
  },
  kind: seed.kind,
  observedAt: "2026-09-30T12:00:00.000Z",
  occurredAt: seed.at,
  occurredAtPrecision: seed.at === null ? "unknown" : "exact",
  origin: "fixture",
  payload: seed.payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: seed.key,
  usage: null,
});

const HOOKS = "collector.cursor-hooks";

const CLI = "collector.cursor-cli";

const LOCAL_DB = "collector.cursor-local-db";

const TRANSCRIPTS = "collector.cursor-transcripts";

const fixtureEvents: readonly DxEventEnvelope[] = [
  eventOf({
    adapterId: LOCAL_DB,
    at: "2026-09-30T10:00:00.000Z",
    key: "session",
    kind: "ai.session",
    payload: {
      isSubagent: false,
      maxMode: false,
      model: "gpt-5-high",
      sourceKind: "local-db",
      title: "Fixture chat title",
      titleExportable: false,
    },
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: HOOKS,
    at: "2026-09-30T10:01:00.000Z",
    generationId: "g1",
    key: "submit-1",
    kind: "ai.request",
    payload: {
      hookEvent: "beforeSubmitPrompt",
      model: "gpt-5-high",
      prompt: "CHATS_PROMPT_CANARY",
    },
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: HOOKS,
    at: "2026-09-30T10:02:00.000Z",
    generationId: "g1",
    key: "tool-1",
    kind: "other",
    payload: { hookEvent: "postToolUse", model: "gpt-5-high", toolCall: true },
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: HOOKS,
    at: "2026-09-30T10:03:00.000Z",
    generationId: "g1",
    key: "stop-1",
    kind: "ai.turn",
    payload: { durationMs: 90_000, hookEvent: "stop", model: "gpt-5-high" },
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: HOOKS,
    at: "2026-09-30T10:10:00.000Z",
    generationId: "g2",
    key: "submit-2",
    kind: "ai.request",
    payload: {
      hookEvent: "beforeSubmitPrompt",
      model: "claude-4.5-sonnet-thinking",
    },
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: HOOKS,
    at: "2026-09-30T10:11:00.000Z",
    generationId: "g2",
    key: "tool-2",
    kind: "other",
    payload: {
      hookEvent: "postToolUse",
      model: "claude-4.5-sonnet-thinking",
      toolCall: true,
    },
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: HOOKS,
    at: "2026-09-30T10:12:00.000Z",
    generationId: "g2",
    key: "stop-2",
    kind: "ai.turn",
    payload: {
      durationMs: 30_000,
      hookEvent: "stop",
      model: "claude-4.5-sonnet-thinking",
    },
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: CLI,
    at: "2026-09-30T10:12:30.000Z",
    key: "cli-usage",
    kind: "ai.usage",
    payload: {
      model: "claude-4.5-sonnet-thinking",
      reasoningEffort: "medium",
      sourceKind: "cursor-cli",
      tokens: {
        "cache-write": 0,
        "cached-input": 500,
        input: 1200,
        output: 300,
        reasoning: null,
        total: null,
      },
    },
    requestId: "req-2",
    sessionId: CHAT,
  }),
  eventOf({
    adapterId: TRANSCRIPTS,
    at: "2026-09-30T10:05:00.000Z",
    key: "child-turn",
    kind: "ai.usage",
    payload: {
      model: "composer-1",
      parentSessionId: CHAT,
      sourceKind: "transcript-estimate",
      toolCalls: 4,
    },
    sessionId: CHILD,
  }),
  eventOf({
    adapterId: HOOKS,
    at: "2026-09-30T09:00:00.000Z",
    branch: "feature/other",
    generationId: "other-g",
    key: "other-branch",
    kind: "ai.request",
    payload: { hookEvent: "beforeSubmitPrompt", model: "gpt-5" },
    sessionId: "other-branch-chat",
  }),
  eventOf({
    adapterId: "collector.cursor-usage-export",
    at: "2026-09-30T10:30:00.000Z",
    key: "csv-row",
    kind: "ai.usage",
    payload: { maxMode: "Yes", model: "gpt-5-high", sourceKind: "usage-csv" },
    sessionId: null,
  }),
];

const scope = { branch: BRANCH, repoCommonDir: "/fixture/.git", since: null };

describe("dx_chats", () => {
  it("parses reasoning level from model names and source fields", () => {
    expect(parseModelEffort("gpt-5-high")).toMatchObject({
      effort: "high",
      effortSource: "model-name-suffix",
      model: "gpt-5",
    });
    expect(parseModelEffort("claude-4.5-opus-high-thinking")).toMatchObject({
      effort: "high+thinking",
      model: "claude-4.5-opus",
    });
    expect(parseModelEffort("grok-4.7-high-fast")).toMatchObject({
      effort: "high+fast",
      model: "grok-4.7",
    });
    expect(parseModelEffort("gpt-5.1-codex-max")).toMatchObject({
      effort: null,
      effortSource: "unavailable",
      model: "gpt-5.1-codex-max",
    });
    expect(parseModelEffort("auto").effortReason).toContain("auto");
    expect(parseModelEffort("o3-high", "low")).toMatchObject({
      effort: "low",
      effortSource: "source-field",
      model: "o3",
    });
  });

  it("builds the chat tree with a per-turn model timeline", () => {
    const report = buildChatTree(fixtureEvents, scope);
    expect(Schema.is(ChatsReportSchema)(report)).toBe(true);
    expect(report.rootSessionIds).toEqual([CHAT]);

    const chat = report.chats.find((c) => c.sessionId === CHAT);
    const child = report.chats.find((c) => c.sessionId === CHILD);

    expect(report.chats.map((c) => c.sessionId).toSorted()).toEqual(
      [CHAT, CHILD].toSorted()
    );
    expect(chat?.childSessionIds).toEqual([CHILD]);
    expect(chat?.title).toEqual({
      exportable: false,
      source: LOCAL_DB,
      value: "Fixture chat title",
    });
    expect(chat?.sourceIds.map((s) => s.kind).toSorted()).toEqual([
      "composerId",
      "conversationId",
      "sessionId",
    ]);
    expect(chat?.span).toEqual({
      end: "2026-09-30T10:12:30.000Z",
      reason: null,
      start: "2026-09-30T10:00:00.000Z",
    });
    expect(chat?.requests).toMatchObject({ method: "observed", value: 2 });
    expect(chat?.toolCalls).toMatchObject({ value: 2 });
    expect(chat?.agentTimeMs).toMatchObject({ reason: null, value: 120_000 });
    expect(chat?.models).toEqual(["gpt-5-high", "claude-4.5-sonnet-thinking"]);

    const efforts = chat?.modelTimeline.map((t) => [
      t.scope,
      t.model,
      t.effort,
      t.effortSource,
    ]);

    expect(efforts).toEqual([
      ["session-setting", "gpt-5", "high", "model-name-suffix"],
      ["request", "gpt-5", "high", "model-name-suffix"],
      ["request", "claude-4.5-sonnet", "thinking", "model-name-suffix"],
      ["turn", "claude-4.5-sonnet", "medium", "source-field"],
    ]);

    expect(
      Object.fromEntries(chat?.tokens.map((t) => [t.category, t.value]) ?? [])
    ).toMatchObject({ "cached-input": 500, input: 1200, output: 300 });
    expect(chat?.tokens.some((t) => t.category === "reasoning")).toBe(false);
    expect(chat?.money).toEqual([]);
    expect(chat?.moneyUnavailableReason).not.toBeNull();

    expect(child).toMatchObject({
      isSubagent: true,
      parentSessionId: CHAT,
      title: null,
      toolCalls: { source: "cursor-transcripts tool calls", value: 4 },
    });
    expect(child?.agentTimeMs.value).toBeNull();
    expect(child?.agentTimeMs.reason).not.toBeNull();
    expect(child?.modelTimeline[0]).toMatchObject({
      effort: null,
      effortSource: "unavailable",
      model: "composer-1",
    });

    expect(report.unattributed).toMatchObject({
      adapters: ["collector.cursor-usage-export"],
      events: 1,
    });
  });

  it("honours the since bound and never leaks prompt text", () => {
    const report = buildChatTree(fixtureEvents, {
      ...scope,
      since: "2026-09-30T10:04:00.000Z",
    });

    const chat = report.chats.find((c) => c.sessionId === CHAT);

    expect(chat?.requests.value).toBe(1);
    expect(chat?.title).toBeNull();
    expect(JSON.stringify(report)).not.toContain("CHATS_PROMPT_CANARY");
  });

  it("marks orphan subagents from local-db flags", () => {
    const report = buildChatTree(
      [
        eventOf({
          adapterId: LOCAL_DB,
          at: null,
          key: "orphan",
          kind: "ai.session",
          payload: { isSubagent: true, sourceKind: "local-db" },
          sessionId: "orphan-sub",
        }),
      ],
      scope
    );

    expect(report.chats[0]).toMatchObject({
      isSubagent: true,
      modelTimeline: [],
      parentSessionId: null,
      span: { end: null, start: null },
    });
    expect(report.chats[0]?.parentUnavailableReason).not.toBeNull();
    expect(report.chats[0]?.span.reason).not.toBeNull();
  });

  it("extracts max mode and per-bubble model but never the composer name", () => {
    const result = mapStateDb(
      {
        headers: [],
        items: [],
        kv: [
          {
            key: "composerData:fx-chat",
            value: JSON.stringify({
              composerId: "fx-chat",
              createdAt: 1_790_000_000_000,
              modelConfig: { maxMode: true, modelName: "gpt-5-high" },
              name: "Fixture local title",
              trackedGitRepos: [{ path: "/fixture" }],
            }),
          },
          {
            key: "bubbleId:fx-chat:b1",
            value: JSON.stringify({
              modelInfo: { modelName: "claude-4.5-sonnet-thinking" },
              type: 2,
            }),
          },
        ],
        layout: "state-vscdb/composer-headers",
      },
      {
        context: {
          branch: BRANCH,
          flightId: null,
          headSha: null,
          repoCommonDir: "/fixture/.git",
          worktreePath: "/fixture",
        },
        observedAt: "2026-09-30T12:00:00.000Z",
        origin: "fixture",
        sourceHash: "fixture",
      }
    );

    const session = result.events.find((e) => e.kind === "ai.session");
    const turn = result.events.find((e) => e.kind === "ai.turn");

    expect(session?.payload).toMatchObject({ maxMode: true });
    expect(JSON.stringify(result.events)).not.toContain("Fixture local title");
    expect(turn?.payload.model).toBe("claude-4.5-sonnet-thinking");
  });

  it.effect("serves the capability over the event store", () =>
    Effect.gen(function* chatsCapability() {
      const store = makeFakeEventStore();
      yield* store.append({
        coverage: {
          adapterId: "fixture",
          expectedItems: null,
          gaps: [],
          observedItems: fixtureEvents.length,
          state: "complete",
          watermark: null,
          windowFrom: null,
          windowTo: null,
        },
        cursor: null,
        events: fixtureEvents,
      });

      const capability = makeDxChatsCapability();

      const report = yield* Effect.provideService(
        capability.handler({ branch: BRANCH, repo: "/fixture/.git" }),
        EventStore,
        store
      );

      expect(report.branch).toBe(BRANCH);
      expect(report.rootSessionIds).toEqual([CHAT]);

      const invalid = yield* Effect.flip(resolveSince("yesterday", 0));
      expect(invalid._tag).toBe("InvalidInput");
      expect(yield* resolveSince("2d", Date.UTC(2026, 8, 30))).toBe(
        "2026-09-28T00:00:00.000Z"
      );
    })
  );
});
