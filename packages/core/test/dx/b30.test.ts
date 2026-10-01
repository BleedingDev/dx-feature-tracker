import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { fakeManifest } from "../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import {
  accountAiUsage,
  accountAiUsageByBranch,
} from "../../src/dx/metrics/ai-usage/ledger.js";
import type { AiUsageAccount } from "../../src/dx/metrics/ai-usage/ledger.js";
import { aiUsageMetric } from "../../src/dx/metrics/ai-usage/metric.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import { DxEventEnvelopeSchema } from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  isHonestMetric,
  MetricResultSchema,
} from "../../src/dx/model/metric.js";
import type { MetricResult } from "../../src/dx/model/metric.js";

const FIXTURE_URL = new URL(
  "fixtures/b30/usage-scenarios.json",
  import.meta.url
);

const ScenariosSchema = Schema.Record(
  Schema.String,
  Schema.Array(DxEventEnvelopeSchema)
);

const loadScenarios = Effect.fn("b30.loadScenarios")(function* loadScenarios() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE_URL));

  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(ScenariosSchema)
  )(text);
});

const scenario = (id: string) =>
  loadScenarios().pipe(Effect.map((all) => all[id] ?? []));

const total = (account: AiUsageAccount, ledger: string, category: string) =>
  account.totals.find(
    (row) => row.ledger === ledger && row.category === category
  )?.value ?? null;

const snapshotOf = (events: readonly DxEventEnvelope[]): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: fakeManifest("b30-snapshot"),
});

describe("B30 ai-usage accounting", () => {
  it.effect(
    "collapses hook + local DB + Entire reports of one request by precedence",
    () =>
      Effect.gen(function* hookDbEntire() {
        const events = yield* scenario("b30/hook-db-entire-duplicate");
        const account = accountAiUsage(events);

        expect(total(account, "tokens", "input")).toBe(1700);
        expect(total(account, "tokens", "output")).toBe(400);
        expect(total(account, "tokens", "cached-input")).toBe(50);
        expect(total(account, "metered", "other")).toBeCloseTo(0.42);
        expect(account.requestCount).toBe(3);
        expect(account.duplicateRowsCollapsed).toBe(6);

        const collapsed = account.groups.filter(
          (group) => group.resolution === "collapsed"
        );

        expect(collapsed).toHaveLength(1);
        expect(collapsed[0]?.memberEvidenceIds).toEqual([
          "db-bubble-1",
          "entire-1",
          "hook-stop-1-dup",
          "hook-stop-1-dup2",
        ]);
        expect(account.uncovered.map((entry) => entry.evidenceId)).toEqual([
          "hook-stop-1",
        ]);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "keeps usage CSV aggregate as an alternative ledger and never sums it with SDK detail",
    () =>
      Effect.gen(function* sdkCsvOverlap() {
        const events = yield* scenario("b30/sdk-csv-overlap");
        const account = accountAiUsage(events);

        expect(total(account, "tokens", "input")).toBe(30);
        expect(total(account, "tokens", "output")).toBe(81);
        expect(total(account, "tokens", "cached-input")).toBe(200);
        expect(total(account, "charge", "other")).toBeCloseTo(0.1);
        expect(total(account, "list-price-estimate", "other")).toBeCloseTo(
          0.12
        );
        expect(account.alternatives.map((alt) => alt.sourceKind)).toEqual([
          "usage-csv",
        ]);
        expect(
          account.groups.filter((group) => group.resolution === "alternative")
        ).toHaveLength(1);
        expect(account.unresolved.map((row) => row.evidenceIds)).toEqual([
          ["transcript-unkeyed"],
        ]);
        expect(account.uncovered.map((entry) => entry.reason)).toEqual([
          "usage event from an unrecognized AI source kind",
        ]);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("splits usage per branch and ignores non-usage events", () =>
    Effect.gen(function* perBranch() {
      const events = yield* scenario("b30/cursor-local-db-branch");
      const byBranch = accountAiUsageByBranch(events);
      const feature = byBranch.get("feature/x");
      const main = byBranch.get("main");

      expect([...byBranch.keys()]).toEqual(["feature/x", "main"]);
      expect(feature && total(feature, "tokens", "input")).toBe(20);
      expect(feature?.usageEvents).toBe(2);
      expect(feature?.requestCount).toBe(1);
      expect(main && total(main, "tokens", "output")).toBe(5);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "emits honest metric results with unavailable reasons and labelled estimates",
    () =>
      Effect.gen(function* honestResults() {
        const events = yield* scenario("b30/sdk-csv-overlap");
        const output = aiUsageMetric.compute(snapshotOf(events));

        const byId = new Map<string, MetricResult>(
          output.results.map((row) => [row.metricId, row])
        );

        for (const row of output.results) {
          expect(isHonestMetric(row)).toBe(true);
          yield* Schema.decodeEffect(MetricResultSchema)(row);
        }

        expect(byId.get("dx.ai-usage.tokens.reasoning")?.measurement).toBe(
          "unavailable"
        );
        expect(byId.get("dx.ai-usage.money.charge")?.value).toBeCloseTo(0.1);
        expect(byId.get("dx.ai-usage.money.list-price-estimate")?.method).toBe(
          "estimated"
        );
        expect(
          byId.get("dx.ai-usage.money.list-price-estimate")?.measurement
        ).toBe("estimated");
        expect(byId.get("dx.ai-usage.tokens.input")?.measurement).toBe(
          "partial"
        );
        expect(byId.get("dx.ai-usage.alternative.tokens.total")?.value).toBe(
          5900
        );
        expect(output.findings.map((finding) => finding.findingId)).toEqual([
          "dx.ai-usage.uncovered",
        ]);
        yield* Schema.decodeEffect(ModuleDescriptorSchema)(
          aiUsageMetric.descriptor
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it("reports counts as unavailable for a snapshot without AI usage", () => {
    const output = aiUsageMetric.compute(snapshotOf([]));

    const requests = output.results.find(
      (row) => row.metricId === "dx.ai-usage.requests"
    );

    expect(requests?.value).toBeNull();
    expect(requests?.reason).toBe("snapshot contains no AI usage events");
  });
});
