import {
  existsSync,
  realpathSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic Cursor files stay inside the parent test's owned scratch directory.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic Cursor references use exact canonical paths.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Scope } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import { StoreBusy } from "../../../../src/dx/contracts/error-store-busy.js";
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
  OperationReceipt,
} from "../../../../src/dx/model/agent-operation.js";
import { emptyFlightContext } from "../../../../src/dx/model/event.js";
import type {
  EventBatch,
  FlightContext,
} from "../../../../src/dx/model/event.js";
import type { PlannedSourceSelection } from "../../../../src/dx/operations/collector.js";
import type { BoundedCursorOperationOptions } from "../../../../src/dx/operations/cursor.js";
import type {
  OperationAdapter,
  OperationApplyInput,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type { StoredCursor } from "../../../../src/dx/storage/harness-cursors.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";

interface CursorOperationFixtures {
  readonly applyInput: (
    plan: OperationPlan,
    key?: string
  ) => OperationApplyInput;
  readonly applyReceipt: (
    service: OperationServiceApi,
    input: OperationApplyInput
  ) => Effect.Effect<
    { readonly receipt: OperationReceipt; readonly reused: boolean },
    AgentStoreFailure
  >;
  readonly createPlan: (
    service: OperationServiceApi,
    opened: OpenedEventStore,
    args?: OperationArguments,
    scope?: AgentScope,
    limits?: Partial<OperationBounds>
  ) => Effect.Effect<OperationPlan, AgentStoreFailure>;
  readonly fixtureBatch: (id: string, context?: FlightContext) => EventBatch;
  readonly fixtureScope: AgentScope;
  readonly makeBoundedCursorOperationAdapter: (
    options: BoundedCursorOperationOptions
  ) => OperationAdapter;
  readonly makeOperationService: (
    store: AgentStoreService,
    adapters: readonly OperationAdapter[]
  ) => Effect.Effect<OperationServiceApi, never, Scope.Scope>;
  readonly withFixtureStore: <A, E>(
    use: (
      opened: OpenedEventStore,
      root: string
    ) => Effect.Effect<A, E, Scope.Scope>
  ) => Effect.Effect<A, E | AgentStoreFailure>;
}

const snapshotSelector = {
  branch: null,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
};

const createSyntheticCursorDatabase = Effect.fn(
  "S03.createSyntheticCursorDatabase"
)(function* createSyntheticCursorDatabase(file: string, worktree: string) {
  const writer = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(file)),
    (source) =>
      Effect.sync(() => {
        source.close();
      })
  );

  writer.exec(
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)"
  );

  for (const selected of [
    { id: "fixture-cursor-selected", worktree },
    { id: "fixture-cursor-other", worktree: `${worktree}-other` },
  ]) {
    writer.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `composerData:${selected.id}`,
      JSON.stringify({
        composerId: selected.id,
        createdAt: 1_790_000_000_000,
        lastUpdatedAt: 1_790_000_600_000,
        modelConfig: { modelName: "fixture-cursor-model" },
        trackedGitRepos: [{ repoPath: selected.worktree }],
      })
    );

    writer.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `bubbleId:${selected.id}:fixture-turn`,
      JSON.stringify({
        createdAt: "2026-09-21T10:00:05.000Z",
        requestId: `${selected.id}-request`,
        type: 2,
      })
    );
  }
}, Effect.scoped);

