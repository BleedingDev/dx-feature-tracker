// @effect-diagnostics nodeBuiltinImport:off newPromise:off asyncFunction:off -- The live page script runs in the browser, so the test evaluates its text in a node:vm context with a small fake DOM and a fetch whose replies the test releases by hand.
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "@effect/vitest";
import {
  AgentResponseContextSchema,
  OperationInputSchema,
  OperationOutputSchema,
} from "@rat-stack/core/dx";
import type {
  AgentError,
  AgentResponseContext,
  OperationOutput,
  OperationReceipt,
} from "@rat-stack/core/dx";
import { DateTime, Effect, Schema } from "effect";

import { DashboardOperationReviewSchema } from "../src/dft-agent-live-bridge.js";
import type { DashboardMetadataExportPlan } from "../src/dft-agent-live-bridge.js";
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

interface ActionReply {
  readonly message: string;
  readonly receipt: OperationReceipt;
}

interface MetadataExportReply extends DashboardMetadataExportPlan {
  readonly context: AgentResponseContext;
}

interface FailureReply {
  readonly error: string;
  readonly failure: Pick<AgentError, "code">;
}

type PageReply =
  | ActionReply
  | FailureReply
  | MetadataExportReply
  | OperationOutput
  | typeof branchReply
  | ReturnType<typeof usageReply>
  | ReturnType<typeof usageOut>;

const EXPORT_BASIS = "fixture:metadata-export-basis";

const EXPORT_DESTINATION = "fixture:metadata-export-destination";

const exportContext = AgentResponseContextSchema.make({
  basisId: EXPORT_BASIS,
  completeness: {
    aggregation: "partial",
    items: "complete",
    missingRefs: 0,
    omittedItems: 0,
    omittedSeries: 0,
    reason: "Synthetic metadata export fixture; evidence is unavailable.",
    series: "not-requested",
  },
  coverage: [],
  effectivePolicies: {
    acquisition: "recorded-only",
    derivation: "ready-only",
    learning: "hidden",
    prices: "cached-only",
  },
  effects: {
    acquisitionReceiptIds: [],
    basisWrites: 0,
    cacheWrites: 0,
    networkRequests: 0,
  },
  freshness: [],
  id: "fixture:metadata-export-context",
  next: [],
  originMix: [{ count: 1, origin: "fixture" }],
  profileVersion: "dx.agent.v1",
  reproducibility: "retained-results-only",
  resources: {
    appliedLimits: {
      maxDecodedBytes: 16_384,
      maxElapsedMs: 1000,
      maxFacts: 64,
      maxItems: 8,
      maxNetworkRequests: 0,
      maxOutputBytes: 8192,
      maxSeriesBuckets: 7,
      maxStacks: 2,
    },
    continuation: null,
    decodedBytes: null,
    elapsedMs: null,
    factsExamined: null,
    limitReached: null,
    networkRequests: 0,
    outputBytes: null,
  },
  resultDigest: "fixture:metadata-export-result-digest",
  resultRef: null,
  revisions: {
    attribution: "fixture:attribution",
    config: "fixture:config",
    definitions: "fixture:definitions",
    derivation: "fixture:derivation",
    evidence: "fixture:evidence",
    prices: "fixture:prices",
  },
  schemaVersion: "dx.context.v1",
  scope: {
    branchSelection: { branches: ["fixture:branch"], kind: "selected" },
    flightId: null,
    repoId: "fixture:repo",
    resolution: "Synthetic metadata export fixture.",
    sources: [],
    tools: [],
    worktreeId: "fixture:worktree",
  },
  storeGeneration: 1,
  storeId: "fixture:metadata-export-store",
  window: {
    resolvedAt: "2026-10-01T01:00:00.000Z",
    sinceInclusive: "2026-10-01T00:00:00.000Z",
    timezone: "UTC",
    untilExclusive: "2026-10-01T01:00:00.000Z",
  },
});

