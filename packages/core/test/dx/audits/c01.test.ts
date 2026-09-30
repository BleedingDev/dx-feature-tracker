// @effect-diagnostics nodeBuiltinImport:off -- This audit reads committed fixtures and opens throwaway SQLite files in an owned temp directory.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { emptySelector } from "../../../src/dx/contracts/fakes.js";
import type {
  DxMetric,
  EventStoreService,
  StoreSnapshot,
} from "../../../src/dx/contracts/services.js";
import {
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
} from "../../../src/dx/contracts/version.js";
import { aiUsageMetric } from "../../../src/dx/metrics/ai-usage/metric.js";
import { costMetric } from "../../../src/dx/metrics/cost/metric.js";
import { frictionMetric } from "../../../src/dx/metrics/friction/metric.js";
import { gitChurnMetric } from "../../../src/dx/metrics/git/metric.js";
import { provenanceMetric } from "../../../src/dx/metrics/provenance/metric.js";
import { SourceCoverageSchema } from "../../../src/dx/model/coverage.js";
import {
  DxEventEnvelopeSchema,
  EVENT_SCHEMA_VERSION,
  EventBatchSchema,
} from "../../../src/dx/model/event.js";
import type { EventBatch } from "../../../src/dx/model/event.js";
import {
  MetricResultSchema,
  isHonestMetric,
} from "../../../src/dx/model/metric.js";
import type { MetricResult } from "../../../src/dx/model/metric.js";
import { SnapshotManifestSchema } from "../../../src/dx/model/snapshot.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";
import type { SqliteEventStoreOptions } from "../../../src/dx/storage/sqlite-event-store.js";

const FixtureDocSchema = Schema.Struct({
  batches: Schema.Array(EventBatchSchema),
  contractDigest: Schema.String,
  contractVersion: Schema.String,
  fixtureId: Schema.String,
  snapshot: SnapshotManifestSchema,
});

type FixtureDoc = typeof FixtureDocSchema.Type;

const RawFixtureSchema = Schema.Struct({
  batches: Schema.Array(
    Schema.Struct({
      coverage: Schema.JsonObject,
      events: Schema.Array(Schema.JsonObject),
    })
  ),
});

const MutationSchema = Schema.Struct({
  expect: Schema.Literals(["reject", "accept"]),
  id: Schema.String,
  op: Schema.Literals(["set", "delete"]),
  path: Schema.Array(Schema.String),
  reason: Schema.String,
  value: Schema.optional(Schema.Json),
});

type Mutation = typeof MutationSchema.Type;

const MutationDocSchema = Schema.Struct({
  baseEventIndex: Schema.Int,
  baseFixture: Schema.String,
  envelopeMutations: Schema.Array(MutationSchema),
});

const KnownFindingsSchema = Schema.Struct({
  nullWithoutCoverage: Schema.Array(Schema.String),
});

const fixturesRoot = path.join(import.meta.dirname, "..", "fixtures");

const readText = (...segments: string[]): string =>
  readFileSync(path.join(fixturesRoot, ...segments), "utf-8");

const loadCore = (name: string): FixtureDoc =>
  Schema.decodeSync(Schema.fromJsonString(FixtureDocSchema))(
    readText("core", `${name}.json`)
  );

const mutationDoc = Schema.decodeSync(Schema.fromJsonString(MutationDocSchema))(
  readText("c01", "envelope-mutations.json")
);

const knownFindings = Schema.decodeSync(
  Schema.fromJsonString(KnownFindingsSchema)
)(readText("c01", "known-findings.json"));

const rawFixture = Schema.decodeSync(Schema.fromJsonString(RawFixtureSchema))(
  readText("core", `${mutationDoc.baseFixture}.json`)
);

const [rawBatch] = rawFixture.batches;

const baseEvent = rawBatch?.events[mutationDoc.baseEventIndex];

const isJsonObject = Schema.is(Schema.JsonObject);

const withPath = (
  target: Schema.JsonObject,
  keys: readonly string[],
  mutation: Mutation
): Schema.JsonObject => {
  const [head, ...rest] = keys;

  if (head === undefined) {
    return target;
  }

  if (rest.length === 0) {
    const kept = Object.entries(target).filter(([key]) => key !== head);

    return Object.fromEntries(
      mutation.op === "delete"
        ? kept
        : [...kept, [head, mutation.value ?? null]]
    );
  }

  const child = target[head];

  if (!isJsonObject(child)) {
    throw new Error(`mutation ${mutation.id}: ${head} is not an object`);
  }

  return Object.fromEntries([
    ...Object.entries(target).filter(([key]) => key !== head),
    [head, withPath(child, rest, mutation)],
  ]);
};

