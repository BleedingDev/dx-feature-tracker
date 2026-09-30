// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B48 fixture files from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  buildLocalFeedbackBatch,
  localFeedbackCollector,
  localFeedbackDescriptor,
} from "../../src/dx/collectors/local-feedback/collector.js";
import { parseNpmDebugLog } from "../../src/dx/collectors/local-feedback/npm-log.js";
import { parseTscOutput } from "../../src/dx/collectors/local-feedback/tsc.js";
import { parseViteLog } from "../../src/dx/collectors/local-feedback/vite-log.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "b48");

const NPM_PLAIN = "2026-09-30T12_01_34_564Z-debug-0.log.txt";

const NPM_TIMING = "2026-09-30T12_10_00_000Z-debug-0.log.txt";

const fixture = (name: string) => ({
  content: readFileSync(path.join(fixtureDir, name), "utf-8"),
  name,
});

const input = (selectedInput: string | null): CollectInput => ({
  adapterId: "local-feedback",
  context: { ...emptyFlightContext, branch: "feature/cart" },
  cursor: null,
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

const OBSERVED = "2026-09-30T12:30:00.000Z";

const gapCodes = (batch: ReturnType<typeof buildLocalFeedbackBatch>) =>
  batch.coverage.gaps.map((gap) => gap.code);

describe("B48 local-feedback adapters", () => {
  it("parses plain tsc diagnostics without a summary line", () => {
    const summary = parseTscOutput(fixture("tsc-plain.txt").content);
    expect(summary).toMatchObject({
      codeCounts: { TS2304: 1, TS2322: 2 },
      errorCount: 3,
      fileCount: 2,
      reportedErrorCount: null,
      warningCount: 0,
    });
    expect(summary.diagnostics[0]).toMatchObject({
      column: 5,
      file: "src/cart.ts",
      line: 12,
    });
  });

  it("parses ANSI-colored pretty tsc output and its Found line", () => {
    const summary = parseTscOutput(fixture("tsc-pretty.txt").content);
    expect(summary).toMatchObject({
      codeCounts: { TS2345: 1 },
      errorCount: 1,
      reportedErrorCount: 1,
    });
  });

  it("keeps npm duration unavailable without --timing", () => {
    const summary = parseNpmDebugLog(fixture(NPM_PLAIN).content);
    expect(summary).toMatchObject({
      command: "view",
      durationMs: null,
      exitCode: 0,
      httpFetchCount: 1,
      httpFetchMs: 97,
      npmVersion: "11.19.1",
    });
  });

  it("reads npm timers and failing exit when --timing was used", () => {
    const summary = parseNpmDebugLog(fixture(NPM_TIMING).content);
    expect(summary).toMatchObject({
      command: "install",
      durationMs: 1210,
      exitCode: 1,
      httpFetchCount: 2,
      httpFetchMs: 100,
      timers: { npm: 1210, "npm:load": 14, reify: 820 },
    });
  });

  it("counts Vite HMR updates including repeat suffixes", () => {
    const summary = parseViteLog(fixture("vite-dev.txt").content);
    expect(summary).toMatchObject({
      firstClock: "2:14:05 PM",
      hmrInvalidations: 1,
      hmrUpdates: 3,
      lastClock: "2:15:30 PM",
      moduleCount: 3,
      pageReloads: 1,
      readyInMs: 312,
      viteVersion: "7.1.3",
    });
  });
});

describe("B48 local-feedback batch", () => {
  const batch = buildLocalFeedbackBatch(
    [
      fixture("tsc-plain.txt"),
      fixture("tsc-pretty.txt"),
      fixture(NPM_PLAIN),
      fixture(NPM_TIMING),
      fixture("vite-dev.txt"),
      fixture("unrecognized.txt"),
    ],
    input("fixtures/b48"),
    OBSERVED
  );

  it("routes each file to one versioned adapter and decodes as v1 batch", () => {
    expect(Schema.decodeSync(EventBatchSchema)(batch)).toBeTruthy();
    expect(batch.events.map((event) => event.payload.adapter)).toEqual([
      "tsc-text",
      "tsc-text",
      "npm-debug-log",
      "npm-debug-log",
      "vite-dev-log",
    ]);
    expect(
      batch.events.every(
        (event) =>
          event.kind === "feedback.local" &&
          event.origin === "fixture" &&
          event.context.branch === "feature/cart"
      )
    ).toBe(true);
    expect(batch.events[2]?.adapterVersion).toBe("1.0.0+npm-debug-log@1.0.0");
  });

  it("reports unsupported IDE subroutes and unrecognized input individually", () => {
    expect(gapCodes(batch)).toEqual([
      "subroute-unsupported:ide-diagnostics",
      "subroute-unsupported:ide-terminal",
      "input-unrecognized",
    ]);
    expect(batch.coverage).toMatchObject({
      expectedItems: 6,
      observedItems: 5,
      state: "partial",
      windowFrom: "2026-09-30T12:01:34.564Z",
      windowTo: "2026-09-30T12:10:00.000Z",
    });
  });

  it("never invents timestamps or HMR latency", () => {
    const vite = batch.events.find(
      (event) => event.payload.subroute === "vite-hmr"
    );

    const tsc = batch.events.find(
      (event) => event.payload.subroute === "compiler"
    );

    expect(vite?.occurredAt).toBeNull();
    expect(vite?.payload.hmrLatencyMs).toBeNull();
    expect(tsc?.occurredAt).toBeNull();
    expect(tsc?.occurredAtPrecision).toBe("unknown");
  });

  it("produces stable event ids for identical evidence", () => {
    const again = buildLocalFeedbackBatch(
      [fixture("tsc-plain.txt")],
      input(null),
      "2026-10-01T00:00:00.000Z"
    );

    expect(again.events[0]?.eventId).toBe(batch.events[0]?.eventId);
  });

  it("marks every registered subroute absent when nothing is recognized", () => {
    const empty = buildLocalFeedbackBatch(
      [fixture("unrecognized.txt")],
      input(null),
      OBSERVED
    );

    expect(empty.coverage.state).toBe("none");
    expect(gapCodes(empty)).toContain("subroute-absent:npm-timing");
    expect(gapCodes(empty)).toContain("subroute-absent:vite-hmr");
    expect(gapCodes(empty)).toContain("subroute-absent:compiler");
  });
});

describe("B48 local-feedback collector", () => {
  it("publishes a degraded descriptor with fixture ids", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      localFeedbackDescriptor
    );

    expect(descriptor.readiness).toBe("degraded");
    expect(descriptor.fixtureIds).toContain("b48-npm-debug-log");
  });

  it.effect("imports a selected directory, skipping non-log files", () =>
    Effect.gen(function* collectDirectory() {
      const batch = yield* localFeedbackCollector.collect(
        input(path.join(fixtureDir, "dir"))
      );

      expect(batch.coverage.expectedItems).toBe(3);
      expect(batch.events.map((event) => event.payload.subroute)).toEqual([
        "compiler",
        "vite-hmr",
      ]);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("rejects a missing selection", () =>
    Effect.gen(function* collectNothing() {
      const error = yield* Effect.flip(
        localFeedbackCollector.collect(input(null))
      );

      expect(error._tag).toBe("InvalidInput");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("fails as unavailable for an unreadable path", () =>
    Effect.gen(function* collectMissing() {
      const error = yield* Effect.flip(
        localFeedbackCollector.collect(
          input(path.join(fixtureDir, "missing.log"))
        )
      );

      expect(error._tag).toBe("SourceUnavailable");
    }).pipe(Effect.provide(NodeServices.layer))
  );
});
