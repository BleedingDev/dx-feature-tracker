// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B34 fixture file from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import {
  computeFriction,
  failedCommandsDefinition,
  FRICTION_FIXTURE_IDS,
  frictionDescriptor,
  reworkedFilesDefinition,
  testFailureRateDefinition,
  testFailuresDefinition,
  testRunsDefinition,
  toolCallFailureRateDefinition,
} from "../../src/dx/metrics/friction/metric.js";
import {
  count,
  percent,
  renderTemplate,
} from "../../src/dx/metrics/friction/templates.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
  EventKindSchema,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import {
  FindingCandidateSchema,
  isHonestMetric,
  MetricResultSchema,
} from "../../src/dx/model/metric.js";
import type { MetricResult } from "../../src/dx/model/metric.js";
import { fakeManifest } from "./fakes.js";

const FixtureEventSchema = Schema.Struct({
  adapterId: Schema.String,
  id: Schema.String,
  kind: EventKindSchema,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});

const ScenarioSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  events: Schema.Array(FixtureEventSchema),
  fixtureId: Schema.String,
});

type Scenario = typeof ScenarioSchema.Type;

const fixture = Schema.decodeUnknownSync(
  Schema.Struct({
    origin: Schema.Literal("fixture"),
    scenarios: Schema.Array(ScenarioSchema),
  })
)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures", "b34", "b34-scenarios.json"),
      "utf-8"
    )
  )
);

const scenario = (id: string): Scenario => {
  const found = fixture.scenarios.find((item) => item.fixtureId === id);

  if (found === undefined) {
    throw new Error(`missing fixture ${id}`);
  }

  return found;
};

const toEnvelope =
  (current: Scenario) =>
  (item: Scenario["events"][number]): DxEventEnvelope => ({
    acquisition: "file-import",
    adapterId: item.adapterId,
    adapterVersion: "0.0.0-fixture",
    ai: null,
    context: { ...emptyFlightContext, branch: current.branch },
    eventId: EventIdSchema.make(`${current.fixtureId}-${item.id}`),
    evidence: { bounded: true, hash: null, ref: `fixture:b34:${item.id}` },
    fieldSemantics: [],
    identity: emptyEventIdentity,
    kind: item.kind,
    observedAt: "2026-09-30T12:00:00.000Z",
    occurredAt: null,
    occurredAtPrecision: "unknown",
    origin: "fixture",
    payload: item.payload,
    schemaVersion: "dx.event.v2",
    sourceVersion: null,
    upstreamKey: item.id,
    usage: null,
  });

const snapshotOf = (current: Scenario): StoreSnapshot => {
  const events = current.events.map(toEnvelope(current));
  const adapters = [...new Set(events.map((event) => event.adapterId))];

  return {
    coverage: adapters.map((adapterId) => ({
      adapterId,
      expectedItems: null,
      gaps: [],
      observedItems: null,
      state: "complete",
      watermark: null,
      windowFrom: null,
      windowTo: null,
    })),
    events: [...events, ...events],
    manifest: fakeManifest(`snap-${current.fixtureId}`),
  };
};

const byId = (results: readonly MetricResult[], id: string): MetricResult => {
  const found = results.find((item) => item.metricId === id);

  if (found === undefined) {
    throw new Error(`missing metric ${id}`);
  }

  return found;
};

const run = (id: string) => computeFriction(snapshotOf(scenario(id)));