const exportPlan = OperationOutputSchema.members[0].fields.plan.make({
  arguments: {
    basisId: EXPORT_BASIS,
    destination: EXPORT_DESTINATION,
    disclosure: "metadata-only",
    kind: "export",
  },
  bounds: {
    maxBytes: 16_384,
    maxElapsedMs: 1000,
    maxFiles: 1,
    maxRecords: 0,
    maxRequests: 0,
    maxRetries: 0,
  },
  consent: {
    reason: "Synthetic preview fixture; no operation was authorized.",
    receiptIds: [],
    scopeDigest: "fixture:metadata-export-scope",
    state: "required",
  },
  createdAt: exportContext.window.resolvedAt,
  effects: {
    destructive: false,
    networkDestinations: [],
    reads: [EXPORT_BASIS],
    writes: [EXPORT_DESTINATION],
  },
  expectedEvidenceImprovement:
    "Synthetic export fixture; no evidence improvement was observed.",
  expiresAt: "2026-10-01T02:00:00.000Z",
  forecast: { bytes: null, cost: null, elapsedMs: null, requests: null },
  id: "fixture:metadata-export-plan",
  kind: "export",
  planDigest: "fixture:metadata-export-plan-digest",
  preconditions: [],
  purpose: "Synthetic export preview; no file was written.",
  resumeBoundary: "atomic-step",
  schemaVersion: "dx.operation.v1",
  scope: exportContext.scope,
  stopCondition: "Stop before exceeding the synthetic work bounds.",
  storeGeneration: exportContext.storeGeneration,
  storeId: exportContext.storeId,
  validity: "valid",
});

const exportPreview: MetadataExportReply = {
  basisId: EXPORT_BASIS,
  confirmText: `EXPORT METADATA ${exportPlan.consent.scopeDigest}`,
  context: exportContext,
  destination: EXPORT_DESTINATION,
  idempotencyKey: `dashboard:export:${exportPlan.id}`,
  plan: exportPlan,
  review: DashboardOperationReviewSchema.make({
    expectedDigest: exportPlan.planDigest,
    kind: "export",
    plan: {
      id: exportPlan.id,
      storeGeneration: exportPlan.storeGeneration,
      storeId: exportPlan.storeId,
    },
  }),
};

const nextExportPlan = OperationOutputSchema.members[0].fields.plan.make({
  ...exportPlan,
  arguments: {
    basisId: "fixture:replacement-export-basis",
    destination: "fixture:replacement-export-destination",
    disclosure: "metadata-only",
    kind: "export",
  },
  id: "fixture:replacement-export-plan",
  planDigest: "fixture:replacement-export-plan-digest",
  storeGeneration: exportPlan.storeGeneration + 1,
});

const nextExportPreview: MetadataExportReply = {
  ...exportPreview,
  basisId: "fixture:replacement-export-basis",
  context: AgentResponseContextSchema.make({
    ...exportContext,
    basisId: "fixture:replacement-export-basis",
    storeGeneration: nextExportPlan.storeGeneration,
  }),
  destination: "fixture:replacement-export-destination",
  idempotencyKey: `dashboard:export:${nextExportPlan.id}`,
  plan: nextExportPlan,
  review: DashboardOperationReviewSchema.make({
    expectedDigest: nextExportPlan.planDigest,
    kind: "export",
    plan: {
      id: nextExportPlan.id,
      storeGeneration: nextExportPlan.storeGeneration,
      storeId: nextExportPlan.storeId,
    },
  }),
};

const pendingExportReceipt =
  OperationOutputSchema.members[1].fields.receipt.make({
    afterRevision: null,
    beforeRevision: exportContext.revisions.evidence,
    cancellationRequested: false,
    completedAt: null,
    effects: {
      backupArtifacts: [],
      backupIds: [],
      configDigest: null,
      evidenceIds: [],
      exportArtifacts: [],
      exports: [],
      filesChanged: [],
      remainingStoreGeneration: exportContext.storeGeneration,
      removalReason: null,
      removedCount: null,
      removedRefs: [],
    },
    executionState: "partial",
    id: "fixture:metadata-export-receipt",
    idempotencyKey: exportPreview.idempotencyKey,
    planDigest: exportPlan.planDigest,
    planId: exportPlan.id,
    recovery: "verify-indeterminate",
    resources: {
      bytesRead: null,
      elapsedMs: null,
      recordsDecoded: null,
      requests: null,
      retries: null,
    },
    resultingBasisId: null,
    revision: 1,
    schemaVersion: "dx.operation.v1",
    startedAt: exportContext.window.resolvedAt,
    steps: [],
    storeGeneration: exportContext.storeGeneration,
    storeId: exportContext.storeId,
    verificationRefs: [],
    verificationState: "indeterminate",
  });

