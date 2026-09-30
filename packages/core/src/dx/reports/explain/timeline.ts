import { Result, Schema } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { StoreSnapshot } from "../../contracts/services.js";
import type { TimePrecision } from "../../model/common.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { EvidenceIdSchema } from "../../model/ids.js";
import type { ExplainTimeline, TimelineEntry } from "../../model/report.js";

export const DEFAULT_EXPLAIN_LIMIT = 50;

export const MAX_EXPLAIN_LIMIT = 500;

const CURSOR_PREFIX = "b36v1";

const MAX_SUMMARY_FIELDS = 6;

const COARSE: ReadonlySet<TimePrecision> = new Set([
  "minute",
  "day",
  "unknown",
]);

const PRECISION_RANK: Record<TimePrecision, number> = {
  day: 3,
  exact: 0,
  minute: 2,
  second: 1,
  unknown: 4,
};

export const laneOf = (event: DxEventEnvelope): string => event.adapterId;

const compareStrings = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

const timeKey = (event: DxEventEnvelope): number | null => {
  if (event.occurredAt === null) {
    return null;
  }

  const ms = Date.parse(event.occurredAt);

  return Number.isNaN(ms) ? null : ms;
};

export const compareEvents = (
  left: DxEventEnvelope,
  right: DxEventEnvelope
): number => {
  const lt = timeKey(left);
  const rt = timeKey(right);

  if (lt === null && rt !== null) {
    return 1;
  }

  if (lt !== null && rt === null) {
    return -1;
  }

  if (lt !== null && rt !== null && lt !== rt) {
    return lt - rt;
  }

  const precision =
    PRECISION_RANK[left.occurredAtPrecision] -
    PRECISION_RANK[right.occurredAtPrecision];

  if (precision !== 0) {
    return precision;
  }

  return (
    compareStrings(left.observedAt, right.observedAt) ||
    compareStrings(laneOf(left), laneOf(right)) ||
    compareStrings(left.eventId, right.eventId)
  );
};

const BUCKET_MS: Record<TimePrecision, number> = {
  day: 86_400_000,

  exact: 1,
  minute: 60_000,

  second: 1000,
  unknown: 1,
};

const bucketOf = (event: DxEventEnvelope): string | null => {
  const ms = timeKey(event);

  if (ms === null) {
    return null;
  }

  const size = BUCKET_MS[event.occurredAtPrecision];

  return `${event.occurredAtPrecision}:${Math.floor(ms / size)}`;
};

const uncertainFlags = (
  ordered: readonly DxEventEnvelope[]
): readonly boolean[] => {
  const lanesByBucket = new Map<string, Set<string>>();

  for (const event of ordered) {
    const bucket = bucketOf(event);

    if (bucket !== null) {
      const lanes = lanesByBucket.get(bucket) ?? new Set<string>();

      lanes.add(laneOf(event));
      lanesByBucket.set(bucket, lanes);
    }
  }

  return ordered.map((event) => {
    const bucket = bucketOf(event);

    if (bucket === null || COARSE.has(event.occurredAtPrecision)) {
      return true;
    }

    return (lanesByBucket.get(bucket)?.size ?? 0) > 1;
  });
};

const isSummaryScalar = Schema.is(
  Schema.Union([Schema.Finite, Schema.Boolean])
);

export const summarize = (event: DxEventEnvelope): string => {
  const fields = Object.keys(event.payload)
    .toSorted(compareStrings)

    .flatMap((key) => {
      const value = event.payload[key];

      return isSummaryScalar(value) ? [`${key}=${String(value)}`] : [];
    })
    .slice(0, MAX_SUMMARY_FIELDS);

  const methods = event.fieldSemantics
    .filter((semantic) => semantic.method !== "observed")
    .map((semantic) => `${semantic.field}:${semantic.method}`)
    .toSorted(compareStrings);

  const parts = [`${event.kind} via ${event.adapterId}`];

  if (fields.length > 0) {
    parts.push(fields.join(" "));
  }

  if (methods.length > 0) {
    parts.push(`[${methods.join(", ")}]`);
  }

  if (event.occurredAt === null) {
    parts.push("(time unavailable)");
  }

  return parts.join(" ");
};

export const encodeCursor = (snapshotId: string, offset: number): string =>
  `${CURSOR_PREFIX}:${offset}:${snapshotId}`;

export const decodeCursor = (
  cursor: string,
  snapshotId: string
): Result.Result<number, InvalidInput> => {
  const [prefix, rawOffset] = cursor.split(":", 2);
  const expectedHead = `${CURSOR_PREFIX}:${rawOffset ?? ""}:`;
  const cursorSnapshot = cursor.slice(expectedHead.length);
  const offset = Number(rawOffset);

  if (
    prefix !== CURSOR_PREFIX ||
    !cursor.startsWith(expectedHead) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return Result.fail(
      new InvalidInput({
        field: "cursor",
        message: "Malformed explain cursor.",
      })
    );
  }

  if (cursorSnapshot !== snapshotId) {
    return Result.fail(
      new InvalidInput({
        field: "cursor",
        message: `Cursor belongs to snapshot ${cursorSnapshot}, not ${snapshotId}; restart pagination with that snapshotId.`,
      })
    );
  }

  return Result.succeed(offset);
};

export interface TimelineRequest {
  readonly cursor: string | null;
  readonly limit: number | null;
}

export const resolveLimit = (
  limit: number | null
): Result.Result<number, InvalidInput> => {
  if (limit === null) {
    return Result.succeed(DEFAULT_EXPLAIN_LIMIT);
  }

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPLAIN_LIMIT) {
    return Result.fail(
      new InvalidInput({
        field: "limit",
        message: `limit must be an integer in 1..${MAX_EXPLAIN_LIMIT}.`,
      })
    );
  }

  return Result.succeed(limit);
};

const toEntry = (
  event: DxEventEnvelope,
  orderingUncertain: boolean
): TimelineEntry => ({
  eventId: event.eventId,
  evidenceIds: [EvidenceIdSchema.make(event.eventId)],
  kind: event.kind,

  lane: laneOf(event),
  occurredAt: event.occurredAt,
  occurredAtPrecision: event.occurredAtPrecision,

  orderingUncertain,

  origin: event.origin,
  summary: summarize(event),
});

export const buildTimeline = (
  snapshot: StoreSnapshot,
  request: TimelineRequest
): Result.Result<ExplainTimeline, InvalidInput> => {
  const { snapshotId } = snapshot.manifest;
  const limit = resolveLimit(request.limit);

  if (Result.isFailure(limit)) {
    return Result.fail(limit.failure);
  }

  const offset =
    request.cursor === null
      ? Result.succeed(0)
      : decodeCursor(request.cursor, snapshotId);

  if (Result.isFailure(offset)) {
    return Result.fail(offset.failure);
  }

  const ordered = snapshot.events.toSorted(compareEvents);
  const flags = uncertainFlags(ordered);
  const start = offset.success;
  const end = Math.min(start + limit.success, ordered.length);

  const entries = ordered
    .slice(start, end)
    .map((event, index) => toEntry(event, flags[start + index] ?? true));

  const lanes = [...new Set(ordered.map(laneOf))].toSorted(compareStrings);

  return Result.succeed({
    entries,
    lanes,
    nextCursor: end < ordered.length ? encodeCursor(snapshotId, end) : null,
    snapshotId,
    total: ordered.length,
  });
};
