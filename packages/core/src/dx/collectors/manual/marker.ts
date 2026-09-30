// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { DateTime, Effect, Option } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { Origin } from "../../model/common.js";
import type {
  DxEventEnvelope,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { emptyEventIdentity } from "../../model/event.js";
import type { FlightId } from "../../model/ids.js";
import { EventIdSchema, FlightIdSchema } from "../../model/ids.js";

export const MANUAL_ADAPTER_ID = "manual";

export const MANUAL_ADAPTER_VERSION = "1.0.0";

export const MARKER_LOG_SCHEMA = "dx.manual.marker.v1";

export const MAX_LABEL_CHARS = 120;

export const MAX_NOTE_CHARS = 500;

export const MAX_FLIGHT_CHARS = 200;

export type MarkerKind =
  | "start"
  | "stop"
  | "wait-start"
  | "wait-stop"
  | "claim";

export const MARKER_KINDS: readonly MarkerKind[] = [
  "start",
  "stop",
  "wait-start",
  "wait-stop",
  "claim",
];

export interface MarkerRequest {
  readonly flight?: string | undefined;
  readonly kind: string;
  readonly label?: string | undefined;
  readonly note?: string | undefined;
  readonly occurredAt: string;
}

export interface MarkerBuildOptions {
  readonly acquisition: "manual" | "file-import";
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const invalid = (field: string, message: string) =>
  new InvalidInput({ field, message });

const isMarkerKind = (value: string): value is MarkerKind =>
  MARKER_KINDS.some((kind) => kind === value);

const eventKindOf = (kind: MarkerKind): EventKind => `marker.${kind}`;

const cleanText = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null;
  }

  const cleaned = value.replaceAll(/\p{Cc}+/gu, " ").trim();

  return cleaned.length === 0 ? null : cleaned;
};

export const resolveFlightId = (
  flight: string | undefined,
  context: FlightContext
): FlightId | null => {
  const explicit = cleanText(flight);

  if (explicit !== null) {
    return FlightIdSchema.make(explicit);
  }

  if (context.flightId !== null) {
    return context.flightId;
  }

  if (context.branch !== null) {
    return FlightIdSchema.make(
      context.repoCommonDir === null
        ? `branch:${context.branch}`
        : `branch:${sha256(context.repoCommonDir).slice(0, 12)}:${context.branch}`
    );
  }

  return null;
};

export const normalizeInstant = (value: string): string | null =>
  DateTime.make(value).pipe(Option.map(DateTime.formatIso), Option.getOrNull);

export const buildMarkerEvent = Effect.fn("Manual.buildMarkerEvent")(
  function* buildMarkerEvent(
    request: MarkerRequest,
    options: MarkerBuildOptions
  ) {
    if (!isMarkerKind(request.kind)) {
      return yield* invalid(
        "kind",
        `unknown marker kind; expected one of ${MARKER_KINDS.join(", ")}`
      );
    }

    const occurredAt = normalizeInstant(request.occurredAt);

    if (occurredAt === null) {
      return yield* invalid("occurredAt", "marker time is not an ISO instant");
    }

    const label = cleanText(request.label);
    const note = cleanText(request.note);

    if (request.kind === "claim" && label === null) {
      return yield* invalid("label", "a claim requires a non-empty label");
    }

    if (label !== null && label.length > MAX_LABEL_CHARS) {
      return yield* invalid(
        "label",
        `label exceeds ${MAX_LABEL_CHARS} characters`
      );
    }

    if (note !== null && note.length > MAX_NOTE_CHARS) {
      return yield* invalid(
        "note",
        `note exceeds ${MAX_NOTE_CHARS} characters`
      );
    }

    const rawFlight = cleanText(request.flight);

    if (rawFlight !== null && rawFlight.length > MAX_FLIGHT_CHARS) {
      return yield* invalid(
        "flight",
        `flight exceeds ${MAX_FLIGHT_CHARS} characters`
      );
    }

    const flightId = resolveFlightId(request.flight, options.context);

    if (flightId === null) {
      return yield* invalid(
        "flight",
        "no flight: pass a flight or run inside a Git branch"
      );
    }

    const kind = eventKindOf(request.kind);

    const contentHash = sha256(
      JSON.stringify([request.kind, flightId, occurredAt, label, note])
    );

    const upstreamKey = `${flightId}:${request.kind}:${occurredAt}:${contentHash.slice(0, 16)}`;

    const timeMethod =
      options.acquisition === "manual" ? "observed" : "user-claimed";

    const fieldSemantics: FieldSemantics[] = [
      {
        field: "occurredAt",
        method: timeMethod,
        note:
          timeMethod === "observed"
            ? "recorder clock at the moment the marker command ran"
            : "time written in an imported marker log",
        rawName: "at",
        unit: "iso8601",
      },
      {
        field: "payload.markerKind",
        method: "user-claimed",
        note: "explicit user marker; not inferred from activity",
        rawName: "kind",
        unit: null,
      },
    ];

    if (label !== null) {
      fieldSemantics.push({
        field: "payload.label",
        method: "user-claimed",
        note: request.kind === "claim" ? "labelled user claim" : null,
        rawName: "label",
        unit: null,
      });
    }

    if (note !== null) {
      fieldSemantics.push({
        field: "payload.note",
        method: "user-claimed",
        note: null,
        rawName: "note",
        unit: null,
      });
    }

    const event: DxEventEnvelope = {
      acquisition: options.acquisition,
      adapterId: MANUAL_ADAPTER_ID,
      adapterVersion: MANUAL_ADAPTER_VERSION,
      context: { ...options.context, flightId },
      eventId: EventIdSchema.make(
        sha256(`${MANUAL_ADAPTER_ID}\n${upstreamKey}\n${kind}`)
      ),
      evidence: {
        bounded: true,
        hash: contentHash,
        ref: `manual:${upstreamKey}`,
      },
      fieldSemantics,
      identity: emptyEventIdentity,
      kind,
      observedAt: options.observedAt,
      occurredAt,
      occurredAtPrecision: "exact",
      origin: options.origin,
      payload: {
        claim: request.kind === "claim",
        flightId,
        label,
        markerKind: request.kind,
        method: "user-claimed",
        note,
      },
      schemaVersion: "dx.event.v1",
      sourceVersion: null,
      upstreamKey,
    };

    return event;
  }
);
