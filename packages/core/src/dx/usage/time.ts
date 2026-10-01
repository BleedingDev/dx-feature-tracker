import { DateTime } from "effect";

const HOUR_MS = 3_600_000;

const QUARTER_MS = 900_000;

const DAY_MS = 86_400_000;

const GAP_QUARTERS = 100;

const MONDAY_OFFSET = 3;

const WEEK_DAYS = 7;

export type TimeBucket = "day" | "week" | "month";

const DATE_ONLY = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

export const systemTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

export const isTimeZone = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });

    return true;
  } catch {
    return false;
  }
};

const PART_NAMES: ReadonlySet<string> = new Set([
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
]);

export interface ZoneClock {
  readonly bucketOf: (ms: number, bucket: TimeBucket) => string;
  readonly dayOf: (ms: number) => number;
  readonly localMidnight: (date: string) => number | null;
  readonly offsetAt: (ms: number) => number;
  readonly tz: string;
}

const isoDate = (day: number): string =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(day * DAY_MS));

const labelOf = (day: number, bucket: TimeBucket): string => {
  if (bucket === "day") {
    return isoDate(day);
  }

  if (bucket === "month") {
    return isoDate(day).slice(0, 7);
  }

  const weekday = (((day + MONDAY_OFFSET) % WEEK_DAYS) + WEEK_DAYS) % WEEK_DAYS;

  return isoDate(day - weekday);
};

export const zoneClock = (tz: string): ZoneClock => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: tz,
    year: "numeric",
  });

  const exact = (at: number): number => {
    const parts = new Map<string, number>();

    for (const part of formatter.formatToParts(at)) {
      if (PART_NAMES.has(part.type)) {
        parts.set(part.type, Number(part.value));
      }
    }

    return (
      Date.UTC(
        parts.get("year") ?? 1970,
        (parts.get("month") ?? 1) - 1,
        parts.get("day") ?? 1,
        parts.get("hour") ?? 0,
        parts.get("minute") ?? 0,
        parts.get("second") ?? 0
      ) - at
    );
  };

  const hours = new Map<number, number | null>();
  const quarters = new Map<number, number>();
  const labels = new Map<TimeBucket, Map<number, string>>();

  const quarterOffset = (quarter: number): number => {
    const cached = quarters.get(quarter);

    if (cached !== undefined) {
      return cached;
    }

    const offset = exact(quarter * QUARTER_MS);
    quarters.set(quarter, offset);

    return offset;
  };

  const offsetAt = (ms: number): number => {
    const hour = Math.floor(ms / HOUR_MS);
    let steady = hours.get(hour);

    if (steady === undefined) {
      const start = exact(hour * HOUR_MS);

      steady =
        start === exact((hour + 1) * HOUR_MS - QUARTER_MS) ? start : null;
      hours.set(hour, steady);
    }

    return steady ?? quarterOffset(Math.floor(ms / QUARTER_MS));
  };

  const dayOf = (ms: number): number =>
    Math.floor((ms + offsetAt(ms)) / DAY_MS);

  const bucketOf = (ms: number, bucket: TimeBucket): string => {
    const quarter = Math.floor(ms / QUARTER_MS);
    const perQuarter = labels.get(bucket) ?? new Map<number, string>();
    const cached = perQuarter.get(quarter);

    if (cached !== undefined) {
      return cached;
    }

    const label = labelOf(dayOf(quarter * QUARTER_MS), bucket);

    perQuarter.set(quarter, label);
    labels.set(bucket, perQuarter);

    return label;
  };

  const localMidnight = (date: string): number | null => {
    const match = DATE_ONLY.exec(date);

    if (match === null) {
      return null;
    }

    const guess = Date.UTC(
      Number(match.groups?.year),
      Number(match.groups?.month) - 1,
      Number(match.groups?.day)
    );

    const candidate = guess - offsetAt(guess - offsetAt(guess));
    const day = guess / DAY_MS;

    if (dayOf(candidate) >= day) {
      return candidate;
    }

    const first = Math.floor(candidate / QUARTER_MS) + 1;

    for (let quarter = first; quarter <= first + GAP_QUARTERS; quarter += 1) {
      if (dayOf(quarter * QUARTER_MS) >= day) {
        return quarter * QUARTER_MS;
      }
    }

    return candidate;
  };

  return { bucketOf, dayOf, localMidnight, offsetAt, tz };
};
