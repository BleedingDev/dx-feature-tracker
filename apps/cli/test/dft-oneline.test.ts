import { describe, expect, it } from "@effect/vitest";
import type { FlightHistoryRow, HistoryMeasure } from "@rat-stack/core/dx";

import {
  branchOneline,
  historyOneline,
  historyText,
  linkedWorktree,
  onelineText,
  reportFacts,
  snapshotLine,
} from "../src/dft-render.js";

const measure = (value: number | null): HistoryMeasure => ({
  measurement: value === null ? "unavailable" : "measured",
  method: "observed",
  metricId: "test",
  reason: value === null ? "not recorded" : null,
  unit: "count",
  value,
});

interface RowInput {
  readonly agentMs?: number | null;
  readonly billed?: number | null;
  readonly branch?: string;
  readonly chats?: number | null;
  readonly commits?: number | null;
  readonly estimate?: number | null;
  readonly lastActivityAt?: string;
  readonly repoCommonDir?: string | null;
  readonly tokens?: number | null;
  readonly worktrees?: readonly string[];
}

const row = (input: RowInput): FlightHistoryRow => ({
  activeTime: measure(null),
  agentTime: measure(input.agentMs ?? null),
  branch: input.branch ?? "feature/x",
  branchAge: measure(null),
  chats: measure(input.chats ?? null),
  commits: measure(input.commits ?? null),
  events: 1,
  firstActivityAt: null,
  lastActivityAt: input.lastActivityAt ?? "2026-09-30T10:00:00.000Z",
  money: {
    billed: measure(input.billed ?? null),
    estimatedPriceTable: measure(input.estimate ?? null),
    estimatedSource: measure(null),
    metered: measure(null),
  },
  repoCommonDir:
    input.repoCommonDir === undefined ? "/code/app/.git" : input.repoCommonDir,
  requests: measure(null),
  status: { reason: null, value: "open" },
  tokens: [{ category: "total", measure: measure(input.tokens ?? null) }],
  worktrees: input.worktrees ?? ["/code/app"],
});

const full = row({
  agentMs: 2_520_000,
  billed: 0.42,
  chats: 3,
  commits: 7,
  estimate: 1.1,
  tokens: 230_000,
});

describe("dft one-line output", () => {
  it("prints every known part on one line", () => {
    expect(branchOneline("feature/x", full)).toBe(
      "feature/x  $0.42 billed · $1.10 est · 230k tokens · 42m agent · 3 chats · 7 commits"
    );
  });

  it("leaves out parts it does not know", () => {
    expect(
      branchOneline("feature/x", row({ estimate: 2.5, tokens: 1_200_000 }))
    ).toBe("feature/x  $2.50 est · 1.2M tokens");
  });

  it("says so plainly when there is no AI usage", () => {
    expect(branchOneline("feature/x", null)).toBe("feature/x  no AI usage yet");
    expect(branchOneline("feature/x", row({ commits: 1 }))).toBe(
      "feature/x  no AI usage yet · 1 commit"
    );
    expect(onelineText("main", null)).not.toContain("unavailable");
  });

  it("marks branches that live in a linked worktree", () => {
    const linked = row({ billed: 1, worktrees: ["/code/app-wt/feature-x"] });

    expect(linkedWorktree(linked)).toBe("feature-x");
    expect(linkedWorktree(full)).toBeNull();
    expect(branchOneline("feature/x", linked)).toBe(
      "feature/x (worktree: feature-x)  $1.00 billed"
    );
  });

  it("reads a worktree field when history provides one", () => {
    const withField = { ...full, worktree: "/code/app-wt/agent-2" };
    const mainField = { ...full, worktree: "/code/app" };

    expect(linkedWorktree(withField)).toBe("agent-2");
    expect(linkedWorktree(mainField)).toBeNull();
  });

  it("prints one aligned line per branch for history", () => {
    const lines = historyOneline(
      [
        row({ billed: 0.1, branch: "main" }),
        row({
          branch: "feature/long-name",
          lastActivityAt: "2026-09-30T12:00:00.000Z",
          tokens: 5000,
        }),
        row({ billed: 3, branch: "account", repoCommonDir: null }),
      ],
      { allRepos: false }
    ).split("\n");

    expect(lines).toStrictEqual([
      "feature/long-name  5k tokens",
      "main               $0.10 billed",
    ]);
  });

  it("uses the same line for the git hook", () => {
    expect(snapshotLine("feature/x", full)).toBe(
      `dft: ${branchOneline("feature/x", full)}`
    );
    expect(snapshotLine(null, null)).toBe("dft: (detached)  no AI usage yet");
  });

  it("builds the line from an analyze report", () => {
    const facts = reportFacts({
      metrics: [
        { id: "dx.cost.charge.usd", value: 3.534 },
        { id: "dx.ai-usage.tokens.input", value: 1_000_000 },
        { id: "dx.ai-usage.tokens.output", value: 200_000 },
        { id: "dx.flight.agent.ms", value: 6_120_000 },
        { id: "dx.flight.commits", value: 2 },
      ].map(({ id, value }) => ({
        method: "observed",
        metricId: id,
        reason: null,
        unit: "x",
        value,
      })),
      snapshot: { selector: { branch: "main" } },
    });

    expect(onelineText("main", facts)).toBe(
      "main  $3.53 billed · 1.2M tokens · 1h 42m agent · 2 commits"
    );
  });
});

describe("dft history worktree column", () => {
  const now = Date.parse("2026-09-30T12:00:00.000Z");

  it("adds a WORKTREE column only when a branch lives in a linked worktree", () => {
    const mainOnly = historyText([row({ billed: 1, branch: "main" })], {
      allRepos: false,
      now,
      verbose: false,
    });

    expect(mainOnly).not.toContain("WORKTREE");

    const [header, first, second] = historyText(
      [
        row({ billed: 1, branch: "main" }),
        row({
          billed: 2,
          branch: "feature/w1",
          lastActivityAt: "2026-09-30T11:00:00.000Z",
          worktrees: ["/code/app-wt/w1"],
        }),
      ],
      { allRepos: false, now, verbose: false }
    ).split("\n");

    expect(header).toMatch(/^BRANCH\s+WORKTREE\s+STATUS/u);
    expect(first).toMatch(/^feature\/w1\s+w1\s+open\s.*\$2\.00/u);
    expect(second).toMatch(/^main\s+app\s+open\s.*\$1\.00/u);
  });
});
