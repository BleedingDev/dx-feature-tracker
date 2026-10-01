// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { SourceCoverage, SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FieldSemantics,
} from "../../model/event.js";
import { emptyEventIdentity } from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import { joinReport, parseCommandSessions } from "./command-session.js";
import type { CommandSession, SessionJoin } from "./command-session.js";
import {
  MAX_FAILING_TESTS,
  parseJUnit,
  parseStructuredJson,
} from "./report.js";
import type { ParsedTestReport } from "./report.js";

export const LOCAL_TEST_ADAPTER_ID = "local-test";

export const LOCAL_TEST_ADAPTER_VERSION = "1.0.0";

export const B21_FIXTURE_IDS = [
  "b21-vitest-junit-pass",
  "b21-junit-failures",
  "b21-vitest-json",
  "b21-command-sessions",
] as const;

export const localTestDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...B21_FIXTURE_IDS],
  gaps: [
    {
      code: "command-session-producer-missing",
      message:
        "No wrapper writes dx.local-test.command.v1 JSONL yet; command joins only work when such a file is supplied.",
    },
    {
      code: "explicit-input-only",
      message:
        "Reports are imported only from an explicitly selected file or directory; test runs that write no report are not observed.",
    },
  ],
  id: DescriptorIdSchema.make("collector/local-test"),
  kind: "collector",
  owner: "B21",
  readiness: "degraded",
  requiredInputs: [
    "selectedInput: JUnit XML, vitest/jest JSON report, or dx.local-test.command.v1 JSONL (file or directory)",
  ],
  supportedFields: [
    "test.result.tests",
    "test.result.passed",
    "test.result.failed",
    "test.result.errors",
    "test.result.skipped",
    "test.result.durationMs",
    "test.result.failingTests",
    "test.result.commandSessionId",
    "command.run.exitCode",
    "command.run.durationMs",
    "command.run.isTestCommand",
  ],
  version: LOCAL_TEST_ADAPTER_VERSION,
};

