// @effect-diagnostics nodeBuiltinImport:off -- This test reads the A07 live fixture and owns a temporary ~/.dft stand-in.
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { parseCursorCliOutput } from "../../src/dx/collectors/cursor-cli/collector.js";
import { fakeManifest } from "../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import {
  computeCost,
  costByBranch,
  priceTableEstimateDefinition,
} from "../../src/dx/metrics/cost/metric.js";
import { priceMethodLabel } from "../../src/dx/metrics/cost/price-table.js";
import { cursorPriceTable202609 } from "../../src/dx/metrics/cost/price-tables/cursor-2026-09.js";
import {
  defaultCostOptions,
  defaultPriceTables,
  loadUserPriceTable,
  parseUserPriceTable,
  selectPriceTable,
} from "../../src/dx/metrics/cost/price-tables/defaults.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import type { MetricResult } from "../../src/dx/model/metric.js";

const STREAM = path.join(
  import.meta.dirname,
  "integration",
  "fixtures",
  "a07-live",
  "cursor-cli.stream.jsonl"
);

const BRANCH = "feature/a07-live-demo";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dft-p1-prices-"));

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

const liveEvents = (): readonly DxEventEnvelope[] =>
  parseCursorCliOutput(
    fs.readFileSync(STREAM, "utf-8"),
    {
      adapterId: "cursor-cli",
      context: {
        branch: BRANCH,
        flightId: null,
        headSha: null,
        repoCommonDir: null,
        worktreePath: null,
      },
      cursor: null,
      origin: "fixture",
      scratchDir: null,
      selectedInput: STREAM,
    },
    "2026-09-30T12:40:00Z"
  ).events;

const withModel = (
  events: readonly DxEventEnvelope[],
  model: string
): readonly DxEventEnvelope[] =>
  events.map((event) =>
    event.kind === "ai.usage"
      ? { ...event, payload: { ...event.payload, model } }
      : event
  );

const snapshotOf = (events: readonly DxEventEnvelope[]): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: fakeManifest("p1-prices", {
    branch: BRANCH,
    flightId: null,
    from: null,
    repoCommonDir: null,
    to: null,
  }),
});

const estimateOf = (results: readonly MetricResult[]): MetricResult => {
  const found = results.find(
    (entry) => entry.metricId === priceTableEstimateDefinition.id
  );

  if (found === undefined) {
    throw new Error("missing price-table estimate");
  }

  return found;
};

const LABEL = "method=price-table:cursor@2026-09";

describe("P1 bundled price tables", () => {
  it("ships one versioned Cursor table as the default", () => {
    expect(defaultPriceTables()).toStrictEqual([cursorPriceTable202609]);
    expect(priceMethodLabel(cursorPriceTable202609)).toBe(
      "price-table:cursor@2026-09"
    );
    expect(cursorPriceTable202609.models["claude-4.5-sonnet"]).toStrictEqual(
      cursorPriceTable202609.models["Claude 4.5 Sonnet"]
    );
    expect(
      cursorPriceTable202609.models["claude-4.5-sonnet-thinking"]
    ).toBeDefined();
    expect(cursorPriceTable202609.models["gpt-5"]?.output).toBe(10);
    expect(cursorPriceTable202609.models.Auto).toBeUndefined();
    expect(cursorPriceTable202609.models.auto).toBeUndefined();
  });

  it("labels the live Auto capture as unpriced instead of inventing a rate", () => {
    const events = liveEvents();
    expect(events.some((event) => event.kind === "ai.usage")).toBe(true);

    const estimate = estimateOf(
      computeCost(snapshotOf(events), defaultCostOptions()).results
    );

    expect(estimate.value).toBeNull();
    expect(estimate.measurement).toBe("unavailable");
    expect(estimate.method).toBe("estimated");
    expect(estimate.reason).toContain(LABEL);
    expect(estimate.reason).toContain("model-not-in-table=1");
  });

  it("estimates the live token counts for a listed model with a labelled estimate", () => {
    const events = withModel(liveEvents(), "Claude 4.5 Sonnet");

    const estimate = estimateOf(
      computeCost(snapshotOf(events), defaultCostOptions()).results
    );

    const expected = (34_384 * 3 + 66_304 * 0.3 + 710 * 15) / 1_000_000;

    expect(estimate.value).toBeCloseTo(expected, 6);
    expect(estimate.measurement).toBe("estimated");
    expect(estimate.method).toBe("estimated");
    expect(estimate.reason).toContain(LABEL);
    expect(estimate.reason).toContain("not a charge");
    expect(estimate.numerator).toBe(1);
    expect(estimate.denominator).toBe(1);

    const charge = computeCost(
      snapshotOf(events),
      defaultCostOptions()
    ).results.find((entry) => entry.metricId === "dx.cost.charge.usd");

    expect(charge?.value).toBeNull();
  });

  it("prices the other categories when the model lists no cache-write rate", () => {
    const events = withModel(liveEvents(), "gpt-5").map((event) =>
      event.kind === "ai.usage"
        ? {
            ...event,
            payload: {
              ...event.payload,
              tokens: { "cache-write": 10, input: 5, output: 1 },
            },
          }
        : event
    );

    const estimate = estimateOf(
      computeCost(snapshotOf(events), defaultCostOptions()).results
    );

    expect(estimate.value).toBe(0.000016);
    expect(estimate.reason).not.toContain("missing-rate");
  });
});

const userTable = {
  currency: "USD",
  effectiveFrom: "2026-01-01T00:00:00Z",
  id: "my-team",
  models: { Auto: { "cached-input": 0.25, input: 1.25, output: 6 } },
  source: "team contract",
  unit: "usd-per-million-tokens",
  version: "7",
};

