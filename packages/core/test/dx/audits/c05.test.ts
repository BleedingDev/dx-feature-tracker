import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { fakeManifest } from "../../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../../src/dx/contracts/services.js";
import {
  accountAiUsage,
  accountAiUsageByBranch,
  UNASSIGNED_BRANCH,
} from "../../../src/dx/metrics/ai-usage/ledger.js";
import type { AiUsageAccount } from "../../../src/dx/metrics/ai-usage/ledger.js";
import { aiUsageMetric } from "../../../src/dx/metrics/ai-usage/metric.js";
import {
  chargeDefinition,
  computeCost,
  costDefinitions,
  costByBranch,
} from "../../../src/dx/metrics/cost/metric.js";
import { DxEventEnvelopeSchema } from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { isHonestMetric } from "../../../src/dx/model/metric.js";
import type { MetricResult } from "../../../src/dx/model/metric.js";

const FIXTURE_URL = new URL(
  "../fixtures/c05/accounting-audit.json",
  import.meta.url
);

const ScenariosSchema = Schema.Record(
  Schema.String,
  Schema.Array(DxEventEnvelopeSchema)
);

const scenario = Effect.fn("c05.scenario")(function* scenario(id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE_URL));

  const all = yield* Schema.decodeEffect(
    Schema.fromJsonString(ScenariosSchema)
  )(text);

  return all[id] ?? [];
});

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
) => effect.pipe(Effect.provide(NodeServices.layer));

const total = (account: AiUsageAccount, ledger: string, category: string) =>
  account.totals.find(
    (row) => row.ledger === ledger && row.category === category
  )?.value ?? null;

const snapshotOf = (events: readonly DxEventEnvelope[]): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: fakeManifest("c05-snapshot"),
});

const resultsById = (events: readonly DxEventEnvelope[]) =>
  new Map<string, MetricResult>(
    aiUsageMetric
      .compute(snapshotOf(events))
      .results.map((row) => [row.metricId, row])
  );

const costValue = (results: readonly MetricResult[], metricId: string) =>
  results.find((row) => row.metricId === metricId)?.value ?? null;

