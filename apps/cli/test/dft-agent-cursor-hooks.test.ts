// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests initialize and stage only their owned synthetic Git repositories.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests read and write only their owned synthetic fixture files.
} from "node:fs";
import os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture artifacts use canonical paths within their isolated repository.
import path from "node:path";

import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentError,
  createOperationWorkBudget,
  makeFakeAgentStore,
} from "@rat-stack/core/dx";
import type {
  AgentScope,
  AgentStoreFailure,
  AgentStoreService,
  OperationAdapter,
  OperationArguments,
  OperationBounds,
  OperationEffectResult,
  OperationPlan,
  OperationPlanInput,
  OperationReceipt,
  OperationStep,
  OperationWorkContext,
} from "@rat-stack/core/dx";
import {
  Clock,
  Effect,
  Layer,
  PlatformError,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeCursorHooksAdapter } from "../src/dft-agent-cursor-hooks.js";
import {
  CURSOR_HOOK_EVENTS,
  installCursorHooks,
  installSkills,
  parseHooksFile,
} from "../src/dft-install.js";
import { skillDigest } from "../src/dft-skills.js";

class FixtureProcessLivenessError extends Schema.TaggedError<FixtureProcessLivenessError>()(
  "FixtureProcessLivenessError",
  { cause: Schema.Defect() }
) {}

const timestamp = "2026-10-02T12:00:00.000Z";

const identity = {
  revision: "fixture-cursor-revision",
  storeGeneration: 1,
  storeId: "fixture-cursor-store",
};

const bounds: OperationBounds = {
  maxBytes: 4_194_304,
  maxElapsedMs: 30_000,
  maxFiles: 200,
  maxRecords: 200,
  maxRequests: 32,
  maxRetries: 0,
};

const command = "node /fixture/dft-main.js hook";

interface Fixture {
  readonly root: string;
  readonly worktree: string;
  readonly source: string;
  readonly scope: AgentScope;
  readonly store: AgentStoreService;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly adapter: OperationAdapter;
  readonly hooks: string;
  readonly ownership: string;
  readonly exclude: string;
}

const fixtureFor = (
  root: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
): Fixture => {
  const worktree = path.join(root, "repo");
  const source = path.join(root, "packaged-skills");

  mkdirSync(worktree);
  execFileSync("git", ["init", "--quiet", worktree], { stdio: "ignore" });

  for (const name of ["dx-analyze", "dx-explain"]) {
    mkdirSync(path.join(source, name), { recursive: true });
    writeFileSync(
      path.join(source, name, "SKILL.md"),
      `# ${name} synthetic fixture v1\n`
    );
  }

  const scope: AgentScope = {
    branchSelection: { branches: ["fixture-main"], kind: "selected" },
    flightId: null,
    repoId: realpathSync(path.join(worktree, ".git")),
    resolution: "Synthetic Cursor fixture; no live observations",
    sources: ["fixture-source"],
    tools: ["cursor"],
    worktreeId: worktree,
  };

  const store = makeFakeAgentStore({
    identity: Effect.succeed(identity),
    readEventPage: () =>
      Effect.die(
        new Error("Cursor installation must not scan recorded events")
      ),
  });

  return {
    adapter: makeCursorHooksAdapter({
      hookCommand: () => command,
      scope,
      skillsSource: source,
      spawner,
      store,
      worktree,
    }),
    exclude: path.join(worktree, ".git", "info", "exclude"),
    hooks: path.join(worktree, ".cursor", "hooks.json"),
    ownership: path.join(
      worktree,
      ".git",
      "dft-install",
      `${skillDigest(".cursor").slice(0, 16)}.json`
    ),
    root,
    scope,
    source,
    spawner,
    store,
    worktree,
  };
};

const withFixture = <A, E>(use: (fixture: Fixture) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* isolatedCursorFixture() {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() =>
          realpathSync(
            mkdtempSync(
              path.join(
                process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
                "dft-cursor-hooks-fixture-"
              )
            )
          )
        ),
        (owned) =>
          Effect.sync(() => {
            rmSync(owned, { force: true, recursive: true });
          })
      );

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      return yield* use(yield* Effect.sync(() => fixtureFor(root, spawner)));
    })
  ).pipe(
    Effect.provide(
      NodeChildProcessSpawner.layer.pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
      )
    )
  );

const argumentsFor = (fixture: Fixture): OperationArguments => ({
  expectedContentDigest: "current",
  kind: "configure",
  path: fixture.hooks,
  settings: { action: "install-hooks", host: "cursor" },
});

const inputFor = (
  fixture: Fixture,
  selectedBounds: OperationBounds = bounds
): OperationPlanInput => ({
  action: "plan",
  arguments: argumentsFor(fixture),
  bounds: selectedBounds,
  purpose: "Verify synthetic Cursor installation behavior",
  scope: fixture.scope,
  target: identity,
});

const contextFor = Effect.fn("cursorHooksTests.context")(function* contextFor(
  selectedBounds: OperationBounds
): Effect.fn.Return<OperationWorkContext, AgentStoreFailure> {
  return {
    budget: yield* createOperationWorkBudget(
      selectedBounds,
      yield* Clock.currentTimeMillis
    ),
  };
});

const prepare = Effect.fn("cursorHooksTests.prepare")(function* prepare(
  fixture: Fixture,
  input: OperationPlanInput = inputFor(fixture)
) {
  return yield* fixture.adapter.prepare(input, yield* contextFor(input.bounds));
});

