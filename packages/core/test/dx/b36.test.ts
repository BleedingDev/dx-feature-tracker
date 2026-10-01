// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B36 fixture file from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import { ValueMethodSchema } from "../../src/dx/model/common.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
  EventKindSchema,
} from "../../src/dx/model/event.js";
import { EventIdSchema, SnapshotIdSchema } from "../../src/dx/model/ids.js";
import { ExplainTimelineSchema } from "../../src/dx/model/report.js";
import type { ExplainTimeline } from "../../src/dx/model/report.js";
import {
  explainReportDescriptor,
  explainTimeline,
} from "../../src/dx/reports/explain/explain.js";
import {
  buildTimeline,
  encodeCursor,
} from "../../src/dx/reports/explain/timeline.js";
import { fakeManifest, makeFakeEventStore } from "./fakes.js";

const FixtureEventSchema = Schema.Struct({
  adapterId: Schema.String,
  id: Schema.String,
  kind: EventKindSchema,
  occurredAt: Schema.NullOr(Schema.String),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  precision: Schema.Literals(["exact", "second", "minute", "day", "unknown"]),
  semantics: Schema.optional(
    Schema.Array(
      Schema.Struct({ field: Schema.String, method: ValueMethodSchema })
    )
  ),
});

const FixtureSchema = Schema.Struct({
  events: Schema.Array(FixtureEventSchema),
  expect: Schema.Struct({
    forbiddenInSummaries: Schema.Array(Schema.String),
    lanes: Schema.Array(Schema.String),
    order: Schema.Array(Schema.String),
    uncertain: Schema.Array(Schema.String),
  }),
  fixtureId: Schema.String,
  note: Schema.String,
  origin: Schema.Literal("fixture"),
});

const fixture = Schema.decodeUnknownSync(FixtureSchema)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures", "b36", "timeline.json"),
      "utf-8"
    )
  )
);

const toEnvelope = (
  item: (typeof fixture.events)[number]
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: item.adapterId,
  adapterVersion: "0.0.0-fixture",
  ai: null,
  context: emptyFlightContext,
  eventId: EventIdSchema.make(item.id),
  evidence: { bounded: true, hash: null, ref: `fixture:b36:${item.id}` },
  fieldSemantics: (item.semantics ?? []).map((semantic) => ({
    field: semantic.field,
    method: semantic.method,
    note: null,
    rawName: null,
    unit: null,
  })),
  identity: emptyEventIdentity,
  kind: item.kind,
  observedAt: "2026-09-30T12:00:00.000Z",
  occurredAt: item.occurredAt,
  occurredAtPrecision: item.precision,
  origin: "fixture",
  payload: item.payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: item.id,
  usage: null,
});

const events = fixture.events.map(toEnvelope);

const snapshotWith = (
  list: readonly DxEventEnvelope[],
  id = "snap-b36"
): StoreSnapshot => ({
  coverage: [],
  events: list,
  manifest: fakeManifest(id),
});

const build = (
  snapshot: StoreSnapshot,
  cursor: string | null,
  limit: number | null
): ExplainTimeline => {
  const result = buildTimeline(snapshot, { cursor, limit });

  if (Result.isFailure(result)) {
    throw new Error(result.failure.message);
  }

  return result.success;
};