const cursorSourceFixture = Effect.fn("S03.cursorSourceFixture")(
  function* cursorSourceFixture(
    fixture: CursorOperationFixtures,
    opened: OpenedEventStore,
    root: string,
    kind: "local" | "output" = "local",
    differentReferenceOrder = false
  ) {
    const sourceRoot = realpathSync(root);
    const worktree = path.join(sourceRoot, "synthetic-cursor-worktree");
    const nativeCwd = path.join(worktree, "synthetic-native-subdirectory");

    const nestedOtherWorktree = path.join(
      worktree,
      "synthetic-nested-worktree"
    );

    const file = path.join(
      sourceRoot,
      kind === "local"
        ? "synthetic-cursor-source.vscdb"
        : "synthetic-cursor-selected-output.jsonl"
    );

    const context: FlightContext = {
      ...emptyFlightContext,
      branch: "fixture-cursor-main",
      headSha: "fixture-cursor-head",
      repoCommonDir: path.join(worktree, ".git"),
      worktreePath: worktree,
    };

    if (kind === "local") {
      yield* createSyntheticCursorDatabase(file, worktree);
    } else {
      writeFileSync(
        file,
        `${JSON.stringify({
          cwd: nativeCwd,
          model: "fixture-cursor-cli-model",
          session_id: "fixture-cursor-cli-selected",
          subtype: "init",
          type: "system",
        })}\n${JSON.stringify({
          request_id: "fixture-cursor-cli-selected-request",
          session_id: "fixture-cursor-cli-selected",
          type: "result",
        })}\n`
      );
      writeFileSync(
        path.join(sourceRoot, "synthetic-cursor-unselected-output.jsonl"),
        `${JSON.stringify({
          request_id: "fixture-cursor-cli-unselected-request",
          session_id: "fixture-cursor-cli-unselected",
          type: "result",
          usage: { inputTokens: 999, outputTokens: 999 },
        })}\n`
      );
    }

    const identity = yield* opened.agentService.identity;

    const source =
      kind === "local" ? "cursor-local-db" : "collector/cursor-cli";

    const inputRef: AgentRef = {
      basisId: null,
      id: file,
      kind: "evidence",
      storeGeneration: identity.storeGeneration,
      storeId: identity.storeId,
      version: "dx.bounded-cursor.v1",
    };

    const ref: SessionRef = {
      channel: "local-db",
      harness: "cursor",
      id: file,
      mtimeMs: null,
      path: file,
      sessionId: null,
      size: null,
      source,
      worktree,
    };

    const firstFields = {
      storeGeneration: inputRef.storeGeneration,
      storeId: inputRef.storeId,
      version: inputRef.version,
    };

    const lastFields = {
      basisId: inputRef.basisId,
      id: inputRef.id,
      kind: inputRef.kind,
    };

    const selectedInputRef: AgentRef =
      differentReferenceOrder === true
        ? { ...firstFields, ...lastFields }
        : inputRef;

    const selection: PlannedSourceSelection = {
      inputRef: selectedInputRef,
      planned: {
        context,
        harness: "cursor",
        input: file,
        ref,
        source,
        unavailable: null,
      },
      root: sourceRoot,
    };

    const args: OperationArguments = {
      allowSourceGrowth: false,
      cursor: null,
      inputRefs: [inputRef],
      kind: "collect",
      parserVersion: "dx.bounded-cursor.v1",
      selectedRoots: [sourceRoot],
      source,
    };

    const scope: AgentScope = {
      ...fixture.fixtureScope,
      branchSelection: { branches: [], kind: "all" },
      repoId: context.repoCommonDir,
      resolution: "Synthetic S03 native Cursor source; no live evidence",
      sources: [source],
      tools: ["cursor"],
      worktreeId: worktree,
    };

    const batches: EventBatch[] = [];
    let appends = 0;
    let executions = 0;
    let busy = false;
    let enrolled = true;
    let afterAppend: Effect.Effect<void, StoreFailure> = Effect.void;

    const store: EventStoreService = {
      ...opened.service,
      append: (batch) =>
        Effect.gen(function* cursorFixtureAppend() {
          appends += 1;

          if (busy) {
            return yield* new StoreBusy({
              message:
                "Synthetic Cursor spool fixture holds the append boundary",
            });
          }

          const labelledBatch: EventBatch = {
            ...batch,
            events: batch.events.map((event) => ({
              ...event,
              origin: "fixture",
            })),
          };

          const result = yield* opened.service.append(labelledBatch);

          batches.push(labelledBatch);
          yield* afterAppend;

          return result;
        }),
    };

    const actual = fixture.makeBoundedCursorOperationAdapter({
      cursors: opened.cursorService,
      enrollment: () =>
        Effect.succeed({
          reason: enrolled
            ? "Explicit synthetic tracked Cursor source enrollment"
            : "The synthetic Cursor source enrollment was revoked",
          receiptIds: enrolled ? ["fixture-s03-cursor-enrollment"] : [],
          state: enrolled ? "authorized" : "denied",
        }),
      env: { store, storePath: path.join(root, "fixture.sqlite") },
      selected: () => Effect.succeed([selection]),
      worktreeRoots: () =>
        Effect.succeed([worktree, `${worktree}-other`, nestedOtherWorktree]),
    });

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
      appends: () => appends,
      args,
      batches,
      context,
      executions: () => executions,
      file,
      limits: { maxBytes: 2_000_000, maxFiles: 10, maxRecords: 2000 },
      nativeCwd,
      nestedOtherWorktree,
      ref,
      revokeEnrollment: () => {
        enrolled = false;
      },
      scope,
      selectedInputRef,
      service,
      setAfterAppend: (effect: Effect.Effect<void, StoreFailure>) => {
        afterAppend = effect;
      },
      setBusy: () => {
        busy = true;
      },
      worktree,
    };
  }
);

