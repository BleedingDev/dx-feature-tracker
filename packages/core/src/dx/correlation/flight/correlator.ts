import type {
  Correlation,
  CorrelationMapping,
  DxCorrelator,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { AttributionState } from "../../model/common.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { DescriptorIdSchema, EvidenceIdSchema } from "../../model/ids.js";
import {
  branchOf,
  buildFlightRegistry,
  covers,
  isDetached,
  sameRepo,
  timeMs,
} from "./registry.js";
import type { Flight, FlightRegistry } from "./registry.js";

export const FLIGHT_CORRELATOR_VERSION = "1.0.0";

export const FLIGHT_TARGET_KIND = "flight";

export const flightCorrelationDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b24/explicit-start-reuse",
    "b24/detached-and-ambiguous",
    "b24/implicit-branch-recreated",
  ],
  gaps: [
    {
      code: "implicit-flight-boundary",
      message:
        "Without an explicit start marker, a branch flight is provisional and only splits on explicit flights or a changed branchCreatedAt.",
    },
    {
      code: "no-remote-identity",
      message:
        "GitHub/PR numeric identities are out of scope; flights are keyed by local repository common dir and branch aliases.",
    },
  ],
  id: DescriptorIdSchema.make("correlation/flight"),
  kind: "correlation",
  owner: "B24",
  readiness: "ready",
  requiredInputs: [
    "context.repoCommonDir",
    "context.branch",
    "occurredAt",
    "marker.start/marker.stop events (optional)",
  ],
  supportedFields: [
    "flightId",
    "aliases",
    "startedAt",
    "stoppedAt",
    "baseSha",
    "branchCreatedAt",
    "firstSeenAt",
    "lastSeenAt",
    "origin",
  ],
  version: FLIGHT_CORRELATOR_VERSION,
};

const result = (
  event: DxEventEnvelope,
  attribution: AttributionState,
  flight: Flight | null,
  reason: string
): Correlation => ({
  attribution,
  eventId: event.eventId,
  evidenceIds: [
    EvidenceIdSchema.make(event.eventId),
    ...(flight?.startEventId !== null && flight?.startEventId !== undefined
      ? [EvidenceIdSchema.make(flight.startEventId)]
      : []),
  ],
  reason,
  target: flight?.flightId ?? null,
  targetKind: FLIGHT_TARGET_KIND,
});

const aliasFlights = (
  registry: FlightRegistry,
  event: DxEventEnvelope,
  branch: string
): Flight[] =>
  registry.flights.filter(
    (flight) =>
      flight.aliases.includes(branch) &&
      sameRepo(flight.repoCommonDir, event.context.repoCommonDir)
  );

const correlateMarker = (
  registry: FlightRegistry,
  event: DxEventEnvelope
): Correlation => {
  const ignored = registry.ignoredMarkers.find(
    (item) => item.eventId === event.eventId
  );

  if (ignored !== undefined) {
    return result(event, "unassigned", null, ignored.reason);
  }

  const flight = registry.flights.find((item) =>
    item.evidenceEventIds.includes(event.eventId)
  );

  return flight === undefined
    ? result(event, "unassigned", null, "marker not linked to a flight")
    : result(event, "strong", flight, `explicit ${event.kind} marker`);
};

const correlateOne = (
  registry: FlightRegistry,
  event: DxEventEnvelope
): Correlation => {
  if (event.kind === "marker.start" || event.kind === "marker.stop") {
    return correlateMarker(registry, event);
  }

  const pinned = event.context.flightId;

  if (pinned !== null) {
    const flight = registry.flights.find((item) => item.flightId === pinned);

    return flight === undefined
      ? result(
          event,
          "provisional",
          null,
          "event names a flight ID with no recorded start marker"
        )
      : result(event, "strong", flight, "event carries explicit flight ID");
  }

  if (isDetached(event)) {
    return result(
      event,
      "unassigned",
      null,
      "detached HEAD: no branch alias to join"
    );
  }

  const branch = branchOf(event);

  if (branch === null) {
    return result(event, "unassigned", null, "no branch context");
  }

  const candidates = aliasFlights(registry, event, branch);
  const ms = timeMs(event.occurredAt);

  if (ms === null) {
    const [only] = candidates;

    return candidates.length === 1 && only !== undefined
      ? result(
          event,
          "provisional",
          only,
          "no timestamp; branch alias has exactly one flight"
        )
      : result(
          event,
          "unassigned",
          null,
          "no timestamp and branch alias is reused or unknown"
        );
  }

  const explicit = candidates.filter(
    (flight) => flight.origin === "explicit" && covers(flight, ms)
  );

  const [single] = explicit;

  if (explicit.length === 1 && single !== undefined) {
    return result(
      event,
      "strong",
      single,
      "inside explicit flight window on branch alias"
    );
  }

  if (explicit.length > 1) {
    return result(
      event,
      "unassigned",
      null,
      "ambiguous: several explicit flights cover this branch alias and time"
    );
  }

  const implicitId = registry.implicitByEvent.get(event.eventId);

  const implicit = registry.flights.find(
    (flight) => flight.flightId === implicitId
  );

  if (implicit !== undefined) {
    return result(
      event,
      "provisional",
      implicit,
      "implicit branch flight (no explicit start marker)"
    );
  }

  return result(
    event,
    "unassigned",
    null,
    event.context.repoCommonDir === null
      ? "no repository context and no explicit flight window"
      : "outside every flight window for this branch alias"
  );
};

export interface FlightCorrelationResult {
  readonly correlations: readonly Correlation[];
  readonly registry: FlightRegistry;
}

export const correlateFlights = (
  events: readonly DxEventEnvelope[],
  mappings: readonly CorrelationMapping[] = []
): FlightCorrelationResult => {
  const registry = buildFlightRegistry(events, mappings);

  return {
    correlations: events.map((event) => correlateOne(registry, event)),
    registry,
  };
};

export const flightCorrelator: DxCorrelator = {
  correlate: (events, mappings) =>
    correlateFlights(events, mappings).correlations,
  descriptor: flightCorrelationDescriptor,
};