const allPages = (snapshot: StoreSnapshot, limit: number) => {
  const pages: ExplainTimeline[] = [];
  let cursor: string | null = null;

  do {
    const page = build(snapshot, cursor, limit);

    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return pages;
};

describe("B36 explain timeline", () => {
  it("orders events stably across source lanes and flags uncertain ordering", () => {
    const timeline = build(snapshotWith(events), null, null);

    expect(Schema.is(ExplainTimelineSchema)(timeline)).toBe(true);
    expect(timeline.entries.map((entry) => entry.eventId)).toEqual(
      fixture.expect.order
    );
    expect(
      timeline.entries
        .filter((entry) => entry.orderingUncertain)
        .map((entry) => entry.eventId)
        .toSorted()
    ).toEqual([...fixture.expect.uncertain].toSorted());
    expect(timeline.lanes).toEqual(fixture.expect.lanes);
    expect(timeline.total).toBe(events.length);
    expect(timeline.nextCursor).toBeNull();
    expect(timeline.entries.every((entry) => entry.origin === "fixture")).toBe(
      true
    );
  });

  it("is independent of store iteration order", () => {
    const forward = build(snapshotWith(events), null, null);
    const reversed = build(snapshotWith(events.toReversed()), null, null);

    expect(reversed).toEqual(forward);
  });

  it("paginates without changing order or uncertainty flags", () => {
    const snapshot = snapshotWith(events);
    const full = build(snapshot, null, null);
    const pages = allPages(snapshot, 3);

    expect(pages.map((page) => page.entries.length)).toEqual([3, 3, 1]);
    expect(pages.flatMap((page) => page.entries)).toEqual(full.entries);
    expect(pages.every((page) => page.snapshotId === "snap-b36")).toBe(true);
  });

  it("rejects foreign, malformed cursors and out-of-range limits", () => {
    const snapshot = snapshotWith(events);

    const foreign = buildTimeline(snapshot, {
      cursor: encodeCursor("snap-other", 3),
      limit: null,
    });

    const malformed = buildTimeline(snapshot, { cursor: "nope", limit: null });

    const zero = buildTimeline(snapshot, { cursor: null, limit: 0 });
    const huge = buildTimeline(snapshot, { cursor: null, limit: 10_000 });

    for (const result of [foreign, malformed, zero, huge]) {
      expect(Result.isFailure(result)).toBe(true);
    }

    expect(Result.isFailure(foreign) && foreign.failure.field).toBe("cursor");

    expect(Result.isFailure(zero) && zero.failure.field).toBe("limit");
  });

  it("never echoes free-text payload and discloses value methods", () => {
    const timeline = build(snapshotWith(events), null, null);
    const text = timeline.entries.map((entry) => entry.summary).join("\n");

    for (const secret of fixture.expect.forbiddenInSummaries) {
      expect(text).not.toContain(secret);
    }

    const cost = timeline.entries.find(
      (entry) => entry.eventId === "evt-cost-estimate"
    );

    expect(cost?.summary).toContain("costUsd:estimated");

    const untimed = timeline.entries.find(
      (entry) => entry.eventId === "evt-cursor-session-untimed"
    );

    expect(untimed?.summary).toContain("time unavailable");
    expect(untimed?.evidenceIds).toEqual(["evt-cursor-session-untimed"]);
  });

  it("returns an empty timeline for an empty snapshot", () => {
    const timeline = build(snapshotWith([]), null, null);

    expect(timeline.entries).toEqual([]);
    expect(timeline.lanes).toEqual([]);
    expect(timeline.total).toBe(0);
    expect(timeline.nextCursor).toBeNull();
  });

  it("publishes a valid ready descriptor", () => {
    expect(Schema.is(ModuleDescriptorSchema)(explainReportDescriptor)).toBe(
      true
    );
    expect(explainReportDescriptor.readiness).toBe("ready");
  });
});

describe("B36 explain snapshot selection", () => {
  const request = {
    asOf: null,
    cursor: null,
    limit: null,
    selector: {
      branch: null,
      flightId: null,
      from: null,
      repoCommonDir: null,
      to: null,
    },
  };

  it.effect(
    "fails visibly for an unknown snapshotId instead of using latest",
    () =>
      Effect.gen(function* unknownSnapshot() {
        const store = makeFakeEventStore();

        const failure = yield* Effect.flip(
          explainTimeline(store, {
            ...request,
            snapshotId: SnapshotIdSchema.make("snap-expired"),
          })
        );

        expect(failure._tag).toBe("SnapshotNotFound");
      })
  );

  it.effect("reuses a pinned snapshotId and binds the cursor to it", () =>
    Effect.gen(function* pinnedSnapshot() {
      const store = makeFakeEventStore();
      yield* store.append({
        coverage: {
          adapterId: "fixture",

          expectedItems: null,
          gaps: [],
          observedItems: events.length,

          state: "complete",
          watermark: null,
          windowFrom: null,
          windowTo: null,
        },
        cursor: null,
        events,
      });
      yield* store.putSnapshotManifest(fakeManifest("snap-pinned"));

      const first = yield* explainTimeline(store, {
        ...request,

        limit: 4,

        snapshotId: SnapshotIdSchema.make("snap-pinned"),
      });

      expect(first.mode).toBe("pinned");
      expect(first.timeline.snapshotId).toBe("snap-pinned");

      expect(first.timeline.nextCursor).not.toBeNull();

      const second = yield* explainTimeline(store, {
        ...request,
        cursor: first.timeline.nextCursor,
        limit: 4,
        snapshotId: SnapshotIdSchema.make("snap-pinned"),
      });

      expect(second.timeline.entries.map((entry) => entry.eventId)).toEqual(
        fixture.expect.order.slice(4)
      );
      expect(second.disclosures.join(" ")).toContain("no source timestamp");

      const mismatch = yield* Effect.flip(
        explainTimeline(store, {
          ...request,
          cursor: first.timeline.nextCursor,
          snapshotId: null,
        })
      );

      expect(mismatch._tag).toBe("InvalidInput");
    })
  );

  it.effect("reports the actual snapshotId when latest is chosen", () =>
    Effect.gen(function* latestSnapshot() {
      const store = makeFakeEventStore();

      const result = yield* explainTimeline(store, {
        ...request,
        snapshotId: null,
      });

      expect(result.mode).toBe("latest");
      expect(result.timeline.snapshotId).toBe("fake-current");
      expect(result.disclosures.join(" ")).toContain("fake-current");
    })
  );
});
