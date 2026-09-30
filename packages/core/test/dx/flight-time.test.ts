// @effect-diagnostics nodeBuiltinImport:off -- Fixture-driven test: it reads committed fixtures and spools hook records into a scratch directory.
// @effect-diagnostics globalDate:off -- The hook handler contract takes a plain capture Date supplied by the hook process.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  CURSOR_CLI_ADAPTER_ID,
  cursorCliCollector,
} from "../../src/dx/collectors/cursor-cli/collector.js";
import { cursorHooksCollector } from "../../src/dx/collectors/cursor-hooks/collector.js";
import { handleCursorHook } from "../../src/dx/collectors/cursor-hooks/handler.js";
import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import { flightTimeMetric } from "../../src/dx/metrics/flight-time/metric.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import type { MetricResult } from "../../src/dx/model/metric.js";
import {
  MetricResultSchema,
  isHonestMetric,
} from "../../src/dx/model/metric.js";
import { SnapshotManifestSchema } from "../../src/dx/model/snapshot.js";
import { allMetrics } from "../../src/dx/registry/registry.js";

const fixtures = path.join(import.meta.dirname, "fixtures");

const scratch = mkdtempSync(path.join(tmpdir(), "dft-flight-time-"));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const GoldenSchema = Schema.Struct({
  batches: Schema.Array(EventBatchSchema),
  snapshot: SnapshotManifestSchema,
});

const golden = Schema.decodeUnknownSync(GoldenSchema)(
  JSON.parse(
    readFileSync(
      path.join(fixtures, "core", "core-golden-flight.json"),
      "utf-8"
    )
  )
);

const snapshotOf = (
  events: readonly DxEventEnvelope[],
  createdAt = golden.snapshot.createdAt
): StoreSnapshot => ({
  coverage: [],
  events,
  manifest: { ...golden.snapshot, createdAt },
});

const byId = (results: readonly MetricResult[]) =>
  Object.fromEntries(results.map((r) => [r.metricId, r]));

const run = (snapshot: StoreSnapshot) =>
  byId(flightTimeMetric.compute(snapshot).results);

const spoolHooks = (): string => {
  const spoolDir = path.join(scratch, "hooks");

  const lines = readFileSync(
    path.join(fixtures, "b05", "agent-turns.jsonl"),
    "utf-8"
  )
    .split("\n")
    .filter((line) => line !== "");

  for (const [index, line] of lines.entries()) {
    handleCursorHook(line, {
      cwd: "/fixture/workspace",
      now: new Date(Date.UTC(2026, 8, 30, 12, 0, index)),
      resolveGit: () => ({
        branch: "feature/fixture",
        headSha: "0000000000000000000000000000000000000001",
        repoCommonDir: "/fixture/workspace/.git",
        worktreePath: "/fixture/workspace",
      }),
      spoolDirFor: () => spoolDir,
    });
  }

  return spoolDir;
};

const hookEvents = Effect.gen(function* hooks() {
  const spoolDir = spoolHooks();

  const batch = yield* cursorHooksCollector.collect({
    adapterId: "cursor-hooks",
    context: emptyFlightContext,
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput: spoolDir,
  });

  return batch.events;
});

const cliEvents = cursorCliCollector
  .collect({
    adapterId: CURSOR_CLI_ADAPTER_ID,
    context: { ...emptyFlightContext, branch: "feature/b10-demo" },
    cursor: null,
    origin: "fixture",
    scratchDir: null,
    selectedInput: path.join(fixtures, "b10", "stream.jsonl"),
  })
  .pipe(
    Effect.map((batch) => batch.events),
    Effect.provide(NodeServices.layer)
  );

