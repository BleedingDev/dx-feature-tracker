import { Schema } from "effect";

import type { CorrelationMapping } from "../../contracts/services.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { FlightIdSchema } from "../../model/ids.js";
import type { FlightId } from "../../model/ids.js";
import { deriveFlightId, isFlightUuid } from "./flight-id.js";

export type FlightOrigin = "explicit" | "implicit";

export interface Flight {
  readonly aliases: readonly string[];
  readonly baseSha: string | null;
  readonly branchCreatedAt: string | null;
  readonly evidenceEventIds: readonly string[];
  readonly firstSeenAt: string | null;
  readonly flightId: FlightId;
  readonly label: string | null;
  readonly lastSeenAt: string | null;
  readonly origin: FlightOrigin;
  readonly repoCommonDir: string | null;
  readonly startEventId: string | null;
  readonly startedAt: string | null;
  readonly stopEventId: string | null;
  readonly stoppedAt: string | null;
}

interface MutableFlight {
  aliases: string[];
  baseSha: string | null;
  branchCreatedAt: string | null;
  evidenceEventIds: string[];
  firstSeenAt: string | null;
  flightId: FlightId;
  label: string | null;
  lastSeenAt: string | null;
  origin: FlightOrigin;
  repoCommonDir: string | null;
  startEventId: string | null;
  startedAt: string | null;
  startMs: number | null;
  stopEventId: string | null;
  stoppedAt: string | null;
  stopMs: number | null;
}

export interface FlightRegistry {
  readonly flights: readonly Flight[];
  readonly implicitByEvent: ReadonlyMap<string, FlightId>;
  readonly ignoredMarkers: readonly {
    readonly eventId: string;
    readonly reason: string;
  }[];
}

interface ImplicitFlights {
  readonly byEvent: Map<string, FlightId>;
  readonly flights: MutableFlight[];
}

const DETACHED_NAMES = new Set(["HEAD", "(detached)", ""]);

export const timeMs = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }

  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? null : ms;
};

const isNonEmptyString = Schema.is(Schema.NonEmptyString);

const payloadString = (event: DxEventEnvelope, key: string): string | null => {
  const value = event.payload[key];

  return isNonEmptyString(value) ? value : null;
};

export const isDetached = (event: DxEventEnvelope): boolean =>
  event.payload.detached === true ||
  (event.context.branch !== null && DETACHED_NAMES.has(event.context.branch));

export const branchOf = (event: DxEventEnvelope): string | null =>
  isDetached(event) ? null : event.context.branch;

export const sameRepo = (a: string | null, b: string | null): boolean =>
  a === null || b === null || a === b;

const eventTime = (event: DxEventEnvelope): string | null =>
  event.occurredAt ?? null;

const compareEvents = (a: DxEventEnvelope, b: DxEventEnvelope): number => {
  const am = timeMs(eventTime(a)) ?? Number.POSITIVE_INFINITY;
  const bm = timeMs(eventTime(b)) ?? Number.POSITIVE_INFINITY;

  if (am !== bm) {
    return am < bm ? -1 : 1;
  }

  if (a.eventId === b.eventId) {
    return 0;
  }

  return a.eventId < b.eventId ? -1 : 1;
};

const markerFlightId = (event: DxEventEnvelope): FlightId | null => {
  if (event.context.flightId !== null) {
    return event.context.flightId;
  }

  const fromPayload = payloadString(event, "flightId");

  return fromPayload !== null && isFlightUuid(fromPayload)
    ? FlightIdSchema.make(fromPayload)
    : null;
};

export const covers = (flight: Flight | MutableFlight, ms: number): boolean => {
  const startMs = timeMs(flight.startedAt);
  const stopMs = timeMs(flight.stoppedAt);

  return startMs !== null && startMs <= ms && (stopMs === null || ms <= stopMs);
};