describe("B34 friction findings", () => {
  it("measures repeated failures once per event (duplicates collapse)", () => {
    const { results } = run("b34-repeated-failures");

    expect(byId(results, testRunsDefinition.id).value).toBe(4);
    expect(byId(results, testFailuresDefinition.id).value).toBe(3);
    const rate = byId(results, testFailureRateDefinition.id);
    expect([rate.numerator, rate.denominator, rate.value]).toStrictEqual([
      3, 4, 0.75,
    ]);
    expect(rate.measurement).toBe("measured");
    const tools = byId(results, toolCallFailureRateDefinition.id);
    expect([tools.numerator, tools.denominator, tools.value]).toStrictEqual([
      3, 5, 0.6,
    ]);
    expect(byId(results, failedCommandsDefinition.id).value).toBe(2);
    const rework = byId(results, reworkedFilesDefinition.id);
    expect([rework.value, rework.denominator]).toStrictEqual([1, 2]);
    expect(rework.evidenceIds).toHaveLength(5);
  });

  it("ranks evidenced findings by severity then weight with inspectable experiments", () => {
    const { findings } = run("b34-repeated-failures");

    expect(findings.map((item) => [item.rank, item.findingId])).toStrictEqual([
      [1, "friction.test-repeated-failure:cart > totals rounding"],
      [2, "friction.test-failure-rate"],
      [3, "friction.tool-failure-rate"],
      [4, "friction.command-repeated-failure:tsc"],
      [5, "friction.file-rework:src/cart.ts"],
    ]);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.summary).toBe(
      "cart > totals rounding failed in 3 separate test runs on feature/checkout."
    );
    expect(findings[1]?.summary).toContain(
      "3 of 4 local test runs failed (75%)"
    );
    expect(findings[2]?.summary).toContain("(60%)");
    expect(findings[2]?.experiment).toContain("most frequent: Shell");

    for (const item of findings) {
      expect(Schema.is(FindingCandidateSchema)(item)).toBe(true);
      expect(item.evidenceIds.length).toBeGreaterThan(0);
      expect(item.experiment).not.toBeNull();
      expect(`${item.summary} ${item.experiment}`).not.toMatch(
        /sav(?:e|ing)|hours|\$|minutes/iu
      );
    }
  });

  it("keeps unknown outcomes visible and emits no finding below thresholds", () => {
    const { findings, results } = run("b34-clean-branch");

    expect(findings).toStrictEqual([]);
    expect(byId(results, testRunsDefinition.id).value).toBe(3);
    const rate = byId(results, testFailureRateDefinition.id);
    expect([rate.value, rate.denominator, rate.measurement]).toStrictEqual([
      0,
      2,
      "partial",
    ]);
    expect(rate.reason).toBe("1 test runs have no known outcome");
    expect(byId(results, reworkedFilesDefinition.id).value).toBe(0);
    expect(byId(results, failedCommandsDefinition.id).measurement).toBe(
      "unavailable"
    );
  });

  it("reports unavailable with reasons instead of zero when no evidence exists", () => {
    const { findings, results } = run("b34-no-evidence");

    expect(findings).toStrictEqual([]);
    expect(results).toHaveLength(6);

    for (const result of results) {
      expect(result.value).toBeNull();
      expect(result.measurement).toBe("unavailable");
      expect(result.reason).not.toBeNull();
    }
  });

  it("marks cross-adapter test overlap as partial and provisional", () => {
    const base = scenario("b34-repeated-failures");

    const extra: Scenario = {
      ...base,
      events: [
        ...base.events,
        {
          adapterId: "dx.shell-command",
          id: "t9",
          kind: "test.result",
          payload: { outcome: "failed" },
        },
      ],
    };

    const runs = byId(
      computeFriction(snapshotOf(extra)).results,
      testRunsDefinition.id
    );

    expect([runs.value, runs.measurement, runs.attribution]).toStrictEqual([
      5,
      "partial",
      "provisional",
    ]);
  });

  it("renders templates null-safely", () => {
    expect(
      renderTemplate("{a} of {b} ({c}) {missing}", {
        a: count(2),
        b: null,
        c: percent(null),
      })
    ).toBe("2 of unavailable (unavailable) unavailable");
    expect(percent(0.3333)).toBe("33%");
    expect(count(Number.NaN)).toBeNull();
  });

  it("emits schema-valid honest results and a ready tested descriptor", () => {
    for (const id of FRICTION_FIXTURE_IDS) {
      for (const result of run(id).results) {
        expect(Schema.is(MetricResultSchema)(result)).toBe(true);
        expect(isHonestMetric(result)).toBe(true);
      }
    }

    expect(Schema.is(ModuleDescriptorSchema)(frictionDescriptor)).toBe(true);
    expect(frictionDescriptor.readiness).toBe("ready");
    expect([...frictionDescriptor.fixtureIds].toSorted()).toStrictEqual(
      fixture.scenarios.map((item) => item.fixtureId).toSorted()
    );
  });
});