const verifiedExportReceipt =
  OperationOutputSchema.members[1].fields.receipt.make({
    ...pendingExportReceipt,
    completedAt: "2026-10-01T01:01:00.000Z",
    effects: {
      ...pendingExportReceipt.effects,
      exportArtifacts: [
        {
          basisId: EXPORT_BASIS,
          contentDigest: "fixture:metadata-export-content-digest",
          destination: EXPORT_DESTINATION,
          disclosure: "metadata-only",
        },
      ],
      exports: [EXPORT_DESTINATION],
      filesChanged: [EXPORT_DESTINATION],
    },
    executionState: "succeeded",
    recovery: "none",
    revision: 2,
    verificationState: "verified",
  });

const cancelledExportReceipt =
  OperationOutputSchema.members[1].fields.receipt.make({
    ...pendingExportReceipt,
    cancellationRequested: true,
    completedAt: null,
    executionState: "cancelled",
    recovery: "none",
    revision: 2,
    startedAt: null,
    verificationState: "not-attempted",
  });

const historicalExportPlan = OperationOutputSchema.members[0].fields.plan.make({
  ...exportPlan,
  validity: "stale",
});

const aliasedExportReceipt =
  OperationOutputSchema.members[1].fields.receipt.make({
    ...verifiedExportReceipt,
    effects: {
      ...verifiedExportReceipt.effects,
      remainingStoreGeneration: nextExportPlan.storeGeneration,
    },
    revision: 3,
    storeGeneration: nextExportPlan.storeGeneration,
  });

const exportAliasLookup = (
  reviewedPlan: Extract<OperationOutput, { action: "plan" }>["plan"] | null,
  receipt: OperationReceipt = aliasedExportReceipt
) =>
  OperationOutputSchema.members[2].make({
    action: "get",
    receipt,
    reviewedPlan,
    reviewedPlanUnavailableReason:
      reviewedPlan === null
        ? "Synthetic historical export plan is unavailable."
        : null,
  });

const deniedExportAliasProofs = [
  exportAliasLookup(null),
  exportAliasLookup(
    OperationOutputSchema.members[0].fields.plan.make({
      ...historicalExportPlan,
      storeGeneration: nextExportPlan.storeGeneration,
    })
  ),
  exportAliasLookup(
    OperationOutputSchema.members[0].fields.plan.make({
      ...historicalExportPlan,
      planDigest: "fixture:unrelated-historical-export-digest",
    })
  ),
  exportAliasLookup(
    OperationOutputSchema.members[0].fields.plan.make({
      ...historicalExportPlan,
      arguments: {
        basisId: EXPORT_BASIS,
        destination: "fixture:unrelated-historical-export-destination",
        disclosure: "metadata-only",
        kind: "export",
      },
    })
  ),
  exportAliasLookup(
    OperationOutputSchema.members[0].fields.plan.make({
      ...historicalExportPlan,
      scope: {
        ...historicalExportPlan.scope,
        worktreeId: "fixture:unrelated-historical-export-worktree",
      },
    })
  ),
  exportAliasLookup(
    historicalExportPlan,
    OperationOutputSchema.members[1].fields.receipt.make({
      ...aliasedExportReceipt,
      idempotencyKey: "fixture:unrelated-export-idempotency-key",
    })
  ),
];

