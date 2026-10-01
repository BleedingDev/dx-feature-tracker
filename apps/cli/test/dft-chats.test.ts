import { describe, expect, it } from "@effect/vitest";

import { chatsInputOf, chatsText, withoutTitles } from "../src/dft-chats.js";
import type { ChatLike, ChatUsageLike } from "../src/dft-chats.js";

const usage = (overrides: Partial<ChatUsageLike> = {}): ChatUsageLike => ({
  billed: null,
  estimate: null,
  requests: 0,
  tokens: { total: null },
  toolFigure: null,
  unpriced: 0,
  ...overrides,
});

const node = (
  sessionId: string,
  overrides: Partial<ChatLike> = {}
): ChatLike & { readonly titleUnavailableReason: string | null } => ({
  agentTimeMs: { value: null },
  branches: ["main"],
  childSessionIds: [],
  modelTimeline: [],
  modelTimelineReason: null,
  money: [],
  sessionId,
  title: null,
  titleUnavailableReason: "no title",
  tokens: [],
  toolCalls: { value: null },
  ...overrides,
});

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

describe("dft chats", () => {
  it("counts subagents apart from chats and names the other branches of a chat", () => {
    const text = chatsText(
      {
        branch: "main",
        chats: [
          node("parent00-1", {
            branches: ["main", "feature/sub-b"],
            childSessionIds: ["child000-1", "child000-2"],
          }),
          node("child000-1"),
          node("child000-2"),
        ],
        rootSessionIds: ["parent00-1"],
        unattributed: { events: 0 },
      },
      { now: NOW, verbose: false }
    ).split("\n");

    expect(text[0]).toBe("1 chat on main, with 2 subagents");
    expect(text).toContain("  Also on feature/sub-b");
    expect(text.filter((line) => line.includes("Also on"))).toHaveLength(1);
  });

  it("names untitled chats apart when their UUIDv7 ids start in the same minute", () => {
    const text = chatsText(
      {
        branch: "main",
        chats: [
          node("01a0f79d-11aa-7c3a-9f10-5b2d8e4a6c01"),
          node("01a0f79d-22bb-7a41-8b22-1c3d5e7f9a02"),
        ],
        rootSessionIds: [
          "01a0f79d-11aa-7c3a-9f10-5b2d8e4a6c01",
          "01a0f79d-22bb-7a41-8b22-1c3d5e7f9a02",
        ],
        unattributed: { events: 0 },
      },
      { now: NOW, verbose: false }
    ).split("\n");

    expect(text).toContain("chat 01a0f79d-11aa");
    expect(text).toContain("chat 01a0f79d-22bb");
  });

  it("lists every tool's chats with tool, title, models, money and the subagent under its parent", () => {
    const text = chatsText(
      {
        branch: null,
        chats: [
          node("claude-1", {
            childSessionIds: ["claude-1:agent-a468bc16"],
            modelTimeline: [
              { effort: "medium", maxMode: null, model: "claude-sonnet-5" },
              { effort: null, maxMode: null, model: "claude-haiku-4-5" },
            ],
            span: {
              end: "2026-10-01T10:05:00.000Z",
              start: "2026-10-01T10:00:00.000Z",
            },
            title: { value: "Fixture claude title" },
            tool: "claude-code",
            usage: usage({
              estimate: 0.42,
              requests: 6,
              tokens: { total: 334_256 },
              toolFigure: 0.19,
            }),
          }),
          node("claude-1:agent-a468bc16", {
            agentType: "general-purpose",
            modelTimeline: [
              { effort: "medium", maxMode: null, model: "claude-sonnet-5" },
            ],
            tool: "claude-code",
            usage: usage({ requests: 2, tokens: { total: 36_300 } }),
          }),
          node("codex-1", {
            modelTimeline: [
              { effort: "high", maxMode: null, model: "gpt-5.6-luna" },
            ],
            title: { value: "Fixture codex title" },
            tool: "codex",
            usage: usage({ estimate: 0.1, requests: 3, unpriced: 1 }),
          }),
        ],
        estimateLabel: "fixture prices",
        filters: { tool: ["claude-code", "codex"] },
        repoCommonDir: "/home/user/work/repo/.git",
        rootSessionIds: ["claude-1", "codex-1"],
        totals: usage({
          estimate: 0.52,
          requests: 11,
          tokens: { total: 400_000 },
          toolFigure: 0.19,
        }),
        unattributed: { events: 0 },
      },
      { now: NOW, verbose: true }
    ).split("\n");

    expect(text[0]).toBe(
      "2 chats on every branch, with 1 subagent (claude-code 2, codex 1)"
    );
    expect(text[1]).toBe(
      "Total: $0.52 estimate · $0.19 tool's figure · 400k tokens · 11 requests"
    );
    expect(text).toContain("[claude-code] Fixture claude title");
    expect(text).toContain(
      "  $0.42 estimate · $0.19 tool's figure · 334k tokens · 6 requests · lasted 5m · started 2 hours ago"
    );
    expect(text).toContain("  claude-sonnet-5 medium ×1, claude-haiku-4-5 ×1");
    expect(text).toContain(
      "└─ [claude-code] subagent general-purpose (a468bc16)"
    );
    expect(text).toContain("[codex] Fixture codex title");
    expect(text).toContain(
      "  $0.10 estimate (1 request unpriced) · - tokens · 3 requests"
    );
    expect(text).toContain("Only tool claude-code, codex.");
    expect(text.some((line) => line.includes("fixture prices"))).toBe(true);
  });

  it("leaves titles out of exports unless asked", () => {
    const report = {
      chats: [node("a", { title: { value: "Local title" } }), node("b")],
    };

    const stripped = withoutTitles(report);

    expect(JSON.stringify(stripped)).not.toContain("Local title");
    expect(stripped.chats[0]?.titleUnavailableReason).toContain("--titles");
    expect(stripped.chats[1]?.titleUnavailableReason).toBe("no title");
  });

  it("turns flags into the dx_chats input like dft usage does", () => {
    expect(
      chatsInputOf(
        {
          allBranches: true,
          branch: "ignored",
          effort: [],
          model: ["gpt-5.6-luna"],
          provider: [],
          since: "7d",
          tool: ["claude-code,codex", " pi "],
          via: [],
        },
        "/home/user/work/repo"
      )
    ).toEqual({
      allBranches: true,
      model: ["gpt-5.6-luna"],
      repo: "/home/user/work/repo",
      since: "7d",
      tool: ["claude-code", "codex", "pi"],
    });
  });
});