export const registerCursorOperationTests = (
  fixture: CursorOperationFixtures
) => {
  describe("S03 bounded native Cursor collection", () => {
    it.effect(
      "independently constructed native references remain valid across property order",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* semanticNativeCursorReference() {
            const source = yield* cursorSourceFixture(
              fixture,
              opened,
              root,
              "local",
              true
            );

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            const reviewedRef =
              plan.arguments.kind === "collect"
                ? plan.arguments.inputRefs[0]
                : null;

            expect(source.selectedInputRef).toEqual(reviewedRef);
            expect(Object.keys(source.selectedInputRef)).not.toEqual(
              Object.keys(reviewedRef ?? {})
            );

            const { receipt } = yield* fixture.applyReceipt(
              source.service,
              fixture.applyInput(plan)
            );

            expect(plan.effects.reads).toEqual([source.file]);
            expect(receipt.steps[0]?.state).toBe("committed");
            expect(source.appends()).toBe(1);
            expect(source.executions()).toBe(1);
            expect(
              source.batches.flatMap((batch) => batch.events)
            ).toHaveLength(2);

            const snapshot = yield* opened.service.snapshot(snapshotSelector);

            expect(snapshot.events).toHaveLength(2);
            expect(
              snapshot.events.every(
                (event) =>
                  event.identity.sessionId === "fixture-cursor-selected" &&
                  event.origin === "fixture"
              )
            ).toBe(true);
          })
        )
    );

    it.effect(
      "native rows import only the selected worktree after unrelated durable progress",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* selectedNativeCursorRows() {
            const source = yield* cursorSourceFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            yield* opened.service.append(
              fixture.fixtureBatch("cursor-unrelated")
            );

            const { receipt } = yield* fixture.applyReceipt(
              source.service,
              fixture.applyInput(plan)
            );

            const events = source.batches.flatMap((batch) => batch.events);

            expect(source.appends()).toBe(1);
            expect(source.executions()).toBe(1);
            expect(receipt.steps[0]?.state).toBe("committed");
            expect(events).toHaveLength(2);
            expect(events.map((event) => event.kind)).toEqual([
              "ai.session",
              "ai.turn",
            ]);
            expect(
              events.every(
                (event) =>
                  event.identity.sessionId === "fixture-cursor-selected" &&
                  event.context.worktreePath === source.worktree &&
                  event.context.branch === null &&
                  event.context.headSha === null &&
                  event.origin === "fixture" &&
                  event.usage === null &&
                  event.ai?.agentId === null
              )
            ).toBe(true);
            expect(plan.forecast.cost).toBeNull();
            expect(receipt.resources.bytesRead).toBeNull();
            expect(
              receipt.steps
                .flatMap((step) => step.gaps)
                .some((gap) => /physical.*I\/O.*unavailable/u.test(gap))
            ).toBe(true);

            const snapshot = yield* opened.service.snapshot(snapshotSelector);

            expect(snapshot.events).toHaveLength(3);
          })
        )
    );

    it.effect(
      "a matching checkpoint cannot turn unreadable native rows into verified evidence on retry",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* partialCursorCheckpointRecovery() {
            const source = yield* cursorSourceFixture(fixture, opened, root);

            yield* Effect.acquireRelease(
              Effect.sync(() => new DatabaseSync(source.file)),
              (writer) =>
                Effect.sync(() => {
                  writer.close();
                })
            ).pipe(
              Effect.tap((writer) =>
                Effect.sync(() => {
                  writer
                    .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
                    .run(
                      "fixture-unreadable-native-bubble",
                      "bubbleId:fixture-cursor-selected:fixture-turn"
                    );
                })
              ),
              Effect.scoped
            );

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            const input = fixture.applyInput(plan);
            const first = yield* fixture.applyReceipt(source.service, input);
            const [initialStep] = first.receipt.steps;
            const checkpoint = yield* opened.cursorService.get(source.ref);
            const before = yield* opened.service.snapshot(snapshotSelector);

            expect(first.receipt).toMatchObject({
              executionState: "partial",
              recovery: "safe-resume",
              verificationState: "partial",
            });
            expect(initialStep).toMatchObject({
              inserted: 1,
              remainingWork: "Replan unresolved native Cursor rows.",
              state: "partial",
            });
            expect(
              initialStep?.gaps.some((gap) => /unreadable-rows/u.test(gap))
            ).toBe(true);
            expect(initialStep?.committedThrough).not.toBeNull();
            expect(initialStep?.committedThrough).toBe(checkpoint?.lastEventId);
            expect(initialStep?.safeCursor).toBe(
              JSON.stringify(checkpoint?.cursor ?? null)
            );
            expect(before.events).toHaveLength(1);

            const retry = yield* fixture.applyReceipt(source.service, input);

            expect(retry.reused).toBe(true);
            expect(retry.receipt).toMatchObject({
              executionState: "partial",
              id: first.receipt.id,
              recovery: "safe-resume",
              verificationState: "partial",
            });
            expect(retry.receipt.steps).toEqual(first.receipt.steps);
            expect(source.executions()).toBe(1);
            expect(source.appends()).toBe(1);
            expect(yield* opened.cursorService.get(source.ref)).toEqual(
              checkpoint
            );

            const read = yield* source.service.run({
              action: "get",
              operation: first.receipt,
            });

            if (read.action === "get") {
              expect(read.receipt).toEqual(retry.receipt);
            } else {
              expect.fail("Expected the retained partial Cursor receipt");
            }

            const after = yield* opened.service.snapshot(snapshotSelector);

            expect(after.events).toEqual(before.events);
          })
        )
    );

    it.effect(
      "an exact saved CLI output imports no neighboring file or invented usage",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* exactSavedCursorOutput() {
            const source = yield* cursorSourceFixture(
              fixture,
              opened,
              root,
              "output"
            );

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            const { receipt } = yield* fixture.applyReceipt(
              source.service,
              fixture.applyInput(plan)
            );

            const events = source.batches.flatMap((batch) => batch.events);

            expect(source.appends()).toBe(1);
            expect(events.length).toBeGreaterThan(0);
            expect(
              events.every(
                (event) =>
                  event.identity.sessionId === "fixture-cursor-cli-selected" &&
                  event.context.worktreePath === source.worktree &&
                  event.context.branch === null &&
                  event.context.headSha === null &&
                  event.context.flightId === null &&
                  event.ai?.cwd === source.nativeCwd &&
                  event.payload.cwd === source.nativeCwd &&
                  event.origin === "fixture" &&
                  event.usage === null
              )
            ).toBe(true);
            expect(plan.effects.reads).toEqual([source.file]);
            expect(plan.effects.networkDestinations).toEqual([]);
            expect(plan.forecast.cost).toBeNull();
            expect(receipt.resources.requests).toBe(0);
            expect(
              receipt.steps
                .flatMap((step) => step.gaps)
                .some((gap) => /no-cost-in-cli-output/u.test(gap))
            ).toBe(true);
          })
        )
    );

    for (const nativeCwdCase of ["missing", "nested-other-worktree"]) {
      it.effect(
        `saved CLI output with ${nativeCwdCase} working-directory proof withholds observations and keeps the safe cursor`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* unprovenNativeCursorCwd() {
              const source = yield* cursorSourceFixture(
                fixture,
                opened,
                root,
                "output"
              );

              const initialFrame =
                nativeCwdCase === "missing"
                  ? ""
                  : `${JSON.stringify({
                      cwd: path.join(
                        source.nestedOtherWorktree,
                        "native-subdirectory"
                      ),
                      session_id: "fixture-cursor-unproven-session",
                      subtype: "init",
                      type: "system",
                    })}\n`;

              writeFileSync(
                source.file,
                `${initialFrame}${JSON.stringify({
                  request_id: "fixture-cursor-unproven-request",
                  session_id: "fixture-cursor-unproven-session",
                  type: "result",
                })}\n`
              );

              const prior: StoredCursor = {
                cursor: {
                  adapterId: "cursor-cli",
                  value: "fixture:s03:known-safe-native-cursor",
                },
                lastEventId: null,
                mtimeMs: null,
                size: null,
              };

              yield* opened.cursorService.put(source.ref, prior);

              const plan = yield* fixture.createPlan(
                source.service,
                opened,
                source.args,
                source.scope,
                source.limits
              );

              const { receipt } = yield* fixture.applyReceipt(
                source.service,
                fixture.applyInput(plan)
              );

              expect(source.batches.flatMap((batch) => batch.events)).toEqual(
                []
              );
              expect(receipt.steps[0]?.inserted).toBe(0);
              expect(receipt.steps[0]?.committedThrough).toBeNull();
              expect(receipt.steps[0]?.safeCursor).toBe(
                JSON.stringify(prior.cursor)
              );
              expect(
                receipt.steps
                  .flatMap((step) => step.gaps)
                  .some((gap) => /scope-unproven/u.test(gap))
              ).toBe(true);
              expect(yield* opened.cursorService.get(source.ref)).toEqual(
                prior
              );

              const snapshot = yield* opened.service.snapshot(snapshotSelector);

              expect(snapshot.events).toEqual([]);
            })
          )
      );
    }

    it.effect(
      "byte and record caps reject source preflight before append",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* cursorPreflightCaps() {
            const source = yield* cursorSourceFixture(fixture, opened, root);

            writeFileSync(
              source.file,
              `SQLite format 3\u0000${"fixture".repeat(4096)}`
            );

            const bytesFailure = yield* fixture
              .createPlan(source.service, opened, source.args, source.scope, {
                ...source.limits,
                maxBytes: 1,
              })
              .pipe(Effect.flip);

            expect(bytesFailure).toMatchObject({ code: "budget-exhausted" });

            writeFileSync(source.file, "");
            yield* createSyntheticCursorDatabase(source.file, source.worktree);

            const recordsFailure = yield* fixture
              .createPlan(source.service, opened, source.args, source.scope, {
                ...source.limits,
                maxRecords: 1,
              })
              .pipe(Effect.flip);

            expect(recordsFailure).toMatchObject({ code: "budget-exhausted" });
            expect(source.executions()).toBe(0);
            expect(source.appends()).toBe(0);
            expect(source.batches).toEqual([]);

            const snapshot = yield* opened.service.snapshot(snapshotSelector);

            expect(snapshot.events).toEqual([]);
          })
        )
    );

    it.effect(
      "current enrollment is required again before applying a reviewed source",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* revokedCursorEnrollment() {
            const source = yield* cursorSourceFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            source.revokeEnrollment();

            const failure = yield* fixture
              .applyReceipt(source.service, {
                ...fixture.applyInput(plan),
                consentReceiptIds: ["fixture-s03-cursor-enrollment"],
              })
              .pipe(Effect.flip);

            expect(failure).toMatchObject({ code: "authorization-required" });
            expect(source.executions()).toBe(0);
            expect(source.appends()).toBe(0);

            const snapshot = yield* opened.service.snapshot(snapshotSelector);

            expect(snapshot.events).toEqual([]);
          })
        )
    );

    it.effect(
      "repository, worktree, branch and selected root mismatches never grant scope",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* mismatchedCursorScopes() {
            const source = yield* cursorSourceFixture(fixture, opened, root);

            const mismatches: readonly AgentScope[] = [
              { ...source.scope, repoId: "fixture:another-repository" },
              { ...source.scope, worktreeId: `${source.worktree}-other` },
              {
                ...source.scope,
                branchSelection: {
                  branches: ["fixture-another-branch"],
                  kind: "selected",
                },
              },
            ];

            for (const scope of mismatches) {
              const failure = yield* fixture
                .createPlan(
                  source.service,
                  opened,
                  source.args,
                  scope,
                  source.limits
                )
                .pipe(Effect.flip);

              expect(failure).toMatchObject({ code: "scope-denied" });
            }

            const rootFailure = yield* fixture
              .createPlan(
                source.service,
                opened,
                { ...source.args, selectedRoots: [source.worktree] },
                source.scope,
                source.limits
              )
              .pipe(Effect.flip);

            expect(rootFailure).toMatchObject({ code: "scope-denied" });
            expect(source.appends()).toBe(0);
            expect(source.executions()).toBe(0);
          })
        )
    );

    it.effect(
      "a saved CLI file changed after review requires a new plan before append",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* changedReviewedCursorOutput() {
            const source = yield* cursorSourceFixture(
              fixture,
              opened,
              root,
              "output"
            );

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            writeFileSync(
              source.file,
              `${JSON.stringify({
                session_id: "fixture-replaced-cursor-cli-session",
                type: "result",
              })}\n`
            );

            const { receipt } = yield* fixture.applyReceipt(
              source.service,
              fixture.applyInput(plan)
            );

            expect(receipt.executionState).toBe("rejected");
            expect(receipt.recovery).toBe("replan");
            expect(receipt.verificationState).toBe("not-attempted");
            expect(source.appends()).toBe(0);
            expect(source.executions()).toBe(0);

            const snapshot = yield* opened.service.snapshot(snapshotSelector);

            expect(snapshot.events).toEqual([]);
          })
        )
    );

    it.effect(
      "a spooled native batch keeps the previous durable safe cursor",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* spooledCursorCheckpoint() {
            const source = yield* cursorSourceFixture(fixture, opened, root);

            const prior: StoredCursor = {
              cursor: {
                adapterId: "cursor-local-db",
                value: "2025-01-01T00:00:00.000Z",
              },
              lastEventId: null,
              mtimeMs: null,
              size: null,
            };

            yield* opened.cursorService.put(source.ref, prior);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            source.setBusy();

            const { receipt } = yield* fixture.applyReceipt(
              source.service,
              fixture.applyInput(plan)
            );

            expect(receipt.steps[0]?.state).toBe("spooled");
            expect(receipt.steps[0]?.inserted).toBe(0);
            expect(receipt.steps[0]?.safeCursor).toBe(
              JSON.stringify(prior.cursor)
            );
            expect(receipt.steps[0]?.spooledRefs).toHaveLength(1);
            expect(
              receipt.steps[0]?.spooledRefs.every((file) => existsSync(file))
            ).toBe(true);
            expect(yield* opened.cursorService.get(source.ref)).toEqual(prior);

            const snapshot = yield* opened.service.snapshot(snapshotSelector);

            expect(snapshot.events).toEqual([]);
          })
        )
    );

    it.effect(
      "a concurrent checkpoint writer survives the committed batch comparison",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* currentCursorCheckpointCas() {
            const source = yield* cursorSourceFixture(fixture, opened, root);

            const concurrent: StoredCursor = {
              cursor: {
                adapterId: "cursor-local-db",
                value: "2026-09-22T00:00:00.000Z",
              },
              lastEventId: null,
              mtimeMs: null,
              size: null,
            };

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            source.setAfterAppend(
              opened.cursorService.put(source.ref, concurrent)
            );

            const { receipt } = yield* fixture.applyReceipt(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.appends()).toBe(1);
            expect(receipt.steps[0]?.state).toBe("partial");
            expect(receipt.steps[0]?.inserted).toBe(2);
            expect(receipt.steps[0]?.safeCursor).toBe("null");
            expect(
              receipt.steps[0]?.gaps.some((gap) =>
                /Another writer changed.*checkpoint/u.test(gap)
              )
            ).toBe(true);
            expect(yield* opened.cursorService.get(source.ref)).toEqual(
              concurrent
            );

            const snapshot = yield* opened.service.snapshot(snapshotSelector);

            expect(snapshot.events).toHaveLength(2);
          })
        )
    );
  });
};
