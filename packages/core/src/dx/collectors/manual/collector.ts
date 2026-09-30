import { DateTime, Effect, FileSystem, Result, Schema } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type {
  CoverageState,
  SourceCoverage,
  SourceGap,
} from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { DxEventEnvelope, EventBatch } from "../../model/event.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import type { MarkerRequest } from "./marker.js";
import {
  MANUAL_ADAPTER_ID,
  MANUAL_ADAPTER_VERSION,
  MARKER_LOG_SCHEMA,
  buildMarkerEvent,
} from "./marker.js";

export const B22_FIXTURE_IDS = [
  "b22-marker-log-basic",
  "b22-marker-log-anomalies",
] as const;

export const manualDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...B22_FIXTURE_IDS],
  gaps: [
    {
      code: "user-claimed-only",
      message:
        "Markers and claims are what the user said; they are labelled user-claimed and never promoted to observed activity, AI ownership or causal savings.",
    },
    {
      code: "open-intervals-censored",
      message:
        "A start/wait-start without its close stays open-ended (censored); dft never assumes it ended now.",
    },
    {
      code: "no-automatic-waiting",
      message:
        "Waiting time exists only between explicit wait-start/wait-stop markers; it is never inferred from idle gaps.",
    },
  ],
  id: DescriptorIdSchema.make("collector/manual"),
  kind: "collector",
  owner: "B22",
  readiness: "ready",
  requiredInputs: [
    "live: dx_mark { kind, flight?, label?, note? } via buildMarkerEvent",
    `import: selectedInput = ${MARKER_LOG_SCHEMA} JSONL marker log`,
  ],
  supportedFields: [
    "marker.start.occurredAt",
    "marker.stop.occurredAt",
    "marker.wait-start.occurredAt",
    "marker.wait-stop.occurredAt",
    "marker.claim.label",
    "marker.*.note",
    "marker.*.flightId",
    "intervals.user-marked-active",
    "intervals.user-marked-waiting",
  ],
  version: MANUAL_ADAPTER_VERSION,
};

export const MarkerLogLineSchema = Schema.Struct({
  at: Schema.String,
  branch: Schema.optional(Schema.String),
  flight: Schema.optional(Schema.String),
  headSha: Schema.optional(Schema.String),
  kind: Schema.String,
  label: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  schema: Schema.Literal(MARKER_LOG_SCHEMA),
});

export type MarkerLogLine = typeof MarkerLogLineSchema.Type;

const MarkerLogLineFromJson = Schema.fromJsonString(MarkerLogLineSchema);

export const toMarkerLogLine = (
  request: MarkerRequest,
  branch: string | null
): string => {
  const line: MarkerLogLine = {
    at: request.occurredAt,
    branch: branch ?? undefined,
    flight: request.flight,
    kind: request.kind,
    label: request.label,
    note: request.note,
    schema: MARKER_LOG_SCHEMA,
  };

  return JSON.stringify(line);
};

const coverageState = (observed: number, gaps: number): CoverageState => {
  if (observed === 0) {
    return "none";
  }

  return gaps === 0 ? "complete" : "partial";
};

export const buildManualBatch = Effect.fn("Manual.buildManualBatch")(
  function* buildManualBatch(
    content: string,
    input: CollectInput,
    observedAt: string
  ) {
    const gaps: SourceGap[] = [];
    const events: DxEventEnvelope[] = [];
    const seen = new Set<string>();

    const lines = content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const [index, raw] of lines.entries()) {
      const decoded = yield* Effect.result(
        Schema.decodeEffect(MarkerLogLineFromJson)(raw)
      );

      if (Result.isFailure(decoded)) {
        gaps.push({
          code: "line-unparseable",
          message: `line ${index + 1}: not a ${MARKER_LOG_SCHEMA} JSON object`,
        });
        continue;
      }

      const line = decoded.success;

      const built = yield* Effect.result(
        buildMarkerEvent(
          {
            flight: line.flight,
            kind: line.kind,
            label: line.label,
            note: line.note,
            occurredAt: line.at,
          },
          {
            acquisition: "file-import",
            context: {
              ...input.context,
              branch: line.branch ?? input.context.branch,
              headSha: line.headSha ?? input.context.headSha,
            },
            observedAt,
            origin: input.origin,
          }
        )
      );

      if (Result.isFailure(built)) {
        gaps.push({
          code: "line-invalid",
          message: `line ${index + 1}: ${built.failure.field ?? "input"}: ${built.failure.message}`,
        });
        continue;
      }

      if (seen.has(built.success.eventId)) {
        continue;
      }

      seen.add(built.success.eventId);
      events.push(built.success);
    }

    const times = events
      .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
      .toSorted();

    const coverage: SourceCoverage = {
      adapterId: input.adapterId,
      expectedItems: lines.length,
      gaps,
      observedItems: events.length,
      state: coverageState(events.length, gaps.length),
      watermark: times.at(-1) ?? null,
      windowFrom: times[0] ?? null,
      windowTo: times.at(-1) ?? null,
    };

    const batch: EventBatch = { coverage, cursor: null, events };

    return batch;
  }
);

export const collectManual = Effect.fn("Manual.collect")(
  function* collectManual(input: CollectInput) {
    if (input.selectedInput === null) {
      return yield* new InvalidInput({
        field: "selectedInput",
        message: `manual import requires an explicitly selected ${MARKER_LOG_SCHEMA} JSONL file; live markers use dx_mark`,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;

    const content = yield* fileSystem.readFileString(input.selectedInput).pipe(
      Effect.mapError(
        () =>
          new SourceUnavailable({
            adapterId: MANUAL_ADAPTER_ID,
            message: "selected marker log is not readable",
          })
      )
    );

    const now = yield* DateTime.now;

    return yield* buildManualBatch(content, input, DateTime.formatIso(now));
  }
);

export const manualCollector: DxCollector<FileSystem.FileSystem> = {
  collect: collectManual,
  descriptor: manualDescriptor,
};
