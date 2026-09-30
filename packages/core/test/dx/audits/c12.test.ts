// @effect-diagnostics nodeBuiltinImport:off -- C12 runtime audit drives real SQLite locks, spool files and a non-repo scratch directory under an owned temp root.
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { runAnalyze } from "../../../src/dx/cli/commands/analyze.js";
import {
  runCollect,
  runImportSpool,
} from "../../../src/dx/cli/commands/collect.js";
import type { DxCommandEnv } from "../../../src/dx/cli/commands/context.js";
import { selectorFromContext } from "../../../src/dx/cli/commands/context.js";
import { cliCommandsDescriptor } from "../../../src/dx/cli/commands/descriptor.js";
import { runExplain } from "../../../src/dx/cli/commands/explain.js";
import { runStatus } from "../../../src/dx/cli/commands/status.js";
import { cursorLocalDbCollector } from "../../../src/dx/collectors/cursor-local-db/collector.js";
import { gitIdentityCollector } from "../../../src/dx/collectors/git-identity/collector.js";
import { InvalidInput } from "../../../src/dx/contracts/error-invalid-input.js";
import type { DxCollector } from "../../../src/dx/contracts/services.js";
import { CONTRACT_VERSION } from "../../../src/dx/contracts/version.js";
import { aiUsageMetric } from "../../../src/dx/metrics/ai-usage/metric.js";
import { costMetric } from "../../../src/dx/metrics/cost/metric.js";
import { gitChurnMetric } from "../../../src/dx/metrics/git/metric.js";
import type { ModuleDescriptor } from "../../../src/dx/model/descriptor.js";
import { EventBatchSchema } from "../../../src/dx/model/event.js";
import type { FlightContext } from "../../../src/dx/model/event.js";
import { DescriptorIdSchema } from "../../../src/dx/model/ids.js";
import { drainSpool } from "../../../src/dx/storage/spool.js";
import { openSqliteEventStore } from "../../../src/dx/storage/sqlite-event-store.js";
import { spoolDirFor } from "../../../src/dx/storage/store-path.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "..", "fixtures", "c12");

const VALID = path.join(FIXTURE_DIR, "offline-flight.batch.json");

const CORRUPT = [
  "garbage.batch.json",
  "truncated.batch.json",
  "wrong-shape.batch.json",
];

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dxfr-c12-"));

