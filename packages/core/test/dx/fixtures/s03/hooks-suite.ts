import {
  realpathSync,
  statSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic hook files stay inside the parent test's owned scratch directory.
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic hook references use canonical paths in their owned scratch directory.
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Scope } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import type {
  Harness,
  ReadError,
  SessionRef,
} from "../../../../src/dx/harness/contract.js";
import type { HookObservation } from "../../../../src/dx/harness/hook-observation.js";
import type { Channel, HarnessId } from "../../../../src/dx/harness/ids.js";
import type { HarnessCatalog } from "../../../../src/dx/harness/registry.js";
import type { AgentScope } from "../../../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
} from "../../../../src/dx/model/agent-operation.js";
import type { Origin } from "../../../../src/dx/model/common.js";
import type { FlightContext } from "../../../../src/dx/model/event.js";
import type {
  PlannedSourceOperationAdapterOptions,
  SelectedSourceSnapshot,
} from "../../../../src/dx/operations/collector.js";
import type {
  BoundedHookSnapshotHarness,
  HookSnapshotResult,
} from "../../../../src/dx/operations/hooks.js";
import type {
  OperationAdapter,
  OperationApplyInput,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";

interface HookOperationFixtures {
  readonly boundedHookSnapshotHarness: (
    snapshot: SelectedSourceSnapshot,
    bounds: OperationBounds,
    scope: AgentScope
  ) => Effect.Effect<BoundedHookSnapshotHarness, AgentStoreFailure>;
  readonly decodeBoundedHookSnapshot: (
    snapshot: SelectedSourceSnapshot,
    bounds: OperationBounds,
    scope: AgentScope,
    origin: Origin
  ) => Effect.Effect<HookSnapshotResult, ReadError>;
  readonly harnessCatalog: (harnesses: readonly Harness[]) => HarnessCatalog;
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
  readonly fixtureScope: AgentScope;
  readonly withFixtureStore: <A, E>(
    use: (
      opened: OpenedEventStore,
      root: string
    ) => Effect.Effect<A, E, Scope.Scope>
  ) => Effect.Effect<A, E | AgentStoreFailure>;
}

interface NativeHookCase {
  readonly channel: Channel;
  readonly event: string;
  readonly kind: "ai.session" | "ai.turn";
  readonly tool: HarnessId;
}

const nativeHookCases: readonly NativeHookCase[] = [
  { channel: "hooks", event: "Stop", kind: "ai.turn", tool: "codex" },
  { channel: "hooks", event: "Stop", kind: "ai.turn", tool: "claude-code" },
  { channel: "hooks", event: "turn_end", kind: "ai.turn", tool: "pi" },
  { channel: "hooks", event: "agent_end", kind: "ai.turn", tool: "omp" },
  { channel: "hooks", event: "turn/end", kind: "ai.turn", tool: "deepseek" },
  {
    channel: "hooks",
    event: "chat.message",
    kind: "ai.turn",
    tool: "opencode",
  },
  {
    channel: "extension",
    event: "chat.message",
    kind: "ai.turn",
    tool: "opencode",
  },
  { channel: "extension", event: "turn_end", kind: "ai.turn", tool: "pi" },
  { channel: "extension", event: "agent_end", kind: "ai.turn", tool: "omp" },
  {
    channel: "extension",
    event: "turn/end",
    kind: "ai.turn",
    tool: "deepseek",
  },
];

const hookBounds: OperationBounds = {
  maxBytes: 131_072,
  maxElapsedMs: 60_000,
  maxFiles: 2,
  maxRecords: 4096,
  maxRequests: 0,
  maxRetries: 1,
};

const fixtureContext = (root: string): FlightContext => ({
  branch: "fixture-main",
  flightId: null,
  headSha: "fixture-s03-hook-commit",
  repoCommonDir: path.join(root, "fixture-repo", ".git"),
  worktreePath: path.join(root, "fixture-repo"),
});

const hookObservation = (
  context: FlightContext,
  tool: HarnessId = "codex",
  event = "Stop"
): HookObservation => ({
  event,
  fields: {
    agentId: "fixture-hook-agent",
    agentType: "fixture-hook-worker",
    cwd: context.worktreePath,
    effort: "high",
    model: "gpt-6",
    parentSessionId: "fixture-hook-parent-session",
    sessionId: "fixture-hook-session",
    transcriptPath: null,
    turnId: "fixture-hook-turn",
  },
  git: {
    branch: context.branch,
    headSha: context.headSha,
    repoCommonDir: context.repoCommonDir,
    worktreePath: context.worktreePath,
  },
  observedAt: "2026-10-02T10:00:00.000Z",
  payloadValid: true,
  schema: "dft.hook.v1",
  tool,
});

const hookSnapshot = (
  root: string,
  text: string,
  tool: HarnessId = "codex",
  channel: Channel = "hooks"
): SelectedSourceSnapshot => {
  const context = fixtureContext(root);
  const file = path.join(root, `fixture-${tool}-${channel}.jsonl`);
  const bytes = new TextEncoder().encode(text);

  const ref: SessionRef = {
    channel,
    harness: tool,
    id: file,
    mtimeMs: null,
    path: file,
    sessionId: null,
    size: bytes.byteLength,
    source: `harness.${tool}`,
    worktree: context.worktreePath,
  };

  return {
    bytes,
    contentDigest: "fixture:s03:captured-hook-bytes",
    identity: "fixture:s03:captured-hook-identity",
    ref,
    selection: {
      inputRef: {
        basisId: null,
        id: `fixture:s03:${tool}:hooks`,
        kind: "evidence",
        storeGeneration: 0,
        storeId: "fixture:s03:isolated-hook-store",
        version: "fixture.s03.hooks.v1",
      },
      planned: {
        context,
        harness: tool,
        input: file,
        ref,
        source: ref.source,
        unavailable: null,
      },
      root,
    },
  };
};

const hookScope = (
  fixture: HookOperationFixtures,
  tool: HarnessId = "codex"
): AgentScope => ({
  ...fixture.fixtureScope,
  sources: [`harness.${tool}`],
  tools: [tool],
});

const allFixtureEvents = {
  branch: null,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
};

const decoderCaps: readonly ("maxBytes" | "maxRecords")[] = [
  "maxBytes",
  "maxRecords",
];

export const registerHookOperationTests = (fixture: HookOperationFixtures) => {
  describe("S03 captured native hook sources", () => {
    for (const native of nativeHookCases) {
      it.effect(
        `${native.tool} ${native.channel} preserves native provenance and stable event identities`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* nativeHookIdentity() {
              const observation = hookObservation(
                fixtureContext(root),
                native.tool,
                native.event
              );

              const snapshot = hookSnapshot(
                root,
                `${JSON.stringify(observation)}\n`,
                native.tool,
                native.channel
              );

              const scope = hookScope(fixture, native.tool);

              const decoded = yield* fixture.decodeBoundedHookSnapshot(
                snapshot,
                hookBounds,
                scope,
                "fixture"
              );

              const harness = yield* fixture.boundedHookSnapshotHarness(
                snapshot,
                hookBounds,
                scope
              );

              expect(yield* harness.diagnostics).toBeNull();

              const reread = yield* harness.read(snapshot.ref, {
                context: snapshot.selection.planned.context,
                cursor: null,
                origin: "fixture",
              });

              expect(reread).toEqual(decoded.batch);
              expect(decoded.diagnostics).toMatchObject({
                filtered: 0,
                inputRecords: 1,
                recordsDecoded: 1,
                rejected: 0,
              });
              expect(decoded.diagnostics.gaps).toContainEqual(
                expect.objectContaining({
                  code: "hooks.flight-ownership-unrecorded",
                })
              );
              expect(decoded.batch.coverage.gaps).toEqual(
                decoded.diagnostics.gaps
              );
              expect(yield* harness.diagnostics).toEqual(decoded.diagnostics);
              expect(decoded.batch.events).toHaveLength(1);
              const [event] = decoded.batch.events;
              expect(event).toMatchObject({
                acquisition: "hook",
                adapterId: `harness.${native.tool}`,
                ai: {
                  agentId: "fixture-hook-agent",
                  branchSource: "hook",
                  channel: native.channel,
                  effort: "high",
                  effortSource: "harness-recorded",
                  harness: native.tool,
                  modelRaw: "gpt-6",
                  parentSessionId: "fixture-hook-parent-session",
                  sessionId: "fixture-hook-session",
                },
                context: fixtureContext(root),
                evidence: { bounded: true },
                identity: {
                  sessionId: "fixture-hook-session",
                  turnId: "fixture-hook-turn",
                },
                kind: native.kind,
                origin: "fixture",
                usage: null,
              });
              expect(event?.eventId).toMatch(/^sha256:[\da-f]{64}$/u);
              expect(event?.context.flightId).toBeNull();
              expect(decoded.batch.coverage.state).toBe("complete");
              expect(yield* opened.service.append(decoded.batch)).toEqual({
                duplicates: 0,
                inserted: 1,
              });
              expect(yield* opened.service.append(reread)).toEqual({
                duplicates: 1,
                inserted: 0,
              });
              const stored = yield* opened.service.snapshot(allFixtureEvents);
              expect(stored.events).toHaveLength(1);
              expect(stored.events[0]?.eventId).toBe(event?.eventId);
              expect(stored.events[0]?.usage).toBeNull();
              expect(stored.manifest.originMix).toEqual([
                { count: 1, origin: "fixture" },
              ]);
            })
          )
      );
    }

    it.effect(
      "the helper reads its captured bytes after the source file and caller bytes change",
      () =>
        fixture.withFixtureStore((_opened, root) =>
          Effect.gen(function* immutableHookCapture() {
            const context = fixtureContext(root);

            const snapshot = hookSnapshot(
              root,
              `${JSON.stringify(hookObservation(context))}\n`
            );

            const scope = hookScope(fixture);

            const expected = yield* fixture.decodeBoundedHookSnapshot(
              snapshot,
              hookBounds,
              scope,
              "fixture"
            );

            const harness = yield* fixture.boundedHookSnapshotHarness(
              snapshot,
              hookBounds,
              scope
            );

            expect(yield* harness.diagnostics).toBeNull();
            writeFileSync(snapshot.ref.path, "ambient file is malformed\n");
            snapshot.bytes.fill(255);

            const batch = yield* harness.read(snapshot.ref, {
              context,
              cursor: null,
              origin: "fixture",
            });

            expect(batch).toEqual(expected.batch);
            expect(yield* harness.diagnostics).toEqual(expected.diagnostics);

            const denied = yield* harness
              .read(
                { ...snapshot.ref, path: `${snapshot.ref.path}.replacement` },
                { context, cursor: null, origin: "fixture" }
              )
              .pipe(Effect.flip);

            expect(denied._tag).toBe("SourceUnavailable");
          })
        )
    );

    it.effect(
      "blank, malformed and truncated frames retain truthful counts and partial coverage",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* malformedHookFrames() {
            const valid = hookObservation(fixtureContext(root));

            const snapshot = hookSnapshot(
              root,
              `${JSON.stringify(valid)}\n\nnot-json\n{"schema":`
            );

            const decoded = yield* fixture.decodeBoundedHookSnapshot(
              snapshot,
              hookBounds,
              hookScope(fixture),
              "fixture"
            );

            expect(decoded.diagnostics).toMatchObject({
              filtered: 0,
              inputRecords: 4,
              recordsDecoded: 3,
              rejected: 3,
            });
            expect(decoded.batch.unsettled).toBe(true);
            expect(decoded.batch.coverage).toMatchObject({
              expectedItems: null,
              observedItems: 1,
              state: "partial",
            });
            expect(decoded.batch.coverage.gaps.map((gap) => gap.code)).toEqual(
              expect.arrayContaining([
                "hooks.empty-records",
                "hooks.invalid-records",
                "hooks.unterminated-record",
                "hooks.flight-ownership-unrecorded",
              ])
            );
            expect(yield* opened.service.append(decoded.batch)).toEqual({
              duplicates: 0,
              inserted: 1,
            });
            expect(decoded.batch.events[0]?.usage).toBeNull();
          })
        )
    );

    it.effect(
      "a valid final frame without an LF remains unsettled instead of claiming complete coverage",
      () =>
        fixture.withFixtureStore((_opened, root) =>
          Effect.gen(function* unterminatedHookFrame() {
            const snapshot = hookSnapshot(
              root,
              JSON.stringify(hookObservation(fixtureContext(root)))
            );

            const decoded = yield* fixture.decodeBoundedHookSnapshot(
              snapshot,
              hookBounds,
              hookScope(fixture),
              "fixture"
            );

            expect(decoded.batch.events).toHaveLength(1);
            expect(decoded.diagnostics).toMatchObject({
              inputRecords: 1,
              rejected: 0,
            });
            expect(decoded.batch.unsettled).toBe(true);
            expect(decoded.batch.coverage.state).toBe("partial");
            expect(decoded.batch.coverage.gaps).toContainEqual(
              expect.objectContaining({ code: "hooks.unterminated-record" })
            );
          })
        )
    );

    it.effect(
      "observations outside the approved tool, repository, worktree or branch are filtered",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* scopedHookFrames() {
            const valid = hookObservation(fixtureContext(root));

            const observations: readonly HookObservation[] = [
              valid,
              { ...valid, tool: "pi" },
              {
                ...valid,
                git: { ...valid.git, repoCommonDir: "/fixture/other/.git" },
              },
              {
                ...valid,
                git: { ...valid.git, worktreePath: "/fixture/other" },
              },
              { ...valid, git: { ...valid.git, branch: "fixture-other" } },
            ];

            const snapshot = hookSnapshot(
              root,
              observations.map((value) => `${JSON.stringify(value)}\n`).join("")
            );

            const decoded = yield* fixture.decodeBoundedHookSnapshot(
              snapshot,
              hookBounds,
              hookScope(fixture),
              "fixture"
            );

            expect(decoded.diagnostics).toMatchObject({
              filtered: 4,
              inputRecords: 5,
              recordsDecoded: 5,
              rejected: 0,
            });
            expect(decoded.batch.events).toHaveLength(1);
            expect(decoded.batch.coverage.state).toBe("complete");
            expect(decoded.batch.coverage.gaps).toContainEqual(
              expect.objectContaining({
                code: "hooks.flight-ownership-unrecorded",
              })
            );
            expect(decoded.batch.events[0]?.context.flightId).toBeNull();
            yield* opened.service.append(decoded.batch);
            const stored = yield* opened.service.snapshot(allFixtureEvents);
            expect(stored.events).toHaveLength(1);
            expect(stored.events[0]?.context).toEqual(fixtureContext(root));
          })
        )
    );

    for (const cap of decoderCaps) {
      it.effect(`${cap} rejects an oversized hook snapshot before append`, () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* hookDecodeCap() {
            const frame = `${JSON.stringify(hookObservation(fixtureContext(root)))}\n`;
            const snapshot = hookSnapshot(root, `${frame}${frame}`);

            const bounds = {
              ...hookBounds,
              [cap]: cap === "maxBytes" ? snapshot.bytes.byteLength - 1 : 1,
            };

            const before = yield* opened.agentService.identity;

            const harness = yield* fixture.boundedHookSnapshotHarness(
              snapshot,
              bounds,
              hookScope(fixture)
            );

            const failure = yield* harness
              .read(snapshot.ref, {
                context: snapshot.selection.planned.context,
                cursor: null,
                origin: "fixture",
              })
              .pipe(Effect.flatMap(opened.service.append), Effect.flip);

            expect(failure._tag).toBe("SourceUnavailable");
            expect(failure.message).toContain(cap);
            expect(yield* harness.diagnostics).toBeNull();
            expect(yield* opened.agentService.identity).toEqual(before);
            expect(
              (yield* opened.service.snapshot(allFixtureEvents)).events
            ).toHaveLength(0);
          })
        )
      );
    }

    it.effect("an unresolved flight scope cannot acquire recorded hooks", () =>
      fixture.withFixtureStore((_opened, root) =>
        Effect.gen(function* unresolvedHookFlight() {
          const snapshot = hookSnapshot(
            root,
            `${JSON.stringify(hookObservation(fixtureContext(root)))}\n`
          );

          const failure = yield* fixture
            .boundedHookSnapshotHarness(snapshot, hookBounds, {
              ...hookScope(fixture),
              flightId: "fixture-hook-flight",
            })
            .pipe(Effect.flip);

          expect(failure._tag).toBe("AgentError");
          expect(failure).toMatchObject({ code: "scope-denied" });
        })
      )
    );

    it.effect(
      "an empty hook snapshot reports no observed coverage without inventing rejected records",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* emptyHookSnapshot() {
            const decoded = yield* fixture.decodeBoundedHookSnapshot(
              hookSnapshot(root, ""),
              hookBounds,
              hookScope(fixture),
              "fixture"
            );

            expect(decoded.diagnostics).toMatchObject({
              filtered: 0,
              inputRecords: 0,
              recordsDecoded: 0,
              rejected: 0,
            });
            expect(decoded.batch.events).toHaveLength(0);
            expect(decoded.batch.coverage).toMatchObject({
              expectedItems: null,
              observedItems: 0,
              state: "none",
            });
            expect(decoded.batch.coverage.gaps).toContainEqual(
              expect.objectContaining({ code: "hooks.empty-snapshot" })
            );
            expect(yield* opened.service.append(decoded.batch)).toEqual({
              duplicates: 0,
              inserted: 0,
            });
          })
        )
    );

    it.effect(
      "the real collection planner rejects an exhausted record budget before decoding or append",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* plannedHookRecordCap() {
            const sourceRoot = realpathSync(root);
            const context = fixtureContext(sourceRoot);
            const frame = `${JSON.stringify(hookObservation(context))}\n`;
            const snapshot = hookSnapshot(sourceRoot, `${frame}${frame}`);
            writeFileSync(snapshot.ref.path, snapshot.bytes);
            const info = statSync(snapshot.ref.path);

            const ref: SessionRef = {
              ...snapshot.ref,
              mtimeMs: info.mtimeMs,
              size: info.size,
            };

            const scope = hookScope(fixture);

            const base = yield* fixture.boundedHookSnapshotHarness(
              { ...snapshot, ref },
              hookBounds,
              scope
            );

            const identity = yield* opened.agentService.identity;

            const inputRef = {
              ...snapshot.selection.inputRef,
              storeGeneration: identity.storeGeneration,
              storeId: identity.storeId,
            };

            let parserCalls = 0;

            const adapter = fixture.makePlannedSourceOperationAdapter({
              enrollment: () =>
                Effect.succeed({
                  reason: "Explicit synthetic hook source enrollment",
                  receiptIds: ["fixture.s03.hooks-enrollment"],
                  state: "authorized",
                }),
              env: {
                store: opened.service,
                storePath: path.join(root, "fixture.sqlite"),
              },
              parserVersion: "dx.bounded-hooks.v1",
              registry: fixture.harnessCatalog([base]),
              selected: [
                {
                  ...snapshot.selection,
                  inputRef,
                  planned: { ...snapshot.selection.planned, ref },
                },
              ],
              snapshotHarness: (captured, bounds) =>
                Effect.gen(function* capturedHookParser() {
                  parserCalls += 1;

                  const harness = yield* fixture.boundedHookSnapshotHarness(
                    captured,
                    bounds,
                    scope
                  );

                  return {
                    ...harness,
                    read: (selected, input) =>
                      harness.read(selected, { ...input, origin: "fixture" }),
                  };
                }),
            });

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [adapter]
            );

            const arguments_: OperationArguments = {
              allowSourceGrowth: false,
              cursor: null,
              inputRefs: [inputRef],
              kind: "collect",
              parserVersion: "dx.bounded-hooks.v1",
              selectedRoots: [sourceRoot],
              source: "harness.codex",
            };

            const failure = yield* fixture
              .createPlan(service, opened, arguments_, scope, {
                ...hookBounds,
                maxRecords: 1,
              })
              .pipe(Effect.flip);

            expect(failure._tag).toBe("AgentError");
            expect(failure).toMatchObject({ code: "budget-exhausted" });
            expect(parserCalls).toBe(0);
            expect(yield* opened.agentService.identity).toEqual(identity);
            expect(
              (yield* opened.service.snapshot(allFixtureEvents)).events
            ).toHaveLength(0);
          })
        )
    );
  });
};