const freeze = (flight: MutableFlight): Flight => ({
  aliases: [...flight.aliases],
  baseSha: flight.baseSha,
  branchCreatedAt: flight.branchCreatedAt,
  evidenceEventIds: [...flight.evidenceEventIds],
  firstSeenAt: flight.firstSeenAt,
  flightId: flight.flightId,
  label: flight.label,
  lastSeenAt: flight.lastSeenAt,
  origin: flight.origin,
  repoCommonDir: flight.repoCommonDir,
  startEventId: flight.startEventId,
  startedAt: flight.startedAt,
  stopEventId: flight.stopEventId,
  stoppedAt: flight.stoppedAt,
});

const addAlias = (flight: MutableFlight, alias: string | null): void => {
  if (alias !== null && !flight.aliases.includes(alias)) {
    flight.aliases.push(alias);
  }
};

const touch = (flight: MutableFlight, event: DxEventEnvelope): void => {
  const at = eventTime(event);

  if (at === null) {
    return;
  }

  const ms = timeMs(at);

  if (ms === null) {
    return;
  }

  const first = timeMs(flight.firstSeenAt);
  const last = timeMs(flight.lastSeenAt);

  if (first === null || ms < first) {
    flight.firstSeenAt = at;
  }

  if (last === null || ms > last) {
    flight.lastSeenAt = at;
  }
};

const registerStarts = (
  sorted: readonly DxEventEnvelope[],
  explicit: Map<FlightId, MutableFlight>,
  ignored: { eventId: string; reason: string }[]
): void => {
  for (const event of sorted.filter((e) => e.kind === "marker.start")) {
    const flightId =
      markerFlightId(event) ??
      deriveFlightId([
        "explicit",
        event.context.repoCommonDir ?? "",
        event.eventId,
      ]);

    if (explicit.has(flightId)) {
      ignored.push({
        eventId: event.eventId,
        reason: "duplicate start: flight start time and base are frozen",
      });
      continue;
    }

    const startedAt = eventTime(event);

    const flight: MutableFlight = {
      aliases: [],
      baseSha: payloadString(event, "baseSha") ?? event.context.headSha,
      branchCreatedAt: payloadString(event, "branchCreatedAt"),
      evidenceEventIds: [event.eventId],
      firstSeenAt: startedAt,
      flightId,
      label: payloadString(event, "label"),
      lastSeenAt: startedAt,
      origin: "explicit",
      repoCommonDir: event.context.repoCommonDir,
      startEventId: event.eventId,
      startMs: timeMs(startedAt),
      startedAt,
      stopEventId: null,
      stopMs: null,
      stoppedAt: null,
    };

    addAlias(flight, branchOf(event));
    explicit.set(flightId, flight);
  }
};

const openCandidates = (
  event: DxEventEnvelope,
  explicit: ReadonlyMap<FlightId, MutableFlight>
): MutableFlight[] => {
  const branch = branchOf(event);
  const ms = timeMs(eventTime(event));

  return [...explicit.values()].filter(
    (flight) =>
      flight.stopEventId === null &&
      branch !== null &&
      flight.aliases.includes(branch) &&
      sameRepo(flight.repoCommonDir, event.context.repoCommonDir) &&
      (ms === null || flight.startMs === null || flight.startMs <= ms)
  );
};

const registerStops = (
  sorted: readonly DxEventEnvelope[],
  explicit: Map<FlightId, MutableFlight>,
  ignored: { eventId: string; reason: string }[]
): void => {
  for (const event of sorted.filter((e) => e.kind === "marker.stop")) {
    const id = markerFlightId(event);

    const candidates =
      id === null
        ? openCandidates(event, explicit)
        : [explicit.get(id)].filter((f) => f !== undefined);

    const [target] = candidates;

    if (candidates.length !== 1 || target === undefined) {
      ignored.push({
        eventId: event.eventId,
        reason:
          candidates.length === 0
            ? "stop marker matches no open explicit flight"
            : "stop marker matches several open flights",
      });
      continue;
    }

    if (target.stopEventId !== null) {
      ignored.push({
        eventId: event.eventId,
        reason: "duplicate stop: first stop is kept",
      });
      continue;
    }

    target.stopEventId = event.eventId;
    target.stoppedAt = eventTime(event);
    target.stopMs = timeMs(target.stoppedAt);
    target.evidenceEventIds.push(event.eventId);
  }
};

