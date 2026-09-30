import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import type { Correlation } from "../../src/dx/contracts/services.js";
import {
  correlateFlights,
  flightCorrelationDescriptor,
  flightCorrelator,
} from "../../src/dx/correlation/flight/correlator.js";
import {
  deriveFlightId,
  isFlightUuid,
} from "../../src/dx/correlation/flight/flight-id.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  DxEventEnvelopeSchema,
  EVENT_SCHEMA_VERSION,
  EventKindSchema,
  emptyEventIdentity,
} from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { EventIdSchema, FlightIdSchema } from "../../src/dx/model/ids.js";

const FixturePayloadSchema = Schema.Struct({
  baseSha: Schema.optional(Schema.String),
  branchCreatedAt: Schema.optional(Schema.String),
  detached: Schema.optional(Schema.Boolean),
  flightId: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
});

const FixtureEventSchema = Schema.Struct({
  at: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  flightId: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  id: Schema.String,
  kind: EventKindSchema,
  payload: Schema.optional(FixturePayloadSchema),
  repo: Schema.NullOr(Schema.String),
});

type FixtureEvent = typeof FixtureEventSchema.Type;

const FixtureSchema = Schema.Struct({
  events: Schema.Array(FixtureEventSchema),
  fixtureId: Schema.String,
});

const eventIdOf = (id: string) => `b24:${id}`;

const startFlightId = (repo: string, id: string) =>
  deriveFlightId(["explicit", repo, eventIdOf(id)]);

const expandPayload = (item: FixtureEvent) => {
  const payload = { ...item.payload };
  const ref = payload.flightId;

  return ref?.startsWith("FLIGHT_OF_") === true
    ? {
        ...payload,
        flightId: startFlightId(
          item.repo ?? "",
          ref.slice("FLIGHT_OF_".length)
        ),
      }
    : payload;
};

const toEnvelope = (item: FixtureEvent): DxEventEnvelope => ({
  acquisition: item.kind.startsWith("marker.") ? "manual" : "derived",
  adapterId: "b24-fixture",
  adapterVersion: "1",
  context: {
    branch: item.branch,
    flightId:
      item.flightId === undefined ? null : FlightIdSchema.make(item.flightId),
    headSha: item.head ?? null,
    repoCommonDir: item.repo,
    worktreePath: null,
  },
  eventId: EventIdSchema.make(eventIdOf(item.id)),
  evidence: { bounded: true, hash: null, ref: `fixture:${item.id}` },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind: item.kind,
  observedAt: "2026-09-30T12:00:00Z",
  occurredAt: item.at,
  occurredAtPrecision: item.at === null ? "unknown" : "second",
  origin: "synthetic",
  payload: expandPayload(item),
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: null,
  upstreamKey: item.id,
});

const loadFixture = (name: string) =>
  Effect.gen(function* load() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const text = yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures", "b24", name)
    );

    const fixture = yield* Schema.decodeEffect(
      Schema.fromJsonString(FixtureSchema)
    )(text);

    const events = fixture.events.map(toEnvelope);

    for (const event of events) {
      yield* Schema.decodeEffect(DxEventEnvelopeSchema)(event);
    }

    return { events, fixtureId: fixture.fixtureId };
  });

const byEvent = (correlations: readonly Correlation[], id: string) => {
  const found = correlations.find((c) => c.eventId === eventIdOf(id));

  if (found === undefined) {
    throw new Error(`missing correlation for ${id}`);
  }

  return found;
};

it("B24 flight IDs are deterministic UUIDs and descriptor decodes", () => {
  const a = deriveFlightId(["explicit", "/r/.git", "e1"]);
  expect(isFlightUuid(a)).toBe(true);
  expect(deriveFlightId(["explicit", "/r/.git", "e1"])).toBe(a);
  expect(deriveFlightId(["explicit", "/r/.git", "e2"])).not.toBe(a);

  const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
    flightCorrelationDescriptor
  );

  expect(descriptor.readiness).toBe("ready");
  expect(descriptor.kind).toBe("correlation");
});