export interface LocalTestFile {
  readonly content: string;
  readonly name: string;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const eventIdFor = (upstreamKey: string, kind: string) =>
  EventIdSchema.make(
    sha256(`${LOCAL_TEST_ADAPTER_ID}\n${upstreamKey}\n${kind}`)
  );

const sourceReported = (
  field: string,
  unit: string | null,
  rawName: string | null
): FieldSemantics => ({
  field,
  method: "source-reported",
  note: null,
  rawName,
  unit,
});

const durationOf = (session: CommandSession): number | null => {
  if (session.startedAt === null || session.endedAt === null) {
    return null;
  }

  const value =
    DateTime.toEpochMillis(DateTime.makeUnsafe(session.endedAt)) -
    DateTime.toEpochMillis(DateTime.makeUnsafe(session.startedAt));

  return value >= 0 ? value : null;
};

const commandStatus = (exitCode: number | null): string => {
  if (exitCode === null) {
    return "unknown";
  }

  return exitCode === 0 ? "passed" : "failed";
};

const occurredAtMethodOf = (
  report: ParsedTestReport,
  join: SessionJoin
): string => {
  if (report.startedAt !== null) {
    return "report-timestamp";
  }

  return join.session === null ? "unavailable" : "command-session-end";
};

const coverageState = (
  observedItems: number,
  total: number
): SourceCoverage["state"] => {
  if (observedItems === 0) {
    return "none";
  }

  return observedItems === total ? "complete" : "partial";
};

const commandEvent = (
  session: CommandSession,
  input: CollectInput,
  observedAt: string,
  evidenceHash: string,
  fileName: string
): DxEventEnvelope => {
  const upstreamKey = `command:${session.sessionId}`;

  const status = commandStatus(session.exitCode);

  return {
    acquisition: "command-capture",
    adapterId: LOCAL_TEST_ADAPTER_ID,
    adapterVersion: LOCAL_TEST_ADAPTER_VERSION,
    ai: null,
    context: {
      ...input.context,
      branch: session.branch ?? input.context.branch,
      headSha: session.headSha ?? input.context.headSha,
    },
    eventId: eventIdFor(upstreamKey, "command.run"),
    evidence: { bounded: true, hash: evidenceHash, ref: fileName },
    fieldSemantics: [
      sourceReported("exitCode", null, "exitCode"),
      {
        field: "durationMs",
        method: "derived",
        note: "endedAt - startedAt",
        rawName: null,
        unit: "ms",
      },
      {
        field: "isTestCommand",
        method: "derived",
        note: "argv matched a known test-runner pattern",
        rawName: null,
        unit: null,
      },
    ],
    identity: { ...emptyEventIdentity, sessionId: session.sessionId },
    kind: "command.run",
    observedAt,
    occurredAt: session.startedAt,
    occurredAtPrecision: session.startedAt === null ? "unknown" : "exact",
    origin: input.origin,
    payload: {
      commandDisplay: session.commandDisplay,
      commandName: session.commandName,
      durationMs: durationOf(session),
      endedAt: session.endedAt,
      exitCode: session.exitCode,
      isTestCommand: session.isTestCommand,
      reports: session.reports,
      status,
    },
    schemaVersion: "dx.event.v2",
    sourceVersion: "dx.local-test.command.v1",
    upstreamKey,
    usage: null,
  };
};

const reportEvent = (
  report: ParsedTestReport,
  join: SessionJoin,
  input: CollectInput,
  observedAt: string,
  evidenceHash: string,
  fileName: string
): DxEventEnvelope => {
  const upstreamKey = `report:${evidenceHash}`;
  const occurredAt = report.startedAt ?? join.session?.endedAt ?? null;

  const occurredAtMethod = occurredAtMethodOf(report, join);

  const failingTests = report.failingTests.slice(0, MAX_FAILING_TESTS);

  return {
    acquisition: "file-import",
    adapterId: LOCAL_TEST_ADAPTER_ID,
    adapterVersion: LOCAL_TEST_ADAPTER_VERSION,
    ai: null,
    context: {
      ...input.context,
      branch: join.session?.branch ?? input.context.branch,
      headSha: join.session?.headSha ?? input.context.headSha,
    },
    eventId: eventIdFor(upstreamKey, "test.result"),
    evidence: { bounded: true, hash: evidenceHash, ref: fileName },
    fieldSemantics: [
      sourceReported("tests", "count", null),
      sourceReported("passed", "count", null),
      sourceReported("failed", "count", "failure"),
      sourceReported("errors", "count", "error"),
      sourceReported("skipped", "count", "skipped"),
      sourceReported(
        "durationMs",
        "ms",
        report.format === "junit" ? "time" : "endTime-startTime"
      ),
    ],
    identity: {
      ...emptyEventIdentity,
      sessionId: join.session?.sessionId ?? null,
    },
    kind: "test.result",
    observedAt,
    occurredAt,
    occurredAtPrecision: occurredAt === null ? "unknown" : "second",
    origin: input.origin,
    payload: {
      commandSessionId: join.session?.sessionId ?? null,
      durationMs: report.durationMs,
      errors: report.errors,
      failed: report.failed,
      failingTests,
      failingTestsTruncated: report.failingTests.length > failingTests.length,
      joinAttribution: join.attribution,
      joinMethod: join.method,
      occurredAtMethod,
      passed: report.passed,
      reportFormat: report.format,
      reportName: fileName,
      skipped: report.skipped,
      status: report.failed + report.errors > 0 ? "failed" : "passed",
      tests: report.tests,
    },
    schemaVersion: "dx.event.v2",
    sourceVersion: report.format,
    upstreamKey,
    usage: null,
  };
};

const parseReport = (file: LocalTestFile): ParsedTestReport | null => {
  if (file.name.endsWith(".xml")) {
    return parseJUnit(file.content);
  }

  if (file.name.endsWith(".json")) {
    return parseStructuredJson(file.content);
  }

  return null;
};

const isSessionFile = (name: string): boolean => name.endsWith(".jsonl");

export const isCandidateFile = (name: string): boolean =>
  name.endsWith(".xml") || name.endsWith(".json") || isSessionFile(name);

export const buildLocalTestBatch = (
  files: readonly LocalTestFile[],
  input: CollectInput,
  observedAt: string
): EventBatch => {
  const gaps: SourceGap[] = [];
  const events: DxEventEnvelope[] = [];
  const sessions: CommandSession[] = [];
  let observedItems = 0;
  const sessionFiles = files.filter((file) => isSessionFile(file.name));
  const reportFiles = files.filter((file) => !isSessionFile(file.name));

  for (const file of sessionFiles) {
    const hash = sha256(file.content);
    const parsed = parseCommandSessions(file.content);

    if (parsed.rejected > 0) {
      gaps.push({
        code: "command-session-rejected",
        message: `${file.name}: ${parsed.rejected} line(s) were not dx.local-test.command.v1 records`,
      });
    }

    if (parsed.sessions.length > 0) {
      observedItems += 1;
    }

    for (const session of parsed.sessions) {
      sessions.push(session);
      events.push(commandEvent(session, input, observedAt, hash, file.name));
    }
  }

  for (const file of reportFiles) {
    const report = parseReport(file);

    if (report === null) {
      gaps.push({
        code: "report-unrecognized",
        message: `${file.name}: not a JUnit XML or vitest/jest JSON report`,
      });
      continue;
    }

    observedItems += 1;
    const join = joinReport(file.name, report.startedAt, sessions);
    events.push(
      reportEvent(
        report,
        join,
        input,
        observedAt,
        sha256(file.content),
        file.name
      )
    );
  }

  if (sessionFiles.length === 0) {
    gaps.push({
      code: "command-sessions-absent",
      message:
        "No command session file supplied; test results are not joined to commands.",
    });
  }

  const times = events
    .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
    .toSorted();

  const coverage: SourceCoverage = {
    adapterId: input.adapterId,
    expectedItems: files.length,
    gaps,
    observedItems,
    state: coverageState(observedItems, files.length),
    watermark: null,
    windowFrom: times[0] ?? null,
    windowTo: times.at(-1) ?? null,
  };

  return { coverage, cursor: null, events };
};

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: LOCAL_TEST_ADAPTER_ID, message });

