// @effect-diagnostics nodeBuiltinImport:off -- The dashboard test writes the HTML file into a throwaway directory and reads it back.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import type { FlightHistoryRow, HistoryMeasure } from "@rat-stack/core/dx";
import { Effect } from "effect";

import {
  escapeHtml,
  renderDashboard,
  writeDashboard,
} from "../src/dft-dashboard.js";
import type {
  DashboardChat,
  DashboardChats,
  DashboardChatsQuery,
  DashboardData,
  DashboardHistoryQuery,
} from "../src/dft-dashboard.js";

const EVIL = `<script>alert("x")</script>`;

const EVIL_TITLE = `"><img src=x onerror=alert(1)>`;

const REPO = "/work/app/.git";

const value = (amount: number | null, unit = "count"): HistoryMeasure => ({
  measurement: amount === null ? "unavailable" : "measured",
  method: "observed",
  metricId: "fixture",
  reason: amount === null ? "fixture: no value" : null,
  unit,
  value: amount,
});

const historyRow = (
  branch: string | null,
  repoCommonDir: string | null,
  money: { readonly billed: number | null; readonly estimate: number | null },
  lastActivityAt: string
): FlightHistoryRow => ({
  activeTime: value(null),
  agentTime: value(6_120_000, "ms"),
  branch,
  branchAge: value(null),
  chats: value(2),
  commits: value(3),
  events: 10,
  firstActivityAt: "2026-09-12T08:00:00Z",
  lastActivityAt,
  money: {
    billed: value(money.billed, "USD"),
    estimatedPriceTable: value(money.estimate, "USD"),
    estimatedSource: value(null, "USD"),
    metered: value(null, "USD"),
  },
  repoCommonDir,
  requests: value(12),
  status: { reason: null, value: "open" },
  tokens: [{ category: "total", measure: value(1_234_567, "tokens") }],
  worktrees: repoCommonDir === null ? [] : [`/work/${EVIL}`],
});

const chat = (
  sessionId: string,
  title: string | null,
  childSessionIds: readonly string[] = []
): DashboardChat => ({
  agentTimeMs: { value: 720_000 },
  branches: ["feature/a", EVIL],
  childSessionIds,
  modelTimeline: [
    { effort: "high", maxMode: null, model: "grok-4.7" },
    { effort: "high", maxMode: null, model: "grok-4.7" },
  ],
  money: [
    {
      category: "total",
      estimate: true,
      ledger: "estimate",
      value: 0.42,
    },
  ],
  sessionId,
  title: title === null ? null : { value: title },
  tokens: [
    { category: "total", estimate: false, ledger: "tokens", value: 5000 },
  ],
  toolCalls: { value: 3 },
});

const chatsReport: DashboardChats = {
  chats: [
    chat("root-0001-aaaa", EVIL_TITLE, ["child-0002-bbbb"]),
    chat("child-0002-bbbb", "Subagent job"),
  ],
  repoCommonDir: REPO,
  rootSessionIds: ["root-0001-aaaa"],
};

const fixture: DashboardData = {
  account: [
    historyRow(
      null,
      null,
      { billed: 3.5343, estimate: null },
      "2026-09-30T10:00:00Z"
    ),
  ],
  branches: [
    {
      chats: chatsReport,
      row: historyRow(
        EVIL,
        REPO,
        { billed: 1.5, estimate: 4.2 },
        "2026-09-30T12:00:00Z"
      ),
    },
    {
      chats: null,
      row: historyRow(
        "feature/b",
        REPO,
        { billed: null, estimate: 0.8 },
        "2026-09-29T12:00:00Z"
      ),
    },
  ],
  generatedAt: Date.parse("2026-09-30T14:00:00Z"),
  repoLabel: "app",
  scope: "all",
  since: "2026-09-01T00:00:00Z",
  titles: true,
  version: "9.9.9",
};

const VOID = new Set(["meta", "input", "br", "img", "link"]);

const unbalancedTags = (html: string): readonly string[] => {
  const stack: string[] = [];
  const problems: string[] = [];

  const body = html.replaceAll(
    /<(?<raw>script|style)>[\s\S]*?<\/\k<raw>>/gu,
    ""
  );

  for (const match of body.matchAll(
    /<(?<closing>\/?)(?<tag>[a-z][a-z0-9]*)\b[^>]*>/gu
  )) {
    const closing = match.groups?.closing ?? "";
    const tag = match.groups?.tag ?? "";

    if (VOID.has(tag)) {
      continue;
    }

    if (closing === "") {
      stack.push(tag);
    } else if (stack.pop() !== tag) {
      problems.push(`unexpected </${tag}>`);
    }
  }

  return [...problems, ...stack.map((tag) => `unclosed <${tag}>`)];
};

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const ENTERPRISE_FOOTER =
  /<p class="enterprise">Want it for your whole company\?.*?<\/p>/u;