const decodeExportAction = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      action: Schema.Literal("export"),
      confirm: Schema.String,
      idempotencyKey: Schema.String,
      review: DashboardOperationReviewSchema,
    })
  )
);

const decodeOperationRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ request: OperationInputSchema }))
);

interface Pending {
  readonly body: string | undefined;
  readonly reject: (error: Error) => void;
  readonly resolve: (body: PageReply, status?: number) => void;
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
  const sent: Pending[] = [];
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
    const reply = await new Promise<{
      readonly body: PageReply;
      readonly status: number;
    }>((resolve, reject) => {
      const requested: Pending = {
        body: init?.body,
        reject,
        resolve: (body, status = 200) => {
          resolve({ body, status });
        },
        url,
      };

      pending.push(requested);
      sent.push(requested);
    });

    return {
      json: async () => await Promise.resolve(reply.body),
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: "Synthetic fixture reply",
    };
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
    sent: (prefix: string): readonly Pending[] =>
      sent.filter((item) => item.url.startsWith(prefix)),
    take: (prefix: string): Pending | undefined => {
      const position = pending.findIndex((item) => item.url.startsWith(prefix));

      if (position === -1) {
        return undefined;
      }

      const [requested] = pending.splice(position, 1);

      return requested;
    },
    takeAll: (prefix: string): readonly Pending[] => {
      const requested = pending.filter((item) => item.url.startsWith(prefix));

      for (const item of requested) {
        pending.splice(pending.indexOf(item), 1);
      }

      return requested;
    },
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

const click = (page: ReturnType<typeof openPage>, id: string): void => {
  const button = page.byId(id);

  for (const listener of button.listeners.get("click") ?? []) {
    listener.call(button, { type: "click" });
  }
};

const takeRequest = (page: ReturnType<typeof openPage>, prefix: string) => {
  const requested = page.take(prefix);

  return requested === undefined
    ? Effect.die(new Error(`No synthetic page request matched ${prefix}.`))
    : Effect.succeed(requested);
};

const previewMetadataExport = Effect.fnUntraced(
  function* previewMetadataExportFixture(page: ReturnType<typeof openPage>) {
    click(page, "s-export");

    const preview = yield* takeRequest(page, "/api/plan?kind=export");

    expect(page.byId("s-export").disabled).toBe(true);
    expect(page.sent("/api/action")).toHaveLength(0);
    preview.resolve(exportPreview);
    yield* settle;

    expect(page.byId("s-export").textContent).toBe("Save reviewed metadata");
    expect(page.byId("s-export-plan").textContent).toContain(EXPORT_BASIS);
    expect(page.byId("s-export-plan").textContent).toContain(
      EXPORT_DESTINATION
    );
    expect(page.byId("s-export-plan").textContent).toContain(exportPlan.id);
  }
);

const BRANCH_HASH = "#/branch?repo=%2Fwork%2Fapp%2F.git&branch=main";

const beginExportAliasRecovery = Effect.fnUntraced(
  function* beginExportAliasRecoveryFixture() {
    const page = openPage(BRANCH_HASH);

    yield* previewMetadataExport(page);
    click(page, "s-export");

    const initial = yield* takeRequest(page, "/api/action");

    expect(decodeExportAction(initial.body)).toEqual({
      action: "export",
      confirm: exportPreview.confirmText,
      idempotencyKey: exportPreview.idempotencyKey,
      review: exportPreview.review,
    });
    initial.reject(
      new Error("Synthetic completed export response was lost before reset.")
    );
    yield* settle;

    expect(page.byId("s-export").textContent).toBe("Retry reviewed save");
    expect(page.byId("s-export-new").disabled).toBe(true);
    click(page, "s-export");

    const retried = yield* takeRequest(page, "/api/action");

    expect(retried.body).toBe(initial.body);
    retried.resolve({
      message: "Synthetic prior export receipt survived a store reset.",
      receipt: aliasedExportReceipt,
    });
    yield* settle;

    const checked = yield* takeRequest(
      page,
      "/api/agent?capability=dx_operation"
    );

    expect(decodeOperationRequest(checked.body)).toEqual({
      request: {
        action: "get",
        operation: {
          id: aliasedExportReceipt.id,
          storeGeneration: aliasedExportReceipt.storeGeneration,
          storeId: aliasedExportReceipt.storeId,
        },
      },
    });
    expect(page.byId("s-export").textContent).not.toBe("Metadata saved");
    expect(page.byId("s-export").disabled).toBe(true);
    expect(page.byId("s-export-new").disabled).toBe(true);
    expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
    expect(page.sent("/api/action")).toHaveLength(2);

    return { checked, initial, page };
  }
);

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

