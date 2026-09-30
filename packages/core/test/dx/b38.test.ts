// @effect-diagnostics nodeBuiltinImport:off -- This test reads committed B38 fixtures and uses an owned temporary store directory.
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { runAnalyze } from "../../src/dx/cli/commands/analyze.js";
import {
  runCollect,
  runImportSpool,
} from "../../src/dx/cli/commands/collect.js";
import type { DxCommandEnv } from "../../src/dx/cli/commands/context.js";
import { selectorFromContext } from "../../src/dx/cli/commands/context.js";
import { cliCommandsDescriptor } from "../../src/dx/cli/commands/descriptor.js";
import { runExplain } from "../../src/dx/cli/commands/explain.js";
import { runStart } from "../../src/dx/cli/commands/start.js";
import { runStatus } from "../../src/dx/cli/commands/status.js";
import { InvalidInput } from "../../src/dx/contracts/error-invalid-input.js";
import { StoreBusy } from "../../src/dx/contracts/error-store-busy.js";
import type {
  DxCollector,
  EventStoreService,
} from "../../src/dx/contracts/services.js";
import { CONTRACT_VERSION } from "../../src/dx/contracts/version.js";
import { aiUsageMetric } from "../../src/dx/metrics/ai-usage/metric.js";
import { costMetric } from "../../src/dx/metrics/cost/metric.js";
import { gitChurnMetric } from "../../src/dx/metrics/git/metric.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { ModuleDescriptor } from "../../src/dx/model/descriptor.js";
import { EventBatchSchema } from "../../src/dx/model/event.js";
import type { FlightContext } from "../../src/dx/model/event.js";
import {
  DescriptorIdSchema,
  SnapshotIdSchema,
} from "../../src/dx/model/ids.js";
import { AnalyzeReportSchema } from "../../src/dx/model/report.js";
import { openSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "b38");

const BATCH = path.join(FIXTURE_DIR, "branch-flight.batch.json");

const LATE_BATCH = path.join(FIXTURE_DIR, "branch-flight-late.batch.json");

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dft-b38-"));

afterAll(() => {
  fs.rmSync(scratchRoot, { force: true, recursive: true });
});

const context: FlightContext = {
  branch: "feature/b38-demo",
  flightId: null,
  headSha: "abc123",
  repoCommonDir: "/fixture/repo/.git",
  worktreePath: "/fixture/repo",
};

const decodeBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(EventBatchSchema)
);

const fixtureDescriptor = (
  readiness: ModuleDescriptor["readiness"]
): ModuleDescriptor => ({
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["b38-branch-flight"],
  gaps: [],
  id: DescriptorIdSchema.make(
    readiness === "ready" ? "collector/b38-fixture" : "collector/b38-off"
  ),
  kind: "collector",
  owner: "B38",
  readiness,
  requiredInputs: ["selectedInput"],
  supportedFields: [],
  version: "1.0.0",
});

const fixtureCollector: DxCollector = {
  collect: (input) =>
    input.selectedInput === null
      ? Effect.fail(
          new InvalidInput({ field: "input", message: "file required" })
        )
      : Effect.sync(() =>
          decodeBatch(fs.readFileSync(input.selectedInput ?? "", "utf-8"))
        ),
  descriptor: fixtureDescriptor("ready"),
};

const disabledCollector: DxCollector = {
  collect: () => Effect.die("disabled collector must not run"),
  descriptor: fixtureDescriptor("disabled"),
};

const collectors = [fixtureCollector, disabledCollector];

const metrics = [aiUsageMetric, costMetric, gitChurnMetric];

const openEnv = (name: string) =>
  Effect.map(
    openSqliteEventStore({
      kind: "live",
      path: path.join(scratchRoot, name, "events.sqlite"),
    }),
    (opened) => ({
      close: opened.close,
      env: {
        store: opened.service,
        storePath: path.join(scratchRoot, name, "events.sqlite"),
      } satisfies DxCommandEnv,
    })
  );

const selector = selectorFromContext(context);