const applyAliasMappings = (
  mappings: readonly CorrelationMapping[],
  explicit: Map<FlightId, MutableFlight>
): void => {
  for (const mapping of mappings) {
    if (!mapping.key.startsWith("alias:")) {
      continue;
    }

    const alias = mapping.key.slice("alias:".length);
    const flight = explicit.get(FlightIdSchema.make(mapping.value));

    if (flight !== undefined && !DETACHED_NAMES.has(alias)) {
      addAlias(flight, alias);
    }
  }
};

const coveredByExplicit = (
  event: DxEventEnvelope,
  branch: string,
  explicit: ReadonlyMap<FlightId, MutableFlight>
): boolean => {
  const ms = timeMs(eventTime(event));

  return (
    ms !== null &&
    [...explicit.values()].some(
      (flight) =>
        flight.aliases.includes(branch) &&
        sameRepo(flight.repoCommonDir, event.context.repoCommonDir) &&
        covers(flight, ms)
    )
  );
};

const buildImplicit = (
  sorted: readonly DxEventEnvelope[],
  explicit: ReadonlyMap<FlightId, MutableFlight>
): ImplicitFlights => {
  const open = new Map<string, MutableFlight>();
  const flights: MutableFlight[] = [];
  const byEvent = new Map<string, FlightId>();

  for (const event of sorted) {
    if (event.kind.startsWith("marker.") || event.context.flightId !== null) {
      continue;
    }

    const branch = branchOf(event);
    const repo = event.context.repoCommonDir;

    if (branch === null || repo === null || timeMs(eventTime(event)) === null) {
      continue;
    }

    const key = `${repo}\u0000${branch}`;

    if (coveredByExplicit(event, branch, explicit)) {
      open.delete(key);
      continue;
    }

    const createdAt = payloadString(event, "branchCreatedAt");
    let current = open.get(key);

    if (
      current !== undefined &&
      createdAt !== null &&
      current.branchCreatedAt !== null &&
      createdAt !== current.branchCreatedAt
    ) {
      current = undefined;
    }

    if (current === undefined) {
      current = {
        aliases: [branch],
        baseSha: payloadString(event, "baseSha"),
        branchCreatedAt: createdAt,
        evidenceEventIds: [],
        firstSeenAt: null,
        flightId: deriveFlightId(["implicit", repo, branch, event.eventId]),
        label: null,
        lastSeenAt: null,
        origin: "implicit",
        repoCommonDir: repo,
        startEventId: null,
        startMs: null,
        startedAt: null,
        stopEventId: null,
        stopMs: null,
        stoppedAt: null,
      };
      open.set(key, current);
      flights.push(current);
    }

    current.branchCreatedAt ??= createdAt;
    current.baseSha ??= payloadString(event, "baseSha");
    current.evidenceEventIds.push(event.eventId);
    touch(current, event);
    byEvent.set(event.eventId, current.flightId);
  }

  return { byEvent, flights };
};

export const buildFlightRegistry = (
  events: readonly DxEventEnvelope[],
  mappings: readonly CorrelationMapping[] = []
): FlightRegistry => {
  const sorted = [...events].toSorted(compareEvents);
  const explicit = new Map<FlightId, MutableFlight>();
  const ignored: { eventId: string; reason: string }[] = [];
  registerStarts(sorted, explicit, ignored);
  applyAliasMappings(mappings, explicit);
  registerStops(sorted, explicit, ignored);

  for (const event of sorted) {
    const ms = timeMs(eventTime(event));
    const branch = branchOf(event);

    if (ms === null || branch === null) {
      continue;
    }

    for (const flight of explicit.values()) {
      if (
        flight.aliases.includes(branch) &&
        sameRepo(flight.repoCommonDir, event.context.repoCommonDir) &&
        covers(flight, ms)
      ) {
        touch(flight, event);
      }
    }
  }

  const implicit = buildImplicit(sorted, explicit);

  return {
    flights: [...explicit.values(), ...implicit.flights].map(freeze),
    ignoredMarkers: ignored,
    implicitByEvent: implicit.byEvent,
  };
};