  it("offers an analysis metadata export without prompts or titles", () => {
    const html = liveDashboardPage("token");

    expect(html).toContain("Preview metadata export");
    expect(html).toContain(
      "A JSON file with the selected recorded analysis basis and coverage; no prompts or raw evidence."
    );
    expect(html).not.toContain('id="s-export-titles"');
  });

  it.live(
    "retries the exact reviewed metadata export after a lost response",
    () =>
      Effect.gen(function* lostExportResponse() {
        const page = openPage(BRANCH_HASH);

        yield* previewMetadataExport(page);
        click(page, "s-export");

        const initial = yield* takeRequest(page, "/api/action");

        expect(decodeExportAction(initial.body)).toEqual({
          action: "export",
          confirm: exportPreview.confirmText,
          idempotencyKey: exportPreview.idempotencyKey,
          review: exportPreview.review,
        });
        initial.reject(new Error("Synthetic export response was lost."));
        yield* settle;

        expect(page.byId("s-export").disabled).toBe(false);
        expect(page.byId("s-export").textContent).toBe("Retry reviewed save");
        expect(page.byId("s-export-new").disabled).toBe(true);
        expect(page.byId("s-export-status").textContent).toContain(
          "Synthetic export response was lost."
        );
        expect(page.byId("s-export-plan").textContent).toContain(
          EXPORT_DESTINATION
        );
        expect(page.sent("/api/plan?kind=export")).toHaveLength(1);

        click(page, "s-export-new");
        yield* settle;

        expect(page.sent("/api/plan?kind=export")).toHaveLength(1);

        click(page, "s-export");

        const retried = yield* takeRequest(page, "/api/action");

        expect(retried.body).toBe(initial.body);
        expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
        retried.resolve({
          message: "Synthetic metadata export was verified.",
          receipt: verifiedExportReceipt,
        });
        yield* settle;

        expect(page.byId("s-export").disabled).toBe(true);
        expect(page.byId("s-export").textContent).toBe("Metadata saved");
        expect(page.byId("s-export-new").disabled).toBe(false);

        click(page, "s-export-new");

        const replacement = yield* takeRequest(page, "/api/plan?kind=export");

        expect(page.sent("/api/plan?kind=export")).toHaveLength(2);
        replacement.resolve(nextExportPreview);
        yield* settle;

        expect(page.byId("s-export").textContent).toBe(
          "Save reviewed metadata"
        );
        expect(page.byId("s-export-plan").textContent).toContain(
          nextExportPreview.destination
        );
        expect(page.sent("/api/action")).toHaveLength(2);
      })
  );

  it.live(
    "proves a consumed export generation alias before accepting its saved receipt",
    () =>
      Effect.gen(function* completedExportAlias() {
        const { checked, initial, page } = yield* beginExportAliasRecovery();

        checked.resolve(exportAliasLookup(historicalExportPlan));
        yield* settle;

        expect(page.byId("s-export").textContent).toBe("Metadata saved");
        expect(page.byId("s-export").disabled).toBe(true);
        expect(page.byId("s-export-new").disabled).toBe(false);
        expect(page.byId("s-export-plan").textContent).toContain(EXPORT_BASIS);
        expect(page.byId("s-export-plan").textContent).toContain(
          EXPORT_DESTINATION
        );
        expect(page.byId("s-export-plan").textContent).toContain(exportPlan.id);
        expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
        expect(page.sent("/api/action")).toHaveLength(2);
        expect(
          page
            .sent("/api/action")
            .every((request) => request.body === initial.body)
        ).toBe(true);
      })
  );

