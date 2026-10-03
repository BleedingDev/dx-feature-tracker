// @effect-diagnostics-next-line nodeBuiltinImport:off -- Physical and decoded fixture bytes use independent content digests.
import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic compressed files stay in the parent test's owned scratch directory.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Compressed fixture references use canonical paths inside owned scratch directories.
import path from "node:path";
import { gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Scope } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import type { SourceUnavailable } from "../../../../src/dx/contracts/error-source-unavailable.js";
import { fileCursorOf } from "../../../../src/dx/harness/contract.js";
import type {
  Harness,
  SessionRef,
} from "../../../../src/dx/harness/contract.js";
import { harnessCatalog } from "../../../../src/dx/harness/registry.js";
import type {
  AgentScope,
  StoreIdentity,
} from "../../../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationOutput,
  OperationPlan,
  OperationReceipt,
} from "../../../../src/dx/model/agent-operation.js";
import { emptyFlightContext } from "../../../../src/dx/model/event.js";
import type { FlightContext } from "../../../../src/dx/model/event.js";
import type { OperationWorkBudget } from "../../../../src/dx/operations/budget.js";
import type {
  PlannedSourceOperationAdapterOptions,
  SelectedSourceSnapshot,
  SnapshotHarness,
} from "../../../../src/dx/operations/collector.js";
import type { DecodedOperationSnapshot } from "../../../../src/dx/operations/decompression.js";
import type {
  OperationAdapter,
  OperationApplyInput,
  OperationWorkContext,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type {
  HarnessCursorsApi,
  StoredCursor,
} from "../../../../src/dx/storage/harness-cursors.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";

export interface DecompressionFixtures {
  readonly boundedCompressedSnapshotHarness: (
    snapshot: SelectedSourceSnapshot,
    bounds: OperationBounds,
    scope: AgentScope,
    context: OperationWorkContext
  ) => Effect.Effect<SnapshotHarness, AgentStoreFailure>;
  readonly decompressOperationSnapshot: (
    snapshot: SelectedSourceSnapshot,
    context: OperationWorkContext
  ) => Effect.Effect<
    DecodedOperationSnapshot,
    AgentStoreFailure | SourceUnavailable
  >;
  readonly makeOperationWorkBudget: (
    bounds: OperationBounds,
    attemptedAtMs: number,
    initial?: OperationReceipt["resources"]
  ) => Effect.Effect<OperationWorkBudget, AgentStoreFailure>;
  readonly makeOperationService: (
    store: AgentStoreService,
    adapters: readonly OperationAdapter[]
  ) => Effect.Effect<OperationServiceApi, never, Scope.Scope>;
  readonly makePlannedSourceOperationAdapter: (
    options: PlannedSourceOperationAdapterOptions
  ) => OperationAdapter;
  readonly memoryCursors: Effect.Effect<HarnessCursorsApi>;
  readonly applyInput: (
    plan: OperationPlan,
    key?: string
  ) => OperationApplyInput;
  readonly applyReceipt: (
    service: OperationServiceApi,
    input: OperationApplyInput
  ) => Effect.Effect<
    Extract<OperationOutput, { action: "apply" }>,
    AgentStoreFailure
  >;
  readonly createPlan: (
    service: OperationServiceApi,
    opened: OpenedEventStore,
    args?: OperationArguments,
    scope?: AgentScope,
    limits?: Partial<OperationBounds>
  ) => Effect.Effect<OperationPlan, AgentStoreFailure>;
  readonly fixtureScope: AgentScope;
  readonly withFixtureStore: <A, E>(
    use: (
      opened: OpenedEventStore,
      root: string
    ) => Effect.Effect<A, E, Scope.Scope>
  ) => Effect.Effect<A, E | AgentStoreFailure>;
}

const compressedBounds: OperationBounds = {
  maxBytes: 8192,
  maxElapsedMs: 60_000,
  maxFiles: 2,
  maxRecords: 16,
  maxRequests: 0,
  maxRetries: 0,
};

const contentDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

type CompressedHarness = "omp" | "deepseek";

const nativeHeader = (
  harness: CompressedHarness,
  cwd: string,
  padding = ""
): string =>
  `${JSON.stringify(
    harness === "omp"
      ? {
          cwd,
          id: "fixture.s03.compressed.omp",
          padding,
          timestamp: "2026-10-02T00:00:00.000Z",
          type: "session",
        }
      : {
          createdAt: 1_790_899_200_000,
          cwd,
          id: "fixture.s03.compressed.deepseek",
          padding,
          type: "session",
        }
  )}\n`;

const compressedSnapshot = (
  root: string,
  harness: CompressedHarness,
  text: string,
  identity: StoreIdentity,
  truncate = false
): SelectedSourceSnapshot => {
  const canonicalRoot = realpathSync(root);

  const file = path.join(
    canonicalRoot,
    harness === "omp" ? "fixture.jsonl.gz" : "fixture.jsonl.zstd"
  );

  const compressed =
    harness === "omp"
      ? gzipSync(new TextEncoder().encode(text))
      : zstdCompressSync(new TextEncoder().encode(text));

  const bytes = new Uint8Array(
    truncate ? compressed.subarray(0, -1) : compressed
  );

  writeFileSync(file, bytes);
  const info = statSync(file);

  const context: FlightContext = {
    ...emptyFlightContext,
    branch: "fixture-main",
    repoCommonDir: path.join(canonicalRoot, "fixture-repo", ".git"),
    worktreePath: canonicalRoot,
  };

  const ref: SessionRef = {
    channel: "session-file",
    harness,
    id: `${file}#fixture.s03.compressed`,
    mtimeMs: info.mtimeMs,
    path: file,
    sessionId: `fixture.s03.compressed.${harness}`,
    size: bytes.byteLength,
    source: `harness.${harness}`,
    worktree: context.worktreePath,
  };

  return {
    bytes,
    contentDigest: contentDigest(bytes),
    identity: `${String(info.dev)}:${String(info.ino)}`,
    ref,
    selection: {
      inputRef: {
        basisId: null,
        id: file,
        kind: "evidence",
        storeGeneration: identity.storeGeneration,
        storeId: identity.storeId,
        version: "fixture.s03.compressed.v1",
      },
      planned: {
        context,
        harness,
        input: file,
        ref,
        source: ref.source,
        unavailable: null,
      },
      root: canonicalRoot,
    },
  };
};

const decodeFixture = Effect.fn("S03.decodeFixture")(function* decodeFixture(
  fixture: DecompressionFixtures,
  bounds: OperationBounds = compressedBounds
) {
  const budget = yield* fixture.makeOperationWorkBudget(bounds, 0);
  const context = { budget };

  return { budget, context };
});

const compressedOperationFixture = Effect.fn("S03.compressedOperationFixture")(
  function* compressedOperationFixture(
    fixture: DecompressionFixtures,
    opened: OpenedEventStore,
    root: string,
    harness: CompressedHarness,
    text: string,
    limits: Partial<OperationBounds> = {}
  ) {
    const snapshot = compressedSnapshot(
      root,
      harness,
      text,
      yield* opened.agentService.identity
    );

    const cursors = yield* fixture.memoryCursors;

    const prior: StoredCursor = {
      cursor: fileCursorOf(snapshot.ref.source, {
        mtimeMs: null,
        offset: 0,
        path: snapshot.ref.path,
        size: null,
      }),
      lastEventId: null,
      mtimeMs: null,
      size: null,
    };

    yield* cursors.put(snapshot.ref, prior);
    const snapshots: SelectedSourceSnapshot[] = [];
    const failures: AgentStoreFailure[] = [];
    let reads = 0;
    let appends = 0;

    const unboundedHarness: Harness = {
      capabilities: {
        branchSources: [],
        liveHooks: false,
        storedFigure: null,
        subagents: false,
      },
      channels: ["session-file"],
      discover: Effect.succeed({
        harness,
        present: true,
        reason: "Synthetic S03 compressed-source fixture",
        roots: [snapshot.selection.root],
        sessions: 1,
        version: "fixture.s03.compressed.v1",
      }),
      displayName: "Synthetic S03 compressed source",
      id: harness,
      locate: () => Effect.succeed([snapshot.ref]),
      read: () =>
        Effect.die(new Error("An unbounded compressed parser was invoked")),
    };

    const adapter = fixture.makePlannedSourceOperationAdapter({
      cursors,
      enrollment: () =>
        Effect.succeed({
          reason: "Only the isolated synthetic compressed source is enrolled",
          receiptIds: ["fixture.s03.compressed.enrollment"],
          state: "authorized",
        }),
      env: {
        store: {
          ...opened.service,
          append: (batch) =>
            Effect.sync(() => {
              appends += 1;
            }).pipe(Effect.andThen(opened.service.append(batch))),
        },
        storePath: path.join(root, "fixture.sqlite"),
      },
      parserVersion: "fixture.s03.compressed.v1",
      registry: harnessCatalog([unboundedHarness]),
      selected: [snapshot.selection],
      snapshotHarness: (captured, bounds, scope, context) =>
        Effect.sync(() => {
          snapshots.push(captured);
        }).pipe(
          Effect.andThen(
            fixture.boundedCompressedSnapshotHarness(
              captured,
              bounds,
              scope,
              context
            )
          ),
          Effect.tapError(
            Effect.fn("S03.captureDecodingFailure")(
              function* captureDecodingFailure(failure: AgentStoreFailure) {
                failures.push(failure);
                yield* Effect.void;
              }
            )
          ),
          Effect.map((parser): SnapshotHarness => ({
            ...parser,
            read: (ref, input) =>
              Effect.sync(() => {
                reads += 1;
              }).pipe(
                Effect.andThen(
                  parser.read(ref, { ...input, origin: "fixture" })
                )
              ),
          }))
        ),
    });

    const service = yield* fixture.makeOperationService(opened.agentService, [
      adapter,
    ]);

    const args: OperationArguments = {
      allowSourceGrowth: false,
      cursor: null,
      inputRefs: [snapshot.selection.inputRef],
      kind: "collect",
      parserVersion: "fixture.s03.compressed.v1",
      selectedRoots: [snapshot.selection.root],
      source: snapshot.ref.source,
    };

    const plan = yield* fixture.createPlan(
      service,
      opened,
      args,
      { ...fixture.fixtureScope, sources: [snapshot.ref.source] },
      { ...compressedBounds, ...limits }
    );

    return {
      appends: () => appends,
      cursors,
      failures,
      plan,
      prior,
      reads: () => reads,
      service,
      snapshot,
      snapshots,
    };
  }
);

export const registerDecompressionTests = (fixture: DecompressionFixtures) => {
  describe("S03 bounded compressed snapshots", () => {
    it.effect(
      "gzip decoding retains the exact physical source and meters decoded LF units",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* retainedPhysicalSource() {
            const text = `${nativeHeader("omp", realpathSync(root))}\n`;

            const snapshot = compressedSnapshot(
              root,
              "omp",
              text,
              yield* opened.agentService.identity
            );

            const bytesBefore = new Uint8Array(snapshot.bytes);
            const refBefore = { ...snapshot.ref };
            const { budget, context } = yield* decodeFixture(fixture);

            const decoded = yield* fixture.decompressOperationSnapshot(
              snapshot,
              context
            );

            const remaining = yield* budget.remaining;

            expect(new TextDecoder().decode(decoded.bytes)).toBe(text);
            expect(decoded.encoding).toBe("gzip");
            expect(decoded.rawRecordUnits).toBe(2);
            expect(decoded.contentDigest).toBe(
              contentDigest(new TextEncoder().encode(text))
            );
            expect(decoded.source).toBe(snapshot);
            expect(snapshot.bytes).toEqual(bytesBefore);
            expect(snapshot.ref).toEqual(refBefore);
            expect(snapshot.contentDigest).toBe(contentDigest(bytesBefore));
            expect(readFileSync(snapshot.ref.path)).toEqual(
              Buffer.from(bytesBefore)
            );
            expect(remaining.maxBytes).toBe(
              compressedBounds.maxBytes - decoded.bytes.byteLength
            );
            expect(remaining.maxRecords).toBe(compressedBounds.maxRecords - 2);
            expect((yield* budget.measurements).bytesRead).toBe(0);
          })
        )
    );

    for (const harness of ["omp", "deepseek"] as const) {
      it.effect(
        `${harness} reads an actual compressed native header with fixture origin`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* nativeCompressedSession() {
              const text = nativeHeader(harness, realpathSync(root));

              const snapshot = compressedSnapshot(
                root,
                harness,
                text,
                yield* opened.agentService.identity
              );

              const { context } = yield* decodeFixture(fixture);

              const parser = yield* fixture.boundedCompressedSnapshotHarness(
                snapshot,
                compressedBounds,
                fixture.fixtureScope,
                context
              );

              const batch = yield* parser.read(snapshot.ref, {
                context: snapshot.selection.planned.context,
                cursor:
                  harness === "omp"
                    ? null
                    : fileCursorOf(snapshot.ref.source, {
                        mtimeMs: null,
                        offset: 1,
                        path: snapshot.ref.path,
                        size: null,
                      }),
                origin: "fixture",
              });

              expect(batch.events).toHaveLength(1);
              expect(batch.events[0]?.kind).toBe("ai.session");
              expect(batch.events[0]?.origin).toBe("fixture");
              expect(batch.events[0]?.context.worktreePath).toBe(
                snapshot.ref.worktree
              );
              expect(parser.recordUnitsPrepaid).toBe(true);
              expect(parser.retainCursor).toBe(harness === "deepseek");

              if (harness === "deepseek") {
                expect(batch.cursor).toBeNull();
                expect(
                  batch.coverage.gaps.some(
                    (gap) =>
                      gap.code === "collection.compressed-cursor-retained"
                  )
                ).toBe(true);
              }

              yield* opened.service.append(batch);

              const stored = yield* opened.service.snapshot({
                branch: null,
                flightId: null,
                from: null,
                repoCommonDir: null,
                to: null,
              });

              expect(stored.events).toHaveLength(1);
              expect(stored.events[0]?.origin).toBe("fixture");

              const secondRead = yield* Effect.flip(
                parser.read(snapshot.ref, {
                  context: snapshot.selection.planned.context,
                  cursor: null,
                  origin: "fixture",
                })
              );

              expect(secondRead._tag).toBe("SourceUnavailable");
              expect(snapshot.contentDigest).toBe(
                contentDigest(snapshot.bytes)
              );
              expect(
                snapshot.ref.path.endsWith(
                  harness === "omp" ? ".jsonl.gz" : ".jsonl.zstd"
                )
              ).toBe(true);
            })
          )
      );
    }

    it.effect(
      "a committed DeepSeek operation retains its physical cursor and real durable receipt",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* compressedCursorReceipt() {
            const state = yield* compressedOperationFixture(
              fixture,
              opened,
              root,
              "deepseek",
              nativeHeader("deepseek", realpathSync(root)),
              { maxRecords: 2 }
            );

            const output = yield* fixture.applyReceipt(
              state.service,
              fixture.applyInput(state.plan, "fixture.s03.compressed.cursor")
            );

            expect(state.failures).toEqual([]);
            expect(state.reads()).toBe(1);
            expect(state.appends()).toBe(1);
            expect(output.receipt.steps[0]?.inserted).toBe(1);
            expect(output.receipt.steps[0]?.safeCursor).toBe(
              JSON.stringify(state.prior.cursor)
            );
            expect(yield* state.cursors.get(state.snapshot.ref)).toEqual(
              state.prior
            );
            expect(
              yield* opened.agentService.getOperation(output.receipt)
            ).toEqual(output.receipt);

            const stored = yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            });

            expect(stored.events).toHaveLength(1);
            expect(stored.events[0]?.origin).toBe("fixture");
            expect(state.snapshots[0]?.contentDigest).toBe(
              state.snapshot.contentDigest
            );
            expect(state.snapshots[0]?.bytes).toEqual(state.snapshot.bytes);
            expect(state.snapshots[0]?.ref.path).toBe(state.snapshot.ref.path);
          })
        )
    );

    for (const harness of ["omp", "deepseek"] as const) {
      it.effect(
        `${harness} expansion exhausts the decoded-byte allowance before native parsing or append`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* compressedOutputBomb() {
              const text = nativeHeader(
                harness,
                realpathSync(root),
                "a".repeat(16_384)
              );

              const state = yield* compressedOperationFixture(
                fixture,
                opened,
                root,
                harness,
                text,
                { maxBytes: 1024 }
              );

              expect(state.snapshot.bytes.byteLength).toBeLessThan(1024);

              const output = yield* fixture.applyReceipt(
                state.service,
                fixture.applyInput(
                  state.plan,
                  `fixture.s03.compressed.bomb.${harness}`
                )
              );

              expect(state.failures).toHaveLength(1);
              expect(state.failures[0]?._tag).toBe("AgentError");
              const [failure] = state.failures;

              if (failure?._tag === "AgentError") {
                expect(failure.code).toBe("budget-exhausted");
              }

              expect(state.reads()).toBe(0);
              expect(state.appends()).toBe(0);
              expect(output.receipt.steps[0]?.inserted).toBe(0);
              expect(yield* state.cursors.get(state.snapshot.ref)).toEqual(
                state.prior
              );
              expect(
                yield* opened.agentService.getOperation(output.receipt)
              ).toEqual(output.receipt);
              expect(
                (yield* opened.service.snapshot({
                  branch: null,
                  flightId: null,
                  from: null,
                  repoCommonDir: null,
                  to: null,
                })).events
              ).toHaveLength(0);
            })
          )
      );
    }

    it.effect(
      "decoded blank LF frames exhaust the record allowance before native parsing or append",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* compressedRawRecordBound() {
            const state = yield* compressedOperationFixture(
              fixture,
              opened,
              root,
              "omp",
              `${nativeHeader("omp", realpathSync(root))}${"\n".repeat(10)}`,
              { maxRecords: 2 }
            );

            const output = yield* fixture.applyReceipt(
              state.service,
              fixture.applyInput(state.plan, "fixture.s03.compressed.lf-limit")
            );

            const [failure] = state.failures;
            expect(state.failures).toHaveLength(1);
            expect(failure?._tag).toBe("AgentError");

            if (failure?._tag === "AgentError") {
              expect(failure.code).toBe("budget-exhausted");
            }

            expect(state.reads()).toBe(0);
            expect(state.appends()).toBe(0);
            expect(output.receipt.steps[0]?.inserted).toBe(0);
            expect(yield* state.cursors.get(state.snapshot.ref)).toEqual(
              state.prior
            );
            expect(
              (yield* opened.service.snapshot({
                branch: null,
                flightId: null,
                from: null,
                repoCommonDir: null,
                to: null,
              })).events
            ).toHaveLength(0);
          })
        )
    );

    it.effect(
      "strict Zstandard framing rejects a truncation accepted by the native decoder",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* strictCompressedFraming() {
            const text = nativeHeader("deepseek", realpathSync(root));

            const snapshot = compressedSnapshot(
              root,
              "deepseek",
              text,
              yield* opened.agentService.identity,
              true
            );

            expect(() => zstdDecompressSync(snapshot.bytes)).not.toThrow();
            const { budget, context } = yield* decodeFixture(fixture);

            const error = yield* Effect.flip(
              fixture.decompressOperationSnapshot(snapshot, context)
            );

            expect(error._tag).toBe("SourceUnavailable");
            expect(error.message).toMatch(/incomplete|unsupported/iu);
            expect(snapshot.contentDigest).toBe(contentDigest(snapshot.bytes));
            expect(readFileSync(snapshot.ref.path)).toEqual(
              Buffer.from(snapshot.bytes)
            );
            expect((yield* budget.remaining).maxBytes).toBe(
              compressedBounds.maxBytes
            );
            expect((yield* budget.measurements).bytesRead).toBe(0);
          })
        )
    );
  });
};
