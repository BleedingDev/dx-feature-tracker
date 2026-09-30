import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { EvidenceId } from "../../model/ids.js";
import { DescriptorIdSchema } from "../../model/ids.js";
import type {
  Interval,
  IntervalHelpers,
  IntervalSumResult,
  IntervalUnionResult,
  MergedInterval,
} from "../../model/interval.js";

export const INTERVALS_VERSION = "1.0.0" as const;

export type IntervalClass = "valid" | "censored" | "clock-error";

type Checked =
  | { readonly kind: "censored" }
  | { readonly kind: "clock-error" }
  | { readonly kind: "valid"; readonly interval: MergedInterval };

const isKnown = (value: number | null): value is number =>
  value !== null && Number.isFinite(value);

const check = (interval: Interval): Checked => {
  const { endMs, evidenceIds, startMs } = interval;

  if (!(isKnown(startMs) && isKnown(endMs))) {
    return { kind: "censored" };
  }

  if (endMs < startMs) {
    return { kind: "clock-error" };
  }

  return { interval: { endMs, evidenceIds, startMs }, kind: "valid" };
};

export const classifyInterval = (interval: Interval): IntervalClass =>
  check(interval).kind;

interface Partitioned {
  readonly censored: number;
  readonly clockErrors: number;
  readonly valid: readonly MergedInterval[];
}

const partition = (intervals: readonly Interval[]): Partitioned => {
  const checked = intervals.map(check);

  const valid = checked.flatMap((c) =>
    c.kind === "valid" ? [c.interval] : []
  );

  const censored = checked.filter((c) => c.kind === "censored").length;

  const clockErrors = checked.filter((c) => c.kind === "clock-error").length;

  return { censored, clockErrors, valid };
};

const mergeEvidence = (
  left: readonly EvidenceId[],
  right: readonly EvidenceId[]
): readonly EvidenceId[] => [...new Set([...left, ...right])];

const durationOf = (interval: MergedInterval): number =>
  interval.endMs - interval.startMs;

const totalOf = (intervals: readonly MergedInterval[]): number | null =>
  intervals.length === 0
    ? null
    : intervals.reduce((acc, interval) => acc + durationOf(interval), 0);

const mergeSorted = (
  sorted: readonly MergedInterval[]
): readonly MergedInterval[] => {
  const merged: MergedInterval[] = [];

  for (const current of sorted) {
    const last = merged.at(-1);

    if (last === undefined || current.startMs > last.endMs) {
      merged.push({
        ...current,
        evidenceIds: mergeEvidence([], current.evidenceIds),
      });
    } else {
      merged[merged.length - 1] = {
        endMs: Math.max(last.endMs, current.endMs),
        evidenceIds: mergeEvidence(last.evidenceIds, current.evidenceIds),
        startMs: last.startMs,
      };
    }
  }

  return merged;
};

export const unionIntervals = (
  intervals: readonly Interval[]
): IntervalUnionResult => {
  const { censored, clockErrors, valid } = partition(intervals);

  const sorted = valid.toSorted(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs
  );

  const merged = mergeSorted(sorted);

  return { censored, clockErrors, merged, totalMs: totalOf(merged) };
};

export const sumIntervals = (
  intervals: readonly Interval[]
): IntervalSumResult => {
  const { censored, clockErrors, valid } = partition(intervals);

  return { excluded: censored + clockErrors, totalMs: totalOf(valid) };
};

export const overlapIntervals = (a: Interval, b: Interval): number | null => {
  const left = check(a);
  const right = check(b);

  if (left.kind !== "valid" || right.kind !== "valid") {
    return null;
  }

  const start = Math.max(left.interval.startMs, right.interval.startMs);
  const end = Math.min(left.interval.endMs, right.interval.endMs);

  return Math.max(0, end - start);
};

export const closeOpenIntervalAt = (
  interval: Interval,
  asOfMs: number
): Interval => {
  const { endMs, label, startMs } = interval;

  if (
    isKnown(startMs) &&
    endMs === null &&
    Number.isFinite(asOfMs) &&
    asOfMs >= startMs
  ) {
    return { ...interval, endMs: asOfMs, label: `${label}@as-of` };
  }

  return interval;
};

export const intervalHelpers: IntervalHelpers = {
  overlap: overlapIntervals,
  sum: sumIntervals,
  union: unionIntervals,
};

export const intervalsDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b27-union-overlap",
    "b27-censored",
    "b27-clock-error",
    "b27-empty",
    "b27-branch-as-of",
  ],
  gaps: [
    {
      code: "lower-bound",
      message:
        "When censored or clockErrors is non-zero, totalMs covers only valid intervals and is a lower bound; consumers must display the counts.",
    },
    {
      code: "unavailable-when-empty",
      message:
        "totalMs is null (unavailable), not 0, when no interval has both a known start and a non-inverted end.",
    },
    {
      code: "no-clock-skew-correction",
      message:
        "Clock skew between sources is not corrected; only end-before-start inversions are detected and excluded.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metric.intervals"),
  kind: "metric",
  owner: "B27",
  readiness: "ready",
  requiredInputs: [],
  supportedFields: [
    "union.merged",
    "union.totalMs",
    "union.censored",
    "union.clockErrors",
    "sum.totalMs",
    "sum.excluded",
    "overlap",
    "closeOpenIntervalAt",
  ],
  version: INTERVALS_VERSION,
};
