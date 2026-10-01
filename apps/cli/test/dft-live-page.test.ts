// @effect-diagnostics nodeBuiltinImport:off newPromise:off asyncFunction:off -- The live page script runs in the browser, so the test evaluates its text in a node:vm context with a small fake DOM and a fetch whose replies the test releases by hand.
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";

import { liveDashboardPage } from "../src/dft-live-page.js";

interface FakeEvent {
  readonly type: string;
}

type Listener = (event: FakeEvent) => void;

class FakeElement {
  checked = false;
  children: FakeElement[] = [];
  className = "";
  clientWidth = 600;
  disabled = false;
  hidden = false;
  offsetWidth = 0;
  placeholder = "";
  style: Record<string, string> = {};
  textContent = "";
  title = "";
  value = "";
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: () => null,
    remove: () => null,
    toggle: () => null,
  };
  readonly listeners = new Map<string, Listener[]>();
  readonly parts = new Map<string, FakeElement>();
  html = "";

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(html: string) {
    this.html = html;
    this.children = Array.from(
      { length: html.split('<div class="tile">').length - 1 },
      () => new FakeElement()
    );
  }

  get parentNode(): FakeElement {
    return this.part("parent");
  }

  get tBodies(): readonly FakeElement[] {
    return [this.part("tbody")];
  }

  get tFoot(): FakeElement {
    return this.part("tfoot");
  }

  get tHead() {
    return { rows: [this.part("thead")] };
  }

  part(name: string): FakeElement {
    const found = this.parts.get(name);

    if (found !== undefined) {
      return found;
    }

    const made = new FakeElement();

    this.parts.set(name, made);

    return made;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  focus(): void {
    this.attributes.set("focused", "true");
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  querySelector(selector: string): FakeElement {
    return this.part(selector);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

const emptyUsage = {
  coverage: { unpriced: 0 },
  groups: [],
  other: null,
  total: { values: {} },
  unattributed: null,
};

const branchReply = {
  view: {
    branch: "main",
    chats: "<p>chats</p>",
    repoRoot: "/work/app",
    report: "branch report",
    summary: [],
    timeline: "timeline",
    usage: { models: emptyUsage, tools: emptyUsage },
    worktrees: [],
  },
};

type PageReply =
  | typeof branchReply
  | ReturnType<typeof usageReply>
  | ReturnType<typeof usageOut>;

interface Pending {
  readonly body: string | undefined;
  readonly resolve: (body: PageReply) => void;
  readonly url: string;
}

const pageScript = (): string => {
  const [code] = [
    ...liveDashboardPage("token").matchAll(/<script>(?<code>.*?)<\/script>/gsu),
  ].map((match) => match.groups?.code ?? "");

  return code ?? "";
};

const openPage = (hash: string) => {
  const elements = new Map<string, FakeElement>();
  const pending: Pending[] = [];
  const windowListeners = new Map<string, Listener[]>();
  const location = { hash };
  const document = new FakeElement();
  const token = new FakeElement();

  token.setAttribute("content", "token");

  const byId = (id: string): FakeElement => {
    const found = elements.get(id) ?? new FakeElement();

    elements.set(id, found);

    return found;
  };

  const fakeDocument = {
    addEventListener: document.addEventListener.bind(document),
    getElementById: byId,
    querySelector: () => token,
    querySelectorAll: () => [],
    title: "",
  };

  const fetch = async (url: string, init?: { readonly body?: string }) => {
    // oxlint-disable-next-line promise/avoid-new -- the fake fetch hands its resolver to the test, so a reply can arrive after a navigation
    const body = await new Promise<PageReply>((resolve) => {
      pending.push({ body: init?.body, resolve, url });
    });

    return { json: async () => await Promise.resolve(body), ok: true };
  };

  const setUrl = (next: string) => {
    location.hash = next;
  };

  runInNewContext(pageScript(), {
    EventSource: FakeElement,
    URLSearchParams,
    clearTimeout: () => null,
    document: fakeDocument,
    fetch,
    history: {
      pushState: (_state: null, _title: string, next: string) => {
        setUrl(next);
      },
      replaceState: (_state: null, _title: string, next: string) => {
        setUrl(next);
      },
    },
    location,
    setInterval: () => 0,
    setTimeout: () => 0,
    window: {
      addEventListener: (type: string, listener: Listener) => {
        windowListeners.set(type, [
          ...(windowListeners.get(type) ?? []),
          listener,
        ]);
      },
      scrollTo: () => null,
    },
  });

  return {
    byId,
    document: fakeDocument,
    navigate: (next: string) => {
      setUrl(next);

      for (const listener of windowListeners.get("hashchange") ?? []) {
        listener({ type: "hashchange" });
      }
    },
    take: (prefix: string): Pending | undefined =>
      pending.find((item) => item.url.startsWith(prefix)),
    takeAll: (prefix: string): readonly Pending[] =>
      pending.filter((item) => item.url.startsWith(prefix)),
  };
};

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const dayOf = (ms: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: ZONE,
    year: "numeric",
  }).format(ms);

const labelOf = (day: string): string => {
  const [, month = "1", date = "1"] = day.split("-");

  return `${MONTHS[Number(month) - 1] ?? ""} ${String(Number(date))}`;
};

const usageReply = (since: DateTime.Utc, today: string) => ({
  bucket: "day",
  coverage: { unpriced: 0 },
  groupBy: "tool",
  groups: [],
  notes: [],
  other: null,
  series: [
    { bucket: today, stacks: [{ key: "codex", values: { estimate: 1 } }] },
  ],
  stackBy: "tool",
  total: { facts: 0, values: {} },
  unattributed: null,
  window: { since: DateTime.formatIso(since), tz: ZONE, until: null },
});

interface Row {
  readonly key: string;
  readonly values: Record<string, number>;
}

const rowOf = (key: string): Row => ({
  key,
  values: { estimate: 1, requests: 1, tokens: 10 },
});

const usageOut = (
  fields: Partial<{
    groupBy: string | null;
    groups: readonly Row[];
    series: readonly { bucket: string; stacks: readonly Row[] }[];
    stackBy: string | null;
  }>
) => ({
  bucket: "week",
  coverage: { unpriced: 0 },
  groupBy: null,
  groups: [],
  notes: [],
  other: null,
  series: [],
  stackBy: null,
  total: { facts: 1, values: { estimate: 1, requests: 1, tokens: 10 } },
  unattributed: null,
  window: { since: null, tz: ZONE, until: null },
  ...fields,
});

const answerUsage = (
  page: ReturnType<typeof openPage>,
  reply: (url: string) => PageReply
): void => {
  for (const pending of page.takeAll("/api/usage?")) {
    pending.resolve(reply(pending.url));
  }
};

const AXIS_LABEL = /text-anchor="middle">(?<label>[^<]+)<\/text>/gu;

const chartLabels = (html: string): string[] =>
  [...html.matchAll(AXIS_LABEL)].map((match) => match.groups?.label ?? "");

const settle = Effect.sleep("5 millis");

const BRANCH_HASH = "#/branch?repo=%2Fwork%2Fapp%2F.git&branch=main";

describe("dft live page", () => {
  it.live("paints a branch when its reply arrives on the branch page", () =>
    Effect.gen(function* branch() {
      const page = openPage(BRANCH_HASH);

      page.take("/api/branch?")?.resolve(branchReply);
      yield* settle;

      expect(page.byId("b-report").textContent).toBe("branch report");
      expect(page.document.title).toBe("dft, main");
    })
  );

  it.live(
    "starts the day chart where the window starts and always labels today",
    () =>
      Effect.gen(function* chart() {
        const current = yield* DateTime.now;
        const since = DateTime.subtract(current, { days: 30 });
        const today = dayOf(DateTime.toEpochMillis(current));
        const reply = usageReply(since, today);

        const paint = (width: number) =>
          Effect.gen(function* painted() {
            const page = openPage("#/?since=30d");

            page.byId("u-chart").clientWidth = width;

            for (const pending of page.takeAll("/api/usage?")) {
              pending.resolve(reply);
            }

            yield* settle;

            return page.byId("u-chart").innerHTML;
          });

        const wide = yield* paint(4000);
        const narrow = yield* paint(600);

        expect(wide.split('class="hit"')).toHaveLength(32);
        expect(chartLabels(wide)[0]).toBe(
          labelOf(dayOf(DateTime.toEpochMillis(since)))
        );
        expect(chartLabels(wide).at(-1)).toBe(labelOf(today));
        expect(chartLabels(narrow).length).toBeLessThan(31);
        expect(chartLabels(narrow).at(-1)).toBe(labelOf(today));
      })
  );

  it.live("sends whether a saved page keeps chat titles", () =>
    Effect.sync(() => {
      const page = openPage(BRANCH_HASH);

      const exportPage = () => {
        for (const listener of page.byId("s-export").listeners.get("click") ??
          []) {
          listener({ type: "click" });
        }
      };

      exportPage();
      page.byId("s-export-titles").checked = true;
      exportPage();

      expect(page.takeAll("/api/action").map((item) => item.body)).toEqual([
        JSON.stringify({ action: "export", titles: false }),
        JSON.stringify({ action: "export", titles: true }),
      ]);
    })
  );

  it.live("ignores a branch reply that arrives after going back to Usage", () =>
    Effect.gen(function* late() {
      const page = openPage(BRANCH_HASH);
      const reply = page.take("/api/branch?");

      expect(reply).toBeDefined();
      page.navigate("#/");

      expect(page.document.title).toBe("dft, usage");

      reply?.resolve(branchReply);
      yield* settle;

      expect(page.document.title).toBe("dft, usage");
      expect(page.byId("b-report").textContent).toBe("");
    })
  );

  it.live(
    "labels DeepSeek sessions in chips and breadcrumbs by their id, not by the session- prefix",
    () =>
      Effect.gen(function* deepseek() {
        const first = "session-b4ed1751-db57-4ba0-833c-2ce90c50e141";
        const second = "session-c4146155-0f3e-4a2b-9d4f-6a8c0e2a4b6d";
        const one = openPage(`#/?session=${first}&by=model&since=all`);

        const two = openPage(
          `#/?session=${first}&session=${second}&by=model&since=all`
        );

        expect(one.byId("u-crumbs").innerHTML).toContain(
          "Session</span> session-b4ed1751"
        );
        expect(one.byId("u-chips").innerHTML).toContain(
          "<b>Session:</b> session-b4ed1751<"
        );
        expect(two.byId("u-chips").innerHTML).toContain(
          "<b>Session:</b> session-b4ed1751, session-c4146155<"
        );

        yield* settle;
      })
  );

  it.live(
    "gives a session the same label in the chart legend and the table",
    () =>
      Effect.gen(function* sameLabel() {
        const top = "6f1c2a9e-4b7d-4e21-9c3a-8d5e7f1a2b3c";
        const near = "6f1c2a9e-1111-4e21-9c3a-8d5e7f1a2b3c";
        const page = openPage("#/?by=session&since=all");

        answerUsage(page, (url) => {
          if (url.includes("stackBy=session")) {
            return usageOut({
              series: [
                {
                  bucket: "2026-09-28",
                  stacks: [rowOf(top), rowOf("(other)")],
                },
              ],
              stackBy: "session",
            });
          }

          return url.includes("groupBy=session")
            ? usageOut({
                groupBy: "session",
                groups: [rowOf(top), rowOf(near)],
              })
            : usageOut({ groupBy: "tool" });
        });
        yield* settle;

        const legend = page.byId("u-legend").innerHTML;
        const table = page.byId("u-table").part("tbody").innerHTML;

        expect(legend).toContain("</i>6f1c2a9e-4b7d</span>");
        expect(table).toContain("</i>6f1c2a9e-4b7d</td>");
        expect(table).toContain("</i>6f1c2a9e-1111</td>");
      })
  );

  it.live(
    "tells repos with the same folder name apart in chips and breadcrumbs",
    () =>
      Effect.gen(function* repos() {
        const claude = "/w/claude-code/repo/.git";
        const codex = "/w/codex/repo/.git";

        const known = (url: string): PageReply =>
          url.includes("groupBy=repo")
            ? usageOut({
                groupBy: "repo",
                groups: [rowOf(claude), rowOf(codex)],
              })
            : usageOut({ groupBy: "tool" });

        const usage = openPage(
          `#/?repo=${encodeURIComponent(claude)}&by=branch&since=all`
        );

        answerUsage(usage, known);
        yield* settle;

        expect(usage.byId("u-crumbs").innerHTML).toContain(
          "Project</span> claude-code/repo"
        );
        expect(usage.byId("u-chips").innerHTML).toContain(
          "<b>Project:</b> claude-code/repo<"
        );

        const branch = openPage(
          `#/branch?repo=${encodeURIComponent(codex)}&branch=main`
        );

        answerUsage(branch, known);
        yield* settle;

        expect(branch.byId("b-crumbs").innerHTML).toContain(
          "Project</span> codex/repo"
        );
      })
  );

  it("says that Setup's session count covers every repo on the machine", () => {
    const page = liveDashboardPage("token");

    expect(page).toContain('class="num">Sessions found</th>');
    expect(page).toContain("across all repos");
  });
});
