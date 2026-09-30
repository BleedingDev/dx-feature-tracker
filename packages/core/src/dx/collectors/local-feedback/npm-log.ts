import type { FeedbackAdapter, FeedbackRecord } from "./registry.js";
import { linesOf } from "./registry.js";

const MAX_TIMERS = 40;

const NPM_VERSION_PATTERN = /^\d+ info using npm@(?<version>\S+)$/u;

const NODE_VERSION_PATTERN = /^\d+ info using node@(?<version>\S+)$/u;

const TITLE_PATTERN = /^\d+ verbose title npm (?<command>\S+)/u;

const EXIT_PATTERN = /^\d+ verbose exit (?<code>-?\d+)$/u;

const FETCH_PATTERN = /^\d+ http fetch \S+ \d+ \S+ (?<ms>\d+)ms/u;

const TIMING_PATTERN = /^\d+ timing (?<name>\S+) Completed in (?<ms>\d+)ms$/u;

const FILE_TIME_PATTERN =
  /(?<date>\d{4}-\d{2}-\d{2})T(?<h>\d{2})_(?<m>\d{2})_(?<s>\d{2})_(?<ms>\d{3})Z-debug/u;

export interface NpmLogSummary {
  readonly command: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly httpFetchCount: number;
  readonly httpFetchMs: number;
  readonly nodeVersion: string | null;
  readonly npmVersion: string | null;
  readonly timers: Readonly<Record<string, number>>;
}

interface NpmLogAccumulator {
  command: string | null;
  exitCode: number | null;
  httpFetchCount: number;
  httpFetchMs: number;
  nodeVersion: string | null;
  npmVersion: string | null;
  readonly timers: Record<string, number>;
}

const readHeader = (acc: NpmLogAccumulator, line: string): void => {
  acc.npmVersion ??= NPM_VERSION_PATTERN.exec(line)?.groups?.version ?? null;
  acc.nodeVersion ??= NODE_VERSION_PATTERN.exec(line)?.groups?.version ?? null;
  acc.command ??= TITLE_PATTERN.exec(line)?.groups?.command ?? null;
};

const readExit = (acc: NpmLogAccumulator, line: string): void => {
  const exit = EXIT_PATTERN.exec(line)?.groups?.code;

  if (exit !== undefined) {
    acc.exitCode = Number(exit);
  }
};

const readFetch = (acc: NpmLogAccumulator, line: string): void => {
  const fetchMs = FETCH_PATTERN.exec(line)?.groups?.ms;

  if (fetchMs !== undefined) {
    acc.httpFetchCount += 1;
    acc.httpFetchMs += Number(fetchMs);
  }
};

const readTiming = (acc: NpmLogAccumulator, line: string): void => {
  const timing = TIMING_PATTERN.exec(line)?.groups;

  if (
    timing?.name !== undefined &&
    timing.ms !== undefined &&
    Object.keys(acc.timers).length < MAX_TIMERS
  ) {
    acc.timers[timing.name] = Number(timing.ms);
  }
};

export const parseNpmDebugLog = (content: string): NpmLogSummary => {
  const acc: NpmLogAccumulator = {
    command: null,
    exitCode: null,
    httpFetchCount: 0,
    httpFetchMs: 0,
    nodeVersion: null,
    npmVersion: null,
    timers: {},
  };

  for (const raw of linesOf(content)) {
    const line = raw.trim();
    readHeader(acc, line);
    readExit(acc, line);
    readFetch(acc, line);
    readTiming(acc, line);
  }

  return { ...acc, durationMs: acc.timers.npm ?? null };
};

const statusOf = (exitCode: number | null): string => {
  if (exitCode === null) {
    return "unknown";
  }

  return exitCode === 0 ? "passed" : "failed";
};

export const npmLogTimeOf = (name: string): string | null => {
  const groups = FILE_TIME_PATTERN.exec(name)?.groups;

  if (groups === undefined) {
    return null;
  }

  return `${groups.date}T${groups.h}:${groups.m}:${groups.s}.${groups.ms}Z`;
};

const detect = (_name: string, content: string): boolean =>
  linesOf(content)
    .slice(0, 5)
    .some((line) => NPM_VERSION_PATTERN.test(line.trim()));

const parse = (name: string, content: string): FeedbackRecord[] => {
  const summary = parseNpmDebugLog(content);
  const occurredAt = npmLogTimeOf(name);

  return [
    {
      fieldSemantics: [
        {
          field: "durationMs",
          method: "source-reported",
          note: "npm 'timing npm Completed in' line; null unless npm ran with --timing",
          rawName: "timing npm",
          unit: "ms",
        },
        {
          field: "exitCode",
          method: "source-reported",
          note: null,
          rawName: "verbose exit",
          unit: null,
        },
        {
          field: "httpFetchMs",
          method: "derived",
          note: "sum of per-request fetch durations; requests may overlap, so this is not wall time",
          rawName: "http fetch",
          unit: "ms",
        },
      ],
      occurredAt,
      occurredAtPrecision: occurredAt === null ? "unknown" : "exact",
      payload: {
        command: summary.command,
        durationMs: summary.durationMs,
        durationReason:
          summary.durationMs === null
            ? "npm did not log a total timer (run with --timing)"
            : null,
        exitCode: summary.exitCode,
        httpFetchCount: summary.httpFetchCount,
        httpFetchMs: summary.httpFetchMs,
        nodeVersion: summary.nodeVersion,
        occurredAtMethod:
          occurredAt === null ? "unavailable" : "npm-log-file-name",
        reportName: name,
        status: statusOf(summary.exitCode),
        subroute: "npm-timing",
        timers: summary.timers,
        tool: "npm",
      },
      sourceVersion:
        summary.npmVersion === null ? null : `npm@${summary.npmVersion}`,
    },
  ];
};

export const npmLogAdapter: FeedbackAdapter = {
  detect,
  id: "npm-debug-log",
  parse,
  subroute: "npm-timing",
  version: "1.0.0",
};
