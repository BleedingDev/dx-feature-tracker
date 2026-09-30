import { describe, expect, it } from "@effect/vitest";

import {
  chatsText,
  collapseTurns,
  formatAge,
  formatCount,
  formatDuration,
  formatUsd,
  syncText,
} from "../src/dft-render.js";

const turn = (model: string, effort: string | null) => ({
  effort,
  maxMode: null,
  model,
});

const node = (
  sessionId: string,
  childSessionIds: readonly string[],
  branches: readonly string[]
) => ({
  agentTimeMs: { value: null },
  branches,
  childSessionIds,
  modelTimeline: [],
  modelTimelineReason: null,
  money: [],
  sessionId,
  title: null,
  tokens: [],
  toolCalls: { value: null },
});

describe("dft human output", () => {
  it("formats money, counts and durations for people", () => {
    expect(formatUsd(3.534)).toBe("$3.53");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatCount(1_234_567)).toBe("1.2M");
    expect(formatCount(230_400)).toBe("230k");
    expect(formatDuration(6_120_000)).toBe("1h 42m");
    expect(formatAge(3 * 86_400_000)).toBe("3 days");
  });

  it("collapses repeated model turns into counts", () => {
    expect(
      collapseTurns([
        turn("grok-4.7", "high"),
        turn("auto", null),
        turn("grok-4.7", "high"),
        turn("default", null),
      ])
    ).toBe("grok-4.7 high ×2, Auto ×2");
  });

  it("counts subagents apart from chats and names the other branches of a chat", () => {
    const text = chatsText(
      {
        branch: "main",
        chats: [
          node(
            "parent00-1",
            ["child000-1", "child000-2"],
            ["main", "feature/sub-b"]
          ),
          node("child000-1", [], ["main"]),
          node("child000-2", [], ["main"]),
        ],
        rootSessionIds: ["parent00-1"],
        unattributed: { events: 0 },
      },
      { now: 0, verbose: false }
    ).split("\n");

    expect(text[0]).toBe("1 chat on main, with 2 subagents");
    expect(text).toContain("  Also on feature/sub-b");
    expect(text.filter((line) => line.includes("Also on"))).toHaveLength(1);
  });

  it("keeps the sync note to one line unless verbose", () => {
    const report = {
      context: {
        branch: "main",
        flightId: null,
        headSha: null,
        repoCommonDir: null,
        worktreePath: null,
      },
      steps: [
        {
          duplicates: 0,
          input: null,
          inserted: 12,
          reason: null,
          source: "collector.git-history",
          status: "synced" as const,
        },
        {
          duplicates: null,
          input: null,
          inserted: null,
          reason: "no folder",
          source: "collector.cursor-transcripts",
          status: "unavailable" as const,
        },
      ],
    };

    expect(syncText(report, false)).toBe(
      "dft: synced 12 new events from 1 source"
    );
    expect(syncText(report, true).split("\n")).toHaveLength(3);
  });
});
