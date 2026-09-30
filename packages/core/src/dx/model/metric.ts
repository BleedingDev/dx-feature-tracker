import { Schema } from "effect";

import {
  AttributionStateSchema,
  IsoTimestampSchema,
  MeasurementStateSchema,
  ValueMethodSchema,
} from "./common.js";
import { SourceCoverageSchema } from "./coverage.js";
import { EvidenceIdSchema, MetricIdSchema } from "./ids.js";

export const MetricDefinitionRefSchema = Schema.Struct({
  description: Schema.String,
  id: MetricIdSchema,
  unit: Schema.String,
  version: Schema.String,
});

export type MetricDefinitionRef = typeof MetricDefinitionRefSchema.Type;

export const MetricResultSchema = Schema.Struct({
  asOf: IsoTimestampSchema,
  attribution: AttributionStateSchema,
  checkpoint: Schema.NullOr(Schema.String),
  coverage: Schema.Array(SourceCoverageSchema),
  definition: MetricDefinitionRefSchema,
  denominator: Schema.NullOr(Schema.Finite),
  evidenceIds: Schema.Array(EvidenceIdSchema),
  measurement: MeasurementStateSchema,
  method: ValueMethodSchema,
  metricId: MetricIdSchema,
  numerator: Schema.NullOr(Schema.Finite),
  reason: Schema.NullOr(Schema.String),
  unit: Schema.String,
  value: Schema.NullOr(Schema.Finite),
});

export type MetricResult = typeof MetricResultSchema.Type;

export const FindingSeveritySchema = Schema.Literals([
  "info",
  "low",
  "medium",
  "high",
]);

export type FindingSeverity = typeof FindingSeveritySchema.Type;

export const FindingCandidateSchema = Schema.Struct({
  evidenceIds: Schema.Array(EvidenceIdSchema),
  experiment: Schema.NullOr(Schema.String),
  findingId: Schema.String,
  metricIds: Schema.Array(MetricIdSchema),
  rank: Schema.Int,
  severity: FindingSeveritySchema,
  summary: Schema.String,
});

export type FindingCandidate = typeof FindingCandidateSchema.Type;

export const isHonestMetric = (m: MetricResult): boolean =>
  m.value !== null || (m.reason !== null && m.reason !== "");