describe("C05 accounting audit", () => {
  it.effect("keeps cache read/write and reasoning as separate categories", () =>
    run(
      Effect.gen(function* cacheCategories() {
        const account = accountAiUsage(yield* scenario("c05/cache-categories"));

        expect(total(account, "tokens", "input")).toBe(100);
        expect(total(account, "tokens", "cached-input")).toBe(400);
        expect(total(account, "tokens", "cache-write")).toBe(50);
        expect(total(account, "tokens", "output")).toBe(20);
        expect(total(account, "tokens", "reasoning")).toBe(7);
        expect(total(account, "tokens", "total")).toBeNull();
      })
    )
  );

  it.effect("counts a keyed event imported twice exactly once", () =>
    run(
      Effect.gen(function* keyedDuplicate() {
        const account = accountAiUsage(
          yield* scenario("c05/duplicate-import-keyed")
        );

        expect(total(account, "tokens", "input")).toBe(10);
        expect(total(account, "metered", "other")).toBeCloseTo(0.02);
        expect(account.requestCount).toBe(1);
        expect(account.duplicateRowsCollapsed).toBe(3);
      })
    )
  );

  it.effect(
    "counts an unkeyed event imported twice exactly once by event identity",
    () =>
      run(
        Effect.gen(function* unkeyedDuplicate() {
          const account = accountAiUsage(
            yield* scenario("c05/duplicate-import-unkeyed")
          );

          expect(account.requestCount).toBe(1);
          expect(total(account, "tokens", "input")).toBe(9);
          expect(account.duplicateRowsCollapsed).toBe(2);
        })
      )
  );

  it.effect(
    "collapses a request reported on two branches in the global ledger",
    () =>
      run(
        Effect.gen(function* mixedGlobal() {
          const events = yield* scenario("c05/mixed-branches");
          const account = accountAiUsage(events);
          const byBranch = accountAiUsageByBranch(events);

          expect(total(account, "tokens", "input")).toBe(107);
          expect([...byBranch.keys()]).toEqual([
            UNASSIGNED_BRANCH,
            "feature/a",
          ]);
          const detached = byBranch.get(UNASSIGNED_BRANCH);

          expect(detached && total(detached, "tokens", "input")).toBe(2);
        })
      )
  );

  it.effect(
    "attributes a request seen on two branches to exactly one branch so per-branch ledgers sum to the global 107",
    () =>
      run(
        Effect.gen(function* mixedPerBranch() {
          const events = yield* scenario("c05/mixed-branches");
          const global = total(accountAiUsage(events), "tokens", "input");

          const perBranchSum = [...accountAiUsageByBranch(events).values()]
            .map((account) => total(account, "tokens", "input") ?? 0)
            .reduce((a, b) => a + b, 0);

          expect(global).toBe(107);
          expect(perBranchSum).toBe(107);
        })
      )
  );

  it.effect("reports absent tokens and costs as unavailable, never zero", () =>
    run(
      Effect.gen(function* absentValues() {
        const byId = resultsById(yield* scenario("c05/absent-values"));

        for (const id of [
          "dx.ai-usage.tokens.input",
          "dx.ai-usage.tokens.output",
          "dx.ai-usage.money.charge",
          "dx.ai-usage.money.list-price-estimate",
        ]) {
          const row = byId.get(id);
          expect(row?.measurement, id).toBe("unavailable");
          expect(row?.value, id).toBeNull();
          expect(row?.reason, id).not.toBeNull();
          expect(row && isHonestMetric(row), id).toBe(true);
        }
      })
    )
  );

  it.effect("keeps an explicit source-reported zero as zero", () =>
    run(
      Effect.gen(function* explicitZero() {
        const byId = resultsById(yield* scenario("c05/explicit-zero"));

        expect(byId.get("dx.ai-usage.money.charge")?.value).toBe(0);
        expect(byId.get("dx.ai-usage.money.charge")?.measurement).toBe(
          "measured"
        );
        expect(byId.get("dx.ai-usage.tokens.input")?.value).toBe(0);
        expect(
          byId.get("dx.ai-usage.money.list-price-estimate")?.measurement
        ).toBe("unavailable");
      })
    )
  );

  it.effect(
    "does not sum a usage CSV row carrying only a payload requestKey with SDK detail",
    () =>
      run(
        Effect.gen(function* keyedCsv() {
          const account = accountAiUsage(
            yield* scenario("c05/keyed-csv-vs-sdk")
          );

          expect(total(account, "tokens", "input")).toBe(30);
          expect(total(account, "charge", "other")).toBeCloseTo(0.1);

          expect(
            account.unresolved.flatMap((row) => row.evidenceIds)
          ).toContain("kc-csv");
        })
      )
  );

  it.effect(
    "joins dashboard request:r9 with hook/DB/Entire session:conv9:id:r9 so the request counts 500 input tokens once",
    () =>
      run(
        Effect.gen(function* crossNamespace() {
          const account = accountAiUsage(
            yield* scenario("c05/stop-db-entire-dashboard")
          );

          expect(total(account, "tokens", "input")).toBe(500);
          expect(total(account, "charge", "other")).toBeCloseTo(0.3);
          expect(account.requestCount).toBe(1);
          expect(account.groups[0]?.preferredEvidenceId).toBe("x-dashboard");
        })
      )
  );

  it.effect(
    "collapses stop hook + local DB + Entire reports sharing session+generation",
    () =>
      run(
        Effect.gen(function* stopDbEntire() {
          const events = (yield* scenario(
            "c05/stop-db-entire-dashboard"
          )).filter((event) => event.eventId !== "x-dashboard");

          const account = accountAiUsage(events);

          expect(total(account, "tokens", "input")).toBe(500);
          expect(total(account, "tokens", "output")).toBe(60);
          expect(account.requestCount).toBe(1);
          expect(account.duplicateRowsCollapsed).toBe(4);
          expect(account.groups[0]?.preferredEvidenceId).toBe("x-hook");
        })
      )
  );
  it.effect(
    "attributes a request reported on two branches to one branch so per-branch cost sums to the global ledger",
    () =>
      run(
        Effect.gen(function* crossBranchCost() {
          const events = (yield* scenario("c05/stop-db-entire-dashboard"))
            .filter((event) => ["x-db", "x-dashboard"].includes(event.eventId))
            .map((event) =>
              event.eventId === "x-db"
                ? {
                    ...event,
                    context: { ...event.context, branch: "feature/a" },
                    payload: {
                      ...event.payload,
                      charge: 0.25,
                      currency: "USD",
                    },
                  }
                : {
                    ...event,
                    context: { ...event.context, branch: "feature/b" },
                  }
            );

          const snapshot = snapshotOf(events);
          const global = computeCost(snapshot).results;
          const branches = costByBranch(snapshot);

          for (const def of costDefinitions) {
            const perBranch = branches.flatMap((entry) => {
              const value = costValue(entry.results, def.id);

              return value === null ? [] : [value];
            });

            const expected = costValue(global, def.id);

            if (expected === null) {
              expect(perBranch).toStrictEqual([]);
            } else {
              expect(
                perBranch.reduce((acc, value) => acc + value, 0)
              ).toBeCloseTo(expected);
            }
          }

          const charged = branches.filter(
            (entry) => costValue(entry.results, chargeDefinition.id) !== null
          );

          expect(costValue(global, chargeDefinition.id)).toBeCloseTo(0.3);
          expect(charged.map((entry) => entry.branch)).toStrictEqual([
            "feature/b",
          ]);
        })
      )
  );
});
