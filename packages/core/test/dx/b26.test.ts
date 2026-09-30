// @effect-diagnostics nodeBuiltinImport:off -- This test reads committed B26 and core fixture files from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import type { CorrelationMapping } from "../../src/dx/contracts/services.js";
import {
  aiCorrelator,
  correlateAi,
} from "../../src/dx/correlation/ai/correlator.js";
import type { AiCorrelationResult } from "../../src/dx/correlation/ai/correlator.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import { DxEventEnvelopeSchema } from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";

const fixturesDir = path.join(import.meta.dirname, "fixtures");

const decodeEvents = Schema.decodeUnknownSync(
  Schema.Array(DxEventEnvelopeSchema)
);

const CoreFixtureSchema = Schema.Struct({
  batches: Schema.Array(Schema.Struct({ events: Schema.Unknown })),
  expectations: Schema.Unknown,
});

const OverlapExpectationsSchema = Schema.Struct({
  alternativeLedgerEventIds: Schema.Array(Schema.String),
  collapsedMembers: Schema.Array(Schema.String),
  collapsedRequestKey: Schema.String,
  duplicateTurnKey: Schema.String,
  unassignedEventIds: Schema.Array(Schema.String),
});

const B26FixtureSchema = Schema.Struct({
  eventNames: Schema.Record(Schema.String, Schema.String),
  events: Schema.Unknown,
  mappings: Schema.Array(
    Schema.Struct({ key: Schema.String, value: Schema.String })
  ),
});

const readText = (relative: string): string =>
  readFileSync(path.join(fixturesDir, relative), "utf-8");

const coreFixture = (name: string) => {
  const fixture = Schema.decodeSync(Schema.fromJsonString(CoreFixtureSchema))(
    readText(`core/${name}.json`)
  );

  return {
    events: fixture.batches.flatMap((batch) => decodeEvents(batch.events)),
    expectations: fixture.expectations,
  };
};

const b26Fixture = () => {
  const fixture = Schema.decodeSync(Schema.fromJsonString(B26FixtureSchema))(
    readText("b26/conversation-branch-join.json")
  );

  const mappings: CorrelationMapping[] = [...fixture.mappings];

  return {
    events: decodeEvents(fixture.events),
    mappings,
    names: fixture.eventNames,
  };
};

const rowFor = (result: AiCorrelationResult, eventId: string | undefined) =>
  result.claims.find((row) => row.eventId === eventId);

describe("B26 AI correlation over core-ai-overlap", () => {
  const { events, expectations } = coreFixture("core-ai-overlap");

  const expected = Schema.decodeUnknownSync(OverlapExpectationsSchema)(
    expectations
  );

  const result = correlateAi(events);

  it("collapses cross-source claims sharing a request id and prefers usage-csv", () => {
    const group = result.overlapGroups.find(
      (candidate) => candidate.requestKey === expected.collapsedRequestKey
    );

    expect(group?.resolution).toBe("collapsed");
    expect(group?.memberEvidenceIds.toSorted()).toStrictEqual(
      expected.collapsedMembers.toSorted()
    );
    expect(group?.preferredEvidenceId).toBe(expected.collapsedMembers[0]);
  });

  it("collapses duplicate stop emissions of one turn into a single unit", () => {
    const turnRows = result.claims.filter(
      (row) => row.turnKey === expected.duplicateTurnKey
    );

    const groupIds = new Set(turnRows.map((row) => row.groupId));

    expect(turnRows).toHaveLength(2);
    expect(groupIds.size).toBe(1);
    expect(turnRows.map((row) => row.role).toSorted()).toStrictEqual([
      "duplicate",
      "preferred",
    ]);
  });

  it("keeps the dashboard aggregate as an alternative ledger outside every total", () => {
    const alternativeIds = result.alternatives.map((entry) => entry.eventId);

    expect(alternativeIds).toStrictEqual(expected.alternativeLedgerEventIds);
    expect(
      result.overlapGroups.some(
        (group) =>
          group.resolution === "alternative" &&
          group.memberEvidenceIds[0] === expected.alternativeLedgerEventIds[0]
      )
    ).toBe(true);
    expect(result.fractions.amounts["tokens:total"]).toBeUndefined();
  });

  it("leaves the estimate without a request key unassigned and never sums overlap", () => {
    const estimate = rowFor(result, expected.unassignedEventIds[0]);

    expect(estimate?.requestAttribution).toBe("unassigned");
    expect(estimate?.requestKey).toBeNull();
    expect(result.fractions.amounts["tokens:input"]?.total).toBe(1000);
    expect(result.fractions.amounts["tokens:output"]?.total).toBe(200);
    expect(result.fractions.amounts["estimated:tokens:output"]?.total).toBe(
      180
    );
    expect(result.fractions.units.total).toBe(3);
  });
});