afterAll(() => {
  fs.rmSync(scratchRoot, { force: true, recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const context: FlightContext = {
  branch: "feature/c12-demo",
  flightId: null,
  headSha: "abc123",
  repoCommonDir: "/fixture/repo/.git",
  worktreePath: "/fixture/repo",
};

const selector = selectorFromContext(context);

const metrics = [aiUsageMetric, costMetric, gitChurnMetric];

const decodeBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(EventBatchSchema)
);

const fixtureDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["c12-offline-flight"],
  gaps: [],
  id: DescriptorIdSchema.make("collector/c12-fixture"),
  kind: "collector",
  owner: "C12",
  readiness: "ready",
  requiredInputs: ["selectedInput"],
  supportedFields: [],
  version: "1.0.0",
};

const fixtureCollector: DxCollector = {
  collect: (input) =>
    input.selectedInput === null
      ? Effect.fail(
          new InvalidInput({ field: "input", message: "file required" })
        )
      : Effect.sync(() =>
          decodeBatch(fs.readFileSync(input.selectedInput ?? "", "utf-8"))
        ),
  descriptor: fixtureDescriptor,
};

const storePathFor = (name: string) =>
  path.join(scratchRoot, name, "events.sqlite");

const openEnv = (name: string, busyTimeoutMs = 5000) =>
  Effect.map(
    openSqliteEventStore({
      busyTimeoutMs,
      kind: "live",
      path: storePathFor(name),
    }),
    (opened) => ({
      close: opened.close,
      env: {
        store: opened.service,
        storePath: storePathFor(name),
      } satisfies DxCommandEnv,
    })
  );

const failureTag = <A, E extends { readonly _tag: string }>(
  result: Result.Result<A, E>
): string => (Result.isFailure(result) ? result.failure._tag : "success");

describe("C12 runtime audit", () => {
  it.effect("offline and without GitHub: the full local flow succeeds", () =>
    Effect.gen(function* offline() {
      const fetchSpy = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error("C12: network access is forbidden"));

      vi.stubGlobal("fetch", fetchSpy);
      vi.stubEnv("GITHUB_TOKEN", "");
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");

      const { close, env } = yield* openEnv("offline");

      const collected = yield* runCollect(env, [fixtureCollector], {
        context,
        input: VALID,
        source: "c12-fixture",
      });

      expect(collected.inserted).toBe(3);

      const analyzed = yield* runAnalyze(env, metrics, {
        asOf: null,
        selector,
        snapshotId: null,
      });

      expect(analyzed.report.snapshot.snapshotId).toBe(analyzed.snapshotId);
      expect(fs.existsSync(analyzed.reportPath)).toBe(true);

      const explained = yield* runExplain(env, {
        asOf: null,
        cursor: null,
        limit: null,
        selector,
        snapshotId: analyzed.snapshotId,
      });

      expect(explained.status).toBe("ok");

      const status = yield* runStatus(env, [cliCommandsDescriptor], selector);

      expect(status.latestSnapshotId).toBe(analyzed.snapshotId);
      expect(fetchSpy).not.toHaveBeenCalled();

      const reportText = fs.readFileSync(analyzed.reportPath, "utf-8");

      expect(reportText).not.toMatch(/api\.github\.com/u);
      close();
    })
  );

  it.effect(
    "no repo: git identity fails as SourceUnavailable, never invents a branch",
    () =>
      Effect.gen(function* noRepo() {
        const bare = path.join(scratchRoot, "not-a-repo");
        fs.mkdirSync(bare, { recursive: true });
        vi.stubEnv("GIT_CEILING_DIRECTORIES", scratchRoot);

        const outcome = yield* Effect.result(
          gitIdentityCollector.collect({
            adapterId: "git-identity",
            context: {
              branch: null,
              flightId: null,
              headSha: null,
              repoCommonDir: null,
              worktreePath: null,
            },
            cursor: null,
            origin: "live",
            scratchDir: null,
            selectedInput: bare,
          })
        );

        expect(failureTag(outcome)).toBe("SourceUnavailable");
        expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
          /not inside a Git working tree/u
        );

        const noSelection = yield* Effect.result(
          gitIdentityCollector.collect({
            adapterId: "git-identity",
            context: {
              branch: null,
              flightId: null,
              headSha: null,
              repoCommonDir: null,
              worktreePath: null,
            },
            cursor: null,
            origin: "live",
            scratchDir: null,
            selectedInput: null,
          })
        );

        expect(failureTag(noSelection)).toBe("InvalidInput");

        const { close, env } = yield* openEnv("no-repo");
        const empty = yield* runStatus(env, [], selector);

        expect(empty.latestSnapshotId).toBeNull();
        expect(empty.cachedReport).toBeNull();
        close();
      })
  );

  it.effect(
    "store busy: a real writer lock spools, then import drains once",
    () =>
      Effect.gen(function* busy() {
        const { close, env } = yield* openEnv("busy", 50);

        const locker = new DatabaseSync(env.storePath);
        locker.exec("BEGIN IMMEDIATE");

        const spooled = yield* Effect.ensuring(
          runCollect(env, [fixtureCollector], {
            context,
            input: VALID,
            source: "c12-fixture",
          }),
          Effect.sync(() => {
            locker.exec("ROLLBACK");
            locker.close();
          })
        );

        expect(spooled.inserted).toBe(0);
        expect(spooled.spooledTo).not.toBeNull();
        expect(fs.existsSync(spooled.spooledTo ?? "")).toBe(true);

        const drained = yield* runImportSpool(env);

        expect(drained).toMatchObject({ files: 1, inserted: 3, rejected: [] });

        const again = yield* runImportSpool(env);

        expect(again).toMatchObject({ files: 0, inserted: 0 });
        close();
      })
  );

  it.effect(
    "corrupt spool files are quarantined; valid ones still import",
    () =>
      Effect.gen(function* corrupt() {
        const { close, env } = yield* openEnv("corrupt");
        const spoolDir = spoolDirFor(env.storePath);
        fs.mkdirSync(spoolDir, { recursive: true });

        for (const name of CORRUPT) {
          fs.copyFileSync(
            path.join(FIXTURE_DIR, name),
            path.join(spoolDir, name)
          );
        }

        fs.copyFileSync(VALID, path.join(spoolDir, "zz-valid.batch.json"));

        const drained = yield* drainSpool(env.store, spoolDir);

        expect(drained.files).toBe(4);
        expect(drained.inserted).toBe(3);
        expect([...drained.rejected].toSorted()).toEqual(CORRUPT.toSorted());

        for (const name of CORRUPT) {
          expect(fs.existsSync(path.join(spoolDir, "rejected", name))).toBe(
            true
          );
        }

        const rerun = yield* drainSpool(env.store, spoolDir);

        expect(rerun).toMatchObject({ files: 0, inserted: 0, rejected: [] });
        close();
      })
  );

  it.effect("corrupt store file fails as a typed StoreError, not a crash", () =>
    Effect.gen(function* corruptStore() {
      const storePath = storePathFor("corrupt-store");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, "this is not a sqlite database".repeat(200));

      const opened = yield* Effect.result(
        openSqliteEventStore({ kind: "live", path: storePath })
      );

      expect(failureTag(opened)).toBe("StoreError");
    })
  );

  it.effect("missing adapter or missing input stays typed and visible", () =>
    Effect.gen(function* missing() {
      const { close, env } = yield* openEnv("missing");

      const outcomes = yield* Effect.forEach(
        [null, "  ", "github-actions", "cursor-dashboard-live"],
        (source) =>
          Effect.result(
            runCollect(env, [fixtureCollector, cursorLocalDbCollector], {
              context,
              input: VALID,
              source,
            })
          )
      );

      expect(outcomes.map(failureTag)).toEqual([
        "InvalidInput",
        "InvalidInput",
        "UnsupportedSource",
        "UnsupportedSource",
      ]);

      const missingDb = yield* Effect.result(
        runCollect(env, [cursorLocalDbCollector], {
          context,
          input: path.join(scratchRoot, "missing", "state.vscdb"),
          scratchDir: path.join(scratchRoot, "missing-scratch"),
          source: cursorLocalDbCollector.descriptor.id,
        })
      );

      expect(failureTag(missingDb)).toBe("SourceUnavailable");

      const status = yield* runStatus(env, [], selector);

      expect(status.snapshotCount).toBe(0);
      close();
    })
  );
});
