import { DateTime, Option, Schema } from "effect";

export type ReportFormat = "junit" | "vitest-json";

export interface ParsedTestReport {
  readonly durationMs: number | null;
  readonly errors: number;
  readonly failed: number;
  readonly failingTests: readonly string[];
  readonly format: ReportFormat;
  readonly passed: number;
  readonly skipped: number;
  readonly startedAt: string | null;
  readonly tests: number;
}

export const MAX_FAILING_TESTS = 25;

export const MAX_NAME_LENGTH = 200;

const ATTRIBUTE_PATTERN = /(?<key>[\w:.-]+)="(?<value>[^"]*)"/gu;

const TESTCASE_PATTERN =
  /<testcase\b(?<attrs>[^>]*?)(?:\/>|>(?<body>[\s\S]*?)<\/testcase>)/gu;

const SUITE_TIMESTAMP_PATTERN =
  /<testsuites?\b[^>]*?\btimestamp="(?<stamp>[^"]+)"/u;

const ROOT_TIME_PATTERN = /<testsuites\b[^>]*?\btime="(?<time>[^"]+)"/u;

const ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

const decodeEntities = (value: string): string =>
  value.replaceAll(
    /&(?<entity>amp|apos|gt|lt|quot);/gu,
    (_match, name: string) => ENTITIES.get(name) ?? ""
  );

const truncateName = (value: string): string =>
  value.length > MAX_NAME_LENGTH ? value.slice(0, MAX_NAME_LENGTH) : value;

const parseAttributes = (raw: string): ReadonlyMap<string, string> => {
  const attributes = new Map<string, string>();

  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const [, key, value] = match;

    if (key !== undefined && value !== undefined) {
      attributes.set(key, decodeEntities(value));
    }
  }

  return attributes;
};

const toIso = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null;
  }

  if (!/(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)) {
    return null;
  }

  const parsed = DateTime.make(value);

  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null;
};

const secondsToMs = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1000)
    : null;
};

type CaseStatus = "passed" | "failed" | "error" | "skipped";

const caseStatus = (body: string | undefined): CaseStatus => {
  if (body === undefined) {
    return "passed";
  }

  if (/<failure\b/u.test(body)) {
    return "failed";
  }

  if (/<error\b/u.test(body)) {
    return "error";
  }

  if (/<skipped\b/u.test(body)) {
    return "skipped";
  }

  return "passed";
};

export const parseJUnit = (content: string): ParsedTestReport | null => {
  if (!/<testsuites?\b/u.test(content)) {
    return null;
  }

  let passed = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  let caseTimeMs = 0;
  let caseTimeKnown = false;
  const failingTests: string[] = [];

  for (const match of content.matchAll(TESTCASE_PATTERN)) {
    const attributes = parseAttributes(match.groups?.attrs ?? "");
    const status = caseStatus(match.groups?.body);
    const time = secondsToMs(attributes.get("time"));

    if (time !== null) {
      caseTimeMs += time;
      caseTimeKnown = true;
    }

    if (status === "passed") {
      passed += 1;
    } else if (status === "skipped") {
      skipped += 1;
    } else {
      if (status === "failed") {
        failed += 1;
      } else {
        errors += 1;
      }

      const classname = attributes.get("classname");
      const name = attributes.get("name") ?? "(unnamed)";
      failingTests.push(
        truncateName(classname === undefined ? name : `${classname} > ${name}`)
      );
    }
  }

  const rootTime = secondsToMs(ROOT_TIME_PATTERN.exec(content)?.groups?.time);

  return {
    durationMs: rootTime ?? (caseTimeKnown ? caseTimeMs : null),
    errors,
    failed,
    failingTests,
    format: "junit",
    passed,
    skipped,
    startedAt: toIso(SUITE_TIMESTAMP_PATTERN.exec(content)?.groups?.stamp),
    tests: passed + failed + errors + skipped,
  };
};

const AssertionSchema = Schema.Struct({
  fullName: Schema.optionalKey(Schema.String),
  status: Schema.String,
  title: Schema.optionalKey(Schema.String),
});

const TestFileSchema = Schema.Struct({
  assertionResults: Schema.optionalKey(Schema.Array(AssertionSchema)),
  endTime: Schema.optionalKey(Schema.Finite),
});

const StructuredReportSchema = Schema.Struct({
  startTime: Schema.optionalKey(Schema.Finite),
  testResults: Schema.Array(TestFileSchema),
});

const decodeStructured = Schema.decodeUnknownOption(
  Schema.fromJsonString(StructuredReportSchema)
);

const spanMs = (start: number | undefined, end: number | null) => {
  if (start === undefined || end === null || end < start) {
    return null;
  }

  return Math.round(end - start);
};

export const parseStructuredJson = (
  content: string
): ParsedTestReport | null => {
  const decoded = decodeStructured(content);

  if (Option.isNone(decoded)) {
    return null;
  }

  const report = decoded.value;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let lastEnd: number | null = null;
  const failingTests: string[] = [];

  for (const file of report.testResults) {
    if (
      file.endTime !== undefined &&
      (lastEnd === null || file.endTime > lastEnd)
    ) {
      lastEnd = file.endTime;
    }

    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "passed") {
        passed += 1;
      } else if (assertion.status === "failed") {
        failed += 1;
        failingTests.push(
          truncateName(assertion.fullName ?? assertion.title ?? "(unnamed)")
        );
      } else {
        skipped += 1;
      }
    }
  }

  return {
    durationMs: spanMs(report.startTime, lastEnd),
    errors: 0,
    failed,
    failingTests,
    format: "vitest-json",
    passed,
    skipped,
    startedAt:
      report.startTime === undefined
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(report.startTime)),
    tests: passed + failed + skipped,
  };
};