const mutate = (mutation: Mutation): Schema.JsonObject => {
  if (baseEvent === undefined) {
    throw new Error("base fixture event is missing");
  }

  return withPath(baseEvent, mutation.path, mutation);
};

const decodeEnvelope = Schema.decodeUnknownExit(DxEventEnvelopeSchema);

const decodeBatch = Schema.decodeUnknownExit(EventBatchSchema);

const decodeCoverage = Schema.decodeUnknownExit(SourceCoverageSchema);

const CORE_FIXTURES = [
  "core-golden-flight",
  "core-ai-overlap",
  "core-missing-time",
  "core-branch-ambiguity",
  "core-secret-canary",
  "core-unavailable-sources",
] as const;

const snapshotOf = (doc: FixtureDoc): StoreSnapshot => ({
  coverage: doc.batches.map((b) => b.coverage),
  events: doc.batches.flatMap((b) => b.events),
  manifest: doc.snapshot,
});

const METRICS: readonly (readonly [string, DxMetric])[] = [
  ["ai-usage", aiUsageMetric],
  ["cost", costMetric],
  ["friction", frictionMetric],
  ["git-churn", gitChurnMetric],
  ["provenance", provenanceMetric],
];

const NULL_OK_STATES = new Set([
  "unavailable",
  "unsupported",
  "disabled",
  "partial",
]);

const NO_VALUE_STATES = new Set(["unavailable", "unsupported", "disabled"]);

const metricViolations = (r: MetricResult): string[] => {
  const out: string[] = [];

  if (Exit.isFailure(Schema.decodeExit(MetricResultSchema)(r))) {
    out.push("does not decode as MetricResult");
  }

  if (!isHonestMetric(r)) {
    out.push("null value without a reason");
  }

  if (r.value === null && !NULL_OK_STATES.has(r.measurement)) {
    out.push(`null value but measurement=${r.measurement}`);
  }

  if (NO_VALUE_STATES.has(r.measurement) && r.value !== null) {
    out.push(`measurement=${r.measurement} but value=${String(r.value)}`);
  }

  if (r.denominator === 0 && r.value !== null) {
    out.push("zero denominator but non-null value");
  }

  if (r.measurement === "estimated" && r.method !== "estimated") {
    out.push(`measurement=estimated but method=${r.method}`);
  }

  if (
    r.method === "estimated" &&
    r.value !== null &&
    r.measurement === "measured"
  ) {
    out.push("estimated method presented as measured");
  }

  if (r.metricId !== r.definition.id) {
    out.push(`metricId ${r.metricId} != definition.id ${r.definition.id}`);
  }

  if (r.unit !== r.definition.unit) {
    out.push(`unit ${r.unit} != definition.unit ${r.definition.unit}`);
  }

  if (r.coverage.some((c) => Exit.isFailure(decodeCoverage(c)))) {
    out.push("coverage entry does not decode");
  }

  return out;
};

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "dxfr-c01-"));

afterAll(() => {
  rmSync(tempRoot, { force: true, recursive: true });
});

const withStore = <A, E>(
  options: SqliteEventStoreOptions,
  use: (store: EventStoreService) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    openSqliteEventStore(options),
    (opened) => use(opened.service),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  );

describe("C01 contract audit: event envelopes", () => {
  it("accepts the unmodified base envelope", () => {
    expect(Exit.isSuccess(decodeEnvelope(baseEvent))).toBe(true);
  });

  for (const mutation of mutationDoc.envelopeMutations) {
    it(`${mutation.expect}s ${mutation.id}: ${mutation.reason}`, () => {
      const exit = decodeEnvelope(mutate(mutation));

      expect(Exit.isSuccess(exit)).toBe(mutation.expect === "accept");
    });
  }

  it("rejects a batch when any single envelope carries an unknown version", () => {
    const bad = mutate({
      expect: "reject",
      id: "batch-member",
      op: "set",
      path: ["schemaVersion"],
      reason: "unknown version inside batch",
      value: "dx.event.v2",
    });

    const exit = decodeBatch({
      coverage: rawBatch?.coverage,
      cursor: null,
      events: [baseEvent, bad],
    });

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects coverage with an unknown state, fractional counts or partial gaps", () => {
    const coverage = loadCore("core-unavailable-sources").batches[0]?.coverage;

    expect(Exit.isSuccess(decodeCoverage(coverage))).toBe(true);
    expect(Exit.isFailure(decodeCoverage({ ...coverage, state: "ok" }))).toBe(
      true
    );
    expect(
      Exit.isFailure(decodeCoverage({ ...coverage, observedItems: 1.5 }))
    ).toBe(true);
    expect(
      Exit.isFailure(decodeCoverage({ ...coverage, gaps: [{ code: "x" }] }))
    ).toBe(true);
  });
});

