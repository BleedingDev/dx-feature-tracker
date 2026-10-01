// @effect-diagnostics nodeBuiltinImport:off -- The page runs the serialized state kit in the browser, so the test evaluates the same script text in a node:vm context.
import { Script, runInNewContext } from "node:vm";

import { describe, expect, it } from "@effect/vitest";

import {
  dashboardStateKit,
  dashboardStateScript,
} from "../src/dft-dashboard-state.js";
import type {
  DashboardStateKit,
  UsageViewState,
} from "../src/dft-dashboard-state.js";
import { liveDashboardPage } from "../src/dft-live-page.js";

const kit = dashboardStateKit();

const base: UsageViewState = {
  by: "tool",
  filters: [],
  metric: "estimate",
  since: "30d",
  until: "",
};

const repo = "/home/user/code/app/.git";

const query = (text: string) => Object.fromEntries(new URLSearchParams(text));

const all = (text: string, name: string) =>
  new URLSearchParams(text).getAll(name);

describe("dashboard URL state", () => {
  it("decodes an empty hash to the defaults and encodes them back to #/", () => {
    const route = kit.decode("");

    expect(route).toEqual({ name: "usage", state: base });
    expect(kit.encode(route)).toBe("#/");
  });

  it("round-trips every part of the usage state, keeping filter order", () => {
    const state: UsageViewState = {
      by: "model",
      filters: [
        ["tool", "codex"],
        ["tool", "claude-code"],
        ["repo", repo],
        ["branch", "feat/a&b"],
      ],
      metric: "tokens",
      since: "2026-09-01",
      until: "2026-09-15",
    };

    const hash = kit.encode({ name: "usage", state });

    expect(hash.startsWith("#/?")).toBe(true);
    expect(kit.decode(hash)).toEqual({ name: "usage", state });
  });

  it("drops unknown dimensions, metrics and group-bys instead of passing them on", () => {
    const route = kit.decode("#/?by=color&metric=vibes&color=red&tool=pi");

    expect(route).toEqual({
      name: "usage",
      state: { ...base, filters: [["tool", "pi"]] },
    });
  });

  it("ignores until for the 7d, 30d and all segments", () => {
    const route = kit.decode("#/?since=7d&until=2026-09-15");

    expect(route.state.until).toBe("");
    expect(kit.segment(route.state)).toBe("7d");
    expect(kit.segment({ ...base, since: "24h" })).toBe("custom");
  });

  it("links straight to a branch with the time range but none of the usage filters", () => {
    const state: UsageViewState = {
      ...base,
      filters: [
        ["tool", "codex"],
        ["model", "gpt-5.6-luna"],
      ],
      since: "7d",
    };

    const hash = kit.encode({
      branch: "feature/x",
      name: "branch",
      repo,
      state,
    });

    expect(hash).not.toContain("tool=");
    expect(kit.decode(hash)).toEqual({
      branch: "feature/x",
      name: "branch",
      repo,
      state: { ...state, filters: [] },
    });

    expect(
      kit.decode(
        `#/branch?repo=${encodeURIComponent(repo)}&branch=main&tool=claude-code&model=claude-sonnet-5`
      ).state.filters
    ).toEqual([]);

    expect(kit.decode("#/setup?since=7d")).toEqual({
      name: "setup",
      state: { ...base, since: "7d" },
    });
  });
});

