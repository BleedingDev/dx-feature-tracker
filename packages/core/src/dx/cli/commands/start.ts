import { DateTime, Effect } from "effect";

import {
  MANUAL_ADAPTER_ID,
  buildMarkerEvent,
} from "../../collectors/manual/marker.js";
import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { StoreFailure } from "../../contracts/services.js";
import type { EventBatch, FlightContext } from "../../model/event.js";
import type { DxCommandEnv } from "./context.js";

export interface StartRequest {
  readonly context: FlightContext;
  readonly flight?: string | undefined;
  readonly label?: string | undefined;
  readonly occurredAt?: string | undefined;
}

export interface StartResult {
  readonly branch: string | null;
  readonly eventId: string;
  readonly flightId: string | null;
  readonly inserted: number;
  readonly storePath: string;
}

export const runStart = (
  env: DxCommandEnv,
  request: StartRequest
): Effect.Effect<StartResult, InvalidInput | StoreFailure> =>
  Effect.gen(function* start() {
    const now = DateTime.formatIso(yield* DateTime.now);

    const event = yield* buildMarkerEvent(
      {
        flight: request.flight,
        kind: "start",
        label: request.label,
        occurredAt: request.occurredAt ?? now,
      },
      {
        acquisition: "manual",
        context: request.context,
        observedAt: now,
        origin: "live",
      }
    );

    const batch: EventBatch = {
      coverage: {
        adapterId: MANUAL_ADAPTER_ID,
        expectedItems: 1,
        gaps: [],
        observedItems: 1,
        state: "complete",
        watermark: null,
        windowFrom: event.occurredAt,
        windowTo: event.occurredAt,
      },
      cursor: null,
      events: [event],
    };

    const appended = yield* env.store.append(batch);

    return {
      branch: event.context.branch,
      eventId: event.eventId,
      flightId: event.context.flightId,
      inserted: appended.inserted,
      storePath: env.storePath,
    };
  });
