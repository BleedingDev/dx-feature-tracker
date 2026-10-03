// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixture record hashes describe only synthetic data.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Native source files stay inside the parent test's owned scratch directory.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native source references use canonical paths inside owned scratch storage.
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Scope } from "effect";

import type { RawObject } from "../../../../src/dx/collectors/cursor-hooks/raw-payload.js";
import type {
  SanitizedHook,
  SpoolRecord,
} from "../../../../src/dx/collectors/cursor-hooks/spool-record.js";
import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import type {
  EventStoreService,
  StoreFailure,
} from "../../../../src/dx/contracts/services.js";
import type { SessionRef } from "../../../../src/dx/harness/contract.js";
import type {
  AgentRef,
  AgentScope,
} from "../../../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
} from "../../../../src/dx/model/agent-operation.js";
import type {
  EventBatch,
  FlightContext,
} from "../../../../src/dx/model/event.js";
import type { PlannedSourceSelection } from "../../../../src/dx/operations/collector.js";
import type { BoundedCursorHookOperationOptions } from "../../../../src/dx/operations/cursor-hooks.js";
import type {
  OperationAdapter,
  OperationApplyInput,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type {
  HarnessCursorsApi,
  StoredCursor,
} from "../../../../src/dx/storage/harness-cursors.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";

export interface CursorHookOperationFixtures {
  readonly applyInput: (
    plan: OperationPlan,
    key?: string
  ) => OperationApplyInput;
  readonly createPlan: (
    service: OperationServiceApi,
    opened: OpenedEventStore,
    args?: OperationArguments,
    scope?: AgentScope,
    limits?: Partial<OperationBounds>
  ) => Effect.Effect<OperationPlan, AgentStoreFailure>;
  readonly fixtureScope: AgentScope;
  readonly makeBoundedCursorHookOperationAdapter: (
    options: BoundedCursorHookOperationOptions
  ) => OperationAdapter;
  readonly makeOperationService: (
    store: AgentStoreService,
    adapters: readonly OperationAdapter[]
  ) => Effect.Effect<OperationServiceApi, never, Scope.Scope>;
  readonly sanitizeHookPayload: (source: RawObject) => SanitizedHook | null;
  readonly withFixtureStore: <A, E>(
    use: (
      opened: OpenedEventStore,
      root: string
    ) => Effect.Effect<A, E, Scope.Scope>
  ) => Effect.Effect<A, E | AgentStoreFailure>;
}

interface CursorHookFixtureOptions {
  readonly afterAppend?: (
    batch: EventBatch,
    ref: SessionRef,
    cursors: HarnessCursorsApi
  ) => Effect.Effect<void, StoreFailure>;
  readonly records?: (context: FlightContext) => readonly SpoolRecord[];
}

const cursorHookVersion = "dx.bounded-cursor-hooks.v1";

const cursorHookSource = "collector.cursor-hooks";

const cursorHookBounds = { maxBytes: 131_072, maxFiles: 40, maxRecords: 100 };

const allFixtureEvents = {
  branch: null,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
};

export const syntheticStopRecord = (
  fixture: CursorHookOperationFixtures,
  context: FlightContext,
  suffix = "selected"
): SpoolRecord => {
  const hook = fixture.sanitizeHookPayload({
    cache_read_tokens: 30,
    cache_write_tokens: 10,
    conversation_id: `fixture-s03-cursor-session-${suffix}`,
    cursor_version: "fixture-cursor-version",
    generation_id: `fixture-s03-cursor-turn-${suffix}`,
    hook_event_name: "stop",
    input_tokens: 100,
    loop_count: 0,
    model: "fixture-cursor-model",
    output_tokens: 20,
    status: "completed",
    workspace_roots:
      context.worktreePath === null ? [] : [context.worktreePath],
  });

  if (hook === null) {
    throw new Error("The synthetic native Cursor stop record was invalid");
  }

  const git = {
    branch: context.branch,
    headSha: context.headSha,
    repoCommonDir: context.repoCommonDir,
    worktreePath: context.worktreePath,
  };

  return {
    capturedAt: "2026-10-02T10:00:00.000Z",
    git,
    hook,
    recordHash: createHash("sha256")
      .update(JSON.stringify({ git, hook }))
      .digest("hex"),
    spoolVersion: "dxfr.cursor-hook-spool.v1",
  };
};

const cursorHookFixture = Effect.fn("S03.cursorHookFixture")(
  function* cursorHookFixture(
    fixture: CursorHookOperationFixtures,
    opened: OpenedEventStore,
    root: string,
    options: CursorHookFixtureOptions = {}
  ) {
    const sourceRoot = realpathSync(root);
    const directory = path.join(sourceRoot, "synthetic-cursor-hooks");
    const worktree = path.join(sourceRoot, "synthetic-cursor-worktree");

    const context: FlightContext = {
      branch: "fixture-cursor-branch",
      flightId: null,
      headSha: "fixture-cursor-head",
      repoCommonDir: path.join(worktree, ".git"),
      worktreePath: worktree,
    };

    mkdirSync(directory);

    const records = options.records?.(context) ?? [
      syntheticStopRecord(fixture, context),
    ];

    const files = records.map((record, index) => {
      const file = path.join(directory, `${String(index + 1)}.json`);
      writeFileSync(file, JSON.stringify(record));

      return file;
    });

    const identity = yield* opened.agentService.identity;

    const inputRef = {
      basisId: null,
      id: directory,
      kind: "evidence" as const,
      storeGeneration: identity.storeGeneration,
      storeId: identity.storeId,
      version: cursorHookVersion,
    };

    const ref: SessionRef = {
      channel: "hooks",
      harness: "cursor",
      id: `${cursorHookSource}:${directory}`,
      mtimeMs: null,
      path: directory,
      sessionId: null,
      size: null,
      source: cursorHookSource,
      worktree,
    };

    const selection: PlannedSourceSelection = {
      inputRef,
      planned: {
        context,
        harness: "cursor",
        input: directory,
        ref,
        source: cursorHookSource,
        unavailable: null,
      },
      root: sourceRoot,
    };

    const args: OperationArguments = {
      allowSourceGrowth: false,
      cursor: null,
      inputRefs: [inputRef],
      kind: "collect",
      parserVersion: cursorHookVersion,
      selectedRoots: [sourceRoot],
      source: cursorHookSource,
    };

    const scope: AgentScope = {
      ...fixture.fixtureScope,
      branchSelection: {
        branches: ["fixture-cursor-branch"],
        kind: "selected",
      },
      repoId: context.repoCommonDir,
      resolution: "Synthetic S03 native Cursor source; no live evidence",
      sources: [cursorHookSource],
      tools: ["cursor"],
      worktreeId: worktree,
    };

    const nativeBatches: EventBatch[] = [];
    let appends = 0;
    let executions = 0;
    let cursorComparisons = 0;

    const store: EventStoreService = {
      ...opened.service,
      append: Effect.fn("S03.appendSyntheticCursorRecords")(
        function* appendSynthetic(batch) {
          appends += 1;
          nativeBatches.push(batch);

          const labelled: EventBatch = {
            ...batch,
            events: batch.events.map((event) => ({
              ...event,
              origin: "fixture",
            })),
          };

          const appended = yield* opened.service.append(labelled);

          if (options.afterAppend !== undefined) {
            yield* options.afterAppend(labelled, ref, opened.cursorService);
          }

          return appended;
        }
      ),
    };

    const cursors: HarnessCursorsApi = {
      ...opened.cursorService,
      putIfCurrent: Effect.fn("S03.compareSyntheticCursor")(
        function* compareCursor(selected, expected, next) {
          cursorComparisons += 1;

          if (opened.cursorService.putIfCurrent === undefined) {
            return yield* Effect.die(
              new Error("The real SQLite cursor service has no compare-and-set")
            );
          }

          return yield* opened.cursorService.putIfCurrent(
            selected,
            expected,
            next
          );
        }
      ),
    };

    const adapterOptions: BoundedCursorHookOperationOptions = {
      cursors,
      enrollment: () =>
        Effect.succeed({
          reason: "Explicit synthetic Cursor hook enrollment",
          receiptIds: ["fixture-s03-cursor-enrollment"],
          state: "authorized",
        }),
      env: { store, storePath: path.join(sourceRoot, "fixture.sqlite") },
      selected: [selection],
    };

    const actual =
      fixture.makeBoundedCursorHookOperationAdapter(adapterOptions);

    const adapter: OperationAdapter = {
      ...actual,
      execute: (plan, step, execution) =>
        Effect.sync(() => {
          executions += 1;
        }).pipe(Effect.andThen(actual.execute(plan, step, execution))),
    };

    const service = yield* fixture.makeOperationService(opened.agentService, [
      adapter,
    ]);

    return {
      adapter,
      adapterOptions,
      appends: () => appends,
      args,
      context,
      cursorComparisons: () => cursorComparisons,
      cursors,
      directory,
      executions: () => executions,
      files,
      nativeBatches,
      records,
      ref,
      scope,
      selection,
      service,
      store,
    };
  }
);

export const createCursorHookLiveFixture = (
  fixture: CursorHookOperationFixtures,
  opened: OpenedEventStore,
  root: string
) =>
  cursorHookFixture(fixture, opened, root, {
    records: (context) => [
      syntheticStopRecord(
        fixture,
        { ...context, branch: "fixture-cursor-other-branch" },
        "live-filtered-branch"
      ),
    ],
  });

const cursorHookApply = Effect.fn("S03.cursorHookApply")(
  function* cursorHookApply(
    service: OperationServiceApi,
    input: OperationApplyInput
  ) {
    const output = yield* service.run(input);

    return output.action === "apply"
      ? output
      : yield* Effect.die(new Error("Expected a Cursor hook apply response"));
  }
);

export const registerCursorHookOperationTests = (
  fixture: CursorHookOperationFixtures
) => {
  describe("S03 bounded native Cursor hook collection", () => {
    it.effect(
      "equivalent selected references remain valid when their property order differs",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* reorderedCursorReference() {
            const source = yield* cursorHookFixture(fixture, opened, root);
            const known = source.selection.inputRef;

            const storeFields: Pick<
              AgentRef,
              "storeGeneration" | "storeId" | "version"
            > = {
              storeGeneration: known.storeGeneration,
              storeId: known.storeId,
              version: known.version,
            };

            const resourceFields: Pick<AgentRef, "basisId" | "id" | "kind"> = {
              basisId: known.basisId,
              id: known.id,
              kind: known.kind,
            };

            const reordered: AgentRef = { ...storeFields, ...resourceFields };

            expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(known));

            const adapter = fixture.makeBoundedCursorHookOperationAdapter({
              ...source.adapterOptions,
              selected: [{ ...source.selection, inputRef: reordered }],
            });

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [adapter]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              source.args,
              source.scope,
              cursorHookBounds
            );

            const output = yield* cursorHookApply(
              service,
              fixture.applyInput(plan)
            );

            expect(output.receipt.executionState).toBe("succeeded");
            expect(output.receipt.steps[0]?.inserted).toBe(2);
            expect(source.appends()).toBe(1);
            expect(source.cursorComparisons()).toBe(1);
            expect(
              (yield* opened.service.snapshot(allFixtureEvents)).events
            ).toHaveLength(2);
          })
        )
    );

    it.effect(
      "native stop and usage records retain provenance, stable ids and known token categories",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* nativeCursorStop() {
            const source = yield* cursorHookFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              cursorHookBounds
            );

            const output = yield* cursorHookApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.appends()).toBe(1);
            expect(source.executions()).toBe(1);
            expect(source.cursorComparisons()).toBe(1);
            expect(output.receipt.steps[0]?.inserted).toBe(2);
            expect(output.receipt.steps[0]?.rejected).toBe(0);

            const stored = yield* opened.service.snapshot(allFixtureEvents);

            expect(stored.events.map((event) => event.kind).toSorted()).toEqual(
              ["ai.turn", "ai.usage"]
            );
            expect(stored.manifest.originMix).toEqual([
              { count: 2, origin: "fixture" },
            ]);

            for (const event of stored.events) {
              expect(event).toMatchObject({
                acquisition: "hook",
                adapterId: "cursor-hooks",
                ai: {
                  branchSource: "hook",
                  channel: "hooks",
                  harness: "cursor",
                  modelRaw: "fixture-cursor-model",
                },
                context: source.context,
                identity: {
                  generationId: "fixture-s03-cursor-turn-selected",
                  sessionId: "fixture-s03-cursor-session-selected",
                  turnId:
                    "fixture-s03-cursor-session-selected:fixture-s03-cursor-turn-selected",
                },
                origin: "fixture",
              });
              expect(event.eventId).toMatch(/^sha256:[\da-f]{64}$/u);
              expect(event.evidence.hash).toBe(
                `sha256:${source.records[0]?.recordHash ?? ""}`
              );
            }

            expect(
              stored.events.find((event) => event.kind === "ai.usage")?.payload
            ).toMatchObject({
              normalizedCategories: {
                cacheWrite: 10,
                cachedInput: 30,
                input: 60,
                output: 20,
              },
              rawUsage: {
                cache_read_tokens: 30,
                cache_write_tokens: 10,
                input_tokens: 100,
                output_tokens: 20,
              },
              semanticsVerified: true,
            });

            expect(
              stored.events.find((event) => event.kind === "ai.usage")?.usage
            ).toMatchObject({
              premiumRequests: null,
              tokens: {
                cacheRead: 30,
                cacheWrite: 10,
                cacheWrite1h: null,
                cacheWrite5m: null,
                inputFresh: 60,
                output: 20,
                reasoning: null,
                total: null,
              },
              toolFigure: null,
            });
            expect(
              stored.events.find((event) => event.kind === "ai.turn")?.usage
            ).toBeNull();

            const checkpoint = yield* opened.cursorService.get(source.ref);

            expect(checkpoint?.cursor).toEqual({
              adapterId: "cursor-hooks",
              value: "1.json",
            });
            expect(output.receipt.steps[0]?.safeCursor).toBe(
              JSON.stringify(checkpoint?.cursor)
            );

            const native = yield* Effect.fromNullishOr(source.nativeBatches[0]);

            expect(
              yield* opened.service.append({
                ...native,
                cursor: checkpoint?.cursor ?? null,
                events: stored.events,
              })
            ).toEqual({ duplicates: 2, inserted: 0 });
          })
        )
    );

    it.effect(
      "only records from the selected repository, worktree and branch reach the real store",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* selectedCursorScope() {
            const source = yield* cursorHookFixture(fixture, opened, root, {
              records: (context) => [
                syntheticStopRecord(fixture, context),
                syntheticStopRecord(
                  fixture,
                  { ...context, branch: "fixture-other-branch" },
                  "other-branch"
                ),
                syntheticStopRecord(
                  fixture,
                  {
                    ...context,
                    repoCommonDir: path.join(root, "synthetic-other", ".git"),
                  },
                  "other-repository"
                ),
                syntheticStopRecord(
                  fixture,
                  {
                    ...context,
                    worktreePath: path.join(root, "synthetic-other-worktree"),
                  },
                  "other-worktree"
                ),
              ],
            });

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              cursorHookBounds
            );

            const output = yield* cursorHookApply(
              source.service,
              fixture.applyInput(plan)
            );

            const stored = yield* opened.service.snapshot(allFixtureEvents);

            expect(stored.events).toHaveLength(2);
            expect(
              stored.events.every(
                (event) =>
                  event.context.branch === source.context.branch &&
                  event.context.worktreePath === source.context.worktreePath &&
                  event.context.repoCommonDir === source.context.repoCommonDir
              )
            ).toBe(true);
            expect(output.receipt.steps[0]?.inserted).toBe(2);
            expect(output.receipt.steps[0]?.rejected).toBe(0);
            expect(source.nativeBatches[0]?.coverage.gaps).toContainEqual(
              expect.objectContaining({ code: "cursor-hooks.scope-filtered" })
            );
          })
        )
    );

    it.effect("an incompatible selected agent tool denies acquisition", () =>
      fixture.withFixtureStore((opened, root) =>
        Effect.gen(function* cursorToolDenied() {
          const source = yield* cursorHookFixture(fixture, opened, root);
          const before = yield* opened.agentService.identity;

          const failure = yield* fixture
            .createPlan(
              source.service,
              opened,
              source.args,
              { ...source.scope, tools: ["pi"] },
              cursorHookBounds
            )
            .pipe(Effect.flip);

          expect(failure).toMatchObject({ code: "scope-denied" });
          expect(source.appends()).toBe(0);
          expect(source.executions()).toBe(0);
          expect(yield* opened.agentService.identity).toEqual(before);
          expect(
            (yield* opened.service.snapshot(allFixtureEvents)).events
          ).toHaveLength(0);
        })
      )
    );

    for (const cap of ["maxFiles", "maxBytes"] as const) {
      it.effect(
        `${cap} stops acquisition before native decoding or append`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* cursorCaptureCap() {
              const source = yield* cursorHookFixture(fixture, opened, root);
              const before = yield* opened.agentService.identity;

              const sourceBytes = new TextEncoder().encode(
                JSON.stringify(source.records[0])
              ).byteLength;

              const failure = yield* fixture
                .createPlan(source.service, opened, source.args, source.scope, {
                  ...cursorHookBounds,
                  [cap]: cap === "maxFiles" ? 1 : sourceBytes - 1,
                })
                .pipe(Effect.flip);

              expect(failure).toMatchObject({ code: "budget-exhausted" });
              expect(source.appends()).toBe(0);
              expect(source.executions()).toBe(0);
              expect(source.cursorComparisons()).toBe(0);
              expect(yield* opened.cursorService.get(source.ref)).toBeNull();
              expect(yield* opened.agentService.identity).toEqual(before);
            })
          )
      );
    }

    it.effect(
      "the durable idempotency receipt survives restart without a second source read or append",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* durableCursorReceipt() {
            const source = yield* cursorHookFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              cursorHookBounds
            );

            const input = fixture.applyInput(plan);
            const first = yield* cursorHookApply(source.service, input);
            rmSync(source.directory, { recursive: true });

            const restarted = yield* fixture.makeOperationService(
              opened.agentService,
              [source.adapter]
            );

            const repeated = yield* cursorHookApply(restarted, input);

            expect(first.reused).toBe(false);
            expect(repeated.reused).toBe(true);
            expect(repeated.receipt).toEqual(first.receipt);
            expect(source.executions()).toBe(1);
            expect(source.appends()).toBe(1);
            expect(source.cursorComparisons()).toBe(1);
            expect(
              (yield* opened.service.snapshot(allFixtureEvents)).events
            ).toHaveLength(2);
          })
        )
    );

    it.effect(
      "duplicate native records consume normalization allowance before deduplication",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* duplicateCursorRecordBudget() {
            const source = yield* cursorHookFixture(fixture, opened, root, {
              records: (context) => {
                const record = syntheticStopRecord(fixture, context);

                return [record, record, record];
              },
            });

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              { ...cursorHookBounds, maxRecords: 8 }
            );

            const output = yield* cursorHookApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.executions()).toBe(1);
            expect(source.appends()).toBe(0);
            expect(source.cursorComparisons()).toBe(0);
            expect(output.receipt.executionState).not.toBe("succeeded");
            expect(output.receipt.steps[0]?.inserted).toBe(0);
            expect(output.receipt.steps[0]?.safeCursor).toBeNull();
            expect(output.receipt.steps[0]?.gaps.join(" ")).toMatch(
              /record|budget|allowance|bound|limit|work/iu
            );
            expect(yield* opened.cursorService.get(source.ref)).toBeNull();
            expect(
              (yield* opened.service.snapshot(allFixtureEvents)).events
            ).toHaveLength(0);
          })
        )
    );

    it.effect(
      "a changed reviewed native file rejects apply before append",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* changedCursorSource() {
            const source = yield* cursorHookFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              cursorHookBounds
            );

            const file = yield* Effect.fromNullishOr(source.files[0]);

            writeFileSync(
              file,
              JSON.stringify(
                syntheticStopRecord(
                  fixture,
                  source.context,
                  "changed-after-review"
                )
              )
            );

            const output = yield* cursorHookApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(output.receipt.executionState).toBe("rejected");
            expect(output.receipt.recovery).toBe("replan");
            expect(output.receipt.verificationState).toBe("not-attempted");
            expect(source.executions()).toBe(0);
            expect(source.appends()).toBe(0);
            expect(yield* opened.cursorService.get(source.ref)).toBeNull();
            expect(
              (yield* opened.service.snapshot(allFixtureEvents)).events
            ).toHaveLength(0);
          })
        )
    );

    it.effect(
      "a competing durable cursor update after append is preserved by compare-and-set",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* competingCursorCheckpoint() {
            let competing: StoredCursor | null = null;

            const source = yield* cursorHookFixture(fixture, opened, root, {
              afterAppend: (batch, ref, cursors) =>
                Effect.gen(function* commitCompetingCheckpoint() {
                  competing = {
                    cursor: {
                      adapterId: "cursor-hooks",
                      value: "fixture-other-operation.json",
                    },
                    lastEventId: batch.events.at(-1)?.eventId ?? null,
                    mtimeMs: null,
                    size: null,
                  };

                  yield* cursors.put(ref, competing);
                }),
            });

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              cursorHookBounds
            );

            const output = yield* cursorHookApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.appends()).toBe(1);
            expect(source.cursorComparisons()).toBe(1);
            expect(output.receipt.steps[0]?.inserted).toBe(2);
            expect(output.receipt.steps[0]?.safeCursor).toBeNull();
            expect(output.receipt.steps[0]?.gaps.join(" ")).toMatch(
              /checkpoint changed concurrently/u
            );
            expect(yield* opened.cursorService.get(source.ref)).toEqual(
              competing
            );
            expect(
              (yield* opened.service.snapshot(allFixtureEvents)).events
            ).toHaveLength(2);
          })
        )
    );
  });
};