describe("B26 branch ambiguity", () => {
  it("never gives a branch-only AI turn strong attribution", () => {
    const { events } = coreFixture("core-branch-ambiguity");

    const turn = correlateAi(events).claims.find(
      (row) => row.sourceKind === "hooks-stop"
    );

    expect(turn?.attribution).toBe("provisional");
    expect(turn?.branch).toBe("feature/fixture-flight");
  });
});

describe("B26 conversation and branch joins", () => {
  const { events, mappings, names } = b26Fixture();
  const result = correlateAi(events, mappings);
  const row = (name: string) => rowFor(result, names[name]);

  it("joins a branchless turn to its conversation's single branch provisionally", () => {
    expect(row("s1-turn-no-branch")).toMatchObject({
      attribution: "provisional",
      branch: "feature/a",
    });
    expect(row("s1-turn-no-branch")?.branchEvidenceIds).toContain(
      names["s1-request-branch"]
    );
  });

  it("honours an explicit session mapping as strong", () => {
    expect(row("s2-cli-mapped")).toMatchObject({
      attribution: "strong",
      branch: "feature/b",
    });
  });

  it("places an id-less usage row by a single branch activity window only provisionally", () => {
    expect(row("csv-in-window")).toMatchObject({
      attribution: "provisional",
      branch: "feature/a",
      bucket: "provisional",
    });
    expect(row("csv-out-of-window")).toMatchObject({
      attribution: "unassigned",
      branch: null,
      bucket: "unallocated",
    });
  });

  it("refuses to pick a branch for a conversation that spans two branches", () => {
    expect(row("s3-usage-no-branch")).toMatchObject({
      attribution: "unassigned",
      branch: null,
    });
  });

  it("reports allocated and unallocated fractions per measure and per branch", () => {
    const { units, amounts } = result.fractions;

    expect(units).toMatchObject({
      provisional: 2,
      strong: 4,
      total: 8,
      unallocated: 2,
      unresolved: 0,
    });
    expect(units.allocatedFraction).toBeCloseTo(6 / 8);
    expect(amounts["charge:USD"]?.provisional).toBeCloseTo(0.12);
    expect(amounts["charge:USD"]?.unallocated).toBeCloseTo(0.05);
    expect(amounts["charge:USD"]?.allocatedFraction).toBeCloseTo(0.12 / 0.17);
    expect(amounts["metered:USD"]).toMatchObject({
      total: 0.4,
      unallocated: 0.4,
    });

    const featureA = result.branches.find(
      (entry) => entry.branch === "feature/a"
    );

    const featureB = result.branches.find(
      (entry) => entry.branch === "feature/b"
    );

    expect(featureA?.amounts["tokens:input"]).toStrictEqual({
      provisional: 1300,
      strong: 0,
    });
    expect(featureB?.amounts["tokens:cached-input"]).toStrictEqual({
      provisional: 0,
      strong: 100,
    });
  });

  it("reports an unavailable fraction with a reason when there are no claims", () => {
    const empty = correlateAi([]);

    expect(empty.fractions.units.allocatedFraction).toBeNull();
    expect(empty.fractions.units.reason).not.toBeNull();
  });
});

describe("B26 correlator contract", () => {
  it("exposes a ready correlation descriptor and one branch correlation per claim", () => {
    const { events, mappings } = b26Fixture();

    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      aiCorrelator.descriptor
    );

    const correlations = aiCorrelator.correlate(events, mappings);

    const aiEvents: DxEventEnvelope[] = events.filter((event) =>
      event.kind.startsWith("ai.")
    );

    expect(descriptor.readiness).toBe("ready");
    expect(descriptor.kind).toBe("correlation");
    expect(correlations).toHaveLength(aiEvents.length);
    expect(correlations.every((entry) => entry.targetKind === "branch")).toBe(
      true
    );
  });
});
