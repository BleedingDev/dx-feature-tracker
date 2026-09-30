import { Schema } from "effect";

import { EvidenceIdSchema } from "./ids.js";

export const IntervalSchema = Schema.Struct({
  endMs: Schema.NullOr(Schema.Finite),
  evidenceIds: Schema.Array(EvidenceIdSchema),
  label: Schema.String,
  startMs: Schema.NullOr(Schema.Finite),
});

export type Interval = typeof IntervalSchema.Type;

export const MergedIntervalSchema = Schema.Struct({
  endMs: Schema.Finite,
  evidenceIds: Schema.Array(EvidenceIdSchema),
  startMs: Schema.Finite,
});

export type MergedInterval = typeof MergedIntervalSchema.Type;

export const IntervalUnionResultSchema = Schema.Struct({
  censored: Schema.Int,
  clockErrors: Schema.Int,
  merged: Schema.Array(MergedIntervalSchema),
  totalMs: Schema.NullOr(Schema.Finite),
});

export type IntervalUnionResult = typeof IntervalUnionResultSchema.Type;

export interface IntervalSumResult {
  readonly excluded: number;
  readonly totalMs: number | null;
}

export interface IntervalHelpers {
  readonly overlap: (a: Interval, b: Interval) => number | null;
  readonly sum: (intervals: readonly Interval[]) => IntervalSumResult;
  readonly union: (intervals: readonly Interval[]) => IntervalUnionResult;
}