const readFiles = Effect.fn("LocalTest.readFiles")(function* readFiles(
  path: string
) {
  const fileSystem = yield* FileSystem.FileSystem;

  const info = yield* fileSystem
    .stat(path)
    .pipe(Effect.mapError(() => unavailable("selected input is not readable")));

  if (info.type === "File") {
    const content = yield* fileSystem
      .readFileString(path)
      .pipe(
        Effect.mapError(() => unavailable("selected file is not readable"))
      );

    return [{ content, name: path.split(/[\\/]/u).at(-1) ?? path }];
  }

  if (info.type !== "Directory") {
    return yield* unavailable(
      "selected input is neither a file nor a directory"
    );
  }

  const names = yield* fileSystem
    .readDirectory(path)
    .pipe(
      Effect.mapError(() => unavailable("selected directory is not readable"))
    );

  const files: LocalTestFile[] = [];

  for (const name of names.filter(isCandidateFile).toSorted()) {
    const content = yield* fileSystem
      .readFileString(`${path}/${name}`)
      .pipe(Effect.mapError(() => unavailable(`${name} is not readable`)));

    files.push({ content, name });
  }

  return files;
});

export const collectLocalTest = Effect.fn("LocalTest.collect")(
  function* collectLocalTest(input: CollectInput) {
    if (input.selectedInput === null) {
      return yield* new InvalidInput({
        field: "selectedInput",
        message:
          "local-test requires an explicitly selected report file or directory",
      });
    }

    const files = yield* readFiles(input.selectedInput);
    const observedAt = DateTime.formatIso(yield* DateTime.now);

    return buildLocalTestBatch(files, input, observedAt);
  }
);

export const localTestCollector: DxCollector<FileSystem.FileSystem> = {
  collect: collectLocalTest,
  descriptor: localTestDescriptor,
};