const planFor = Effect.fn("cursorHooksTests.plan")(function* planFor(
  fixture: Fixture
) {
  const input = inputFor(fixture);
  const prepared = yield* prepare(fixture, input);

  const plan: OperationPlan = {
    ...prepared,
    bounds: input.bounds,
    consent: { ...prepared.consent, scopeDigest: "fixture-cursor-consent" },
    createdAt: timestamp,
    expiresAt: "2026-10-02T12:30:00.000Z",
    id: "fixture-cursor-plan",
    kind: "configure",
    planDigest: "fixture-cursor-plan-digest",
    purpose: input.purpose,
    schemaVersion: "dx.operation.v1",
    scope: input.scope,
    storeGeneration: identity.storeGeneration,
    storeId: identity.storeId,
    validity: "valid",
  };

  return plan;
});

const firstStep = (adapter: OperationAdapter, plan: OperationPlan) => {
  const [step] = adapter.steps(plan);

  if (step === undefined) {
    throw new Error("Expected one Cursor installation step");
  }

  return step;
};

const confirmationFor = (plan: OperationPlan) =>
  `INSTALL CURSOR HOOKS ${plan.consent.scopeDigest}`;

const executeStep = (
  fixture: Fixture,
  plan: OperationPlan,
  context: OperationWorkContext,
  confirmation: string = confirmationFor(plan)
) =>
  fixture.adapter.execute(plan, firstStep(fixture.adapter, plan), {
    ...context,
    confirmation,
    operation: {
      id: "fixture-cursor-operation",
      storeGeneration: identity.storeGeneration,
      storeId: identity.storeId,
    },
  });

const execute = Effect.fn("cursorHooksTests.execute")(function* execute(
  fixture: Fixture,
  plan: OperationPlan,
  confirmation: string = confirmationFor(plan)
) {
  const context = yield* contextFor(plan.bounds);

  yield* fixture.adapter.validate(plan, context);
  yield* fixture.adapter.authorize(
    plan,
    {
      action: "apply",
      confirmation,
      consentReceiptIds: [],
      expectedDigest: plan.planDigest,
      idempotencyKey: "fixture-cursor-operation-key",
      plan,
    },
    context
  );

  return yield* executeStep(fixture, plan, context, confirmation);
});

const validate = Effect.fn("cursorHooksTests.validate")(function* validate(
  fixture: Fixture,
  plan: OperationPlan
) {
  return yield* fixture.adapter.validate(plan, yield* contextFor(plan.bounds));
});

const receiptFor = (
  plan: OperationPlan,
  result?: OperationEffectResult
): OperationReceipt => ({
  afterRevision: null,
  beforeRevision: identity.revision,
  cancellationRequested: false,
  completedAt: result === undefined ? null : timestamp,
  effects: result?.effects ?? {
    backupArtifacts: [],
    backupIds: [],
    configDigest: null,
    evidenceIds: [],
    exportArtifacts: [],
    exports: [],
    filesChanged: [],
    remainingStoreGeneration: identity.storeGeneration,
    removalReason: null,
    removedCount: null,
    removedRefs: [],
  },
  executionState: result === undefined ? "planned" : "succeeded",
  id: "fixture-cursor-operation",
  idempotencyKey: "fixture-cursor-operation-key",
  planDigest: plan.planDigest,
  planId: plan.id,
  recovery: "none",
  resources: result?.resources ?? {
    bytesRead: 0,
    elapsedMs: 0,
    recordsDecoded: 0,
    requests: 0,
    retries: 0,
  },
  resultingBasisId: null,
  revision: 1,
  schemaVersion: "dx.operation.v1",
  startedAt: result === undefined ? null : timestamp,
  steps: result === undefined ? [] : [result.step],
  storeGeneration: identity.storeGeneration,
  storeId: identity.storeId,
  verificationRefs: [],
  verificationState: "not-attempted",
});

const probe = Effect.fn("cursorHooksTests.probe")(function* probe(
  fixture: Fixture,
  plan: OperationPlan,
  receipt: OperationReceipt,
  step: OperationStep = firstStep(fixture.adapter, plan)
) {
  return yield* fixture.adapter.probe(
    plan,
    step,
    receipt,
    yield* contextFor(plan.bounds)
  );
});

const expectCode = <A>(
  effect: Effect.Effect<A, AgentStoreFailure>,
  code: AgentError["code"]
) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(AgentError)(failure)).toBe(true);

        if (Schema.is(AgentError)(failure)) {
          expect(failure.code).toBe(code);
        }
      })
    )
  );

const skillFile = (fixture: Fixture, name = "dx-analyze") =>
  path.join(fixture.worktree, ".cursor", "skills", name, "SKILL.md");

const requiredHooks = (fixture: Fixture) => {
  const parsed = parseHooksFile(readFileSync(fixture.hooks, "utf-8"));

  if (parsed === null) {
    throw new Error("Expected valid synthetic Cursor hooks");
  }

  return parsed;
};

