// @effect-diagnostics nodeBuiltinImport:off newPromise:off asyncFunction:off -- The live page script runs in the browser, so the test evaluates its text in a node:vm context with a small fake DOM and a fetch whose replies the test releases by hand.
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

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

type BranchReply = typeof branchReply;

interface Pending {
  readonly resolve: (body: BranchReply) => void;
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

  const fetch = async (url: string) => {
    // oxlint-disable-next-line promise/avoid-new -- the fake fetch hands its resolver to the test, so a reply can arrive after a navigation
    const body = await new Promise<BranchReply>((resolve) => {
      pending.push({ resolve, url });
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
  };
};

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
});