describe("flight-time metric", () => {
  it("is registered and emits schema-valid, honest results", () => {
    expect(allMetrics).toContain(flightTimeMetric);

    const { results } = flightTimeMetric.compute(
      snapshotOf(golden.batches.flatMap((b) => b.events))
    );

    expect(results.every(Schema.is(MetricResultSchema))).toBe(true);
    expect(results.every(isHonestMetric)).toBe(true);
  });

  it("measures branch age, commits and active time on the golden flight", () => {
    const r = run(snapshotOf(golden.batches.flatMap((b) => b.events)));

    expect(r["dx.flight.branch-age.ms"]?.value).toBe(3 * 3_600_000);
    expect(r["dx.flight.branch-age.ms"]?.measurement).toBe("partial");
    expect(r["dx.flight.branch-age.ms"]?.reason).toContain(
      "start=first-observed-activity@2026-09-30T09:00:00.000Z"
    );
    expect(r["dx.flight.branch-age.ms"]?.checkpoint).toBe(
      "branch:feature/fixture-flight"
    );
    expect(r["dx.flight.commits"]?.value).toBe(2);
    expect(r["dx.flight.first-commit-at"]?.value).toBe(
      Date.parse("2026-09-30T09:35:00.000Z")
    );
    expect(r["dx.flight.last-commit-at"]?.value).toBe(
      Date.parse("2026-09-30T10:20:00.000Z")
    );
    expect(r["dx.flight.active.ms"]?.value).toBe(45 * 60_000);
    expect(r["dx.flight.active.intervals"]?.value).toBe(2);
    expect(r["dx.flight.agent.ms"]?.value).toBeNull();
    expect(r["dx.flight.agent.ms"]?.measurement).toBe("unavailable");
    expect(r["dx.flight.tool-calls"]?.value).toBeNull();
    expect(r["dx.flight.tool-calls"]?.reason).toContain(
      "no tool-call evidence"
    );
  });

  it("prefers reflog creation and a merge time when present", () => {
    const events = golden.batches.flatMap((b) => b.events);
    const context = events.find((e) => e.kind === "git.context");
    const pr = events.find((e) => e.kind === "pr.metadata");

    expect(context).toBeDefined();
    expect(pr).toBeDefined();

    const patched = events.map((e) => {
      if (e === context) {
        return {
          ...e,
          payload: {
            ...e.payload,
            branchCreatedAt: "2026-09-30T08:00:00.000Z",
          },
        };
      }

      return e === pr
        ? {
            ...e,
            payload: { ...e.payload, mergedAt: "2026-09-30T11:00:00.000Z" },
          }
        : e;
    });

    const age = run(snapshotOf(patched))["dx.flight.branch-age.ms"];

    expect(age?.value).toBe(3 * 3_600_000);
    expect(age?.measurement).toBe("measured");
    expect(age?.method).toBe("observed");
    expect(age?.reason).toContain("end=merged");
  });

  it.effect("merges hook session intervals and counts postToolUse calls", () =>
    Effect.gen(function* hooks() {
      const events = yield* hookEvents;
      const r = run(snapshotOf(events, "2026-09-30T13:00:00.000Z"));

      expect(r["dx.flight.agent.ms"]?.value).toBe(90_000);
      expect(r["dx.flight.agent.ms"]?.evidenceIds.length).toBeGreaterThan(0);
      expect(r["dx.flight.tool-calls"]?.value).toBe(2);
      expect(r["dx.flight.commits"]?.measurement).toBe("unavailable");
      expect(r["dx.flight.commits"]?.value).toBeNull();
    })
  );

  it.effect(
    "counts cursor-cli tool calls and collapses a transcript duplicate",
    () =>
      Effect.gen(function* cli() {
        const events = yield* cliEvents;
        const alone = run(snapshotOf(events));
        const [first] = events;

        expect(alone["dx.flight.tool-calls"]?.value).toBe(2);
        expect(alone["dx.flight.agent.ms"]?.value).toBeGreaterThanOrEqual(5400);

        expect(first).toBeDefined();

        if (first === undefined) {
          return;
        }

        const transcriptCopy: DxEventEnvelope = {
          ...first,
          adapterId: "cursor-transcripts",
          eventId: EventIdSchema.make(`${first.eventId}-transcript`),
          payload: {
            ...first.payload,
            sourceKind: "transcript-estimate",
            toolCalls: 5,
          },
        };

        const r = run(snapshotOf([...events, transcriptCopy]));

        expect(r["dx.flight.tool-calls"]?.value).toBe(2);
        expect(r["dx.flight.tool-calls"]?.reason).toContain(
          "1 duplicate report(s) collapsed"
        );
        expect(r["dx.flight.agent.ms"]?.value).toBe(
          alone["dx.flight.agent.ms"]?.value
        );
      })
  );

  it("uses the oldest reflog entry and a complete empty history on a base branch", () => {
    const template = golden.batches
      .flatMap((b) => b.events)
      .find((e) => e.kind === "git.context");

    expect(template).toBeDefined();

    if (template === undefined) {
      return;
    }

    const observation: DxEventEnvelope = {
      ...template,
      adapterId: "git-history",
      eventId: EventIdSchema.make("reflog-oldest-fixture"),
      kind: "git.observation",
      payload: {
        branchCreatedAt: null,
        reflogOldestAt: "2026-09-30T11:00:00.000Z",
      },
    };

    const r = run({
      ...snapshotOf([observation]),
      coverage: [
        {
          adapterId: "git-history",
          expectedItems: 0,
          gaps: [],
          observedItems: 0,
          state: "complete",
          watermark: null,
          windowFrom: null,
          windowTo: null,
        },
      ],
    });

    expect(r["dx.flight.branch-age.ms"]?.value).toBe(3_600_000);
    expect(r["dx.flight.branch-age.ms"]?.reason).toContain(
      "start=reflog-oldest-entry"
    );
    expect(r["dx.flight.commits"]?.value).toBe(0);
    expect(r["dx.flight.first-commit-at"]?.value).toBeNull();
  });

  it("reports every metric unavailable with a reason on an empty snapshot", () => {
    const { results } = flightTimeMetric.compute(snapshotOf([]));

    expect(results.length).toBe(8);
    expect(
      results.every((r) => r.value === null && r.measurement === "unavailable")
    ).toBe(true);
    expect(results.every((r) => (r.reason ?? "") !== "")).toBe(true);
  });
});
