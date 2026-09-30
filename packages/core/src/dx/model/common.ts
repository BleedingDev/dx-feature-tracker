import { Schema } from "effect";

export const IsoTimestampSchema = Schema.String;

export type IsoTimestamp = typeof IsoTimestampSchema.Type;

export const OriginSchema = Schema.Literals([
  "live",
  "imported",
  "replay",
  "fixture",
  "synthetic",
]);

export type Origin = typeof OriginSchema.Type;

export const AcquisitionSchema = Schema.Literals([
  "hook",
  "file-import",
  "api",
  "git",
  "manual",
  "db-snapshot",
  "command-capture",
  "derived",
]);

export type Acquisition = typeof AcquisitionSchema.Type;

export const ValueMethodSchema = Schema.Literals([
  "source-reported",
  "observed",
  "derived",
  "estimated",
  "user-claimed",
]);

export type ValueMethod = typeof ValueMethodSchema.Type;

export const MeasurementStateSchema = Schema.Literals([
  "measured",
  "partial",
  "estimated",
  "unavailable",
  "unsupported",
  "disabled",
]);

export type MeasurementState = typeof MeasurementStateSchema.Type;

export const AttributionStateSchema = Schema.Literals([
  "strong",
  "provisional",
  "unassigned",
  "not-applicable",
]);

export type AttributionState = typeof AttributionStateSchema.Type;

export const TimePrecisionSchema = Schema.Literals([
  "exact",
  "second",
  "minute",
  "day",
  "unknown",
]);

export type TimePrecision = typeof TimePrecisionSchema.Type;

export const UnavailableSchema = Schema.Struct({
  reason: Schema.String,
  state: Schema.Literals(["unavailable", "unsupported", "disabled"]),
});

export type Unavailable = typeof UnavailableSchema.Type;
