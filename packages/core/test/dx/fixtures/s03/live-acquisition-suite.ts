import {
  existsSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic source files stay inside the parent test's owned scratch directory.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Selected fixture references use exact canonical absolute paths.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Scope } from "effect";

import { runImportSpool } from "../../../../src/dx/cli/commands/collect.js";
import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import { StoreBusy } from "../../../../src/dx/contracts/error-store-busy.js";
import type { EventStoreService } from "../../../../src/dx/contracts/services.js";
import { fileCursorOf } from "../../../../src/dx/harness/contract.js";
import type {
  Harness,
  ReadInput,
  SessionRef,
} from "../../../../src/dx/harness/contract.js";
import { harnessCatalog } from "../../../../src/dx/harness/registry.js";
import type { LiveAcquisitionExecutor } from "../../../../src/dx/live/engine.js";
import type { AgentScope } from "../../../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationInput,
  OperationOutput,
  OperationPlan,
} from "../../../../src/dx/model/agent-operation.js";
import { emptyFlightContext } from "../../../../src/dx/model/event.js";
import type {
  EventBatch,
  FlightContext,
} from "../../../../src/dx/model/event.js";
import type {
  ExplicitSelectedSourceCatalogOptions,
  ExplicitSourceMapping,
  PlannedSourceOperationAdapterOptions,
  PlannedSourceSelection,
  SelectedSourceRequest,
  SelectedSourceSnapshot,
} from "../../../../src/dx/operations/collector.js";
import type { BoundedCursorHookIdentityOptions } from "../../../../src/dx/operations/cursor-hooks.js";
import type {
  LiveCompletedAcquisitionIdentity,
  LiveOperationAcquisitionOptions,
  LiveSelectedSourceCatalog,
  LiveSelectedSourceCatalogOptions,
} from "../../../../src/dx/operations/live-acquisition.js";
import type {
  OperationAdapter,
  OperationApplyInput,
  OperationWorkContext,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type { PlannedSource } from "../../../../src/dx/registry/sync.js";
import { HarnessCursors } from "../../../../src/dx/storage/harness-cursors.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";
import {
  createCursorHookLiveFixture,
  syntheticStopRecord,
} from "./cursor-hooks-suite.js";
import type { CursorHookOperationFixtures } from "./cursor-hooks-suite.js";

interface LiveAcquisitionFixtures extends CursorHookOperationFixtures {
  readonly makeBoundedCursorHookIdentityProbe: (
    options: BoundedCursorHookIdentityOptions
  ) => (
    request: SelectedSourceRequest,
    context: OperationWorkContext
  ) => Effect.Effect<string | null, AgentStoreFailure>;
  readonly makeExplicitSelectedSourceCatalog: (
    options: ExplicitSelectedSourceCatalogOptions
  ) => (
    request: SelectedSourceRequest
  ) => Effect.Effect<readonly PlannedSourceSelection[], AgentStoreFailure>;
  readonly makeLiveOperationAcquisitionExecutor: (
    options: LiveOperationAcquisitionOptions
  ) => LiveAcquisitionExecutor;
  readonly makeLiveSelectedSourceCatalog: (
    options: LiveSelectedSourceCatalogOptions
  ) => LiveSelectedSourceCatalog;
  readonly makeOperationService: (
    store: AgentStoreService,
    adapters: readonly OperationAdapter[]
  ) => Effect.Effect<OperationServiceApi, never, Scope.Scope>;
  readonly makePlannedSourceOperationAdapter: (
    options: PlannedSourceOperationAdapterOptions
  ) => OperationAdapter;
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
  readonly withFixtureStore: <A, E>(
    use: (
      opened: OpenedEventStore,
      root: string
    ) => Effect.Effect<A, E, Scope.Scope>
  ) => Effect.Effect<A, E | AgentStoreFailure>;
}

interface ObservedOperation {
  readonly input: OperationInput;
  readonly output: OperationOutput;
}

const liveAcquisitionFixture = Effect.fn("S03.liveAcquisitionFixture")(
  function* liveAcquisitionFixture(
    fixture: LiveAcquisitionFixtures,
    opened: OpenedEventStore,
    root: string,
    preserveNativeReference?: boolean
  ) {
    const sourceRoot = realpathSync(root);
    const file = path.join(sourceRoot, "fixture-live-session.jsonl");
    writeFileSync(file, "fixture\n");
    const info = statSync(file);

    const context: FlightContext = {
      ...emptyFlightContext,
      branch: "fixture-live-branch",
      repoCommonDir: path.join(sourceRoot, "fixture-repo", ".git"),
      worktreePath: path.join(sourceRoot, "fixture-repo"),
    };

    const fileRef: SessionRef = {
      channel: "session-file",
      harness: "pi",
      id: file,
      mtimeMs: info.mtimeMs,
      path: file,
      sessionId: "fixture-s03-live-session",
      size: info.size,
      source: "harness.pi",
      worktree: context.worktreePath,
    };

    const ref: SessionRef =
      preserveNativeReference === true
        ? {
            ...fileRef,
            id: `${file}#${context.worktreePath ?? ""}`,
            splitAcross: [file],
          }
        : fileRef;

    const planned: PlannedSource = {
      context,
      harness: "pi",
      input: file,
      ref,
      source: "harness.pi",
      unavailable: null,
    };

    let busy = false;
    let directReads = 0;
    const reads: ReadInput[] = [];
    const readRefs: SessionRef[] = [];
    const snapshots: SelectedSourceSnapshot[] = [];
    const calls: ObservedOperation[] = [];

    const harness: Harness = {
      capabilities: {
        branchSources: [],
        liveHooks: false,
        storedFigure: null,
        subagents: false,
      },
      channels: ["session-file"],
      discover: Effect.succeed({
        harness: "pi",
        present: true,
        reason: "Synthetic S03 live acquisition fixture",
        roots: [sourceRoot],
        sessions: 1,
        version: "fixture.s03.live.v1",
      }),
      displayName: "Synthetic S03 live acquisition source",
      id: "pi",
      locate: () => Effect.succeed([ref]),
      read: (_selected, input) =>
        Effect.sync(() => {
          directReads += 1;

          return fixture.fixtureBatch(
            "evt_fixture_s03_unbounded_live_read",
            input.context
          );
        }),
    };

    const registry = harnessCatalog([harness]);
    const cursors = yield* HarnessCursors;

    const store: EventStoreService = {
      ...opened.service,
      append: (batch) =>
        busy
          ? Effect.fail(new StoreBusy({ message: "Synthetic writer lock" }))
          : opened.service.append(batch),
    };

    const storePath = path.join(root, "fixture.sqlite");

    const mappings: readonly ExplicitSourceMapping[] = [
      {
        channel: "session-file",
        harness: "pi",
        source: "harness.pi",
      },
    ];

    const explicit = fixture.makeExplicitSelectedSourceCatalog({
      contextForScope: () => Effect.succeed(context),
      mappings,
    });

    const catalog = fixture.makeLiveSelectedSourceCatalog({
      mappings,
      selected: explicit,
    });

    const adapter = fixture.makePlannedSourceOperationAdapter({
      cursors,
      enrollment: () =>
        Effect.succeed({
          reason: "Explicit isolated fixture source enrollment",
          receiptIds: ["fixture.s03.live-enrollment"],
          state: "authorized",
        }),
      env: { store, storePath },
      parserVersion: "fixture.s03.live.v1",
      registry,
      selected: catalog.selected,
      snapshotHarness: (snapshot) =>
        Effect.sync(() => {
          snapshots.push(snapshot);

          return {
            ...harness,
            read: (selected, input) =>
              Effect.sync(() => {
                readRefs.push(selected);
                reads.push(input);

                return {
                  ...fixture.fixtureBatch(
                    "evt_fixture_s03_live_acquired",
                    input.context
                  ),
                  cursor: fileCursorOf("harness.pi", {
                    mtimeMs: snapshot.ref.mtimeMs,
                    offset: snapshot.bytes.byteLength,
                    path: snapshot.ref.path,
                    size: snapshot.ref.size,
                  }),
                };
              }),
          };
        }),
    });

    const service = yield* fixture.makeOperationService(opened.agentService, [
      adapter,
    ]);

    const operations: OperationServiceApi = {
      descriptors: service.descriptors,
      run: (input) =>
        service.run(input).pipe(
          Effect.tap((output) =>
            Effect.sync(() => {
              calls.push({ input, output });
            })
          )
        ),
    };

    const acquisitionOptions: LiveOperationAcquisitionOptions = {
      agentStore: opened.agentService,
      operations,
      parserVersion: "fixture.s03.live.v1",
      registerSelectedSource: catalog.register,
      sources: mappings,
      store,
    };

    return {
      acquire: fixture.makeLiveOperationAcquisitionExecutor(acquisitionOptions),
      calls,
      context,
      cursors,
      directReads: () => directReads,
      environment: { cursors, registry, store, storePath },
      file,
      planned,
      readRefs,
      reads,
      ref,
      setBusy: (value: boolean) => {
        busy = value;
      },
      snapshots,
    };
  }
);

const completedHookAcquisitionFixture = Effect.fn(
  "S03.completedHookAcquisitionFixture"
)(function* completedHookAcquisitionFixture(
  fixture: LiveAcquisitionFixtures,
  opened: OpenedEventStore,
  root: string,
  useCompletedIdentity?: boolean
) {
  const source = yield* createCursorHookLiveFixture(fixture, opened, root);
  const { args } = source;

  if (args.kind !== "collect") {
    return yield* Effect.die(
      new Error("Expected native hook collection arguments")
    );
  }

  const calls: ObservedOperation[] = [];

  const operations: OperationServiceApi = {
    descriptors: source.service.descriptors,
    run: (input) =>
      source.service.run(input).pipe(
        Effect.tap((output) =>
          Effect.sync(() => {
            calls.push({ input, output });
          })
        )
      ),
  };

  const options: LiveOperationAcquisitionOptions = {
    agentStore: opened.agentService,
    bounds: {
      maxBytes: 131_072,
      maxElapsedMs: 60_000,
      maxFiles: 40,
      maxRecords: 100,
      maxRequests: 0,
      maxRetries: 1,
    },
    operations,
    parserVersion: args.parserVersion,
    resolveArguments: () => Effect.succeed(args),
    resolveScope: () => source.scope,
    sources: [{ channel: "hooks", harness: "cursor", source: args.source }],
    store: source.store,
  };

  const probe = fixture.makeBoundedCursorHookIdentityProbe(
    source.adapterOptions
  );

  const fingerprints: (string | null)[] = [];

  const completedIdentity: LiveCompletedAcquisitionIdentity = (
    _planned,
    selectedArgs,
    identity,
    scope,
    bounds,
    context
  ) =>
    probe(
      {
        arguments: selectedArgs,
        bounds,
        scope,
        storeGeneration: identity.storeGeneration,
        storeId: identity.storeId,
      },
      context
    ).pipe(
      Effect.tap((fingerprint) =>
        Effect.sync(() => {
          fingerprints.push(fingerprint);
        })
      )
    );

  const completedOptions: LiveOperationAcquisitionOptions =
    useCompletedIdentity === true
      ? {
          ...options,
          completedAcquisitionIdentity: completedIdentity,
          completedAcquisitionIdentitySources: [args.source],
        }
      : options;

  return {
    acquire: fixture.makeLiveOperationAcquisitionExecutor(completedOptions),
    calls,
    environment: {
      cursors: source.cursors,
      registry: harnessCatalog([]),
      store: source.store,
      storePath: source.adapterOptions.env.storePath,
    },
    fingerprints,
    source,
  };
});

export const registerLiveAcquisitionTests = (
  fixture: LiveAcquisitionFixtures
) => {
  describe("S03 live operation acquisition", () => {
    it.effect(
      "a committed unchanged cursor avoids planning and source reads",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* unchangedLiveSource() {
            const live = yield* liveAcquisitionFixture(fixture, opened, root);
            const eventId = "evt_fixture_s03_live_prior_commit";
            yield* opened.service.append(
              fixture.fixtureBatch(eventId, live.context)
            );

            const cursor = fileCursorOf("harness.pi", {
              mtimeMs: live.ref.mtimeMs,
              offset: live.ref.size ?? 0,
              path: live.file,
              size: live.ref.size,
            });

            yield* live.cursors.put(live.ref, {
              cursor,
              lastEventId: eventId,
              mtimeMs: live.ref.mtimeMs,
              size: live.ref.size,
            });

            const result = yield* live.acquire(live.planned, live.environment);

            expect(result).toMatchObject({
              duplicates: 0,
              inserted: 0,
              lastEventId: eventId,
              recordsRead: 0,
              safeCursor: cursor,
              state: "unchanged",
            });
            expect(live.calls).toEqual([]);
            expect(live.reads).toEqual([]);
            expect(live.snapshots).toEqual([]);
            expect(live.directReads()).toBe(0);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );

    it.effect(
      "a changed selected source commits through a retained plan with its exact live context",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* changedLiveSource() {
            const live = yield* liveAcquisitionFixture(fixture, opened, root);
            const identity = yield* opened.agentService.identity;

            const priorCursor = fileCursorOf("harness.pi", {
              mtimeMs: null,
              offset: 0,
              path: live.file,
              size: 0,
            });

            yield* live.cursors.put(live.ref, {
              cursor: priorCursor,
              lastEventId: null,
              mtimeMs: null,
              size: 0,
            });

            const result = yield* live.acquire(live.planned, live.environment);
            expect(result.state).toBe("committed");
            expect(result.inserted).toBe(1);
            expect(result.rejected).toBeNull();
            expect(result.eventsRead).toBeNull();
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
            ]);

            const planned = yield* Effect.fromNullishOr(
              live.calls.flatMap((call) =>
                call.output.action === "plan" ? [call.output.plan] : []
              )[0]
            );

            expect(planned).toMatchObject({
              arguments: {
                inputRefs: [
                  {
                    id: live.file,
                    storeGeneration: identity.storeGeneration,
                    storeId: identity.storeId,
                  },
                ],
                kind: "collect",
                selectedRoots: [path.dirname(live.file)],
                source: live.planned.source,
              },
              scope: {
                branchSelection: {
                  branches: [live.context.branch],
                  kind: "current",
                },
                flightId: live.context.flightId,
                repoId: live.context.repoCommonDir,
                sources: [live.planned.source],
                worktreeId: live.context.worktreePath,
              },
              storeGeneration: identity.storeGeneration,
              storeId: identity.storeId,
            });

            expect(live.calls[0]?.input).toMatchObject({
              action: "plan",
              target: identity,
            });

            expect(
              yield* opened.agentService.getOperationPlan({
                id: planned.id,
                storeGeneration: identity.storeGeneration,
                storeId: identity.storeId,
              })
            ).toEqual(planned);
            expect(live.reads).toMatchObject([
              { context: live.context, cursor: priorCursor },
            ]);
            expect(live.snapshots.map((snapshot) => snapshot.ref.path)).toEqual(
              [live.file]
            );
            expect(new TextDecoder().decode(live.snapshots[0]?.bytes)).toBe(
              "fixture\n"
            );
            expect(live.directReads()).toBe(0);

            const committed = yield* opened.service.snapshot({
              branch: live.context.branch,
              flightId: null,
              from: null,
              repoCommonDir: live.context.repoCommonDir,
              to: null,
            });

            expect(committed.events).toMatchObject([
              {
                context: live.context,
                eventId: "evt_fixture_s03_live_acquired",
                origin: "fixture",
              },
            ]);
            expect((yield* live.cursors.get(live.ref))?.cursor).toEqual(
              result.safeCursor
            );
            expect(result.safeCursor).not.toEqual(priorCursor);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );

    it.effect(
      "an unmapped source remains unavailable without planning or parsing",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* unmappedLiveSource() {
            const live = yield* liveAcquisitionFixture(fixture, opened, root);

            const selected = {
              ...live.planned,
              ref: { ...live.ref, source: "fixture.s03.unsupported" },
              source: "fixture.s03.unsupported",
            };

            const result = yield* live.acquire(selected, live.environment);

            expect(result).toMatchObject({
              duplicates: null,
              eventsRead: null,
              input: live.file,
              inserted: null,
              readCursor: null,
              recordsRead: null,
              rejected: null,
              safeCursor: null,
              source: selected.source,
              state: "unavailable",
            });
            expect(result.reason).toMatch(/mapping|source/u);
            expect(live.calls).toEqual([]);
            expect(live.reads).toEqual([]);
            expect(live.directReads()).toBe(0);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );

    it.effect(
      "a selected source's unavailable reason survives without fabricated counts",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* unavailableLiveSource() {
            const live = yield* liveAcquisitionFixture(fixture, opened, root);
            const reason = "Synthetic selected source fixture is unavailable";

            const result = yield* live.acquire(
              { ...live.planned, unavailable: reason },
              live.environment
            );

            expect(result).toMatchObject({
              duplicates: null,
              inserted: null,
              reason,
              recordsRead: null,
              rejected: null,
              state: "unavailable",
              unavailableReasons: [reason],
            });
            expect(live.calls).toEqual([]);
            expect(live.reads).toEqual([]);
            expect(live.directReads()).toBe(0);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );

    it.effect(
      "a different event store cannot receive the selected live acquisition",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* mismatchedLiveStore() {
            const live = yield* liveAcquisitionFixture(fixture, opened, root);

            const result = yield* live.acquire(live.planned, {
              ...live.environment,
              store: { ...opened.service },
            });

            expect(result).toMatchObject({
              inserted: null,
              state: "unavailable",
            });
            expect(result.reason).toMatch(/same opened event store/u);
            expect(live.calls).toEqual([]);
            expect(live.reads).toEqual([]);
            expect(live.directReads()).toBe(0);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );

    it.effect(
      "a busy writer stages a real batch while preserving the last safe cursor",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* spooledLiveSource() {
            const live = yield* liveAcquisitionFixture(fixture, opened, root);

            const priorCursor = fileCursorOf("harness.pi", {
              mtimeMs: null,
              offset: 0,
              path: live.file,
              size: 0,
            });

            yield* live.cursors.put(live.ref, {
              cursor: priorCursor,
              lastEventId: null,
              mtimeMs: null,
              size: 0,
            });
            live.setBusy(true);

            const result = yield* live.acquire(live.planned, live.environment);

            expect(result).toMatchObject({
              eventsRead: null,
              inserted: 0,
              lastEventId: null,
              readCursor: null,
              rejected: null,
              safeCursor: priorCursor,
              state: "spooled",
            });
            expect(result.spooledRefs).toHaveLength(1);
            expect(result.spooledRefs?.every((file) => existsSync(file))).toBe(
              true
            );
            expect(
              result.gaps?.some((gap) =>
                /Rejected-row count.*unavailable/u.test(gap.message)
              )
            ).toBe(true);
            expect((yield* live.cursors.get(live.ref))?.cursor).toEqual(
              priorCursor
            );
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
            ]);
            expect(live.reads).toHaveLength(1);

            const snapshot = yield* opened.service.snapshot({
              branch: null,
              flightId: null,
              from: null,
              repoCommonDir: null,
              to: null,
            });

            expect(snapshot.events).toEqual([]);

            live.setBusy(false);
            const drained = yield* runImportSpool(live.environment);
            expect(drained.inserted).toBe(1);

            const resumed = yield* live.acquire(live.planned, live.environment);
            expect(resumed.state).toBe("duplicate");
            expect(resumed.duplicates).toBe(1);
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
              "apply",
            ]);
            expect(live.calls[2]?.input).toEqual(live.calls[1]?.input);
            expect(live.calls[2]?.output).toMatchObject({
              action: "apply",
              reused: true,
            });
            expect((yield* live.cursors.get(live.ref))?.cursor).toEqual(
              resumed.safeCursor
            );
            expect(resumed.safeCursor).not.toEqual(priorCursor);

            const settled = yield* live.acquire(live.planned, live.environment);
            expect(settled.state).toBe("unchanged");
            expect(live.calls).toHaveLength(3);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );
    it.effect(
      "a replaced spooled input rejects its retained plan before a later poll creates a fresh plan",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* replacedPendingLiveSource() {
            const live = yield* liveAcquisitionFixture(fixture, opened, root);
            live.setBusy(true);

            const staged = yield* live.acquire(live.planned, live.environment);
            expect(staged.state).toBe("spooled");
            expect(live.reads).toHaveLength(1);

            renameSync(live.file, `${live.file}.fixture-replaced`);
            writeFileSync(live.file, "replacement\n");
            live.setBusy(false);

            const rejected = yield* live.acquire(
              live.planned,
              live.environment
            );

            expect(rejected.state).toBe("unavailable");
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
              "apply",
            ]);
            expect(live.calls[2]?.input).toEqual(live.calls[1]?.input);
            expect(live.calls[2]?.output).toMatchObject({
              action: "apply",
              receipt: { recovery: "replan", steps: [{ state: "rejected" }] },
            });
            expect(live.reads).toHaveLength(1);

            const fresh = yield* live.acquire(live.planned, live.environment);
            expect(fresh.state).toBe("committed");
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
              "apply",
              "plan",
              "apply",
            ]);

            const plans = live.calls.flatMap((call) =>
              call.output.action === "plan" ? [call.output.plan] : []
            );

            expect(plans).toHaveLength(2);
            expect(plans[1]?.id).not.toBe(plans[0]?.id);
            expect(live.reads).toHaveLength(2);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );
    it.effect(
      "a native session reference keeps its original cursor identity and becomes idle after committing",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* nativeLiveReference() {
            const live = yield* liveAcquisitionFixture(
              fixture,
              opened,
              root,
              true
            );

            expect(live.ref.id).not.toBe(live.file);

            const committed = yield* live.acquire(
              live.planned,
              live.environment
            );

            expect(committed.state).toBe("committed");
            expect(committed.inserted).toBe(1);
            expect(live.readRefs).toEqual([live.ref]);
            expect(live.snapshots.map((snapshot) => snapshot.ref)).toEqual([
              live.ref,
            ]);
            expect(live.reads).toMatchObject([{ context: live.context }]);
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
            ]);
            expect(live.calls[0]?.input).toMatchObject({
              action: "plan",
              arguments: {
                inputRefs: [{ id: live.file, version: "dx.live-input.v1" }],
              },
            });

            const stored = yield* live.cursors.get(live.ref);
            expect(stored).toMatchObject({
              cursor: committed.safeCursor,
              lastEventId: "evt_fixture_s03_live_acquired",
              mtimeMs: live.ref.mtimeMs,
              size: live.ref.size,
            });
            expect(
              yield* live.cursors.get({ ...live.ref, id: live.file })
            ).toBeNull();

            const idle = yield* live.acquire(live.planned, live.environment);
            expect(idle).toMatchObject({
              inserted: 0,
              lastEventId: "evt_fixture_s03_live_acquired",
              safeCursor: committed.safeCursor,
              state: "unchanged",
            });
            expect(live.calls).toHaveLength(2);
            expect(live.readRefs).toHaveLength(1);
            expect(live.directReads()).toBe(0);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(HarnessCursors.memory, NodeServices.layer)
            )
          )
        )
    );
    it.effect(
      "completed filtered hooks use a bounded identity proof to idle until a new native record arrives",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* completedFilteredHooks() {
            const live = yield* completedHookAcquisitionFixture(
              fixture,
              opened,
              root,
              true
            );

            const { source } = live;
            expect(source.ref.mtimeMs).toBeNull();
            expect(source.ref.size).toBeNull();
            const baseline = yield* source.cursors.get(source.ref);

            const first = yield* live.acquire(
              source.selection.planned,
              live.environment
            );

            expect(first).toMatchObject({
              duplicates: 0,
              inserted: 0,
              recordsRead: null,
              state: "committed",
            });
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
            ]);
            expect(live.calls[1]?.output).toMatchObject({
              action: "apply",
              receipt: {
                executionState: "succeeded",
                recovery: "none",
                steps: [{ remainingWork: null, state: "committed" }],
                verificationState: "verified",
              },
            });
            expect(yield* source.cursors.get(source.ref)).toEqual(baseline);
            expect(source.executions()).toBe(1);
            expect(source.nativeBatches).toHaveLength(1);
            expect(source.nativeBatches[0]?.events).toEqual([]);
            expect(
              live.fingerprints.every((fingerprint) => fingerprint !== null)
            ).toBe(true);

            const beforeIdleProbes = live.fingerprints.length;

            const idle = yield* live.acquire(
              source.selection.planned,
              live.environment
            );

            expect(idle).toMatchObject({
              duplicates: 0,
              eventsRead: 0,
              inserted: 0,
              recordsRead: 0,
              rejected: 0,
              state: "unchanged",
            });
            expect(
              idle.gaps?.some(
                (gap) => gap.code === "live.completed-acquisition"
              )
            ).toBe(true);
            expect(live.fingerprints.length).toBeGreaterThan(beforeIdleProbes);
            expect(live.calls).toHaveLength(2);
            expect(source.executions()).toBe(1);
            expect(source.nativeBatches).toHaveLength(1);
            expect(yield* source.cursors.get(source.ref)).toEqual(baseline);

            writeFileSync(
              path.join(source.directory, "2.json"),
              JSON.stringify(
                syntheticStopRecord(
                  fixture,
                  source.context,
                  "live-cache-selected"
                )
              )
            );

            const changed = yield* live.acquire(
              source.selection.planned,
              live.environment
            );

            expect(changed.state).toBe("committed");
            expect(changed.inserted).toBe(2);
            expect(changed.recordsRead).toBeNull();
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
              "plan",
              "apply",
            ]);

            const plans = live.calls.flatMap((call) =>
              call.output.action === "plan" ? [call.output.plan] : []
            );

            expect(plans[1]?.id).not.toBe(plans[0]?.id);
            expect(source.executions()).toBe(2);
            expect(source.nativeBatches).toHaveLength(2);
            expect(yield* source.cursors.get(source.ref)).toEqual(baseline);

            const stored = yield* opened.service.snapshot({
              branch: source.context.branch,
              flightId: null,
              from: null,
              repoCommonDir: source.context.repoCommonDir,
              to: null,
            });

            expect(stored.events).toHaveLength(2);
            expect(
              stored.events.every((event) => event.origin === "fixture")
            ).toBe(true);
          }).pipe(Effect.provide(NodeServices.layer))
        )
    );

    it.effect(
      "a hook directory with unavailable metadata cannot idle without a bounded identity proof",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* unprovenFilteredHooks() {
            const live = yield* completedHookAcquisitionFixture(
              fixture,
              opened,
              root
            );

            const { source } = live;
            const baseline = yield* source.cursors.get(source.ref);

            const first = yield* live.acquire(
              source.selection.planned,
              live.environment
            );

            const second = yield* live.acquire(
              source.selection.planned,
              live.environment
            );

            expect(first).toMatchObject({
              inserted: 0,
              recordsRead: null,
              state: "committed",
            });
            expect(second).toMatchObject({
              inserted: 0,
              recordsRead: null,
              state: "committed",
            });
            expect(live.calls.map((call) => call.input.action)).toEqual([
              "plan",
              "apply",
              "plan",
              "apply",
            ]);
            expect(live.fingerprints).toEqual([]);
            expect(source.executions()).toBe(2);
            expect(source.nativeBatches).toHaveLength(2);
            expect(yield* source.cursors.get(source.ref)).toEqual(baseline);
          }).pipe(Effect.provide(NodeServices.layer))
        )
    );
  });
};
