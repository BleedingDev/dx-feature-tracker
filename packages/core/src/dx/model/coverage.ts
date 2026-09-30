import { Schema } from "effect";

import { IsoTimestampSchema } from "./common.js";

export const CoverageStateSchema = Schema.Literals([
  "complete",
  "partial",
  "none",
  "unsupported",
  "disabled",
  "error",
]);

export type CoverageState = typeof CoverageStateSchema.Type;

export const SourceGapSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});

export type SourceGap = typeof SourceGapSchema.Type;

export const CollectCursorSchema = Schema.Struct({
  adapterId: Schema.String,
  value: Schema.String,
});

export type CollectCursor = typeof CollectCursorSchema.Type;

export const SourceCoverageSchema = Schema.Struct({
  adapterId: Schema.String,
  expectedItems: Schema.NullOr(Schema.Int),
  gaps: Schema.Array(SourceGapSchema),
  observedItems: Schema.NullOr(Schema.Int),
  state: CoverageStateSchema,
  watermark: Schema.NullOr(Schema.String),
  windowFrom: Schema.NullOr(IsoTimestampSchema),
  windowTo: Schema.NullOr(IsoTimestampSchema),
});

export type SourceCoverage = typeof SourceCoverageSchema.Type;