  it.live(
    "retains the original reviewed retry when an export alias proof is denied",
    () =>
      Effect.gen(function* deniedExportAlias() {
        const failedLookups: readonly {
          readonly body: PageReply;
          readonly status: number;
        }[] = [
          ...deniedExportAliasProofs.map((body) => ({ body, status: 200 })),
          {
            body: {
              error: "Synthetic alias lookup generation is stale.",
              failure: { code: "stale-generation" },
            },
            status: 409,
          },
        ];

        for (const lookup of failedLookups) {
          const { checked, initial, page } = yield* beginExportAliasRecovery();

          checked.resolve(lookup.body, lookup.status);
          yield* settle;

          expect(page.byId("s-export").textContent).toBe("Retry reviewed save");
          expect(page.byId("s-export").disabled).toBe(false);
          expect(page.byId("s-export-new").disabled).toBe(true);
          expect(page.byId("s-export-plan").textContent).toContain(
            EXPORT_BASIS
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            EXPORT_DESTINATION
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            exportPlan.id
          );
          expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
          expect(page.sent("/api/action")).toHaveLength(2);

          click(page, "s-export-new");
          yield* settle;

          expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
          click(page, "s-export");

          const retried = yield* takeRequest(page, "/api/action");

          expect(retried.body).toBe(initial.body);
          retried.resolve({
            message: "Synthetic original export alias requires proof again.",
            receipt: aliasedExportReceipt,
          });
          yield* settle;

          const rechecked = yield* takeRequest(
            page,
            "/api/agent?capability=dx_operation"
          );

          expect(rechecked.body).toBe(checked.body);
          rechecked.resolve(exportAliasLookup(historicalExportPlan));
          yield* settle;

          expect(page.byId("s-export").textContent).toBe("Metadata saved");
          expect(page.byId("s-export-new").disabled).toBe(false);
          expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
          expect(page.sent("/api/action")).toHaveLength(3);
        }
      })
  );

  it.live(
    "checks a partial export receipt and retains the same retry identity",
    () =>
      Effect.gen(function* pendingExport() {
        const page = openPage(BRANCH_HASH);

        yield* previewMetadataExport(page);
        click(page, "s-export");

        const initial = yield* takeRequest(page, "/api/action");

        initial.resolve({
          message: "Synthetic metadata export requires verification.",
          receipt: pendingExportReceipt,
        });
        yield* settle;

        expect(page.byId("s-export").textContent).toBe("Retry reviewed save");
        expect(page.byId("s-export-receipt").hidden).toBe(false);
        expect(page.byId("s-export-new").disabled).toBe(true);

        click(page, "s-export-receipt");

        const checked = yield* takeRequest(
          page,
          "/api/agent?capability=dx_operation"
        );

        expect(decodeOperationRequest(checked.body)).toEqual({
          request: {
            action: "get",
            operation: {
              id: pendingExportReceipt.id,
              storeGeneration: pendingExportReceipt.storeGeneration,
              storeId: pendingExportReceipt.storeId,
            },
          },
        });
        checked.resolve(
          OperationOutputSchema.members[2].make({
            action: "get",
            receipt: pendingExportReceipt,
            reviewedPlan: exportPlan,
            reviewedPlanUnavailableReason: null,
          })
        );
        yield* settle;

        expect(page.byId("s-export").textContent).toBe("Retry reviewed save");
        expect(page.byId("s-export-new").disabled).toBe(true);
        expect(page.sent("/api/plan?kind=export")).toHaveLength(1);

        click(page, "s-export");

        const retried = yield* takeRequest(page, "/api/action");

        expect(retried.body).toBe(initial.body);
        retried.resolve({
          message: "Synthetic metadata export still requires verification.",
          receipt: pendingExportReceipt,
        });
        yield* settle;

        click(page, "s-export-receipt");

        const unrelated = yield* takeRequest(
          page,
          "/api/agent?capability=dx_operation"
        );

        unrelated.resolve(
          OperationOutputSchema.members[2].make({
            action: "get",
            receipt: OperationOutputSchema.members[1].fields.receipt.make({
              ...verifiedExportReceipt,
              planId: "fixture:unrelated-export-plan",
            }),
            reviewedPlan: null,
            reviewedPlanUnavailableReason:
              "Synthetic unrelated receipt fixture.",
          })
        );
        yield* settle;

        expect(page.byId("s-export").textContent).not.toBe("Metadata saved");
        expect(page.byId("s-export-new").disabled).toBe(true);

        click(page, "s-export-receipt");

        const verified = yield* takeRequest(
          page,
          "/api/agent?capability=dx_operation"
        );

        verified.resolve(
          OperationOutputSchema.members[2].make({
            action: "get",
            receipt: verifiedExportReceipt,
            reviewedPlan: exportPlan,
            reviewedPlanUnavailableReason: null,
          })
        );
        yield* settle;

        expect(page.byId("s-export").disabled).toBe(true);
        expect(page.byId("s-export").textContent).toBe("Metadata saved");
        expect(page.byId("s-export-new").disabled).toBe(false);
        expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
      })
  );

