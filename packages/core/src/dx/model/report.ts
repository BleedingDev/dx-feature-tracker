import { Schema } from "effect";

import {
  IsoTimestampSchema,
  OriginSchema,
  TimePrecisionSchema,
} from "./common.js";
import { SourceCoverageSchema } from "./coverage.js";
import { ModuleDescriptorSchema } from "./descriptor.js";
import { EventKindSchema } from "./event.js";
import { EventIdSchema, EvidenceIdSchema, FlightIdSchema } from "./ids.js";
import { FindingCandidateSchema, MetricResultSchema } from "./metric.js";
import { SnapshotManifestSchema } from "./snapshot.js";

export const REPORT_SCHEMA_VERSION = "dx.report.v1" as const;

export const AnalyzeReportSchema = Schema.Struct({
  coverage: Schema.Array(SourceCoverageSchema),
  findings: Schema.Array(FindingCandidateSchema),
  flightId: Schema.NullOr(FlightIdSchema),
  metrics: Schema.Array(MetricResultSchema),
  notes: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(REPORT_SCHEMA_VERSION),
  snapshot: SnapshotManifestSchema,
});

export type AnalyzeReport = typeof AnalyzeReportSchema.Type;

export const TimelineEntrySchema = Schema.Struct({
  eventId: EventIdSchema,
  evidenceIds: Schema.Array(EvidenceIdSchema),
  kind: EventKindSchema,
  lane: Schema.String,
  occurredAt: Schema.NullOr(IsoTimestampSchema),
  occurredAtPrecision: TimePrecisionSchema,
  orderingUncertain: Schema.Boolean,
  origin: OriginSchema,
  summary: Schema.String,
});

export type TimelineEntry = typeof TimelineEntrySchema.Type;

export const ExplainTimelineSchema = Schema.Struct({
  entries: Schema.Array(TimelineEntrySchema),
  lanes: Schema.Array(Schema.String),
  nextCursor: Schema.NullOr(Schema.String),
  snapshotId: Schema.String,
  total: Schema.Int,
});

export type ExplainTimeline = typeof ExplainTimelineSchema.Type;

export const EvidenceItemSchema = Schema.Struct({
  adapterId: Schema.String,
  evidenceId: EvidenceIdSchema,
  excerpt: Schema.NullOr(Schema.String),
  origin: OriginSchema,
  redacted: Schema.Boolean,
  ref: Schema.String,
});

export type EvidenceItem = typeof EvidenceItemSchema.Type;

export const StatusReportSchema = Schema.Struct({
  contractDigest: Schema.String,
  contractVersion: Schema.String,
  descriptors: Schema.Array(ModuleDescriptorSchema),
  snapshotCount: Schema.NullOr(Schema.Int),
  storePath: Schema.NullOr(Schema.String),
});

export type StatusReport = typeof StatusReportSchema.Type;