it.layer(NodeServices.layer)("B24 flight correlation", (test) => {
  test.effect(
    "explicit start freezes base/time, branch reuse gets a new flight, history is not inherited",
    () =>
      Effect.gen(function* explicitStart() {
        const { events, fixtureId } = yield* loadFixture(
          "explicit-start-reuse.json"
        );

        expect(fixtureId).toBe("b24/explicit-start-reuse");
        const repo = "/r/app/.git";
        const flight1 = startFlightId(repo, "start-1");
        const flight2 = startFlightId(repo, "start-2");

        const { correlations, registry } = correlateFlights(events, [
          { key: "alias:feature/login-v2", value: flight2 },
        ]);

        const first = registry.flights.find((f) => f.flightId === flight1);
        expect(first?.origin).toBe("explicit");
        expect(first?.startedAt).toBe("2026-09-01T10:00:00Z");
        expect(first?.baseSha).toBe("aaa111");
        expect(first?.label).toBe("login v1");
        expect(first?.stoppedAt).toBe("2026-09-01T12:00:00Z");

        const second = registry.flights.find((f) => f.flightId === flight2);
        expect(second?.aliases).toEqual(["feature/login", "feature/login-v2"]);
        expect(second?.stoppedAt).toBeNull();

        const dup = byEvent(correlations, "start-1-dup");
        expect(dup.attribution).toBe("unassigned");
        expect(dup.reason).toMatch(/frozen/u);

        expect(byEvent(correlations, "use-1")).toMatchObject({
          attribution: "strong",
          target: flight1,
          targetKind: "flight",
        });
        expect(byEvent(correlations, "use-2").target).toBe(flight2);
        expect(byEvent(correlations, "renamed-1")).toMatchObject({
          attribution: "strong",
          target: flight2,
        });

        const pre = byEvent(correlations, "pre-1");
        const gap = byEvent(correlations, "gap-1");
        expect(pre.attribution).toBe("provisional");
        expect(gap.attribution).toBe("provisional");
        expect(pre.target).not.toBe(flight1);
        expect(gap.target).not.toBe(pre.target);
        expect([flight1, flight2]).not.toContain(gap.target);

        const untimed = byEvent(correlations, "untimed-1");
        expect(untimed.attribution).toBe("unassigned");
        expect(untimed.target).toBeNull();

        expect(byEvent(correlations, "stop-1")).toMatchObject({
          attribution: "strong",
          target: flight1,
        });
        expect(flightCorrelator.correlate(events, [])).toHaveLength(
          events.length
        );
      })
  );

  test.effect(
    "detached, multi-root ambiguity and unknown pinned IDs stay unassigned or provisional",
    () =>
      Effect.gen(function* detached() {
        const { events } = yield* loadFixture("detached-and-ambiguous.json");
        const { correlations, registry } = correlateFlights(events);
        const flightA = startFlightId("/r/one/.git", "start-a");

        expect(byEvent(correlations, "no-repo")).toMatchObject({
          attribution: "unassigned",
          target: null,
        });
        expect(byEvent(correlations, "repo-one")).toMatchObject({
          attribution: "strong",
          target: flightA,
        });

        for (const id of ["detached", "detached-null"]) {
          const item = byEvent(correlations, id);
          expect(item.attribution).toBe("unassigned");
          expect(item.target).toBeNull();
        }

        const stop = byEvent(correlations, "stop-ambiguous");
        expect(stop.attribution).toBe("unassigned");
        expect(stop.reason).toMatch(/several/u);
        expect(
          registry.flights.every((flight) => flight.stoppedAt === null)
        ).toBe(true);
        expect(byEvent(correlations, "pinned-unknown")).toMatchObject({
          attribution: "provisional",
          target: null,
        });
      })
  );

  test.effect(
    "recreated branch with a new creation time splits implicit flights",
    () =>
      Effect.gen(function* recreated() {
        const { events } = yield* loadFixture("implicit-branch-recreated.json");
        const { correlations, registry } = correlateFlights(events);
        expect(registry.flights).toHaveLength(2);
        const [older, newer] = registry.flights;
        expect(older?.origin).toBe("implicit");
        expect(older?.baseSha).toBe("base111");
        expect(older?.firstSeenAt).toBe("2026-09-10T09:00:00Z");
        expect(older?.lastSeenAt).toBe("2026-09-10T10:00:00Z");
        expect(newer?.baseSha).toBe("base222");
        expect(byEvent(correlations, "use-1").target).toBe(older?.flightId);
        expect(byEvent(correlations, "use-2")).toMatchObject({
          attribution: "provisional",
          target: newer?.flightId,
        });
        const again = correlateFlights([...events].toReversed());
        expect(again.registry.flights.map((f) => f.flightId)).toEqual(
          registry.flights.map((f) => f.flightId)
        );
      })
  );
});