  it.live(
    "allows an explicit new export after a matched cancellation from apply or receipt lookup",
    () =>
      Effect.gen(function* cancelledExport() {
        for (const response of ["apply", "get"]) {
          const page = openPage(BRANCH_HASH);

          yield* previewMetadataExport(page);
          click(page, "s-export");

          const initial = yield* takeRequest(page, "/api/action");

          initial.resolve({
            message:
              response === "apply"
                ? "Synthetic metadata export was cancelled."
                : "Synthetic metadata export requires verification.",
            receipt:
              response === "apply"
                ? cancelledExportReceipt
                : pendingExportReceipt,
          });
          yield* settle;

          if (response === "get") {
            click(page, "s-export-receipt");

            const unrelated = yield* takeRequest(
              page,
              "/api/agent?capability=dx_operation"
            );

            unrelated.resolve(
              OperationOutputSchema.members[2].make({
                action: "get",
                receipt: OperationOutputSchema.members[1].fields.receipt.make({
                  ...cancelledExportReceipt,
                  planId: "fixture:unrelated-cancelled-export-plan",
                }),
                reviewedPlan: null,
                reviewedPlanUnavailableReason:
                  "Synthetic unrelated cancelled receipt fixture.",
              })
            );
            yield* settle;

            expect(page.byId("s-export").textContent).toBe(
              "Retry reviewed save"
            );
            expect(page.byId("s-export-new").disabled).toBe(true);
            click(page, "s-export-new");
            yield* settle;

            expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
            click(page, "s-export-receipt");

            const checked = yield* takeRequest(
              page,
              "/api/agent?capability=dx_operation"
            );

            expect(decodeOperationRequest(checked.body)).toEqual({
              request: {
                action: "get",
                operation: {
                  id: pendingExportReceipt.id,
                  storeGeneration: pendingExportReceipt.storeGeneration,
                  storeId: pendingExportReceipt.storeId,
                },
              },
            });
            checked.resolve(
              OperationOutputSchema.members[2].make({
                action: "get",
                receipt: cancelledExportReceipt,
                reviewedPlan: exportPlan,
                reviewedPlanUnavailableReason: null,
              })
            );
            yield* settle;
          }

          expect(page.byId("s-export").disabled).toBe(true);
          expect(page.byId("s-export").textContent).toBe("Export cancelled");
          expect(page.byId("s-export-status").textContent).toContain(
            "cancelled"
          );
          expect(page.byId("s-export-status").textContent).not.toContain(
            "is verified"
          );
          expect(page.byId("s-export-status").textContent).not.toContain(
            "Saved "
          );
          expect(page.byId("s-export-status").textContent).not.toContain(
            "Metadata saved"
          );
          expect(page.byId("s-export-new").disabled).toBe(false);
          expect(page.byId("s-export-receipt").hidden).toBe(false);
          expect(page.byId("s-export-receipt").disabled).toBe(false);
          expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
          expect(page.sent("/api/action")).toHaveLength(1);

          click(page, "s-export");
          yield* settle;

          expect(page.sent("/api/action")).toHaveLength(1);
          click(page, "s-export-new");

          const replacement = yield* takeRequest(page, "/api/plan?kind=export");

          expect(page.sent("/api/plan?kind=export")).toHaveLength(2);
          replacement.resolve(nextExportPreview);
          yield* settle;

          expect(page.byId("s-export").disabled).toBe(false);
          expect(page.byId("s-export").textContent).toBe(
            "Save reviewed metadata"
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            nextExportPreview.basisId
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            nextExportPreview.destination
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            nextExportPlan.id
          );
          expect(page.sent("/api/action")).toHaveLength(1);

          click(page, "s-export");

          const replacementSave = yield* takeRequest(page, "/api/action");

          expect(decodeExportAction(replacementSave.body)).toEqual({
            action: "export",
            confirm: nextExportPreview.confirmText,
            idempotencyKey: nextExportPreview.idempotencyKey,
            review: nextExportPreview.review,
          });
          expect(replacementSave.body).not.toBe(initial.body);
          expect(page.sent("/api/action")).toHaveLength(2);
          expect(page.sent("/api/plan?kind=export")).toHaveLength(2);
        }
      })
  );