describe("dashboard drilldown", () => {
  it("goes tool, then model, then branch", () => {
    const model = kit.drill(base, "claude-code");

    expect(model).toEqual({
      name: "usage",
      state: { ...base, by: "model", filters: [["tool", "claude-code"]] },
    });

    const branch = kit.drill(model?.state ?? base, "claude-sonnet-5");

    expect(branch?.state).toEqual({
      ...base,
      by: "branch",
      filters: [
        ["tool", "claude-code"],
        ["model", "claude-sonnet-5"],
      ],
    });
  });

  it("goes repo, then branch, then session", () => {
    const branches = kit.drill({ ...base, by: "repo" }, repo);

    expect(branches?.state).toEqual({
      ...base,
      by: "branch",
      filters: [["repo", repo]],
    });

    const sessions = kit.drill(branches?.state ?? base, "main");

    expect(sessions?.state).toEqual({
      ...base,
      by: "session",
      filters: [
        ["repo", repo],
        ["branch", "main"],
      ],
    });

    expect(kit.drill(sessions?.state ?? base, "abc")).toBeNull();
  });

  it("asks for the repo when a branch name is not tied to one, then opens the branch", () => {
    const repos = kit.drill({ ...base, by: "branch" }, "main");

    expect(repos?.state).toEqual({
      ...base,
      by: "repo",
      filters: [["branch", "main"]],
    });

    expect(kit.drill(repos?.state ?? base, repo)).toEqual({
      branch: "main",
      name: "branch",
      repo,
      state: { ...base, by: "repo" },
    });
  });

  it("opens the whole branch from a tool and model drilldown instead of a silently filtered one", () => {
    const repos = kit.drill(
      {
        ...base,
        by: "repo",
        filters: [
          ["tool", "claude-code"],
          ["model", "claude-sonnet-5"],
          ["branch", "main"],
        ],
      },
      repo
    );

    expect(repos).toEqual({
      branch: "main",
      name: "branch",
      repo,
      state: { ...base, by: "repo" },
    });
  });

  it("turns a day or week into a custom window and never drills into Other", () => {
    expect(kit.drill({ ...base, by: "day" }, "2026-09-30")?.state).toEqual({
      ...base,
      since: "2026-09-30",
      until: "2026-10-01",
    });

    expect(kit.drill({ ...base, by: "week" }, "2026-12-28")?.state).toEqual({
      ...base,
      since: "2026-12-28",
      until: "2027-01-04",
    });

    expect(kit.drill(base, "(other)")).toBeNull();
    expect(kit.drill(base, "(unattributed)")).toBeNull();
  });

  it("builds breadcrumbs from the drilled filters, each undoing the later ones", () => {
    const state: UsageViewState = {
      ...base,
      by: "branch",
      filters: [
        ["tool", "codex"],
        ["model", "gpt-5.6-luna"],
      ],
    };

    const crumbs = kit.crumbs(state);

    expect(crumbs.map((crumb) => [crumb.dimension, crumb.value])).toEqual([
      [null, "All usage"],
      ["tool", "codex"],
      ["model", "gpt-5.6-luna"],
    ]);

    expect(kit.decode(crumbs[0]?.hash ?? "").state).toEqual(base);
    expect(kit.decode(crumbs[1]?.hash ?? "").state).toEqual({
      ...base,
      by: "model",
      filters: [["tool", "codex"]],
    });
  });

  it("keeps multi-value chip filters when a crumb goes back", () => {
    const state: UsageViewState = {
      ...base,
      by: "branch",
      filters: [
        ["provider", "openai"],
        ["provider", "anthropic"],
        ["model", "gpt-5.6-luna"],
      ],
    };

    const [first] = kit.crumbs(state);

    expect(kit.decode(first?.hash ?? "").state.filters).toEqual([
      ["provider", "openai"],
      ["provider", "anthropic"],
    ]);
  });

  it("replaces one dimension's values in place and removes them with an empty list", () => {
    const state: UsageViewState = {
      ...base,
      filters: [
        ["tool", "pi"],
        ["model", "m1"],
      ],
    };

    expect(kit.withFilter(state, "tool", ["omp", "codex"]).filters).toEqual([
      ["tool", "omp"],
      ["tool", "codex"],
      ["model", "m1"],
    ]);
    expect(kit.withFilter(state, "tool", []).filters).toEqual([
      ["model", "m1"],
    ]);
  });
});

