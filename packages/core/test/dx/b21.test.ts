// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B21 fixture files from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  buildLocalTestBatch,
  localTestCollector,
  localTestDescriptor,
} from "../../src/dx/collectors/local-test/collector.js";
import {
  joinReport,
  parseCommandSessions,
} from "../../src/dx/collectors/local-test/command-session.js";
import {
  parseJUnit,
  parseStructuredJson,
} from "../../src/dx/collectors/local-test/report.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "b21");

const fixture = (relative: string) =>
  readFileSync(path.join(fixtureDir, relative), "utf-8");

const input = (selectedInput: string | null): CollectInput => ({
  adapterId: "local-test",
  context: { ...emptyFlightContext, branch: "main" },
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const OBSERVED = "2026-09-30T12:00:00.000Z";

const payloadOf = (
  batch: ReturnType<typeof buildLocalTestBatch>,
  kind: string,
  sessionId: string | null
) =>
  batch.events.find(
    (event) => event.kind === kind && event.identity.sessionId === sessionId
  )?.payload;

describe("B21 local-test report parsing", () => {
  it("parses real vitest JUnit output", () => {
    const report = parseJUnit(fixture("pass/vitest-junit.xml"));
    expect(report).toMatchObject({
      errors: 0,
      failed: 0,
      format: "junit",
      passed: 2,
      skipped: 0,
      startedAt: "2026-09-30T12:07:06.344Z",
      tests: 2,
    });
    expect(report?.durationMs).toBe(1);
  });

  it("counts failures, errors and skips and decodes names", () => {
    const report = parseJUnit(fixture("joined/junit-failures.xml"));
    expect(report).toMatchObject({
      durationMs: 1500,
      errors: 1,
      failed: 1,
      passed: 1,
      skipped: 1,
      tests: 4,
    });
    expect(report?.failingTests).toEqual([
      'test/cart.test.ts > cart > applies "discount"',
      "test/cart.test.ts > cart > loads catalog",
    ]);
  });

  it("parses real vitest JSON output", () => {
    const report = parseStructuredJson(fixture("pass/vitest-report.json"));

    expect(report).toMatchObject({
      failed: 0,
      format: "vitest-json",
      passed: 2,
      tests: 2,
    });
    expect(report?.startedAt).not.toBeNull();
  });

  it("leaves zone-less JUnit timestamps unavailable", () => {
    const report = parseJUnit(
      '<testsuite timestamp="2026-09-30T11:00:30"><testcase name="a"/></testsuite>'
    );

    expect(report?.startedAt).toBeNull();
    expect(report?.durationMs).toBeNull();
  });

  it("rejects non-report input", () => {
    expect(parseJUnit("<html></html>")).toBeNull();
    expect(parseStructuredJson('{"numTotalTests":3}')).toBeNull();
  });
});

describe("B21 command sessions", () => {
  it("keeps valid records, rejects others and redacts secrets", () => {
    const parsed = parseCommandSessions(fixture("joined/commands.jsonl"));
    expect(parsed.rejected).toBe(2);
    expect(parsed.sessions.map((session) => session.sessionId)).toEqual([
      "cmd-1",
      "cmd-2",
      "cmd-3",
    ]);
    const [first] = parsed.sessions;
    expect(first?.commandDisplay).toContain("API_TOKEN=[redacted]");
    expect(first?.commandDisplay).not.toContain("abc123");
    expect(parsed.sessions[2]?.isTestCommand).toBe(false);
  });

  it("refuses ambiguous time-window joins", () => {
    const { sessions } = parseCommandSessions(fixture("joined/commands.jsonl"));
    const [first] = sessions;

    if (first === undefined) {
      throw new Error("fixture missing");
    }

    const twin = { ...first, reports: [], sessionId: "cmd-twin" };

    const joined = joinReport("unlisted.xml", "2026-09-30T10:15:02.000Z", [
      { ...first, reports: [] },
      twin,
    ]);

    expect(joined).toEqual({
      attribution: "unassigned",
      method: "none",
      session: null,
    });
  });
});

describe("B21 batch", () => {
  const files = [
    "commands.jsonl",
    "junit-failures.xml",
    "nightly-junit.xml",
  ].map((name) => ({ content: fixture(`joined/${name}`), name }));

  it("joins reports to command sessions and stays schema-valid", () => {
    const batch = buildLocalTestBatch(files, input(null), OBSERVED);
    expect(Schema.is(EventBatchSchema)(batch)).toBe(true);
    expect(
      batch.events.filter((event) => event.kind === "command.run")
    ).toHaveLength(3);
    const declared = payloadOf(batch, "test.result", "cmd-1");
    expect(declared).toMatchObject({
      failed: 1,
      joinAttribution: "strong",
      joinMethod: "declared-report",
      status: "failed",
    });
    const windowed = payloadOf(batch, "test.result", "cmd-2");
    expect(windowed).toMatchObject({
      joinAttribution: "provisional",
      joinMethod: "time-window",
      status: "passed",
    });

    const joinedEvent = batch.events.find(
      (event) =>
        event.identity.sessionId === "cmd-1" && event.kind === "test.result"
    );

    expect(joinedEvent?.context.branch).toBe("feature/cart");
    expect(payloadOf(batch, "command.run", "cmd-3")).toMatchObject({
      durationMs: null,
      exitCode: null,
      status: "unknown",
    });
    expect(batch.coverage.gaps.map((gap) => gap.code)).toEqual([
      "command-session-rejected",
    ]);
    expect(batch.coverage.state).toBe("complete");
  });

  it("produces stable event ids on re-import", () => {
    const first = buildLocalTestBatch(files, input(null), OBSERVED);

    const second = buildLocalTestBatch(
      files,
      input(null),
      "2027-01-01T00:00:00.000Z"
    );

    expect(second.events.map((event) => event.eventId)).toEqual(
      first.events.map((event) => event.eventId)
    );
  });

  it("reports unrecognized files and missing sessions as gaps", () => {
    const batch = buildLocalTestBatch(
      [{ content: "{}", name: "random.json" }],
      input(null),
      OBSERVED
    );

    expect(batch.events).toHaveLength(0);
    expect(batch.coverage.state).toBe("none");
    expect(batch.coverage.gaps.map((gap) => gap.code)).toEqual([
      "report-unrecognized",
      "command-sessions-absent",
    ]);
  });
});

describe("B21 collector", () => {
  it("has a schema-valid degraded descriptor", () => {
    expect(Schema.is(ModuleDescriptorSchema)(localTestDescriptor)).toBe(true);
    expect(localTestDescriptor.readiness).toBe("degraded");
  });

  it.effect("collects a selected fixture directory", () =>
    Effect.gen(function* collectsDirectory() {
      const batch = yield* localTestCollector.collect(
        input(path.join(fixtureDir, "joined"))
      );

      expect(batch.events).toHaveLength(5);
      expect(batch.coverage.observedItems).toBe(3);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("requires an explicitly selected input", () =>
    Effect.gen(function* requiresInput() {
      const error = yield* Effect.flip(localTestCollector.collect(input(null)));
      expect(error._tag).toBe("InvalidInput");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("fails with SourceUnavailable for a missing path", () =>
    Effect.gen(function* missingPath() {
      const error = yield* Effect.flip(
        localTestCollector.collect(input(path.join(fixtureDir, "missing")))
      );

      expect(error._tag).toBe("SourceUnavailable");
    }).pipe(Effect.provide(NodeServices.layer))
  );
});