describe("B38 CLI commands", () => {
  it.effect(
    "start, import, analyze, status and explain share one snapshot",
    () =>
      Effect.gen(function* flow() {
        const { close, env } = yield* openEnv("flow");

        const started = yield* runStart(env, {
          context,
          occurredAt: "2026-09-30T09:59:00.000Z",
        });

        expect(started.inserted).toBe(1);
        expect(started.branch).toBe("feature/b38-demo");

        const collected = yield* runCollect(env, collectors, {
          context,
          input: BATCH,
          source: "b38-fixture",
        });

        expect(collected).toMatchObject({
          events: 3,
          inserted: 3,
          origin: "imported",
          spooledTo: null,
        });

        const again = yield* runCollect(env, collectors, {
          context,
          input: BATCH,
          source: "collector/b38-fixture",
        });

        expect(again.duplicates).toBe(3);

        const analyzed = yield* runAnalyze(env, metrics, {
          asOf: null,
          selector,
          snapshotId: null,
        });

        expect(analyzed.mode).toBe("latest");
        expect(analyzed.report.snapshot.snapshotId).toBe(analyzed.snapshotId);

        const cached = yield* Schema.decodeEffect(
          Schema.fromJsonString(AnalyzeReportSchema)
        )(fs.readFileSync(analyzed.reportPath, "utf-8"));

        expect(cached.snapshot.snapshotId).toBe(analyzed.snapshotId);

        const status = yield* runStatus(env, [cliCommandsDescriptor], selector);

        expect(status.cachedReport?.reportPath).toBe(analyzed.reportPath);
        expect(status.cachedReport?.snapshotId).toBe(analyzed.snapshotId);
        expect(status.latestSnapshotId).toBe(analyzed.snapshotId);
        expect(status.snapshotCount).toBe(1);
        expect(status.storePath).toBe(env.storePath);

        const explained = yield* runExplain(env, {
          asOf: null,
          cursor: null,
          limit: null,
          selector,
          snapshotId: analyzed.snapshotId,
        });

        expect(explained.status).toBe("ok");
        expect(explained.status === "ok" && explained.timeline.total).toBe(4);
        expect(explained.status === "ok" && explained.timeline.snapshotId).toBe(
          analyzed.snapshotId
        );

        yield* runCollect(env, collectors, {
          context,
          input: LATE_BATCH,
          source: "b38-fixture",
        });

        const relatest = yield* runAnalyze(env, metrics, {
          asOf: null,
          selector,
          snapshotId: null,
        });

        expect(relatest.snapshotId).not.toBe(analyzed.snapshotId);
        expect(
          relatest.disclosures.some((d) => d.startsWith("Evidence changed"))
        ).toBe(true);

        const pinned = yield* runAnalyze(env, metrics, {
          asOf: null,
          selector,
          snapshotId: analyzed.snapshotId,
        });

        expect(pinned.mode).toBe("pinned");
        expect(pinned.snapshotId).toBe(analyzed.snapshotId);
        expect(pinned.report.snapshot.eventWatermark).toBe(
          analyzed.report.snapshot.eventWatermark
        );
        close();
      })
  );

  it.effect("unknown snapshots are reported, never replaced by latest", () =>
    Effect.gen(function* unknown() {
      const { close, env } = yield* openEnv("unknown");
      yield* runCollect(env, collectors, {
        context,
        input: BATCH,
        source: "b38-fixture",
      });
      const missing = SnapshotIdSchema.make("snap-does-not-exist");

      const explained = yield* runExplain(env, {
        asOf: null,
        cursor: null,
        limit: null,
        selector,
        snapshotId: missing,
      });

      expect(explained).toMatchObject({
        problem: "unknown",
        snapshotId: missing,
        status: "snapshot-unavailable",
      });

      const analyzed = yield* Effect.result(
        runAnalyze(env, metrics, { asOf: null, selector, snapshotId: missing })
      );

      expect(Result.isFailure(analyzed)).toBe(true);
      expect(Result.isFailure(analyzed) && analyzed.failure._tag).toBe(
        "SnapshotNotFound"
      );

      const status = yield* runStatus(env, [], selector);

      expect(status.cachedReport).toBeNull();
      close();
    })
  );

  it.effect("collect requires an explicit, enabled source", () =>
    Effect.gen(function* selection() {
      const { close, env } = yield* openEnv("selection");

      const outcomes = yield* Effect.forEach(
        [null, "nope", "b38-off"],
        (source) =>
          Effect.result(
            runCollect(env, collectors, { context, input: BATCH, source })
          )
      );

      const tags = outcomes.map((o) =>
        Result.isFailure(o) ? o.failure._tag : "success"
      );

      expect(tags).toEqual([
        "InvalidInput",
        "UnsupportedSource",
        "UnsupportedSource",
      ]);
      close();
    })
  );

  it.effect("a busy store spools the batch and import drains it", () =>
    Effect.gen(function* busy() {
      const { close, env } = yield* openEnv("busy");

      const busyStore: EventStoreService = {
        ...env.store,
        append: () => Effect.fail(new StoreBusy({ message: "locked" })),
      };

      const spooled = yield* runCollect(
        { ...env, store: busyStore },
        collectors,
        { context, input: BATCH, source: "b38-fixture" }
      );

      expect(spooled.inserted).toBe(0);
      expect(spooled.spooledTo).not.toBeNull();
      expect(fs.existsSync(spooled.spooledTo ?? "")).toBe(true);

      const drained = yield* runImportSpool(env);

      expect(drained.inserted).toBe(3);
      expect(drained.files).toBe(1);
      close();
    })
  );

  it("descriptor is a valid ready surface descriptor", () => {
    const decoded = Schema.decodeSync(ModuleDescriptorSchema)(
      cliCommandsDescriptor
    );

    expect(decoded.readiness).toBe("ready");
    expect(decoded.owner).toBe("B38");
  });
});