describe("dft dashboard", () => {
  it("renders one balanced, self-contained HTML page", () => {
    const html = renderDashboard(fixture, { timeZone: "UTC" });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(unbalancedTags(html.replace("<!doctype html>", ""))).toEqual([]);
    expect(html.replace(ENTERPRISE_FOOTER, "")).not.toMatch(
      /https?:|\/\/[a-z]|<[^>]+\s(?:src|href|action)=/iu
    );
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("Generated Sep 30, 2026, 14:00 · dft 9.9.9");
  });

  it("links the enterprise offer once, in the footer, opening a new tab", () => {
    const html = renderDashboard(fixture, { timeZone: "UTC" });

    const footer = html.slice(
      html.indexOf("<footer>"),
      html.indexOf("</footer>")
    );

    expect(html.match(/whole company/gu)).toHaveLength(1);
    expect(footer).toMatch(ENTERPRISE_FOOTER);
    expect(footer).toContain(
      '<a href="https://www.linkedin.com/in/bleedingdev/" target="_blank" rel="noopener">LinkedIn</a>'
    );
    expect(footer).toContain(
      '<a href="mailto:petr.glaser@bleeding.dev" target="_blank" rel="noopener">email</a>'
    );
  });

  it("shows totals, human numbers and the account row", () => {
    const html = renderDashboard(fixture, { timeZone: "UTC" });

    expect(html).toContain("<dd>$5.03</dd>");
    expect(html).toContain(
      "<dd>$5.00<small>some tokens have no price</small></dd>"
    );
    expect(html).toContain("<dd>3.7M</dd>");
    expect(html).toContain("<dd>3h 24m</dd>");
    expect(html).toContain("Sep 12 to Sep 30");
    expect(html).toContain("Not linked to a branch:</strong> $3.53 billed");
    expect(html).toContain("grok-4.7 high ×2");
    expect(html).toContain('<span class="tag">subagent</span> Subagent job');
    expect(html).toContain("Chats for this branch could not be read.");
  });

  it("escapes every string that came from data", () => {
    const html = renderDashboard(fixture, { timeZone: "UTC" });

    expect(html).not.toContain(EVIL);
    expect(html).not.toContain(EVIL_TITLE);
    expect(html).toContain(escapeHtml(EVIL));
    expect(html).toContain(escapeHtml(EVIL_TITLE));
    expect(escapeHtml(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&#39;");
  });

  it("hides chat titles when asked", () => {
    const html = renderDashboard({ ...fixture, titles: false });

    expect(html).not.toContain(escapeHtml(EVIL_TITLE));
    expect(html).toContain("chat root-000");
  });

  it.effect("writes the file from history and chats without opening it", () =>
    Effect.gen(function* dashboardFile() {
      const dir = mkdtempSync(path.join(tmpdir(), "dft-dashboard-"));
      created.push(dir);

      const historyCalls: DashboardHistoryQuery[] = [];
      const chatCalls: DashboardChatsQuery[] = [];

      const result = yield* writeDashboard(
        {
          dftHome: dir,
          open: false,
          repo: "/work/app",
          scope: "repo",
          since: "7d",
        },
        {
          chats: (input) =>
            Effect.sync(() => {
              chatCalls.push(input);

              return chatsReport;
            }),
          history: (input) =>
            Effect.sync(() => {
              historyCalls.push(input);

              return {
                rows: [
                  ...fixture.account,
                  ...fixture.branches.map((b) => b.row),
                ],
                since: "2026-09-23T00:00:00Z",
              };
            }),
        }
      );

      const html = readFileSync(result.path, "utf-8");

      expect(result.path).toBe(path.join(dir, "dashboard.html"));
      expect(result.opened).toBe(false);
      expect(result.branches).toBe(2);
      expect(historyCalls).toEqual([
        { allRepos: false, repo: "/work/app", since: "7d" },
      ]);
      expect(chatCalls.map((call) => call.branch)).toEqual([EVIL, "feature/b"]);
      expect(html).not.toContain("Not linked to a branch");
      expect(html).toContain("Repo app · since Sep");
    })
  );
});