describe("P1 user price override", () => {
  it("parses a valid override and uses it in place of the bundled table", () => {
    const load = parseUserPriceTable(
      "/x/prices.json",
      JSON.stringify(userTable)
    );

    expect(load.kind).toBe("loaded");
    expect(selectPriceTable(load)).toMatchObject({
      origin: "user",
      warning: null,
    });

    const estimate = estimateOf(
      computeCost(snapshotOf(liveEvents()), defaultCostOptions(load)).results
    );

    expect(estimate.reason).toContain("method=price-table:my-team@7");
    expect(estimate.value).toBeCloseTo(
      (34_384 * 1.25 + 66_304 * 0.25 + 710 * 6) / 1_000_000,
      6
    );
  });

  it("falls back to the bundled table with a warning for an invalid override", () => {
    const load = parseUserPriceTable(
      "/x/prices.json",
      JSON.stringify({ ...userTable, currency: "EUR" })
    );

    expect(load.kind).toBe("invalid");
    const selection = selectPriceTable(load);
    expect(selection.origin).toBe("bundled");
    expect(selection.warning).toContain("ignored");
    expect(selectPriceTable(null)).toMatchObject({
      origin: "bundled",
      warning: null,
    });
  });

  it.effect(
    "loads ~/.dft/prices.json when present and reports absence otherwise",
    () =>
      Effect.gen(function* loadOverride() {
        const home = path.join(scratch, "dft-home");
        fs.mkdirSync(home, { recursive: true });

        const absent = yield* loadUserPriceTable(home);
        expect(absent).toStrictEqual({
          kind: "absent",
          path: path.join(home, "prices.json"),
        });

        fs.writeFileSync(
          path.join(home, "prices.json"),
          JSON.stringify(userTable)
        );
        const loaded = yield* loadUserPriceTable(`${home}/`);
        expect(loaded.kind).toBe("loaded");

        fs.writeFileSync(path.join(home, "prices.json"), "{not json");
        const broken = yield* loadUserPriceTable(home);
        expect(broken.kind).toBe("invalid");
      }).pipe(Effect.provide(NodeServices.layer))
  );
});

interface UsageRowSpec {
  readonly branch: string | null;
  readonly id: string;
  readonly listPriceUsd: number | null;
  readonly model: string;
  readonly requestKey: string;
  readonly sourceKind: string;
}

const usageEvent = (spec: UsageRowSpec): DxEventEnvelope => {
  const template = liveEvents().find((event) => event.kind === "ai.usage");

  if (template === undefined) {
    throw new Error("missing live usage event");
  }

  return {
    ...template,
    context: { ...template.context, branch: spec.branch },
    eventId: EventIdSchema.make(spec.id),
    payload: {
      costLedger: spec.listPriceUsd === null ? null : "metered",
      costRawField: spec.listPriceUsd === null ? null : "tokenUsage.totalCents",
      costUsd: spec.listPriceUsd,
      currency: spec.listPriceUsd === null ? null : "USD",
      model: spec.model,
      requestKey: spec.requestKey,
      sourceKind: spec.sourceKind,
      tokens: { input: 1_000_000, output: 100_000 },
    },
  };
};

const SONNET_USD = 3 + 1.5;

describe("P1 Cursor Auto list-price estimate", () => {
  const auto = usageEvent({
    branch: BRANCH,
    id: "evt-auto",
    listPriceUsd: 0.42,
    model: "auto",
    requestKey: "req-auto",
    sourceKind: "dashboard-response",
  });

  const sonnetWithRow = usageEvent({
    branch: BRANCH,
    id: "evt-sonnet",
    listPriceUsd: 9.99,
    model: "Claude 4.5 Sonnet",
    requestKey: "req-sonnet",
    sourceKind: "dashboard-response",
  });

  const bare = usageEvent({
    branch: "other",
    id: "evt-bare",
    listPriceUsd: null,
    model: "default",
    requestKey: "req-bare",
    sourceKind: "dashboard-response",
  });

  it("uses Cursor's per-request list price for an Auto request", () => {
    const estimate = estimateOf(
      computeCost(snapshotOf([auto]), defaultCostOptions()).results
    );

    expect(estimate.value).toBeCloseTo(0.42, 6);
    expect(estimate.reason).toContain(`${LABEL}+cursor-list-price`);
    expect(estimate.measurement).toBe("estimated");
  });

  it("prices a table model from the table and never double counts its usage row", () => {
    const estimate = estimateOf(
      computeCost(snapshotOf([auto, sonnetWithRow]), defaultCostOptions())
        .results
    );

    expect(estimate.value).toBeCloseTo(SONNET_USD + 0.42, 6);
    expect(estimate.numerator).toBe(2);
    expect(estimate.denominator).toBe(2);
  });

  it("keeps the table-only label when no request needs Cursor's list price", () => {
    const estimate = estimateOf(
      computeCost(snapshotOf([sonnetWithRow]), defaultCostOptions()).results
    );

    expect(estimate.value).toBeCloseTo(SONNET_USD, 6);
    expect(estimate.reason).not.toContain("cursor-list-price");
  });

  it("sums per-request estimates per branch and leaves unmatched Auto unpriced", () => {
    const branches = costByBranch(
      snapshotOf([auto, sonnetWithRow, bare]),
      defaultCostOptions()
    );

    const valueOf = (branch: string) =>
      estimateOf(
        branches.find((entry) => entry.branch === branch)?.results ?? []
      ).value;

    expect(valueOf(BRANCH)).toBeCloseTo(SONNET_USD + 0.42, 6);
    expect(valueOf("other")).toBeNull();

    const metered = branches
      .find((entry) => entry.branch === BRANCH)
      ?.results.find((entry) => entry.metricId === "dx.cost.metered.usd");

    expect(metered?.value).toBeCloseTo(0.42 + 9.99, 6);
  });
});
