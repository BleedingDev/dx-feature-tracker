import { Schema } from "effect";

import { AiAttributionSchema, AiUsageSchema } from "./attribution.js";
import {
  AcquisitionSchema,
  IsoTimestampSchema,
  OriginSchema,
  TimePrecisionSchema,
  ValueMethodSchema,
} from "./common.js";
import { CollectCursorSchema, SourceCoverageSchema } from "./coverage.js";
import { EventIdSchema, FlightIdSchema } from "./ids.js";

export const EVENT_SCHEMA_VERSION = "dx.event.v2" as const;

export const EventKindSchema = Schema.Literals([
  "git.context",
  "git.commit",
  "git.diff",
  "git.observation",
  "ai.request",
  "ai.turn",
  "ai.usage",
  "ai.tool-edit",
  "ai.session",
  "ci.run",
  "ci.attempt",
  "ci.job",
  "ci.check",
  "pr.metadata",
  "pr.review",
  "command.run",
  "test.result",
  "marker.start",
  "marker.stop",
  "marker.wait-start",
  "marker.wait-stop",
  "marker.claim",
  "feedback.local",
  "provenance.attestation",
  "other",
]);

export type EventKind = typeof EventKindSchema.Type;

export const FlightContextSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  flightId: Schema.NullOr(FlightIdSchema),
  headSha: Schema.NullOr(Schema.String),
  repoCommonDir: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});

export type FlightContext = typeof FlightContextSchema.Type;

export const emptyFlightContext: FlightContext = {
  branch: null,
  flightId: null,
  headSha: null,
  repoCommonDir: null,
  worktreePath: null,
};

export const EventIdentitySchema = Schema.Struct({
  commitSha: Schema.NullOr(Schema.String),
  generationId: Schema.NullOr(Schema.String),
  githubAttempt: Schema.NullOr(Schema.Int),
  githubRunId: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Int),
  requestId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
});

export type EventIdentity = typeof EventIdentitySchema.Type;

export const emptyEventIdentity: EventIdentity = {
  commitSha: null,
  generationId: null,
  githubAttempt: null,
  githubRunId: null,
  prNumber: null,
  requestId: null,
  sessionId: null,
  turnId: null,
};

export const EvidenceRefSchema = Schema.Struct({
  bounded: Schema.Boolean,
  hash: Schema.NullOr(Schema.String),
  ref: Schema.String,
});

export type EvidenceRef = typeof EvidenceRefSchema.Type;

export const FieldSemanticsSchema = Schema.Struct({
  field: Schema.String,
  method: ValueMethodSchema,
  note: Schema.NullOr(Schema.String),
  rawName: Schema.NullOr(Schema.String),
  unit: Schema.NullOr(Schema.String),
});

export type FieldSemantics = typeof FieldSemanticsSchema.Type;

export const MAX_PAYLOAD_BYTES = 16_384;

export const DxEventEnvelopeSchema = Schema.Struct({
  acquisition: AcquisitionSchema,
  adapterId: Schema.String,
  adapterVersion: Schema.String,
  ai: Schema.NullOr(AiAttributionSchema),
  context: FlightContextSchema,
  eventId: EventIdSchema,
  evidence: EvidenceRefSchema,
  fieldSemantics: Schema.Array(FieldSemanticsSchema),
  identity: EventIdentitySchema,
  kind: EventKindSchema,
  observedAt: IsoTimestampSchema,
  occurredAt: Schema.NullOr(IsoTimestampSchema),
  occurredAtPrecision: TimePrecisionSchema,
  origin: OriginSchema,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  schemaVersion: Schema.Literal(EVENT_SCHEMA_VERSION),
  sourceVersion: Schema.NullOr(Schema.String),
  upstreamKey: Schema.String,
  usage: Schema.NullOr(AiUsageSchema),
});

export type DxEventEnvelope = typeof DxEventEnvelopeSchema.Type;

export const EventBatchSchema = Schema.Struct({
  coverage: SourceCoverageSchema,
  cursor: Schema.NullOr(CollectCursorSchema),
  events: Schema.Array(DxEventEnvelopeSchema),
  replace: Schema.optional(
    Schema.Struct({
      adapterId: Schema.String,
      fromOccurredAt: IsoTimestampSchema,
    })
  ),
});

export type EventBatch = typeof EventBatchSchema.Type;