describe("C01 contract audit: versions", () => {
  it("pins the envelope schema version literal", () => {
    expect(EVENT_SCHEMA_VERSION).toBe("dx.event.v1");
  });

  it("every core fixture carries the current contract version and digest", () => {
    for (const name of CORE_FIXTURES) {
      const doc = loadCore(name);

      expect(doc.contractVersion, name).toBe(CONTRACT_VERSION);
      expect(doc.contractDigest, name).toBe(CONTRACT_DIGEST);
      expect(doc.snapshot.contractVersion, name).toBe(CONTRACT_VERSION);
      expect(doc.snapshot.contractDigest, name).toBe(CONTRACT_DIGEST);
    }
  });

  it("every metric descriptor declares the current contract version", () => {
    for (const [name, metric] of METRICS) {
      expect(metric.descriptor.contractVersion, name).toBe(CONTRACT_VERSION);
      expect(metric.definitions.length, name).toBeGreaterThan(0);
    }
  });

  it.effect(
    "the store fails closed when a persisted envelope has an unknown version",
    () =>
      Effect.gen(function* c01UnknownVersionStore() {
        const doc = loadCore(mutationDoc.baseFixture);
        const [first] = doc.batches;
        const target = first?.events[0]?.eventId ?? "";

        const options: SqliteEventStoreOptions = {
          kind: "replay",
          path: path.join(tempRoot, "unknown-version.sqlite"),
        };

        yield* withStore(options, (store) =>
          Effect.forEach((batch: EventBatch) => store.append(batch))(
            doc.batches
          )
        );

        const tamper = new DatabaseSync(options.path);

        tamper
          .prepare(
            "UPDATE events SET body = json_set(body, '$.schemaVersion', 'dx.event.v2') WHERE event_id = ?"
          )
          .run(target);
        tamper.close();

        const error = yield* withStore(options, (store) =>
          Effect.flip(store.snapshot(emptySelector))
        );

        expect(target).not.toBe("");
        expect(error._tag).toBe("StoreError");
      })
  );
});

describe("C01 contract audit: metric null and coverage rules", () => {
  for (const name of CORE_FIXTURES) {
    for (const [metricName, metric] of METRICS) {
      it(`${metricName} on ${name} emits only honest MetricResults`, () => {
        const output = metric.compute(snapshotOf(loadCore(name)));

        const violations = output.results.flatMap((r) =>
          metricViolations(r).map((v) => `${r.metricId}: ${v}`)
        );

        expect(violations).toEqual([]);
      });
    }
  }

  it("no metric reports a measured value when every source is unavailable", () => {
    const doc = loadCore("core-unavailable-sources");

    const measured = METRICS.flatMap(([, metric]) =>
      metric
        .compute(snapshotOf(doc))
        .results.filter((r) => r.value !== null && r.measurement === "measured")
        .map((r) => `${r.metricId}=${String(r.value)}`)
    );

    expect(doc.batches.every((b) => b.events.length === 0)).toBe(true);
    expect(measured).toEqual([]);
  });

  it("null metric values cite at least one source coverage entry, known gaps excepted", () => {
    const known = new Set(knownFindings.nullWithoutCoverage);

    const offenders = CORE_FIXTURES.flatMap((name) =>
      METRICS.filter(([metricName]) => !known.has(metricName)).flatMap(
        ([metricName, metric]) =>
          metric
            .compute(snapshotOf(loadCore(name)))
            .results.filter((r) => r.value === null && r.coverage.length === 0)
            .map((r) => `${metricName}/${name}/${r.metricId}`)
      )
    );

    expect(offenders).toEqual([]);
  });

  it("metrics are deterministic for the same immutable snapshot", () => {
    const snap = snapshotOf(loadCore("core-golden-flight"));

    for (const [name, metric] of METRICS) {
      expect(metric.compute(snap), name).toEqual(metric.compute(snap));
    }
  });

  it("the audit rules reject dishonest results", () => {
    const [sample] = gitChurnMetric.compute(
      snapshotOf(loadCore("core-golden-flight"))
    ).results;

    if (sample === undefined) {
      throw new Error("git churn produced no results");
    }

    const bad: MetricResult[] = [
      { ...sample, measurement: "measured", reason: null, value: null },
      { ...sample, measurement: "unavailable", reason: "x", value: 0 },
      { ...sample, denominator: 0, numerator: 0, value: 0 },
      { ...sample, measurement: "estimated", method: "source-reported" },
    ];

    for (const r of bad) {
      expect(metricViolations(r).length).toBeGreaterThan(0);
    }
  });
});
