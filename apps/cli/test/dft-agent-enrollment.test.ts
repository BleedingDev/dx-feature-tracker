// @effect-diagnostics nodeBuiltinImport:off -- Enrollment checks own and release canonical temporary configuration paths and never read live inputs.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { configPath, createOperationWorkBudget } from "@rat-stack/core/dx";
import type {
  CollectionEnrollmentRequest,
  LiveHome,
  OperationBounds,
  OperationWorkContext,
} from "@rat-stack/core/dx";
import { Clock, Effect } from "effect";

import {
  makeTrackedSourceEnrollment,
  readTrackedEnrollmentConfig,
} from "../src/dft-agent-enrollment.js";

const roots: string[] = [];

const fixture = (): LiveHome => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "dft-agent-enrollment-"))
  );

  roots.push(root);

  return { dftHome: root, storePath: path.join(root, "fixture.sqlite") };
};

const makeWork = Effect.fn("enrollmentTest.makeWork")(function* work(
  overrides: Partial<OperationBounds> = {}
) {
  const attemptedAt = yield* Clock.currentTimeMillis;

  const budget = yield* createOperationWorkBudget(
    {
      maxBytes: 4096,
      maxElapsedMs: 60_000,
      maxFiles: 4,
      maxRecords: 4096,
      maxRequests: 0,
      maxRetries: 0,
      ...overrides,
    },
    attemptedAt
  );

  return { budget };
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("bounded tracked enrollment configuration", () => {
  it.effect(
    "shares the configuration file allowance with the injected repository resolver",
    () =>
      Effect.gen(function* meteredResolver() {
        const home = fixture();
        const repo = path.join(home.dftHome, "synthetic-repo");

        writeFileSync(configPath(home), JSON.stringify({ repos: [repo] }));

        const authorize = makeTrackedSourceEnrollment({
          home,
          locations: { rootOf: () => repo },
          mappings: [
            { channel: "hooks", harness: "codex", source: "harness.codex" },
          ],
          resolveContext: Effect.fn("EnrollmentFixture.resolveContext")(
            function* resolve(worktree: string, work: OperationWorkContext) {
              const usage = {
                bytesRead: 0,
                filesRead: 1,
                recordsDecoded: 0,
                requests: 0,
                retries: 0,
              };

              const reservation = yield* work.budget.reserve(usage);

              yield* reservation.complete(usage);

              return {
                branch: null,
                flightId: null,
                headSha: null,
                repoCommonDir: repo,
                worktreePath: worktree,
              };
            }
          ),
        });

        const work = yield* makeWork({ maxFiles: 1 });

        const request: CollectionEnrollmentRequest = {
          bounds: yield* work.budget.remaining,
          inputRefs: [],
          receiptIds: [],
          scope: {
            branchSelection: { branches: [], kind: "all" },
            flightId: null,
            repoId: repo,
            resolution: "Synthetic metered repository identity fixture",
            sources: ["harness.codex"],
            tools: ["codex"],
            worktreeId: repo,
          },
          selectedRoots: [repo],
          source: "harness.codex",
        };

        expect(yield* Effect.flip(authorize(request, work))).toMatchObject({
          code: "budget-exhausted",
        });
        expect(yield* work.budget.remaining).toMatchObject({ maxFiles: 0 });
      })
  );

  it.effect(
    "permits a mapped harness and its explicit spool while denying sibling roots and a different repository",
    () =>
      Effect.gen(function* explicitSpool() {
        const home = fixture();
        const repo = path.join(home.dftHome, "repo");
        const harnessRoot = path.join(home.dftHome, "native", ".codex");
        const spool = path.join(home.dftHome, "hooks", "codex");

        mkdirSync(repo);
        mkdirSync(harnessRoot, { recursive: true });
        mkdirSync(spool, { recursive: true });
        writeFileSync(path.join(spool, "events.jsonl"), "{}\n");
        writeFileSync(configPath(home), JSON.stringify({ repos: [repo] }));

        const context = Object.freeze({
          branch: null,
          flightId: null,
          headSha: null,
          repoCommonDir: path.join(repo, ".git"),
          worktreePath: repo,
        });

        const source = "harness.codex";

        const authorize = makeTrackedSourceEnrollment({
          home,
          locations: { rootOf: () => harnessRoot },
          mappings: [{ channel: "hooks", harness: "codex", source }],
          resolveContext: () => Effect.succeed(context),
          sourceRoots: (selected) =>
            selected === source ? [spool, harnessRoot, spool] : [],
        });

        const work = yield* makeWork();

        const request: CollectionEnrollmentRequest = {
          bounds: yield* work.budget.remaining,
          inputRefs: [],
          receiptIds: [],
          scope: {
            branchSelection: { branches: [], kind: "all" },
            flightId: null,
            repoId: context.repoCommonDir,
            resolution: "Synthetic explicit mapped spool fixture",
            sources: [source],
            tools: ["codex"],
            worktreeId: repo,
          },
          selectedRoots: [path.join(spool, "events.jsonl")],
          source,
        };

        expect(yield* authorize(request, work)).toMatchObject({
          receiptIds: [configPath(home)],
          state: "authorized",
        });
        expect(
          yield* authorize({ ...request, selectedRoots: [harnessRoot] }, work)
        ).toMatchObject({ state: "authorized" });
        expect(
          yield* authorize(
            {
              ...request,
              selectedRoots: [path.join(home.dftHome, "hooks", "pi")],
            },
            work
          )
        ).toMatchObject({
          reason:
            "Select exact local roots inside the tracked worktree or its configured source root.",
          receiptIds: [],
          state: "denied",
        });
        expect(
          yield* authorize(
            {
              ...request,
              scope: {
                ...request.scope,
                repoId: path.join(home.dftHome, "other.git"),
              },
            },
            work
          )
        ).toMatchObject({
          reason:
            "The current repository identity does not match the exact tracked operation scope.",
          receiptIds: [],
          state: "denied",
        });
      })
  );

  it.effect(
    "meters the exact persisted snapshot and hashes its raw bytes",
    () =>
      Effect.gen(function* snapshot() {
        const home = fixture();

        const text =
          '{ "repos": ["/fixture/repo"], "cursorUsageImport": true }\n';

        writeFileSync(configPath(home), text);
        const work = yield* makeWork();
        const read = yield* readTrackedEnrollmentConfig(home, work);

        expect(read).toEqual({
          config: { cursorUsageImport: true, repos: ["/fixture/repo"] },
          cursorUsageEnrolled: true,
          digest: createHash("sha256").update(text).digest("hex"),
          receiptIds: [configPath(home)],
        });
        expect(yield* work.budget.remaining).toMatchObject({
          maxBytes: 4096 - Buffer.byteLength(text),
          maxFiles: 3,
          maxRecords: 4094,
        });
        expect(yield* work.budget.measurements).toMatchObject({
          bytesRead: Buffer.byteLength(text),
          recordsDecoded: 2,
          requests: 0,
          retries: 0,
        });
      })
  );

  it.effect(
    "keeps absent settings distinct from an explicit persisted grant",
    () =>
      Effect.gen(function* absent() {
        const home = fixture();
        const work = yield* makeWork();

        expect(yield* readTrackedEnrollmentConfig(home, work)).toEqual({
          config: null,
          cursorUsageEnrolled: false,
          digest: null,
          receiptIds: [],
        });
        writeFileSync(configPath(home), '{"repos":[]}');
        expect(yield* readTrackedEnrollmentConfig(home, work)).toMatchObject({
          config: { cursorUsageImport: true, repos: [] },
          cursorUsageEnrolled: false,
        });
        writeFileSync(configPath(home), '{"cursorUsageImport":false}');
        expect(yield* readTrackedEnrollmentConfig(home, work)).toMatchObject({
          config: { cursorUsageImport: false, repos: [] },
          cursorUsageEnrolled: false,
        });
      })
  );

  it.effect(
    "rejects linked configuration files and linked parent directories",
    () =>
      Effect.gen(function* linked() {
        const home = fixture();
        const target = path.join(home.dftHome, "real");

        mkdirSync(target);
        writeFileSync(
          path.join(target, "config.json"),
          '{"cursorUsageImport":true}'
        );
        symlinkSync(path.join(target, "config.json"), configPath(home));
        const work = yield* makeWork();

        expect(
          yield* Effect.flip(readTrackedEnrollmentConfig(home, work))
        ).toMatchObject({ code: "scope-denied" });
        rmSync(configPath(home));
        const linkedHome = path.join(home.dftHome, "linked");

        symlinkSync(target, linkedHome);
        expect(
          yield* Effect.flip(
            readTrackedEnrollmentConfig({ ...home, dftHome: linkedHome }, work)
          )
        ).toMatchObject({ code: "scope-denied" });
        expect(yield* work.budget.measurements).toMatchObject({ bytesRead: 0 });
      })
  );

  it.effect(
    "denies oversized reads before decoding and shares the file allowance",
    () =>
      Effect.gen(function* limited() {
        const home = fixture();

        writeFileSync(configPath(home), '{"cursorUsageImport":true}');
        const work = yield* makeWork({ maxBytes: 8, maxFiles: 1 });

        expect(
          yield* Effect.flip(readTrackedEnrollmentConfig(home, work))
        ).toMatchObject({ code: "budget-exhausted" });
        expect(yield* work.budget.measurements).toMatchObject({ bytesRead: 0 });
        expect(
          yield* Effect.flip(readTrackedEnrollmentConfig(home, work))
        ).toMatchObject({ code: "budget-exhausted" });
      })
  );

  it.effect(
    "retains read measurements and conservative work on malformed data",
    () =>
      Effect.gen(function* malformed() {
        const home = fixture();
        const text = '{"repos":[';

        writeFileSync(configPath(home), text);
        const work = yield* makeWork();

        const failure = yield* Effect.flip(
          readTrackedEnrollmentConfig(home, work)
        );

        expect(failure).toMatchObject({
          code: "source-unavailable",
        });
        expect(yield* work.budget.measurements).toMatchObject({
          bytesRead: Buffer.byteLength(text),
          recordsDecoded: null,
        });
        expect(yield* work.budget.remaining).toMatchObject({
          maxRecords: 4096 - Buffer.byteLength(text) - 1,
        });
      })
  );

  it.effect(
    "rejects persisted repository lists above the bounded schema limit",
    () =>
      Effect.gen(function* excessive() {
        const home = fixture();

        writeFileSync(
          configPath(home),
          JSON.stringify({
            repos: Array.from({ length: 257 }, () => "/fixture"),
          })
        );
        const work = yield* makeWork();

        expect(
          yield* Effect.flip(readTrackedEnrollmentConfig(home, work))
        ).toMatchObject({ code: "source-unavailable" });
      })
  );
});