describe("dashboard usage queries", () => {
  const state: UsageViewState = {
    ...base,
    by: "model",
    filters: [
      ["tool", "codex"],
      ["tool", "pi"],
      ["model", "gpt-5.6-luna"],
    ],
    metric: "toolFigure",
    since: "7d",
  };

  it("asks for the table grouped and sorted by the chosen dimension and measure", () => {
    const text = kit.tableQuery(state, "Europe/Prague");

    expect(query(text)).toMatchObject({
      groupBy: "model",
      limit: "25",
      metrics: "tokens,requests,sessions,estimate,toolFigure,billed",
      since: "7d",
      sortBy: "toolFigure",
      tz: "Europe/Prague",
    });
    expect(all(text, "tool")).toEqual(["codex", "pi"]);
    expect(all(text, "model")).toEqual(["gpt-5.6-luna"]);
  });

  it("leaves since out for all time and passes a custom window through", () => {
    expect(query(kit.tableQuery({ ...base, since: "all" }, "UTC")).since).toBe(
      undefined
    );

    expect(
      query(
        kit.tableQuery(
          { ...base, since: "2026-09-01", until: "2026-09-08" },
          "UTC"
        )
      )
    ).toMatchObject({ since: "2026-09-01", until: "2026-09-08" });
  });

  it("buckets time groupings and lists every bucket", () => {
    expect(query(kit.tableQuery({ ...base, by: "week" }, "UTC"))).toMatchObject(
      { bucket: "week", groupBy: "week", limit: "500" }
    );
  });

  it("stacks the chart by tool for tools and time, else by the top 6 groups", () => {
    expect(query(kit.chartQuery(state, "UTC"))).toMatchObject({
      bucket: "day",
      limit: "6",
      metrics: "toolFigure",
      stackBy: "model",
    });
    expect(query(kit.chartQuery({ ...base, by: "day" }, "UTC")).stackBy).toBe(
      "tool"
    );
    expect(query(kit.chartQuery({ ...base, since: "all" }, "UTC")).bucket).toBe(
      "week"
    );
    expect(query(kit.chartQuery(state, "UTC")).groupBy).toBe(undefined);
  });

  it("lists a facet's values under every other filter but its own", () => {
    const text = kit.facetQuery(state, "UTC", "tool");

    expect(all(text, "tool")).toEqual([]);
    expect(all(text, "model")).toEqual(["gpt-5.6-luna"]);
    expect(query(text)).toMatchObject({
      groupBy: "tool",
      metrics: "tokens,estimate,toolFigure",
    });
  });

  it("asks per tool for every ledger the tiles show", () => {
    expect(query(kit.toolsQuery(state, "UTC"))).toMatchObject({
      groupBy: "tool",
      metrics: "tokens,requests,estimate,toolFigure,billed",
    });
  });

  it("adds days across months, leap years and backwards", () => {
    expect(kit.addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(kit.addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(kit.addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(kit.addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(kit.addDays("2026-09-25", 30)).toBe("2026-10-25");
    expect(kit.addDays("soon", 1)).toBeNull();
  });
});

describe("dashboard session labels", () => {
  const parent = "01a0f71d-2ce1-7c3a-9f10-5b2d8e4a6c01";
  const subagent = "01a0f71d-900e-7a41-8b22-1c3d5e7f9a02";
  const later = "01a0f71d-fae9-7d55-a301-4e6f8a0b2c03";

  it("keeps the millisecond part of a UUIDv7 session, so sessions started in the same minute differ", () => {
    expect([parent, subagent, later].map(kit.shortSession)).toEqual([
      "01a0f71d-2ce1",
      "01a0f71d-900e",
      "01a0f71d-fae9",
    ]);
    expect(kit.shortSession("6f1c2a9e-4b7d-4e21-9c3a-8d5e7f1a2b3c")).toBe(
      "6f1c2a9e"
    );
    expect(kit.shortSession("ses_short")).toBe("ses_short");
  });

  it("shows more of an id only where two short labels would collide", () => {
    const v4a = "6f1c2a9e-4b7d-4e21-9c3a-8d5e7f1a2b3c";
    const v4b = "6f1c2a9e-4b7d-4e21-9c3a-000000000000";
    const v4c = "6f1c2a9e-1111-4e21-9c3a-8d5e7f1a2b3c";
    const lone = "0b2d4f6a-8c0e-4a2b-9d4f-6a8c0e2a4b6d";

    expect(kit.sessionLabels([v4a, v4b, v4c, lone, "(none)"])).toEqual([
      v4a,
      v4b,
      "6f1c2a9e-1111",
      "0b2d4f6a",
      "(none)",
    ]);
    expect(new Set(kit.sessionLabels([parent, subagent, later])).size).toBe(3);
  });

  it("keeps the part of an id after a tool prefix such as session- or ses_", () => {
    const deepseek = "session-b4ed1751-db57-4ba0-833c-2ce90c50e141";
    const other = "session-c4146155-0f3e-4a2b-9d4f-6a8c0e2a4b6d";

    expect(kit.shortSession(deepseek)).toBe("session-b4ed1751");
    expect(kit.shortSession("ses_3b5a2f1e8ffeKq9TzW4hVb2N")).toBe(
      "ses_3b5a2f1e"
    );
    expect(kit.sessionLabels([deepseek, other])).toEqual([
      "session-b4ed1751",
      "session-c4146155",
    ]);
  });

  it("names a subagent after its session and gives the session the same label with or without it", () => {
    const first = "24ae293e-278a-483e-a09d-62c57aa4728e";
    const second = "c3304500-46ce-4a18-9d9f-a084435b758e";
    const child = `${first}:agent-a1b2c3d4e5f60718`;

    expect(kit.shortSession(child)).toBe("24ae293e › a1b2c3d4");
    expect(kit.sessionLabels([first, second])).toEqual(
      kit.sessionLabels([first, second, child]).slice(0, 2)
    );
    expect(kit.sessionLabels([first, second])).toEqual([
      "24ae293e",
      "c3304500",
    ]);
  });
});

describe("dashboard state script", () => {
  it("runs on its own in a bare context and answers like the module", () => {
    const kits: DashboardStateKit[] = [];

    runInNewContext(`${dashboardStateScript()}keep(STATE);`, {
      URLSearchParams,
      keep: (found: DashboardStateKit) => {
        kits.push(found);
      },
    });

    const [page] = kits;

    const state: UsageViewState = {
      ...base,
      by: "branch",
      filters: [["repo", repo]],
      since: "2026-09-01",
      until: "2026-10-01",
    };

    expect(page?.encode({ name: "usage", state })).toBe(
      kit.encode({ name: "usage", state })
    );
    expect(page?.tableQuery(state, "UTC")).toBe(kit.tableQuery(state, "UTC"));
    expect(page?.drill(state, "main")).toEqual(kit.drill(state, "main"));
    expect(page?.addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("dashboard page scripts", () => {
  it("compiles every inline script of the live page", () => {
    const page = liveDashboardPage("token", { intro: true });

    const scripts = [...page.matchAll(/<script>(?<code>.*?)<\/script>/gsu)].map(
      (match) => match.groups?.code ?? ""
    );

    expect(scripts).toHaveLength(2);

    for (const code of scripts) {
      expect(() => new Script(code)).not.toThrow();
    }
  });
});
