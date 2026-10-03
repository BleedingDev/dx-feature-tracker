// @effect-diagnostics-next-line nodeBuiltinImport:off -- The parent owns and releases the scratch directory containing synthetic source databases.
import { realpathSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic source references use exact canonical absolute paths.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Scope } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import type { EventStoreService } from "../../../../src/dx/contracts/services.js";
import type {
  AgentRef,
  AgentScope,
} from "../../../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
} from "../../../../src/dx/model/agent-operation.js";
import { emptyFlightContext } from "../../../../src/dx/model/event.js";
import type {
  EventBatch,
  FlightContext,
} from "../../../../src/dx/model/event.js";
import type { PlannedSourceSelection } from "../../../../src/dx/operations/collector.js";
import type { BoundedOpencodeOperationOptions } from "../../../../src/dx/operations/opencode.js";
import type {
  OperationAdapter,
  OperationApplyInput,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";

interface OpencodeOperationFixtures {
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
  readonly fixtureBatch: (id: string, context?: FlightContext) => EventBatch;
  readonly fixtureScope: AgentScope;
  readonly makeBoundedOpencodeOperationAdapter: (
    options: BoundedOpencodeOperationOptions
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

interface SyntheticMessage {
  readonly data: string;
  readonly id: string;
  readonly seq: number;
  readonly sessionId: string;
  readonly type: "user" | "assistant";
}

const insertSyntheticSession = (
  writer: DatabaseSync,
  id: string,
  directory: string
) => {
  writer
    .prepare(
      "INSERT INTO session_v2 (id, directory, time_created) VALUES (?, ?, ?)"
    )
    .run(id, directory, 1_767_225_600_000);
};

const insertSyntheticMessage = (
  writer: DatabaseSync,
  message: SyntheticMessage
) => {
  writer
    .prepare(
      "INSERT INTO session_message (id, session_id, seq, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      message.id,
      message.sessionId,
      message.seq,
      message.type,
      1_767_225_600_000 + message.seq,
      1_767_225_600_010 + message.seq,
      message.data
    );
};

const opencodeFixture = Effect.fn("S03.opencodeFixture")(
  function* opencodeFixture(
    fixture: OpencodeOperationFixtures,
    opened: OpenedEventStore,
    root: string
  ) {
    const sourceRoot = realpathSync(root);
    const file = path.join(sourceRoot, "synthetic-opencode-source.sqlite");
    const worktree = path.join(sourceRoot, "synthetic-tracked-worktree");
    const unrelatedWorktree = path.join(sourceRoot, "synthetic-other-worktree");
    const sessionId = "fixture-s03-opencode-selected";
    const unrelatedSessionId = "fixture-s03-opencode-unselected";
    const otherSessionId = "fixture-s03-opencode-other-worktree";

    const writer = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(file)),
      (source) =>
        Effect.sync(() => {
          source.close();
        })
    );

    writer.exec(
      "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL, directory TEXT NOT NULL); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)"
    );

    for (const selected of [
      { directory: worktree, id: sessionId },
      { directory: worktree, id: unrelatedSessionId },
      { directory: unrelatedWorktree, id: otherSessionId },
    ]) {
      insertSyntheticSession(writer, selected.id, selected.directory);
      insertSyntheticMessage(writer, {
        data: JSON.stringify({
          location: { directory: selected.directory },
          model: { id: "fixture-model", providerID: "local" },
          time: { completed: 1_767_225_600_020 },
        }),
        id: `${selected.id}-assistant`,
        seq: 2,
        sessionId: selected.id,
        type: "assistant",
      });
    }

    insertSyntheticMessage(writer, {
      data: JSON.stringify({ location: { directory: worktree } }),
      id: `${sessionId}-user`,
      seq: 1,
      sessionId,
      type: "user",
    });

    const identity = yield* opened.agentService.identity;

    const context: FlightContext = {
      ...emptyFlightContext,
      branch: "fixture-opencode-branch",
      headSha: "fixture-opencode-head",
      repoCommonDir: path.join(worktree, ".git"),
      worktreePath: worktree,
    };

    const inputRef: AgentRef = {
      basisId: null,
      id: `${file}#${sessionId}`,
      kind: "evidence",
      storeGeneration: identity.storeGeneration,
      storeId: identity.storeId,
      version: "dx.bounded-opencode.v1",
    };

    const selection: PlannedSourceSelection = {
      inputRef,
      planned: {
        context,
        harness: "opencode",
        input: file,
        ref: {
          channel: "local-db",
          harness: "opencode",
          id: inputRef.id,
          mtimeMs: null,
          path: file,
          sessionId,
          size: null,
          source: "harness.opencode",
          worktree,
        },
        source: "harness.opencode",
        unavailable: null,
      },
      root: sourceRoot,
    };

    const args: OperationArguments = {
      allowSourceGrowth: true,
      cursor: null,
      inputRefs: [inputRef],
      kind: "collect",
      parserVersion: "dx.bounded-opencode.v1",
      selectedRoots: [sourceRoot],
      source: "harness.opencode",
    };

    const scope: AgentScope = {
      ...fixture.fixtureScope,
      branchSelection: { branches: [context.branch ?? ""], kind: "selected" },
      repoId: context.repoCommonDir,
      resolution: "Synthetic S03 native OpenCode source; no live evidence",
      sources: ["harness.opencode"],
      worktreeId: worktree,
    };

    let appends = 0;
    let executions = 0;
    const batches: EventBatch[] = [];

    const store: EventStoreService = {
      ...opened.service,
      append: (batch) => {
        const labelled: EventBatch = {
          ...batch,
          events: batch.events.map((event): EventBatch["events"][number] => ({
            ...event,
            origin: "fixture",
          })),
        };

        return Effect.sync(() => {
          appends += 1;
        }).pipe(
          Effect.andThen(opened.service.append(labelled)),
          Effect.tap(() =>
            Effect.sync(() => {
              batches.push(labelled);
            })
          )
        );
      },
    };

    const actual = fixture.makeBoundedOpencodeOperationAdapter({
      enrollment: () =>
        Effect.succeed({
          reason: "Explicit synthetic tracked source enrollment",
          receiptIds: ["fixture-s03-opencode-enrollment"],
          state: "authorized",
        }),
      env: { store, storePath: path.join(root, "fixture.sqlite") },
      selected: (request) =>
        Effect.succeed(
          request.arguments.kind === "collect" &&
            request.arguments.inputRefs.some(
              (ref) => ref.id === selection.inputRef.id
            )
            ? [selection]
            : []
        ),
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
      limits: { maxBytes: 2_000_000, maxFiles: 10, maxRecords: 1000 },
      scope,
      selection,
      service,
      sessionId,
      unrelatedSessionId,
      worktree,
      writer,
    };
  }
);

const opencodeApply = Effect.fn("S03.opencodeApply")(function* opencodeApply(
  service: OperationServiceApi,
  input: OperationApplyInput
) {
  const result = yield* service.run(input);

  return result.action === "apply"
    ? result.receipt
    : yield* Effect.die(new Error("Expected an apply response"));
});

export const registerOpencodeOperationTests = (
  fixture: OpencodeOperationFixtures
) => {
  describe("S03 bounded native OpenCode collection", () => {
    it.effect(
      "an exact session imports only its own native rows and preserves unavailable usage",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* exactOpencodeSession() {
            const source = yield* opencodeFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            const receipt = yield* opencodeApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.appends()).toBe(1);
            expect(source.executions()).toBe(1);
            expect(receipt.steps[0]?.inserted).toBeGreaterThan(0);
            expect(receipt.steps[0]?.rejected).toBeNull();
            expect(receipt.resources.bytesRead).toBeNull();

            const snapshot = yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            });

            expect(snapshot.events.length).toBeGreaterThan(0);
            expect(
              snapshot.events.every(
                (event) =>
                  event.origin === "fixture" &&
                  event.identity.sessionId === source.sessionId &&
                  event.context.worktreePath === source.worktree &&
                  event.context.branch === source.context.branch &&
                  event.context.repoCommonDir === source.context.repoCommonDir
              )
            ).toBe(true);
            expect(snapshot.events.map((event) => event.kind)).toContain(
              "ai.request"
            );
            expect(snapshot.events.every((event) => event.usage === null)).toBe(
              true
            );
            expect(plan.forecast.cost).toBeNull();
            expect(
              receipt.steps
                .flatMap((step) => step.gaps)
                .some((gap) => /physical read volume.*unavailable/u.test(gap))
            ).toBe(true);
          })
        )
    );

    it.effect(
      "an independently resolved native reference accepts equivalent reordered fields",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* reorderedOpencodeReference() {
            const source = yield* opencodeFixture(fixture, opened, root);
            const original = source.selection.inputRef;

            const reordered: AgentRef = {
              basisId: original.basisId,
              id: original.id,
              kind: original.kind,
              storeGeneration: original.storeGeneration,
              storeId: original.storeId,
              version: original.version,
            };

            const reorderedArguments: OperationArguments = {
              allowSourceGrowth: true,
              cursor: null,
              inputRefs: [reordered],
              kind: "collect",
              parserVersion: "dx.bounded-opencode.v1",
              selectedRoots: [source.selection.root],
              source: "harness.opencode",
            };

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              reorderedArguments,
              source.scope,
              source.limits
            );

            const receipt = yield* opencodeApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.executions()).toBe(1);
            expect(source.appends()).toBe(1);
            expect(receipt.steps[0]?.inserted).toBeGreaterThan(0);
            expect(
              source.batches
                .flatMap((batch) => batch.events)
                .every(
                  (event) =>
                    event.origin === "fixture" &&
                    event.identity.sessionId === source.sessionId
                )
            ).toBe(true);
          })
        )
    );

    it.effect(
      "native recorded tokens do not invent an unavailable charge",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* opencodeUnknownCharge() {
            const source = yield* opencodeFixture(fixture, opened, root);

            source.writer
              .prepare("UPDATE session_message SET data = ? WHERE id = ?")
              .run(
                JSON.stringify({
                  location: { directory: source.worktree },
                  time: { completed: 1_767_225_600_020 },
                  tokens: {
                    cache: { read: 0, write: 0 },
                    input: 4,
                    output: 2,
                    reasoning: 0,
                  },
                }),
                `${source.sessionId}-assistant`
              );

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            const receipt = yield* opencodeApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.appends()).toBe(1);
            expect(receipt.steps[0]?.inserted).toBeGreaterThan(0);

            const usage = source.batches
              .flatMap((batch) => batch.events)
              .flatMap((event) => (event.usage === null ? [] : [event.usage]));

            expect(usage).toHaveLength(1);
            expect(usage[0]?.tokens.total).toBe(6);
            expect(usage[0]?.toolFigure).toBeNull();
            expect(plan.forecast.cost).toBeNull();
          })
        )
    );

    for (const limited of [
      { kind: "bytes", limits: { maxBytes: 1 } },
      { kind: "records", limits: { maxRecords: 12 } },
    ]) {
      it.effect(
        `a ${limited.kind} allowance rejects native source preflight before parsing or append`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* boundedOpencodePreflight() {
              const source = yield* opencodeFixture(fixture, opened, root);

              const failure = yield* fixture
                .createPlan(source.service, opened, source.args, source.scope, {
                  ...source.limits,
                  ...limited.limits,
                })
                .pipe(Effect.flip);

              expect(failure).toMatchObject({ code: "budget-exhausted" });
              expect(source.executions()).toBe(0);
              expect(source.appends()).toBe(0);
              expect(source.batches).toEqual([]);

              const snapshot = yield* opened.service.snapshot({
                branch: null,
                flightId: null,
                from: null,
                repoCommonDir: null,
                to: null,
              });

              expect(snapshot.events).toEqual([]);
            })
          )
      );
    }

    it.effect(
      "a selected native row update invalidates the reviewed digest before writes",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* changedOpencodeRow() {
            const source = yield* opencodeFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            source.writer
              .prepare("UPDATE session_message SET data = ? WHERE id = ?")
              .run(
                JSON.stringify({
                  cost: 7,
                  location: { directory: source.worktree },
                  time: { completed: 1_767_225_600_020 },
                  tokens: { input: 500, output: 40 },
                }),
                `${source.sessionId}-assistant`
              );

            const receipt = yield* opencodeApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.executions()).toBe(0);
            expect(source.appends()).toBe(0);
            expect(receipt.executionState).toBe("rejected");
            expect(receipt.recovery).toBe("replan");
            expect(
              receipt.steps.flatMap((step) => step.gaps).join(" ")
            ).toMatch(/selected.*rows|digest|changed/u);
          })
        )
    );

    it.effect(
      "approved unrelated session growth leaves the selected native observations unchanged",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* unrelatedOpencodeGrowth() {
            const source = yield* opencodeFixture(fixture, opened, root);

            const plan = yield* fixture.createPlan(
              source.service,
              opened,
              source.args,
              source.scope,
              source.limits
            );

            yield* opened.service.append(
              fixture.fixtureBatch("evt_fixture_s03_opencode_prior")
            );
            insertSyntheticMessage(source.writer, {
              data: JSON.stringify({
                location: { directory: source.worktree },
                time: { completed: 1_767_225_600_020 },
                tokens: { input: 999, output: 999 },
              }),
              id: "fixture-s03-opencode-unselected-appended",
              seq: 3,
              sessionId: source.unrelatedSessionId,
              type: "assistant",
            });

            const receipt = yield* opencodeApply(
              source.service,
              fixture.applyInput(plan)
            );

            expect(source.appends()).toBe(1);
            expect(receipt.steps[0]?.inserted).toBeGreaterThan(0);
            expect(
              source.batches
                .flatMap((batch) => batch.events)
                .every(
                  (event) =>
                    event.identity.sessionId === source.sessionId &&
                    event.usage === null
                )
            ).toBe(true);

            const snapshot = yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            });

            expect(snapshot.events.map((event) => event.eventId)).toContain(
              "evt_fixture_s03_opencode_prior"
            );
            expect(
              snapshot.events.some(
                (event) =>
                  event.identity.sessionId === source.unrelatedSessionId
              )
            ).toBe(false);
          })
        )
    );

    for (const mismatched of ["worktree", "branch"] as const) {
      it.effect(
        `a mismatched tracked ${mismatched} cannot widen the selected native source scope`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* mismatchedOpencodeScope() {
              const source = yield* opencodeFixture(fixture, opened, root);

              const scope: AgentScope =
                mismatched === "worktree"
                  ? {
                      ...source.scope,
                      worktreeId: path.join(
                        root,
                        "fixture-unapproved-worktree"
                      ),
                    }
                  : {
                      ...source.scope,
                      branchSelection: {
                        branches: ["fixture-unapproved-branch"],
                        kind: "selected",
                      },
                    };

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
              expect(source.executions()).toBe(0);
              expect(source.appends()).toBe(0);
            })
          )
      );
    }
  });
};
