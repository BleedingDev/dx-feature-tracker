// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B33 fixture file from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { fakeManifest } from "../../src/dx/contracts/fakes.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import { alignUnique } from "../../src/dx/metrics/provenance/alignment.js";
import {
  aiLinesIntroducedDefinition,
  heuristicSimilarityDefinition,
  humanRewriteDefinition,
  provenanceMetric,
  sourceAttributedDefinition,
  strictSurvivalDefinition,
  unresolvedFilesDefinition,
} from "../../src/dx/metrics/provenance/metric.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import {
  isHonestMetric,
  MetricResultSchema,
} from "../../src/dx/model/metric.js";
import type { MetricResult } from "../../src/dx/model/metric.js";

const FixtureEventSchema = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.optional(Schema.String),
  payload: Schema.Record(Schema.String, Schema.Unknown),
});

const ScenarioSchema = Schema.Struct({
  coverage: Schema.Literals(["complete", "none"]),
  events: Schema.Array(FixtureEventSchema),
  expect: Schema.Struct({
    checkpoint: Schema.optional(Schema.String),
    denominator: Schema.optional(Schema.Int),
    humanRewritten: Schema.optional(Schema.Int),
    introduced: Schema.optional(Schema.Int),
    measurement: Schema.String,
    numerator: Schema.optional(Schema.Int),
    reasons: Schema.optional(Schema.Array(Schema.String)),
    sourceAttributed: Schema.optional(Schema.Finite),
    survival: Schema.NullOr(Schema.Finite),
    unresolvedFiles: Schema.optional(Schema.Int),
  }),
  fixtureId: Schema.String,
});

type Scenario = typeof ScenarioSchema.Type;

const FixtureFileSchema = Schema.Struct({
  origin: Schema.Literal("fixture"),
  scenarios: Schema.Array(ScenarioSchema),
});

const ADAPTER = "fixture-provenance";

const fixture = Schema.decodeUnknownSync(FixtureFileSchema)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures", "b33", "b33-scenarios.json"),
      "utf-8"
    )
  )
);

const toEnvelope = (item: Scenario["events"][number]): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: ADAPTER,
  adapterVersion: "0.0.0-fixture",
  ai: null,
  context: emptyFlightContext,
  eventId: EventIdSchema.make(`b33-${item.id}`),
  evidence: { bounded: true, hash: null, ref: `fixture:b33:${item.id}` },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind: "ai.tool-edit",
  observedAt: "2026-09-30T12:00:00.000Z",
  occurredAt: item.occurredAt ?? null,
  occurredAtPrecision: item.occurredAt === undefined ? "unknown" : "exact",
  origin: "fixture",
  payload: item.payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: item.id,
  usage: null,
});

const snapshotOf = (scenario: Scenario): StoreSnapshot => ({
  coverage:
    scenario.coverage === "complete"
      ? [
          {
            adapterId: ADAPTER,
            expectedItems: scenario.events.length,
            gaps: [],
            observedItems: scenario.events.length,
            state: "complete",
            watermark: null,
            windowFrom: null,
            windowTo: null,
          },
        ]
      : [],
  events: scenario.events.map(toEnvelope),
  manifest: fakeManifest(`snap-${scenario.fixtureId}`),
});

const scenario = (id: string): Scenario => {
  const found = fixture.scenarios.find((item) => item.fixtureId === id);

  if (found === undefined) {
    throw new Error(`missing fixture ${id}`);
  }

  return found;
};

const byId = (results: readonly MetricResult[], id: string): MetricResult => {
  const found = results.find((item) => item.metricId === id);

  if (found === undefined) {
    throw new Error(`missing metric ${id}`);
  }

  return found;
};

const run = (id: string) => {
  const current = scenario(id);

  return {
    current,
    results: provenanceMetric.compute(snapshotOf(current)).results,
  };
};

describe("B33 strict AI line survival", () => {
  it("projects observed survival and human rewrites from ordered preimages", () => {
    const { current, results } = run("b33-clean-lineage");
    const survival = byId(results, strictSurvivalDefinition.id);
    expect(survival.value).toBe(current.expect.survival);
    expect(survival.numerator).toBe(current.expect.numerator);
    expect(survival.denominator).toBe(current.expect.denominator);
    expect(survival.measurement).toBe(current.expect.measurement);
    expect(survival.method).toBe("observed");
    expect(survival.checkpoint).toBe(current.expect.checkpoint);
    expect(survival.evidenceIds.length).toBe(current.events.length);
    expect(byId(results, aiLinesIntroducedDefinition.id).value).toBe(
      current.expect.introduced
    );
    expect(byId(results, humanRewriteDefinition.id).value).toBe(
      current.expect.humanRewritten
    );
    expect(byId(results, unresolvedFilesDefinition.id).value).toBe(0);
  });

  it("keeps each unresolved lineage state explicit and excluded", () => {
    const { current, results } = run("b33-unresolved-states");
    const survival = byId(results, strictSurvivalDefinition.id);
    expect(survival.value).toBe(current.expect.survival);
    expect(survival.denominator).toBe(current.expect.denominator);
    expect(survival.measurement).toBe("partial");

    for (const reason of current.expect.reasons ?? []) {
      expect(survival.reason).toContain(reason);
    }

    expect(byId(results, unresolvedFilesDefinition.id).value).toBe(
      current.expect.unresolvedFiles
    );
  });

  it("reports unavailable with a reason when no evidence exists", () => {
    const { results } = run("b33-no-evidence");

    for (const item of results) {
      expect(item.value).toBeNull();
      expect(isHonestMetric(item)).toBe(true);
    }

    expect(byId(results, strictSurvivalDefinition.id).measurement).toBe(
      "unavailable"
    );
    expect(byId(results, heuristicSimilarityDefinition.id).measurement).toBe(
      "unsupported"
    );
  });

  it("keeps source-attributed share separate from observed survival", () => {
    const { current, results } = run("b33-source-attributed");
    const attributed = byId(results, sourceAttributedDefinition.id);
    expect(attributed.value).toBe(current.expect.sourceAttributed);
    expect(attributed.method).toBe("source-reported");
    expect(attributed.attribution).toBe("provisional");
    const survival = byId(results, strictSurvivalDefinition.id);
    expect(survival.value).toBeNull();
    expect(survival.measurement).toBe("unavailable");
  });

  it("emits schema-valid honest results for every fixture", () => {
    const decode = Schema.decodeUnknownSync(MetricResultSchema);

    for (const item of fixture.scenarios) {
      for (const metric of provenanceMetric.compute(snapshotOf(item)).results) {
        expect(() => decode(metric)).not.toThrow();
        expect(isHonestMetric(metric)).toBe(true);
      }
    }
  });

  it("flags repeated identical lines as ambiguous alignments", () => {
    expect(alignUnique(["x", "y", "x"], ["x"]).kind).toBe("ambiguous");
    expect(alignUnique(["x", "y"], ["x", "z", "y"])).toEqual({
      kind: "unique",
      pairs: [
        [0, 0],
        [1, 2],
      ],
    });
  });

  it("ships a truthful disabled descriptor covering every fixture", () => {
    const descriptor = Schema.decodeUnknownSync(ModuleDescriptorSchema)(
      provenanceMetric.descriptor
    );

    expect(descriptor.readiness).toBe("disabled");
    expect(descriptor.gaps.map((gap) => gap.code)).toContain("no-producer");
    expect([...descriptor.fixtureIds].toSorted()).toEqual(
      fixture.scenarios.map((item) => item.fixtureId).toSorted()
    );
  });
});
