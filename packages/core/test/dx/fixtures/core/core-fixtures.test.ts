// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed fixture files from disk and recomputes their sha256 event IDs.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  CONTRACT_DIGEST,
  CONTRACT_VERSION,
} from "../../../../src/dx/contracts/version.js";
import {
  AiSourceKindSchema,
  canonicalRequestKey,
  canonicalTurnKey,
} from "../../../../src/dx/model/ai.js";
import { EventBatchSchema } from "../../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../../src/dx/model/event.js";
import { SnapshotManifestSchema } from "../../../../src/dx/model/snapshot.js";

const IndexEntrySchema = Schema.Struct({
  eventCount: Schema.optional(Schema.Int),
  id: Schema.String,
  kind: Schema.String,
  path: Schema.String,
});

type IndexEntry = typeof IndexEntrySchema.Type;

const FixtureIndexSchema = Schema.Struct({
  contractDigest: Schema.String,
  contractVersion: Schema.String,
  fixtures: Schema.Array(IndexEntrySchema),
});

const VocabularySchema = Schema.Struct({
  placeholders: Schema.Struct({ syntheticSecretCanary: Schema.String }),
});

const FixtureDocSchema = Schema.Struct({
  batches: Schema.Array(EventBatchSchema),
  expectations: Schema.Unknown,
  snapshot: SnapshotManifestSchema,
});

const OverlapExpectationsSchema = Schema.Struct({
  collapsedMembers: Schema.Array(Schema.String),
  collapsedRequestKey: Schema.String,
  duplicateTurnKey: Schema.String,
  preferredSourceKind: AiSourceKindSchema,
  unassignedEventIds: Schema.Array(Schema.String),
});

const fixturesRoot = path.join(import.meta.dirname, "..");

const coreDir = import.meta.dirname;

const readText = (file: string): string => readFileSync(file, "utf-8");

const index = Schema.decodeSync(Schema.fromJsonString(FixtureIndexSchema))(
  readText(path.join(fixturesRoot, "index.json"))
);

const eventEntries = index.fixtures.filter(
  (entry) => entry.kind === "event-batches"
);

const vocabulary = Schema.decodeSync(Schema.fromJsonString(VocabularySchema))(
  readText(path.join(coreDir, "vocabulary.json"))
);

const canary = vocabulary.placeholders.syntheticSecretCanary;

const loadFixture = (entry: IndexEntry) =>
  Schema.decodeSync(Schema.fromJsonString(FixtureDocSchema))(
    readText(path.join(fixturesRoot, entry.path))
  );

const eventsOf = (entry: IndexEntry): readonly DxEventEnvelope[] =>
  loadFixture(entry).batches.flatMap((batch) => batch.events);

const expectedEventId = (event: DxEventEnvelope) => {
  const digest = createHash("sha256")
    .update(`${event.adapterId}\u0000${event.upstreamKey}\u0000${event.kind}`)
    .digest("hex");

  return `sha256:${digest}`;
};

describe("core fixture index", () => {
  it("pins the frozen contract and lists every core fixture file", () => {
    expect(index.contractDigest).toBe(CONTRACT_DIGEST);

    expect(index.contractVersion).toBe(CONTRACT_VERSION);

    const listed = index.fixtures
      .filter((entry) => entry.path.startsWith("core/"))
      .map((entry) => path.basename(entry.path))
      .toSorted();

    const onDisk = readdirSync(coreDir)
      .filter((name) => name.endsWith(".json"))
      .toSorted();

    expect(listed).toStrictEqual(onDisk);
  });
});

describe.each(eventEntries)("fixture $id", (entry) => {
  it("decodes against the v1 envelope and snapshot schemas", () => {
    const doc = loadFixture(entry);

    const events = doc.batches.flatMap((batch) => batch.events);

    expect(events).toHaveLength(entry.eventCount ?? -1);

    expect(doc.snapshot.contractDigest).toBe(CONTRACT_DIGEST);

    const mixTotal = doc.snapshot.originMix.reduce(
      (sum, item) => sum + item.count,
      0
    );

    expect(mixTotal).toBe(events.length);
  });

  it("keeps deterministic unique event IDs and fixture origin", () => {
    const events = eventsOf(entry);

    for (const event of events) {
      expect(event.eventId).toBe(expectedEventId(event));

      expect(event.origin).toBe("fixture");

      expect(event.occurredAt === null).toBe(
        event.occurredAtPrecision === "unknown"
      );
    }

    expect(new Set(events.map((event) => event.eventId)).size).toBe(
      events.length
    );
  });

  it("contains the synthetic secret canary only in the canary fixture", () => {
    const text = readFileSync(path.join(fixturesRoot, entry.path), "utf-8");

    expect(text.includes(canary)).toBe(entry.id === "core-secret-canary");
  });
});

describe("overlap fixture", () => {
  it("collapses usage-csv and hooks-stop rows onto one request key", () => {
    const entry = eventEntries.find((item) => item.id === "core-ai-overlap");

    expect(entry).toBeDefined();

    const doc = loadFixture(entry ?? { id: "", kind: "", path: "" });

    const expectations = Schema.decodeUnknownSync(OverlapExpectationsSchema)(
      doc.expectations
    );

    const events = doc.batches.flatMap((batch) => batch.events);

    const memberRequestIds = events
      .filter((event) => expectations.collapsedMembers.includes(event.eventId))
      .map((event) => event.identity.requestId);

    expect(memberRequestIds).toStrictEqual(["req-0100", "req-0100"]);

    const key = canonicalRequestKey({
      generationId: null,
      requestId: "req-0100",
      sessionId: null,
      sourceKind: expectations.preferredSourceKind,
      turnIndex: null,
    });

    expect(key).toBe(expectations.collapsedRequestKey);

    const stopTurnKeys = events
      .filter((event) => event.kind === "ai.turn")
      .map((event) =>
        canonicalTurnKey(
          event.identity.sessionId ?? "",
          event.identity.generationId ?? ""
        )
      );

    expect(stopTurnKeys).toHaveLength(2);

    expect(new Set<string>(stopTurnKeys)).toStrictEqual(
      new Set([expectations.duplicateTurnKey])
    );

    const unassigned = events.filter((event) =>
      expectations.unassignedEventIds.includes(event.eventId)
    );

    expect(unassigned).toHaveLength(1);

    const estimatedWithoutIdentity = unassigned.every(
      (event) =>
        event.identity.requestId === null &&
        event.identity.sessionId === null &&
        event.fieldSemantics.every((field) => field.method === "estimated")
    );

    expect(estimatedWithoutIdentity).toBe(true);
  });
});
