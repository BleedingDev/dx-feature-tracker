import type { SourceGap } from "../../model/coverage.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { EvidenceIdSchema } from "../../model/ids.js";
import type { Interval } from "../../model/interval.js";

export interface FlightMarkerIntervals {
  readonly active: readonly Interval[];
  readonly anomalies: readonly SourceGap[];
  readonly claims: readonly DxEventEnvelope[];
  readonly flightId: string;
  readonly waiting: readonly Interval[];
}

interface Pairing {
  readonly closeKind: string;
  readonly label: string;
  readonly openKind: string;
}

const ACTIVE: Pairing = {
  closeKind: "marker.stop",
  label: "user-marked-active",
  openKind: "marker.start",
};

const WAITING: Pairing = {
  closeKind: "marker.wait-stop",
  label: "user-marked-waiting",
  openKind: "marker.wait-start",
};

const timeOf = (event: DxEventEnvelope): number | null => {
  if (event.occurredAt === null) {
    return null;
  }

  const ms = Date.parse(event.occurredAt);

  return Number.isNaN(ms) ? null : ms;
};

const evidence = (event: DxEventEnvelope) =>
  EvidenceIdSchema.make(event.eventId);

const pair = (
  events: readonly DxEventEnvelope[],
  pairing: Pairing,
  anomalies: SourceGap[]
): Interval[] => {
  const intervals: Interval[] = [];
  let open: DxEventEnvelope | null = null;

  for (const event of events) {
    if (event.kind === pairing.openKind) {
      if (open !== null) {
        anomalies.push({
          code: "marker-reopened",
          message: `${pairing.openKind} at ${event.occurredAt} before closing the previous one; previous interval left open-ended (censored)`,
        });
        intervals.push({
          endMs: null,
          evidenceIds: [evidence(open)],
          label: pairing.label,
          startMs: timeOf(open),
        });
      }

      open = event;
    } else if (event.kind === pairing.closeKind) {
      if (open === null) {
        anomalies.push({
          code: "marker-unopened-close",
          message: `${pairing.closeKind} at ${event.occurredAt} without a matching open marker; start stays unknown (censored)`,
        });
        intervals.push({
          endMs: timeOf(event),
          evidenceIds: [evidence(event)],
          label: pairing.label,
          startMs: null,
        });
      } else {
        intervals.push({
          endMs: timeOf(event),
          evidenceIds: [evidence(open), evidence(event)],
          label: pairing.label,
          startMs: timeOf(open),
        });
        open = null;
      }
    }
  }

  if (open !== null) {
    anomalies.push({
      code: "marker-still-open",
      message: `${pairing.openKind} at ${open.occurredAt} has no close marker; interval end is unknown (censored), not assumed to be now`,
    });
    intervals.push({
      endMs: null,
      evidenceIds: [evidence(open)],
      label: pairing.label,
      startMs: timeOf(open),
    });
  }

  return intervals;
};

const byTime = (a: DxEventEnvelope, b: DxEventEnvelope): number =>
  (timeOf(a) ?? 0) - (timeOf(b) ?? 0) || a.eventId.localeCompare(b.eventId);

export const pairMarkerIntervals = (
  events: readonly DxEventEnvelope[]
): readonly FlightMarkerIntervals[] => {
  const byFlight = new Map<string, DxEventEnvelope[]>();

  for (const event of events) {
    if (!event.kind.startsWith("marker.")) {
      continue;
    }

    const flightId = event.context.flightId ?? "unassigned";
    const list = byFlight.get(flightId) ?? [];

    list.push(event);
    byFlight.set(flightId, list);
  }

  return [...byFlight.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([flightId, list]) => {
      const sorted = [...list].toSorted(byTime);
      const anomalies: SourceGap[] = [];

      return {
        active: pair(sorted, ACTIVE, anomalies),
        anomalies,
        claims: sorted.filter((event) => event.kind === "marker.claim"),
        flightId,
        waiting: pair(sorted, WAITING, anomalies),
      };
    });
};