describe("reviewed Cursor hooks operations", () => {
  it.effect("discovers the adapter without repository or file reads", () =>
    Effect.gen(function* lazyDiscovery() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const adapter = makeCursorHooksAdapter({
        hookCommand: () => {
          throw new Error("Discovery must not resolve the hook invocation");
        },
        scope: () => {
          throw new Error("Discovery must not resolve repository scope");
        },
        skillsSource: "/fixture/unavailable-cursor-skills",
        spawner,
        store: makeFakeAgentStore({
          identity: Effect.die(new Error("Discovery must not read the store")),
        }),
        worktree: () => {
          throw new Error("Discovery must not resolve a worktree");
        },
      });

      expect(adapter.descriptor).toMatchObject({
        enabled: true,
        kind: "configure",
      });
      expect(adapter.replay).toBe("probe-required");
    }).pipe(
      Effect.provide(
        NodeChildProcessSpawner.layer.pipe(
          Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
        )
      )
    )
  );

  it.effect(
    "does not launch a process when the reviewed request quota is zero",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* zeroProcessQuota() {
          const attempts: ChildProcess.Command[] = [];

          const spawner = ChildProcessSpawner.make((selected) =>
            Effect.suspend(() => {
              attempts.push(selected);

              return fixture.spawner.spawn(selected);
            })
          );

          const adapter = makeCursorHooksAdapter({
            hookCommand: () => command,
            scope: fixture.scope,
            skillsSource: fixture.source,
            spawner,
            store: fixture.store,
            worktree: fixture.worktree,
          });

          const input = inputFor(fixture, { ...bounds, maxRequests: 0 });
          const context = yield* contextFor(input.bounds);

          yield* expectCode(
            adapter.prepare(input, context),
            "budget-exhausted"
          );
          expect(attempts).toHaveLength(0);
          expect((yield* context.budget.measurements).requests).toBe(0);
          expect(existsSync(fixture.hooks)).toBe(false);
          expect(existsSync(fixture.ownership)).toBe(false);
        })
      )
  );

  it.effect("shares subprocess quota between validation and execution", () =>
    withFixture((fixture) =>
      Effect.gen(function* cumulativeProcessQuota() {
        const plan = yield* planFor(fixture);
        const originalExclude = readFileSync(fixture.exclude, "utf-8");
        const attempts: ChildProcess.Command[] = [];

        const spawner = ChildProcessSpawner.make((selected) =>
          Effect.suspend(() => {
            attempts.push(selected);

            return fixture.spawner.spawn(selected);
          })
        );

        const adapter = makeCursorHooksAdapter({
          hookCommand: () => command,
          scope: fixture.scope,
          skillsSource: fixture.source,
          spawner,
          store: fixture.store,
          worktree: fixture.worktree,
        });

        const context = yield* contextFor({ ...bounds, maxRequests: 2 });

        expect(yield* adapter.validate(plan, context)).toEqual([]);
        expect(attempts).toHaveLength(2);
        expect((yield* context.budget.measurements).requests).toBe(2);
        yield* expectCode(
          executeStep({ ...fixture, adapter }, plan, context),
          "budget-exhausted"
        );
        expect(attempts).toHaveLength(2);
        expect((yield* context.budget.measurements).requests).toBe(2);
        expect(existsSync(fixture.hooks)).toBe(false);
        expect(existsSync(fixture.ownership)).toBe(false);
        expect(readFileSync(fixture.exclude, "utf-8")).toBe(originalExclude);
      })
    )
  );

  it.effect(
    "counts a failed spawn attempt and withholds private diagnostics",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* failedProcessQuota() {
          const attempts: ChildProcess.Command[] = [];
          const privateDiagnostic = "fixture-private-spawn-diagnostic";

          const spawner = ChildProcessSpawner.make((selected) =>
            Effect.suspend(() => {
              attempts.push(selected);

              return Effect.fail(
                PlatformError.badArgument({
                  description: privateDiagnostic,
                  method: "spawn",
                  module: "ChildProcess",
                })
              );
            })
          );

          const adapter = makeCursorHooksAdapter({
            hookCommand: () => command,
            scope: fixture.scope,
            skillsSource: fixture.source,
            spawner,
            store: fixture.store,
            worktree: fixture.worktree,
          });

          const input = inputFor(fixture, { ...bounds, maxRequests: 1 });
          const context = yield* contextFor(input.bounds);

          const error = yield* expectCode(
            adapter.prepare(input, context),
            "source-unavailable"
          );

          expect(JSON.stringify(error)).not.toContain(privateDiagnostic);
          expect(attempts).toHaveLength(1);
          expect((yield* context.budget.measurements).requests).toBe(1);
          yield* expectCode(
            adapter.prepare(input, context),
            "budget-exhausted"
          );
          expect(attempts).toHaveLength(1);
          expect((yield* context.budget.measurements).requests).toBe(1);
          expect(existsSync(fixture.hooks)).toBe(false);
          expect(existsSync(fixture.ownership)).toBe(false);
        })
      )
  );

  it.effect(
    "rejects unused legacy plans before resolving targets or spawning",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* legacyProcessPlan() {
          const current = yield* planFor(fixture);

          const plan: OperationPlan = {
            ...current,
            preconditions: current.preconditions.filter(
              (item) => item.target !== "cursor-hooks-adapter-version"
            ),
          };

          const mismatched: OperationPlan = {
            ...current,
            preconditions: current.preconditions.map((item) =>
              item.target === "cursor-hooks-adapter-version"
                ? { ...item, expected: "dft.cursor-hooks-operation.v1" }
                : item
            ),
          };

          const attempts: ChildProcess.Command[] = [];
          const resolutions: AgentScope[] = [];

          const adapter = makeCursorHooksAdapter({
            hookCommand: () => command,
            resolveTarget: (scope) => {
              resolutions.push(scope);

              return Effect.die(
                new Error("Legacy plans must not resolve a target")
              );
            },
            scope: fixture.scope,
            skillsSource: fixture.source,
            spawner: ChildProcessSpawner.make((selected) => {
              attempts.push(selected);

              return fixture.spawner.spawn(selected);
            }),
            store: fixture.store,
            worktree: fixture.worktree,
          });

          const context = yield* contextFor(bounds);

          expect(yield* adapter.validate(plan, context)).toEqual([
            "adapter-version",
          ]);
          expect(yield* adapter.validate(mismatched, context)).toEqual([
            "adapter-version",
          ]);
          yield* expectCode(
            adapter.authorize(
              plan,
              {
                action: "apply",
                confirmation: confirmationFor(plan),
                consentReceiptIds: [],
                expectedDigest: plan.planDigest,
                idempotencyKey: "fixture-legacy-operation-key",
                plan,
              },
              context
            ),
            "plan-stale"
          );
          yield* expectCode(
            executeStep({ ...fixture, adapter }, plan, context),
            "plan-stale"
          );
          expect(
            (yield* adapter.probe(
              plan,
              firstStep(adapter, plan),
              receiptFor(plan),
              context
            )).state
          ).toBe("indeterminate");
          expect(
            (yield* adapter.probe(
              mismatched,
              firstStep(adapter, mismatched),
              receiptFor(mismatched),
              context
            )).state
          ).toBe("indeterminate");
          expect(attempts).toHaveLength(0);
          expect(resolutions).toHaveLength(0);
          expect((yield* context.budget.measurements).requests).toBe(0);
        })
      )
  );

  it.effect(
    "kills a ready owned child that ignores SIGTERM when its query times out",
    () =>
      TestClock.withLive(
        withFixture((fixture) =>
          Effect.gen(function* ownedTimeoutChild() {
            const script = path.join(fixture.root, "ignored-term-fixture.cjs");
            const pidFile = path.join(fixture.root, "owned-child.pid");
            const readyFile = path.join(fixture.root, "owned-child.ready");

            const termCanary = path.join(
              fixture.root,
              "unexpected-term.canary"
            );

            const privateDiagnostic = "fixture-private-stderr-canary";
            const originalExclude = readFileSync(fixture.exclude, "utf-8");

            yield* Effect.sync(() => {
              writeFileSync(
                script,
                [
                  'const fs = require("node:fs");',
                  "const [pid, ready, term] = process.argv.slice(2);",
                  'process.on("SIGTERM", () => fs.writeFileSync(term, "TERM received"));',
                  "fs.writeFileSync(pid, String(process.pid));",
                  'fs.writeFileSync(ready, String(process.listenerCount("SIGTERM")));',
                  `process.stderr.write(${JSON.stringify(privateDiagnostic)});`,
                  'fs.writeSync(3, "ready");',
                  "fs.closeSync(3);",
                  "setInterval(() => {}, 1000);",
                ].join("\n")
              );
            });

            const handles: ChildProcessSpawner.ChildProcessHandle[] = [];

            const spawner = ChildProcessSpawner.make(
              Effect.fnUntraced(function* ownedNativeSpawn(
                selected: ChildProcess.Command
              ) {
                if (!Predicate.isTagged(selected, "StandardCommand")) {
                  return yield* PlatformError.badArgument({
                    method: "spawn",
                    module: "ChildProcess",
                  });
                }

                expect(selected.command).toBe("git");
                expect(selected.options.killSignal).toBe("SIGKILL");
                expect(selected.options.forceKillAfter).toBe(0);

                const handle = yield* fixture.spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    [script, pidFile, readyFile, termCanary],
                    {
                      ...selected.options,
                      additionalFds: {
                        ...selected.options.additionalFds,
                        fd3: { type: "output" },
                      },
                    }
                  )
                );

                handles.push(handle);
                expect(
                  yield* Stream.mkString(
                    Stream.decodeText(handle.getOutputFd(3))
                  )
                ).toBe("ready");
                expect(readFileSync(pidFile, "utf-8")).toBe(String(handle.pid));
                expect(readFileSync(readyFile, "utf-8")).toBe("1");
                expect(yield* handle.isRunning).toBe(true);

                return handle;
              })
            );

            const adapter = makeCursorHooksAdapter({
              hookCommand: () => command,
              scope: fixture.scope,
              skillsSource: fixture.source,
              spawner,
              store: fixture.store,
              worktree: fixture.worktree,
            });

            const input = inputFor(fixture, { ...bounds, maxElapsedMs: 2000 });
            const context = yield* contextFor(input.bounds);

            const error = yield* expectCode(
              adapter.prepare(input, context),
              "budget-exhausted"
            );

            expect(handles).toHaveLength(1);
            const [handle] = handles;

            if (handle === undefined) {
              throw new Error("Expected the ready owned fixture process");
            }

            expect(yield* handle.isRunning).toBe(false);

            const livenessFailure = yield* Effect.try({
              catch: (cause) => new FixtureProcessLivenessError({ cause }),
              try: () => process.kill(Number(handle.pid), 0),
            }).pipe(Effect.flip);

            expect(
              Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))(
                livenessFailure.cause
              )
            ).toBe(true);
            expect(readFileSync(pidFile, "utf-8")).toBe(String(handle.pid));
            expect(readFileSync(readyFile, "utf-8")).toBe("1");
            expect(existsSync(termCanary)).toBe(false);
            expect(JSON.stringify(error)).not.toContain(privateDiagnostic);
            expect((yield* context.budget.measurements).requests).toBe(1);
            expect(existsSync(fixture.hooks)).toBe(false);
            expect(existsSync(fixture.ownership)).toBe(false);
            expect(readFileSync(fixture.exclude, "utf-8")).toBe(
              originalExclude
            );
          })
        )
      )
  );

  it.effect(
    "charges the trusted target resolver before reserving file work",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* meteredTargetResolution() {
          const contexts: OperationWorkContext[] = [];
          const context = yield* contextFor(bounds);

          const adapter = makeCursorHooksAdapter({
            hookCommand: () => command,
            resolveTarget: (scope, work) =>
              Effect.gen(function* trustedFixtureTarget() {
                expect(scope).toEqual(fixture.scope);
                contexts.push(work);
                yield* work.budget.charge({
                  bytesRead: 256,
                  filesRead: 1,
                  recordsDecoded: 1,
                  requests: 0,
                  retries: 0,
                });

                return { scope: fixture.scope, worktree: fixture.worktree };
              }),
            scope: () => {
              throw new Error(
                "The trusted resolver supplies the admitted scope"
              );
            },
            skillsSource: fixture.source,
            spawner: fixture.spawner,
            store: fixture.store,
            worktree: () => {
              throw new Error(
                "The trusted resolver supplies the admitted target"
              );
            },
          });

          const prepared = yield* adapter.prepare(inputFor(fixture), context);
          const measured = yield* context.budget.measurements;
          const remaining = yield* context.budget.remaining;

          expect(contexts).toHaveLength(1);
          expect(contexts[0]).toBe(context);
          expect(prepared.arguments).toMatchObject({
            expectedContentDigest: "absent",
            path: fixture.hooks,
          });
          expect(measured.bytesRead).toBeGreaterThan(256);
          expect(measured.recordsDecoded).toBeGreaterThan(1);
          expect(remaining.maxBytes + (measured.bytesRead ?? 0)).toBe(
            bounds.maxBytes
          );
          expect(existsSync(fixture.hooks)).toBe(false);
          expect(existsSync(fixture.ownership)).toBe(false);
        })
      )
  );

  it.effect(
    "stops file work when trusted target resolution spends the budget",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* exhaustedTargetResolution() {
          const originalExclude = readFileSync(fixture.exclude, "utf-8");
          const context = yield* contextFor(bounds);

          const adapter = makeCursorHooksAdapter({
            hookCommand: () => command,
            resolveTarget: (_scope, work) =>
              work.budget
                .charge({
                  bytesRead: bounds.maxBytes,
                  filesRead: 0,
                  recordsDecoded: 0,
                  requests: 0,
                  retries: 0,
                })
                .pipe(
                  Effect.as({
                    scope: fixture.scope,
                    worktree: fixture.worktree,
                  })
                ),
            scope: fixture.scope,
            skillsSource: fixture.source,
            spawner: fixture.spawner,
            store: fixture.store,
            worktree: fixture.worktree,
          });

          yield* expectCode(
            adapter.prepare(inputFor(fixture), context),
            "budget-exhausted"
          );
          expect(existsSync(fixture.hooks)).toBe(false);
          expect(existsSync(fixture.ownership)).toBe(false);
          expect(readFileSync(fixture.exclude, "utf-8")).toBe(originalExclude);
        })
      )
  );

  it.effect("plans exact selected paths and consent without writes", () =>
    withFixture((fixture) =>
      Effect.gen(function* readOnlyCursorPlan() {
        const originalExclude = readFileSync(fixture.exclude, "utf-8");
        const plan = yield* planFor(fixture);

        expect(plan.arguments).toMatchObject({
          expectedContentDigest: "absent",
          kind: "configure",
          path: fixture.hooks,
          settings: { action: "install-hooks", host: "cursor" },
        });
        expect(plan.preconditions.map((item) => item.target)).toContain(
          fixture.hooks
        );
        expect(plan.preconditions.map((item) => item.target)).toContain(
          fixture.exclude
        );
        expect(plan.preconditions).toContainEqual({
          allowAppend: false,
          expected: "dft.cursor-hooks-operation.v2",
          kind: "parser-version",
          target: "cursor-hooks-adapter-version",
        });
        expect(plan.forecast.requests).toBe(2);
        expect(plan.effects.networkDestinations).toEqual([]);
        expect(existsSync(path.join(fixture.worktree, ".cursor"))).toBe(false);
        expect(existsSync(fixture.ownership)).toBe(false);
        expect(readFileSync(fixture.exclude, "utf-8")).toBe(originalExclude);

        yield* expectCode(
          execute(fixture, plan, "INSTALL CURSOR HOOKS another-scope"),
          "authorization-required"
        );
        expect(existsSync(fixture.hooks)).toBe(false);
      })
    )
  );

  it.effect("rejects generated hook ownership over its cap before writes", () =>
    withFixture((fixture) =>
      Effect.sync(() => {
        const original = '{"hooks":{},"userSetting":"preserve","version":1}\n';

        mkdirSync(path.dirname(fixture.hooks));
        writeFileSync(fixture.hooks, original);

        expect(() =>
          installCursorHooks(fixture.worktree, command, {
            maxOwnershipBytes: 1,
            ownershipPath: fixture.ownership,
            readFile: (file) => (existsSync(file) ? readFileSync(file) : null),
            refresh: true,
          })
        ).toThrow();
        expect(readFileSync(fixture.hooks, "utf-8")).toBe(original);
        expect(existsSync(fixture.ownership)).toBe(false);
        expect(
          existsSync(path.join(path.dirname(fixture.ownership), "backups"))
        ).toBe(false);
      })
    )
  );

  it.effect(
    "rejects generated skill ownership over its cap before writes",
    () =>
      withFixture((fixture) =>
        Effect.sync(() => {
          expect(() =>
            installSkills(fixture.worktree, fixture.source, ".cursor", {
              maxOwnershipBytes: 1,
              ownershipPath: fixture.ownership,
              readFile: (file) =>
                existsSync(file) ? readFileSync(file) : null,
              skills: [
                {
                  body: "# synthetic prepared guidance fixture\n",
                  name: "dx-analyze",
                },
              ],
            })
          ).toThrow();
          expect(existsSync(path.join(fixture.worktree, ".cursor"))).toBe(
            false
          );
          expect(existsSync(fixture.ownership)).toBe(false);
          expect(
            existsSync(path.join(path.dirname(fixture.ownership), "backups"))
          ).toBe(false);
        })
      )
  );

  it.effect(
    "lets the ownership callback refuse removal before any mutations",
    () =>
      withFixture((fixture) =>
        Effect.sync(() => {
          const originalOwnership = JSON.stringify({
            hookFileCreated: false,
            hooks: {},
            schema: "dft.install.ownership.v1",
            skills: {},
          });

          const originalHooks = JSON.stringify({
            hooks: Object.fromEntries(
              CURSOR_HOOK_EVENTS.map((event) => [event, [{ command }]])
            ),
            version: 1,
          });

          const body = "# matching synthetic user guidance\n";

          const refused = new Error(
            "Fixture callback refused the ownership write"
          );

          const phases: string[] = [];

          mkdirSync(path.dirname(fixture.ownership));
          writeFileSync(fixture.ownership, originalOwnership);
          mkdirSync(path.dirname(skillFile(fixture)), { recursive: true });
          writeFileSync(skillFile(fixture), body);
          writeFileSync(fixture.hooks, originalHooks);

          const onOwnershipWrite = (
            file: string,
            serialized: string | null,
            phase: "before" | "after"
          ) => {
            phases.push(phase);
            expect(file).toBe(fixture.ownership);
            expect(serialized).toBeNull();

            if (phase === "before") {
              throw refused;
            }
          };

          const prepared = {
            onOwnershipWrite,
            ownershipPath: fixture.ownership,
            readFile: (file: string) =>
              existsSync(file) ? readFileSync(file) : null,
          };

          expect(() =>
            installCursorHooks(fixture.worktree, command, {
              ...prepared,
              refresh: true,
            })
          ).toThrow(refused);
          expect(() =>
            installSkills(fixture.worktree, fixture.source, ".cursor", {
              ...prepared,
              skills: [{ body, name: "dx-analyze" }],
            })
          ).toThrow(refused);
          expect(phases).toEqual(["before", "before"]);
          expect(readFileSync(fixture.ownership, "utf-8")).toBe(
            originalOwnership
          );
          expect(readFileSync(fixture.hooks, "utf-8")).toBe(originalHooks);
          expect(readFileSync(skillFile(fixture), "utf-8")).toBe(body);
          expect(
            existsSync(path.join(path.dirname(fixture.ownership), "backups"))
          ).toBe(false);
        })
      )
  );

  it.effect("requires the selected hook file digest before planning", () =>
    withFixture((fixture) =>
      Effect.gen(function* exactHookDigest() {
        const body = '{"version":1,"hooks":{}}\n';

        yield* Effect.sync(() => {
          mkdirSync(path.dirname(fixture.hooks));
          writeFileSync(fixture.hooks, body);
        });
        const input = inputFor(fixture);

        const prepared = yield* prepare(fixture, {
          ...input,
          arguments: {
            ...argumentsFor(fixture),
            expectedContentDigest: skillDigest(body),
            kind: "configure",
            path: fixture.hooks,
            settings: { action: "install-hooks", host: "cursor" },
          },
        });

        expect(prepared.arguments).toMatchObject({
          expectedContentDigest: skillDigest(body),
        });
        yield* expectCode(
          prepare(fixture, {
            ...input,
            arguments: {
              expectedContentDigest: "absent",
              kind: "configure",
              path: fixture.hooks,
              settings: { action: "install-hooks", host: "cursor" },
            },
          }),
          "plan-stale"
        );
        expect(readFileSync(fixture.hooks, "utf-8")).toBe(body);
      })
    )
  );

  it.effect("rejects another scope, generation and unselected target", () =>
    withFixture((fixture) =>
      Effect.gen(function* invalidCursorScope() {
        const input = inputFor(fixture);

        yield* expectCode(
          prepare(fixture, {
            ...input,
            scope: { ...fixture.scope, worktreeId: fixture.root },
          }),
          "scope-denied"
        );
        yield* expectCode(
          prepare(fixture, {
            ...input,
            target: { ...identity, storeGeneration: 2 },
          }),
          "stale-generation"
        );
        yield* expectCode(
          prepare(fixture, {
            ...input,
            arguments: {
              expectedContentDigest: "current",
              kind: "configure",
              path: path.join(fixture.root, "hooks.json"),
              settings: { action: "install-hooks", host: "cursor" },
            },
          }),
          "invalid-selector"
        );
        expect(existsSync(fixture.hooks)).toBe(false);
      })
    )
  );

  it.effect(
    "rejects malformed hooks while preserving their exact contents",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* malformedCursorHooks() {
          const malformed = '{"version":1,"hooks":';
          const originalExclude = readFileSync(fixture.exclude, "utf-8");

          yield* Effect.sync(() => {
            mkdirSync(path.dirname(fixture.hooks));
            writeFileSync(fixture.hooks, malformed);
          });
          yield* expectCode(prepare(fixture), "source-unavailable");
          expect(readFileSync(fixture.hooks, "utf-8")).toBe(malformed);
          expect(existsSync(skillFile(fixture))).toBe(false);
          expect(existsSync(fixture.ownership)).toBe(false);
          expect(readFileSync(fixture.exclude, "utf-8")).toBe(originalExclude);
        })
      )
  );

  it.effect(
    "rejects malformed ownership without installing hooks or skills",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* malformedCursorOwnership() {
          const malformed = '{"schema":"dft.install.ownership.v1"}';
          const originalExclude = readFileSync(fixture.exclude, "utf-8");

          yield* Effect.sync(() => {
            mkdirSync(path.dirname(fixture.ownership));
            writeFileSync(fixture.ownership, malformed);
          });
          yield* expectCode(prepare(fixture), "source-unavailable");
          expect(readFileSync(fixture.ownership, "utf-8")).toBe(malformed);
          expect(existsSync(fixture.hooks)).toBe(false);
          expect(existsSync(skillFile(fixture))).toBe(false);
          expect(readFileSync(fixture.exclude, "utf-8")).toBe(originalExclude);
        })
      )
  );

  it.effect(
    "rejects an incomplete Git exclude block before planning writes",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* malformedCursorExclude() {
          const malformed =
            "# user fixture rules\n# >>> dft agent Cursor hooks\n/.cursor/hooks.json\n";

          yield* Effect.sync(() => {
            writeFileSync(fixture.exclude, malformed);
          });
          yield* expectCode(prepare(fixture), "plan-stale");
          expect(readFileSync(fixture.exclude, "utf-8")).toBe(malformed);
          expect(existsSync(fixture.hooks)).toBe(false);
          expect(existsSync(fixture.ownership)).toBe(false);
          expect(existsSync(skillFile(fixture))).toBe(false);
        })
      )
  );

  it.effect("refuses linked Cursor directories and Git excludes", () =>
    withFixture((fixture) =>
      Effect.gen(function* linkedCursorPaths() {
        const external = path.join(fixture.root, "outside");

        yield* Effect.sync(() => {
          mkdirSync(external);
          symlinkSync(external, path.join(fixture.worktree, ".cursor"));
        });
        yield* expectCode(prepare(fixture), "scope-denied");
        expect(existsSync(path.join(external, "hooks.json"))).toBe(false);
        yield* Effect.sync(() => {
          rmSync(path.join(fixture.worktree, ".cursor"));
          rmSync(fixture.exclude);
          writeFileSync(path.join(external, "exclude"), "# external fixture\n");
          symlinkSync(path.join(external, "exclude"), fixture.exclude);
        });
        yield* expectCode(prepare(fixture), "scope-denied");
        expect(readFileSync(path.join(external, "exclude"), "utf-8")).toBe(
          "# external fixture\n"
        );
      })
    )
  );

  it.effect(
    "detects changed packaged skills, hooks and ownership records",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* staleCursorFiles() {
          yield* execute(fixture, yield* planFor(fixture));
          const plan = yield* planFor(fixture);
          const source = path.join(fixture.source, "dx-analyze", "SKILL.md");
          const originalSource = readFileSync(source, "utf-8");
          const originalHooks = readFileSync(fixture.hooks, "utf-8");

          yield* Effect.sync(() => {
            appendFileSync(source, "# updated packaged fixture\n");
          });
          expect((yield* validate(fixture, plan)).length).toBeGreaterThan(0);
          yield* expectCode(execute(fixture, plan), "plan-stale");
          yield* Effect.sync(() => {
            writeFileSync(source, originalSource);
            appendFileSync(fixture.hooks, "\n");
          });
          expect((yield* validate(fixture, plan)).length).toBeGreaterThan(0);
          yield* expectCode(execute(fixture, plan), "plan-stale");
          yield* Effect.sync(() => {
            writeFileSync(fixture.hooks, originalHooks);
            appendFileSync(fixture.ownership, "\n");
          });
          expect((yield* validate(fixture, plan)).length).toBeGreaterThan(0);
          yield* expectCode(execute(fixture, plan), "plan-stale");
          expect(readFileSync(fixture.hooks, "utf-8")).toBe(originalHooks);
        })
      )
  );

  it.effect("invalidates a plan when Git starts tracking the hook file", () =>
    withFixture((fixture) =>
      Effect.gen(function* changedGitTracking() {
        yield* Effect.sync(() => {
          mkdirSync(path.dirname(fixture.hooks));
          writeFileSync(fixture.hooks, '{"version":1,"hooks":{}}\n');
        });
        const plan = yield* planFor(fixture);
        const original = readFileSync(fixture.hooks, "utf-8");

        yield* Effect.sync(() => {
          execFileSync("git", ["add", "--", ".cursor/hooks.json"], {
            cwd: fixture.worktree,
            stdio: "ignore",
          });
        });
        expect((yield* validate(fixture, plan)).length).toBeGreaterThan(0);
        yield* expectCode(execute(fixture, plan), "plan-stale");
        expect(readFileSync(fixture.hooks, "utf-8")).toBe(original);
        expect(existsSync(skillFile(fixture))).toBe(false);
      })
    )
  );

  it.effect(
    "preserves edited hooks and skills while upgrading owned files",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* ownedCursorUpgrade() {
          yield* execute(fixture, yield* planFor(fixture));
          const edited = skillFile(fixture);
          const upgraded = skillFile(fixture, "dx-explain");
          const oldUpgrade = readFileSync(upgraded, "utf-8");
          const unrelated = skillFile(fixture, "my-skill");
          const parsed = requiredHooks(fixture);

          const userHook = {
            command: "node /fixture/user-hook.js",
            note: "mine",
          };

          const editedHook = { command: `${command} --user-note` };

          yield* Effect.sync(() => {
            writeFileSync(
              fixture.hooks,
              JSON.stringify({
                ...parsed,
                hooks: {
                  ...parsed.hooks,
                  sessionStart: [userHook, editedHook],
                },
                userSetting: "preserved",
              })
            );
            writeFileSync(edited, "# my edited guidance\n");
            mkdirSync(path.dirname(unrelated), { recursive: true });
            writeFileSync(unrelated, "# my unrelated skill\n");
            writeFileSync(
              path.join(fixture.source, "dx-explain", "SKILL.md"),
              "# synthetic explain fixture v2\n"
            );
          });
          const result = yield* execute(fixture, yield* planFor(fixture));
          const installed = requiredHooks(fixture);

          expect(installed.hooks?.sessionStart).toEqual([userHook, editedHook]);
          expect(installed.userSetting).toBe("preserved");
          expect(readFileSync(edited, "utf-8")).toBe("# my edited guidance\n");
          expect(readFileSync(unrelated, "utf-8")).toBe(
            "# my unrelated skill\n"
          );
          expect(readFileSync(upgraded, "utf-8")).toBe(
            "# synthetic explain fixture v2\n"
          );
          expect(result.effects?.filesChanged).toContain(upgraded);
          expect(result.effects?.filesChanged).not.toContain(edited);
          expect(result.effects?.filesChanged).not.toContain(unrelated);

          const backup = result.effects?.backupArtifacts.find(
            (item) => item.contentDigest === skillDigest(oldUpgrade)
          );

          expect(backup).toBeDefined();

          if (backup !== undefined) {
            expect(readFileSync(backup.id, "utf-8")).toBe(oldUpgrade);
          }
        })
      )
  );

  it.effect("keeps matching preexisting guidance and hooks unowned", () =>
    withFixture((fixture) =>
      Effect.gen(function* preexistingCursorOwnership() {
        const userHook = { command };
        const preexistingSkill = skillFile(fixture);

        const originalSkill = readFileSync(
          path.join(fixture.source, "dx-analyze", "SKILL.md"),
          "utf-8"
        );

        yield* Effect.sync(() => {
          mkdirSync(path.dirname(preexistingSkill), { recursive: true });
          writeFileSync(preexistingSkill, originalSkill);
          writeFileSync(
            fixture.hooks,
            JSON.stringify({ hooks: { sessionStart: [userHook] }, version: 1 })
          );
        });
        yield* execute(fixture, yield* planFor(fixture));
        yield* Effect.sync(() => {
          writeFileSync(
            path.join(fixture.source, "dx-analyze", "SKILL.md"),
            "# synthetic analyze fixture v2\n"
          );
        });
        const result = yield* execute(fixture, yield* planFor(fixture));

        expect(readFileSync(preexistingSkill, "utf-8")).toBe(originalSkill);
        expect(requiredHooks(fixture).hooks?.sessionStart).toEqual([userHook]);
        expect(result.effects?.filesChanged).not.toContain(preexistingSkill);
      })
    )
  );

  it.effect("backs up Git excludes and preserves their existing rules", () =>
    withFixture((fixture) =>
      Effect.gen(function* backedUpGitExclude() {
        const previous = "# user fixture rules\n/local-secret\n";

        yield* Effect.sync(() => {
          writeFileSync(fixture.exclude, previous);
        });
        const result = yield* execute(fixture, yield* planFor(fixture));
        const installed = requiredHooks(fixture);

        for (const event of CURSOR_HOOK_EVENTS) {
          expect(installed.hooks?.[event]).toEqual([{ command }]);
        }

        const current = readFileSync(fixture.exclude, "utf-8");

        expect(current).toContain(previous);
        expect(current).toContain("# >>> dft agent Cursor hooks");
        expect(current).toContain("# <<< dft agent Cursor hooks");
        expect(current).toContain(".cursor/hooks.json");
        expect(result.effects?.filesChanged).toContain(fixture.exclude);

        const backup = result.effects?.backupArtifacts.find(
          (item) => item.contentDigest === skillDigest(previous)
        );

        expect(backup).toBeDefined();

        if (backup !== undefined) {
          expect(readFileSync(backup.id, "utf-8")).toBe(previous);
          expect(backup.storeId).toBe(identity.storeId);
          expect(backup.storeGeneration).toBe(identity.storeGeneration);
        }

        expect(result.resources?.requests).toBe(2);
        expect(result.resources?.bytesRead).toBeGreaterThan(0);
      })
    )
  );

  it.effect(
    "stops cumulative work before writing after validation spends its budget",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* exhaustedCursorBudget() {
          const originalExclude = readFileSync(fixture.exclude, "utf-8");
          const plan = yield* planFor(fixture);
          const context = yield* contextFor(plan.bounds);

          yield* fixture.adapter.validate(plan, context);
          const measured = yield* context.budget.measurements;

          expect(measured.bytesRead).toBeGreaterThan(0);
          const remaining = yield* context.budget.remaining;

          yield* context.budget.charge({
            bytesRead: remaining.maxBytes,
            filesRead: 0,
            recordsDecoded: 0,
            requests: 0,
            retries: 0,
          });
          yield* expectCode(
            executeStep(fixture, plan, context),
            "budget-exhausted"
          );
          expect(existsSync(fixture.hooks)).toBe(false);
          expect(existsSync(fixture.ownership)).toBe(false);
          expect(readFileSync(fixture.exclude, "utf-8")).toBe(originalExclude);
        })
      )
  );

  it.effect("rejects a tiny planning budget without creating artifacts", () =>
    withFixture((fixture) =>
      Effect.gen(function* boundedCursorPlanning() {
        const originalExclude = readFileSync(fixture.exclude, "utf-8");

        yield* expectCode(
          prepare(fixture, inputFor(fixture, { ...bounds, maxBytes: 1 })),
          "budget-exhausted"
        );
        expect(existsSync(fixture.hooks)).toBe(false);
        expect(existsSync(fixture.ownership)).toBe(false);
        expect(readFileSync(fixture.exclude, "utf-8")).toBe(originalExclude);
      })
    )
  );

  it.effect(
    "requires a matching durable receipt to recognize completed effects",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* conservativeCursorReplay() {
          const plan = yield* planFor(fixture);

          expect((yield* probe(fixture, plan, receiptFor(plan))).state).toBe(
            "absent"
          );
          const result = yield* execute(fixture, plan);
          const receipt = receiptFor(plan, result);

          expect((yield* probe(fixture, plan, receipt)).state).toBe("complete");
          expect(
            (yield* probe(fixture, plan, {
              ...receipt,
              effects: { ...receipt.effects, backupArtifacts: [] },
            })).state
          ).toBe("indeterminate");
          expect((yield* probe(fixture, plan, receiptFor(plan))).state).toBe(
            "indeterminate"
          );
          expect(
            (yield* probe(fixture, plan, {
              ...receipt,
              planDigest: "another-plan-digest",
            })).state
          ).toBe("indeterminate");
          expect(
            (yield* probe(fixture, plan, {
              ...receipt,
              storeGeneration: receipt.storeGeneration + 1,
            })).state
          ).toBe("indeterminate");
          expect(
            (yield* probe(fixture, plan, {
              ...receipt,
              storeId: "another-fixture-store",
            })).state
          ).toBe("indeterminate");
          yield* Effect.sync(() => {
            appendFileSync(fixture.hooks, "\n");
          });
          expect((yield* probe(fixture, plan, receipt)).state).toBe(
            "indeterminate"
          );
        })
      )
  );
});