  it.live(
    "requires an explicit new preview after a stale plan or store generation",
    () =>
      Effect.gen(function* staleExport() {
        const failures: readonly AgentError["code"][] = [
          "plan-stale",
          "stale-generation",
        ];

        for (const code of failures) {
          const page = openPage(BRANCH_HASH);

          yield* previewMetadataExport(page);
          click(page, "s-export");

          const initial = yield* takeRequest(page, "/api/action");

          expect(decodeExportAction(initial.body)).toEqual({
            action: "export",
            confirm: exportPreview.confirmText,
            idempotencyKey: exportPreview.idempotencyKey,
            review: exportPreview.review,
          });
          initial.resolve(
            {
              error: "Synthetic export preview is stale.",
              failure: { code },
            },
            409
          );
          yield* settle;

          expect(page.byId("s-export").disabled).toBe(true);
          expect(page.byId("s-export-new").disabled).toBe(false);
          expect(page.byId("s-export-status").textContent).toContain(
            "The reviewed export is stale."
          );
          expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
          expect(page.sent("/api/action")).toHaveLength(1);

          click(page, "s-export");
          yield* settle;

          expect(page.sent("/api/plan?kind=export")).toHaveLength(1);
          expect(page.sent("/api/action")).toHaveLength(1);
          click(page, "s-export-new");

          const replacement = yield* takeRequest(page, "/api/plan?kind=export");

          expect(page.sent("/api/plan?kind=export")).toHaveLength(2);
          expect(nextExportPreview.review.plan.storeGeneration).not.toBe(
            exportPreview.review.plan.storeGeneration
          );
          replacement.resolve(nextExportPreview);
          yield* settle;

          expect(page.byId("s-export").disabled).toBe(false);
          expect(page.byId("s-export").textContent).toBe(
            "Save reviewed metadata"
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            nextExportPreview.basisId
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            nextExportPreview.destination
          );
          expect(page.byId("s-export-plan").textContent).toContain(
            nextExportPreview.review.plan.id
          );
          expect(page.sent("/api/action")).toHaveLength(1);

          click(page, "s-export");

          const replacementSave = yield* takeRequest(page, "/api/action");

          expect(decodeExportAction(replacementSave.body)).toEqual({
            action: "export",
            confirm: nextExportPreview.confirmText,
            idempotencyKey: nextExportPreview.idempotencyKey,
            review: nextExportPreview.review,
          });
          expect(replacementSave.body).not.toBe(initial.body);
          expect(page.sent("/api/action")).toHaveLength(2);
          expect(page.sent("/api/plan?kind=export")).toHaveLength(2);
        }
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
