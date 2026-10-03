import { Buffer } from "node:buffer";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Composition checks initialize only the Git repository inside their owned synthetic fixture.
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
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Each fixture acquires and releases only its own isolated artifact directory.
} from "node:fs";
import os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Selected fixture artifacts use canonical local paths.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentError,
  createOperationWorkBudget,
  makeFakeAgentStore,
  operationStep,
} from "@rat-stack/core/dx";
import type {
  AgentScope,
  AgentStoreFailure,
  AgentStoreService,
  AnalysisBasisMetadata,
  OperationAdapter,
  OperationArguments,
  OperationBounds,
  OperationEffectResult,
  OperationPlan,
  OperationPlanInput,
  OperationReceipt,
  OperationWorkContext,
} from "@rat-stack/core/dx";
import { Clock, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeAppOperationAdapters } from "../src/dft-agent-adapters.js";
import { makeCursorHooksAdapter } from "../src/dft-agent-cursor-hooks.js";
import { skillDigest } from "../src/dft-skills.js";

const timestamp = "2026-10-02T12:00:00.000Z";

const fixtureIdentity = {
  revision: "fixture-revision-1",
  storeGeneration: 1,
  storeId: "fixture-app-adapter-store",
};

const fixtureBounds: OperationBounds = {
  maxBytes: 1_048_576,
  maxElapsedMs: 30_000,
  maxFiles: 100,
  maxRecords: 100,
  maxRequests: 4,
  maxRetries: 0,
};

interface AdapterFixture {
  readonly root: string;
  readonly worktree: string;
  readonly source: string;
  readonly scope: AgentScope;
  readonly store: AgentStoreService;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly metadata: AnalysisBasisMetadata[];
  readonly reads: { metadata: number };
  readonly configure: OperationAdapter;
  readonly exportMetadata: OperationAdapter;
}

const fixtureMetadata = (scope: AgentScope): AnalysisBasisMetadata => ({
  acquisitionReceiptIds: ["fixture-acquisition"],
  attributionVersion: "fixture-attribution-v1",
  configDigest: "fixture-config-v1",
  contractDigest: "fixture-contract-digest",
  contractVersion: "fixture-contract-v1",
  coverage: [],
  createdAt: timestamp,
  descriptors: [{ id: "fixture-source", version: "fixture-v1" }],
  eventWatermark: "fixture-event-watermark",
  id: "fixture-selected-basis",
  interpretationBytes: 32,
  metricDefinitions: [{ id: "fixture-metric", version: "fixture-v1" }],
  normalizedFilters: { repo: ["fixture-app-adapter-repo"] },
  originMix: [{ count: 3, origin: "fixture" }],
  priceSheets: [
    {
      contentHash: "fixture-price-sheet-hash",
      effectiveFrom: null,
      effectiveUntil: null,
      id: "fixture-price-sheet",
    },
  ],
  queryKey: "fixture-query-key",
  reconciliationVersion: "fixture-reconciliation-v1",
  reproducibility: "retained-inputs",
  retainedDecodedBytes: 64,
  retainedEventCount: 3,
  schemaVersion: "dx.basis.v1",
  scope,
  selectedEventDigest: "fixture-selected-events-digest",
  storeGeneration: fixtureIdentity.storeGeneration,
  storeId: fixtureIdentity.storeId,
  supportedResultVersions: ["dx.result.v1"],
  window: {
    resolvedAt: timestamp,
    sinceInclusive: "2026-10-01T00:00:00.000Z",
    timezone: "UTC",
    untilExclusive: timestamp,
  },
});

const requiredAdapter = (
  adapters: readonly OperationAdapter[],
  kind: "configure" | "export"
): OperationAdapter => {
  const adapter = adapters.find((item) => item.descriptor.kind === kind);

  if (adapter === undefined) {
    throw new Error(`Missing ${kind} adapter`);
  }

  return adapter;
};

const fixtureFor = (
  root: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
): AdapterFixture => {
  const worktree = path.join(root, "repo");
  const source = path.join(root, "packaged-skills");

  mkdirSync(worktree);

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
    repoId: "fixture-app-adapter-repo",
    resolution: "Synthetic app adapter fixture; no live observations",
    sources: ["fixture-source"],
    tools: ["codex"],
    worktreeId: worktree,
  };

  const metadata = [fixtureMetadata(scope)];
  const reads = { metadata: 0 };

  const store = makeFakeAgentStore({
    getBasis: () =>
      Effect.die(
        new Error("Export must not read retained event or price contents")
      ),
    identity: Effect.succeed(fixtureIdentity),
    readBasisMetadata: (handle, maxDecodedBytes) => {
      reads.metadata += 1;
      const [selected] = metadata;

      if (selected === undefined || handle.id !== selected.id) {
        return Effect.succeed({
          decodedBytes: 0,
          factsExamined: 0,
          metadata: null,
        });
      }

      const decodedBytes = Buffer.byteLength(JSON.stringify(selected));

      if (decodedBytes > maxDecodedBytes) {
        return Effect.fail(
          new AgentError({
            code: "budget-exhausted",
            currentRevision: null,
            expectedRevision: null,
            message:
              "Synthetic basis metadata exceeds the selected decoded-byte bound.",
            recovery: { action: "replan", ref: null },
            ref: null,
            retryable: false,
          })
        );
      }

      return Effect.succeed({
        decodedBytes,
        factsExamined: 1,
        metadata: selected,
      });
    },
    readEventPage: () =>
      Effect.die(new Error("App adapters must not scan recorded events")),
  });

  const adapters = makeAppOperationAdapters({
    scope,
    skillsSource: source,
    spawner,
    store,
    worktree,
  });

  return {
    configure: requiredAdapter(adapters, "configure"),
    exportMetadata: requiredAdapter(adapters, "export"),
    metadata,
    reads,
    root,
    scope,
    source,
    spawner,
    store,
    worktree,
  };
};

const withFixture = <A, E>(
  use: (fixture: AdapterFixture) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(
    Effect.gen(function* isolatedFixture() {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() =>
          realpathSync(
            mkdtempSync(
              path.join(
                process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
                "dft-app-adapter-fixture-"
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
  ).pipe(Effect.provide(NodeServices.layer));

const skillFile = (fixture: AdapterFixture, name = "dx-analyze") =>
  path.join(fixture.worktree, ".agents", "skills", name, "SKILL.md");

const guidanceArguments = (fixture: AdapterFixture): OperationArguments => ({
  expectedContentDigest: "current",
  kind: "configure",
  path: path.join(fixture.worktree, ".agents", "skills"),
  settings: { action: "install-guidance", host: "codex" },
});

const exportArguments = (fixture: AdapterFixture): OperationArguments => ({
  basisId: "fixture-selected-basis",
  destination: path.join(fixture.worktree, ".dft", "exports", "selected.json"),
  disclosure: "metadata-only",
  kind: "export",
});

const inputFor = (
  fixture: AdapterFixture,
  args: OperationArguments,
  bounds: OperationBounds = fixtureBounds
): OperationPlanInput => ({
  action: "plan",
  arguments: args,
  bounds,
  purpose: "Verify synthetic local artifact behavior",
  scope: fixture.scope,
  target: fixtureIdentity,
});

const contextFor = Effect.fn("appAdapterTests.context")(function* contextFor(
  bounds: OperationBounds
): Effect.fn.Return<OperationWorkContext, AgentStoreFailure> {
  const budget = yield* createOperationWorkBudget(
    bounds,
    yield* Clock.currentTimeMillis
  );

  return { budget };
});

const prepare = Effect.fn("appAdapterTests.prepare")(function* prepare(
  adapter: OperationAdapter,
  input: OperationPlanInput
) {
  return yield* adapter.prepare(input, yield* contextFor(input.bounds));
});

const validate = Effect.fn("appAdapterTests.validate")(function* validate(
  adapter: OperationAdapter,
  plan: OperationPlan,
  context?: OperationWorkContext
) {
  return yield* adapter.validate(
    plan,
    context ?? (yield* contextFor(plan.bounds))
  );
});

const probe = Effect.fn("appAdapterTests.probe")(function* probe(
  adapter: OperationAdapter,
  plan: OperationPlan,
  step: OperationEffectResult["step"],
  receipt: OperationReceipt,
  context?: OperationWorkContext
) {
  return yield* adapter.probe(
    plan,
    step,
    receipt,
    context ?? (yield* contextFor(plan.bounds))
  );
});

const planFor = Effect.fn("appAdapterTests.plan")(function* planFor(
  fixture: AdapterFixture,
  adapter: OperationAdapter,
  args: OperationArguments,
  bounds: OperationBounds = fixtureBounds
) {
  const input = inputFor(fixture, args, bounds);
  const prepared = yield* prepare(adapter, input);

  const plan: OperationPlan = {
    ...prepared,
    bounds,
    consent: { ...prepared.consent, scopeDigest: "fixture-reviewed-consent" },
    createdAt: timestamp,
    expiresAt: "2026-10-02T12:30:00.000Z",
    id: "fixture-reviewed-plan",
    kind: args.kind,
    planDigest: "fixture-reviewed-plan-digest",
    purpose: input.purpose,
    schemaVersion: "dx.operation.v1",
    scope: input.scope,
    storeGeneration: fixtureIdentity.storeGeneration,
    storeId: fixtureIdentity.storeId,
    validity: "valid",
  };

  return plan;
});

const confirmationFor = (plan: OperationPlan): string =>
  `${plan.kind === "configure" ? "INSTALL CODEX GUIDANCE" : "EXPORT METADATA"} ${plan.consent.scopeDigest}`;

const executeStep = (
  adapter: OperationAdapter,
  plan: OperationPlan,
  work: OperationWorkContext,
  confirmation?: string
) =>
  adapter.execute(
    plan,
    adapter.steps(plan)[0] ?? operationStep("fixture-step"),
    {
      ...work,
      confirmation: confirmation ?? confirmationFor(plan),
      operation: {
        id: "fixture-operation",
        storeGeneration: plan.storeGeneration,
        storeId: plan.storeId,
      },
    }
  );

const execute = Effect.fn("appAdapterTests.execute")(function* execute(
  adapter: OperationAdapter,
  plan: OperationPlan,
  confirmation?: string,
  context?: OperationWorkContext
) {
  const work = context ?? (yield* contextFor(plan.bounds));

  yield* adapter.validate(plan, work);
  yield* adapter.authorize(
    plan,
    {
      action: "apply",
      confirmation: confirmation ?? confirmationFor(plan),
      consentReceiptIds: [],
      expectedDigest: plan.planDigest,
      idempotencyKey: "fixture-operation-key",
      plan,
    },
    work
  );

  return yield* executeStep(adapter, plan, work, confirmation);
});

const receiptFor = (
  plan: OperationPlan,
  result?: OperationEffectResult
): OperationReceipt => ({
  afterRevision: null,
  beforeRevision: fixtureIdentity.revision,
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
    remainingStoreGeneration: plan.storeGeneration,
    removalReason: null,
    removedCount: null,
    removedRefs: [],
  },
  executionState: result === undefined ? "planned" : "succeeded",
  id: "fixture-operation",
  idempotencyKey: "fixture-operation-key",
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
  storeGeneration: plan.storeGeneration,
  storeId: plan.storeId,
  verificationRefs: [],
  verificationState: "not-attempted",
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

const selectedMetadata = (fixture: AdapterFixture): AnalysisBasisMetadata => {
  const [selected] = fixture.metadata;

  if (selected === undefined) {
    throw new Error("Expected selected synthetic metadata");
  }

  return selected;
};

describe("reviewed native Codex guidance operations", () => {
  it.effect(
    "keeps one lazy configure descriptor and routes native guidance and Cursor hook preparation",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* configureAdapterComposition() {
          yield* Effect.sync(() => {
            execFileSync("git", ["init", "--quiet", fixture.worktree], {
              stdio: "ignore",
            });
          });

          const scope: AgentScope = {
            ...fixture.scope,
            repoId: realpathSync(path.join(fixture.worktree, ".git")),
          };

          const calls = {
            hookCommand: 0,
            resolveCursorTarget: 0,
            scope: 0,
            worktree: 0,
          };

          const resolverContexts: OperationWorkContext[] = [];

          const hookCommand = () => {
            calls.hookCommand += 1;

            return "node /fixture/dft-main.js hook";
          };

          const resolveTarget = (
            selectedScope: AgentScope,
            context: OperationWorkContext
          ) =>
            Effect.sync(() => {
              calls.resolveCursorTarget += 1;
              resolverContexts.push(context);
              expect(selectedScope).toEqual(scope);

              return { scope, worktree: fixture.worktree };
            });

          const selectedScope = () => {
            calls.scope += 1;

            return scope;
          };

          const selectedWorktree = () => {
            calls.worktree += 1;

            return fixture.worktree;
          };

          const cursorHooksAdapter = makeCursorHooksAdapter({
            hookCommand,
            resolveTarget,
            scope: selectedScope,
            skillsSource: fixture.source,
            spawner: fixture.spawner,
            store: fixture.store,
            worktree: selectedWorktree,
          });

          const adapters = makeAppOperationAdapters({
            cursorHooksAdapter,
            scope: selectedScope,
            skillsSource: fixture.source,
            spawner: fixture.spawner,
            store: fixture.store,
            worktree: selectedWorktree,
          });

          const configure = requiredAdapter(adapters, "configure");

          expect(calls).toEqual({
            hookCommand: 0,
            resolveCursorTarget: 0,
            scope: 0,
            worktree: 0,
          });
          expect(
            adapters.filter(
              (adapter) => adapter.descriptor.kind === "configure"
            )
          ).toHaveLength(1);
          expect(configure.descriptor.requiredInputs.join(" ")).toContain(
            "install-guidance"
          );
          expect(configure.descriptor.requiredInputs.join(" ")).toContain(
            "install-hooks"
          );

          const nativeContext = yield* contextFor(fixtureBounds);

          const native = yield* configure.prepare(
            { ...inputFor(fixture, guidanceArguments(fixture)), scope },
            nativeContext
          );

          expect(native.arguments).toMatchObject({
            kind: "configure",
            settings: { action: "install-guidance", host: "codex" },
          });
          expect(calls.resolveCursorTarget).toBe(0);
          expect(calls.hookCommand).toBe(0);

          const hooks = path.join(fixture.worktree, ".cursor", "hooks.json");
          const cursorContext = yield* contextFor(fixtureBounds);

          const cursor = yield* configure.prepare(
            {
              ...inputFor(fixture, guidanceArguments(fixture)),
              arguments: {
                expectedContentDigest: "current",
                kind: "configure",
                path: hooks,
                settings: { action: "install-hooks", host: "cursor" },
              },
              scope,
            },
            cursorContext
          );

          expect(cursor.arguments).toMatchObject({
            kind: "configure",
            path: hooks,
            settings: { action: "install-hooks", host: "cursor" },
          });
          expect(cursor.effects.writes).toContain(hooks);
          expect(calls.resolveCursorTarget).toBe(1);
          expect(calls.hookCommand).toBe(1);

          const [resolvedContext] = resolverContexts;

          expect(resolverContexts).toHaveLength(1);
          expect(resolvedContext?.budget).toBe(cursorContext.budget);
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
          expect(existsSync(path.join(fixture.worktree, ".cursor"))).toBe(
            false
          );
        })
      )
  );

  it.effect(
    "discovers both operation descriptors before resolving scope, worktree, store or packaged files",
    () =>
      Effect.sync(() => {
        const calls = { scope: 0, worktree: 0 };

        const adapters = makeAppOperationAdapters({
          scope: () => {
            calls.scope += 1;

            throw new Error(
              "Descriptor discovery must not resolve repository scope"
            );
          },
          skillsSource: "/fixture/dft-app-adapters-unavailable-packaged-files",
          spawner: ChildProcessSpawner.make(() =>
            Effect.die(new Error("Descriptor discovery must not launch Git"))
          ),
          store: makeFakeAgentStore({
            identity: Effect.die(
              new Error("Descriptor discovery must not read store identity")
            ),
          }),
          worktree: () => {
            calls.worktree += 1;

            throw new Error("Descriptor discovery must not inspect a worktree");
          },
        });

        expect(adapters.map((adapter) => adapter.descriptor.kind)).toEqual([
          "configure",
          "export",
        ]);
        expect(adapters.every((adapter) => adapter.descriptor.enabled)).toBe(
          true
        );
        expect(calls).toEqual({ scope: 0, worktree: 0 });
      })
  );

  it.effect(
    "prepares an exact read-only plan and requires its typed consent before writes",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* readOnlyGuidancePlan() {
          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
          expect(plan.arguments).toMatchObject({
            kind: "configure",
            settings: { host: "codex" },
          });
          expect(
            plan.arguments.kind === "configure" &&
              plan.arguments.expectedContentDigest
          ).not.toBe("current");
          expect(plan.preconditions.map((item) => item.target)).toContain(
            skillFile(fixture)
          );
          expect(plan.forecast.requests).toBeNull();
          expect(plan.effects.networkDestinations).toEqual([]);

          yield* expectCode(
            execute(
              fixture.configure,
              plan,
              "INSTALL CODEX GUIDANCE another-scope"
            ),
            "authorization-required"
          );
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
        })
      )
  );

  it.effect(
    "rejects a different worktree, store generation, traversal and linked destination before writes",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* rejectedGuidanceScope() {
          const input = inputFor(fixture, guidanceArguments(fixture));

          yield* expectCode(
            prepare(fixture.configure, {
              ...input,
              scope: { ...fixture.scope, worktreeId: fixture.root },
            }),
            "scope-denied"
          );
          yield* expectCode(
            prepare(fixture.configure, {
              ...input,
              target: { ...fixtureIdentity, storeGeneration: 2 },
            }),
            "stale-generation"
          );
          yield* expectCode(
            prepare(fixture.configure, {
              ...input,
              arguments: {
                ...guidanceArguments(fixture),
                expectedContentDigest: "current",
                kind: "configure",
                path: path.join(fixture.root, "skills"),
                settings: { action: "install-guidance", host: "codex" },
              },
            }),
            "invalid-selector"
          );
          const external = path.join(fixture.root, "external-agents");
          yield* Effect.sync(() => {
            mkdirSync(external);
            symlinkSync(external, path.join(fixture.worktree, ".agents"));
          });
          yield* expectCode(prepare(fixture.configure, input), "scope-denied");
          expect(existsSync(path.join(external, "skills"))).toBe(false);
        })
      )
  );

  it.effect(
    "detects changes to packaged guidance, targets and installer ownership before execution",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* staleGuidanceInputs() {
          const initial = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          yield* execute(fixture.configure, initial);

          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          const sourceFile = path.join(
            fixture.source,
            "dx-analyze",
            "SKILL.md"
          );

          const originalSource = readFileSync(sourceFile, "utf-8");
          yield* Effect.sync(() => {
            appendFileSync(sourceFile, "source changed\n");
          });
          expect(yield* validate(fixture.configure, plan)).toContain(
            "packaged-guidance"
          );
          yield* expectCode(execute(fixture.configure, plan), "plan-stale");
          yield* Effect.sync(() => {
            writeFileSync(sourceFile, originalSource);
          });
          const target = skillFile(fixture);
          const originalTarget = readFileSync(target, "utf-8");
          yield* Effect.sync(() => {
            appendFileSync(target, "user edit\n");
          });
          expect(yield* validate(fixture.configure, plan)).toContain(
            "selected-content"
          );
          yield* Effect.sync(() => {
            writeFileSync(target, originalTarget);
          });

          const ownership = path.join(
            fixture.worktree,
            ".agents",
            "dft-install.ownership.json"
          );

          yield* Effect.sync(() => {
            appendFileSync(ownership, "\n");
          });
          expect(yield* validate(fixture.configure, plan)).toContain(ownership);
          yield* expectCode(execute(fixture.configure, plan), "plan-stale");
          expect(readFileSync(target, "utf-8")).toBe(originalTarget);
        })
      )
  );

  it.effect(
    "rejects oversized serialized ownership before changing an owned skill or creating its backup",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* ownershipAdmissionBeforeWrites() {
          const initial = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          yield* execute(fixture.configure, initial);

          const target = skillFile(fixture);
          const previous = readFileSync(target, "utf-8");

          const ownershipFile = path.join(
            fixture.worktree,
            ".agents",
            "dft-install.ownership.json"
          );

          const ownership = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
          )(readFileSync(ownershipFile, "utf-8"));

          let detail: typeof Schema.Json.Type = "Synthetic nested hook detail";

          for (let depth = 0; depth < 200; depth += 1) {
            detail = [detail];
          }

          const expandedOwnership = {
            ...ownership,
            hooks: { stop: [{ command: "fixture-preserved-hook", detail }] },
          };

          const compactOwnership = `${JSON.stringify(expandedOwnership)}\n`;
          const formattedOwnership = `${JSON.stringify(expandedOwnership, null, 2)}\n`;
          const bounds = { ...fixtureBounds, maxBytes: 16_384 };

          const oldBackup = path.join(
            fixture.worktree,
            ".agents",
            "backups",
            `${skillDigest(target).slice(0, 16)}-${skillDigest(previous)}.backup`
          );

          expect(Buffer.byteLength(compactOwnership)).toBeLessThan(
            bounds.maxBytes
          );
          expect(Buffer.byteLength(formattedOwnership)).toBeGreaterThan(
            bounds.maxBytes
          );

          yield* Effect.sync(() => {
            writeFileSync(ownershipFile, compactOwnership);
            writeFileSync(
              path.join(fixture.source, "dx-analyze", "SKILL.md"),
              "# synthetic admission fixture v2\n"
            );
          });

          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture),
            bounds
          );

          const ownershipDigest = skillDigest(readFileSync(ownershipFile));
          const previousDigest = skillDigest(readFileSync(target));

          expect(existsSync(oldBackup)).toBe(false);

          yield* expectCode(
            execute(fixture.configure, plan),
            "budget-exhausted"
          );

          expect(skillDigest(readFileSync(target))).toBe(previousDigest);
          expect(skillDigest(readFileSync(ownershipFile))).toBe(
            ownershipDigest
          );
          expect(existsSync(oldBackup)).toBe(false);
        })
      )
  );

  it.effect(
    "upgrades owned guidance without inspecting an unreviewed oversized backup for the new body",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* upgradeWithUnreviewedBackup() {
          const initial = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          yield* execute(fixture.configure, initial);

          const target = skillFile(fixture);
          const previous = readFileSync(target, "utf-8");
          const replacement = "# synthetic native guidance fixture v2\n";
          const backups = path.join(fixture.worktree, ".agents", "backups");
          const targetKey = skillDigest(target).slice(0, 16);

          const oldBackup = path.join(
            backups,
            `${targetKey}-${skillDigest(previous)}.backup`
          );

          const unrelatedBackup = path.join(
            backups,
            `${targetKey}-${skillDigest(replacement)}.backup`
          );

          const unrelatedBody = Buffer.alloc(2_097_152, "x");

          expect(unrelatedBody.byteLength).toBeGreaterThan(
            fixtureBounds.maxBytes
          );

          yield* Effect.sync(() => {
            writeFileSync(
              path.join(fixture.source, "dx-analyze", "SKILL.md"),
              replacement
            );
            mkdirSync(backups, { recursive: true });
            writeFileSync(unrelatedBackup, unrelatedBody);
          });

          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          expect(
            plan.preconditions.map((condition) => condition.target)
          ).toContain(oldBackup);
          expect(
            plan.preconditions.map((condition) => condition.target)
          ).not.toContain(unrelatedBackup);
          expect(plan.effects.reads).not.toContain(unrelatedBackup);
          expect(plan.effects.writes).not.toContain(unrelatedBackup);

          const result = yield* execute(fixture.configure, plan);

          const oldArtifact = result.effects?.backupArtifacts.find(
            (artifact) => artifact.id === oldBackup
          );

          expect(result.step.state).toBe("committed");
          expect(readFileSync(target, "utf-8")).toBe(replacement);
          expect(readFileSync(oldBackup, "utf-8")).toBe(previous);
          expect(oldArtifact).toMatchObject({
            contentDigest: skillDigest(previous),
            id: oldBackup,
            storeGeneration: fixtureIdentity.storeGeneration,
            storeId: fixtureIdentity.storeId,
          });
          expect(result.effects?.backupIds).toContain(oldBackup);
          expect(result.effects?.backupIds).not.toContain(unrelatedBackup);
          expect(readFileSync(unrelatedBackup).equals(unrelatedBody)).toBe(
            true
          );
        })
      )
  );

  it.effect(
    "preserves edited and unrelated guidance while backing up an owned upgrade with exact receipts",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* preserveGuidanceAndBackups() {
          const initial = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          yield* execute(fixture.configure, initial);
          const edited = skillFile(fixture);
          const upgraded = skillFile(fixture, "dx-explain");
          const oldUpgrade = readFileSync(upgraded, "utf-8");

          const unrelated = path.join(
            fixture.worktree,
            ".agents",
            "skills",
            "my-skill",
            "SKILL.md"
          );

          yield* Effect.sync(() => {
            writeFileSync(edited, "# my edited guidance\n");
            mkdirSync(path.dirname(unrelated), { recursive: true });
            writeFileSync(unrelated, "# my unrelated skill\n");
            writeFileSync(
              path.join(fixture.source, "dx-explain", "SKILL.md"),
              "# synthetic explain fixture v2\n"
            );
          });

          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          const result = yield* execute(fixture.configure, plan);

          expect(readFileSync(edited, "utf-8")).toBe("# my edited guidance\n");
          expect(readFileSync(unrelated, "utf-8")).toBe(
            "# my unrelated skill\n"
          );
          expect(readFileSync(upgraded, "utf-8")).toBe(
            "# synthetic explain fixture v2\n"
          );
          expect(result.step.state).toBe("partial");
          expect(result.step.gaps.length).toBeGreaterThan(0);
          expect(result.effects?.filesChanged).toContain(upgraded);
          expect(result.effects?.filesChanged).not.toContain(edited);
          expect(result.effects?.filesChanged).not.toContain(unrelated);
          expect(result.effects?.configDigest).toEqual(expect.any(String));

          const backup = result.effects?.backupArtifacts.find(
            (item) => item.contentDigest === skillDigest(oldUpgrade)
          );

          expect(backup).toBeDefined();

          if (backup !== undefined) {
            expect(readFileSync(backup.id, "utf-8")).toBe(oldUpgrade);
            expect(backup).toMatchObject({
              storeGeneration: 1,
              storeId: fixtureIdentity.storeId,
            });
          }

          expect(result.resources?.requests).toBe(1);
          expect(result.resources?.bytesRead).toBeGreaterThan(0);
        })
      )
  );

  it.effect(
    "recognizes pristine and receipt-verified guidance states but treats external edits as indeterminate",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* probeGuidanceStates() {
          const initial = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          yield* execute(fixture.configure, initial);

          const previous = readFileSync(skillFile(fixture), "utf-8");

          yield* Effect.sync(() => {
            writeFileSync(
              path.join(fixture.source, "dx-analyze", "SKILL.md"),
              "# synthetic replay fixture v2\n"
            );
          });

          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          const step =
            fixture.configure.steps(plan)[0] ?? operationStep("fixture-step");

          expect(
            (yield* probe(fixture.configure, plan, step, receiptFor(plan)))
              .state
          ).toBe("absent");
          const result = yield* execute(fixture.configure, plan);
          const receipt = receiptFor(plan, result);

          expect(
            (yield* probe(fixture.configure, plan, step, {
              ...receipt,
              planId: "fixture-foreign-plan",
            })).state
          ).toBe("indeterminate");

          const requiredBackup = receipt.effects.backupArtifacts.find(
            (artifact) => artifact.contentDigest === skillDigest(previous)
          );

          if (requiredBackup === undefined) {
            throw new Error(
              "Expected the reviewed prior guidance backup in the completed receipt"
            );
          }

          const missingBackupReceipt: OperationReceipt = {
            ...receipt,
            effects: {
              ...receipt.effects,
              backupArtifacts: receipt.effects.backupArtifacts.filter(
                (artifact) => artifact.id !== requiredBackup.id
              ),
              backupIds: receipt.effects.backupIds.filter(
                (id) => id !== requiredBackup.id
              ),
            },
          };

          expect(
            (yield* probe(fixture.configure, plan, step, missingBackupReceipt))
              .state
          ).toBe("indeterminate");
          expect(
            (yield* probe(fixture.configure, plan, step, receipt)).state
          ).toBe("complete");
          expect(
            (yield* probe(fixture.configure, plan, step, receiptFor(plan)))
              .state
          ).toBe("indeterminate");
          yield* Effect.sync(() => {
            appendFileSync(skillFile(fixture), "external edit\n");
          });
          expect(
            (yield* probe(fixture.configure, plan, step, receipt)).state
          ).toBe("indeterminate");
          yield* expectCode(
            probe(
              fixture.configure,
              { ...plan, storeGeneration: 2 },
              step,
              receipt
            ),
            "stale-generation"
          );
        })
      )
  );

  it.effect(
    "rejects a backup created after review before upgrading owned guidance",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* staleGuidanceBackup() {
          const initial = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          yield* execute(fixture.configure, initial);

          const target = skillFile(fixture);
          const previous = readFileSync(target, "utf-8");

          yield* Effect.sync(() => {
            writeFileSync(
              path.join(fixture.source, "dx-analyze", "SKILL.md"),
              "# synthetic fixture v2\n"
            );
          });

          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          const backup = plan.preconditions.find(
            (condition) =>
              condition.kind === "selected-content" &&
              condition.target.includes(`${path.sep}backups${path.sep}`) &&
              condition.expected === "absent"
          );

          if (backup === undefined) {
            throw new Error(
              "Expected an explicitly reviewed absent guidance backup"
            );
          }

          yield* Effect.sync(() => {
            mkdirSync(path.dirname(backup.target), { recursive: true });
            writeFileSync(backup.target, "concurrent backup artifact\n");
          });

          yield* expectCode(validate(fixture.configure, plan), "plan-stale");
          yield* expectCode(execute(fixture.configure, plan), "plan-stale");
          expect(readFileSync(target, "utf-8")).toBe(previous);
          expect(readFileSync(backup.target, "utf-8")).toBe(
            "concurrent backup artifact\n"
          );
        })
      )
  );

  it.effect(
    "stops growing packaged guidance at its byte bound before creating target or ownership files",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* boundedGuidanceWrites() {
          const bounds = { ...fixtureBounds, maxBytes: 16_384 };

          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture),
            bounds
          );

          yield* Effect.sync(() => {
            writeFileSync(
              path.join(fixture.source, "dx-analyze", "SKILL.md"),
              "x".repeat(32_768)
            );
          });
          yield* expectCode(
            execute(fixture.configure, plan),
            "budget-exhausted"
          );
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
        })
      )
  );
});

describe("native guidance command bounds", () => {
  it.effect(
    "refuses native work at zero quota without invoking the spawner",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* noNativeRequests() {
          const plan = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          const calls = { count: 0 };

          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* observedNativeSpawn() {
              calls.count += 1;

              return yield* fixture.spawner.spawn(command);
            })
          );

          const adapter = requiredAdapter(
            makeAppOperationAdapters({
              scope: fixture.scope,
              skillsSource: fixture.source,
              spawner,
              store: fixture.store,
              worktree: fixture.worktree,
            }),
            "configure"
          );

          const bounds = { ...fixtureBounds, maxRequests: 0 };
          const reviewed = { ...plan, bounds };
          const context = yield* contextFor(bounds);

          yield* expectCode(
            adapter.prepare(
              inputFor(fixture, guidanceArguments(fixture), bounds),
              context
            ),
            "budget-exhausted"
          );
          yield* expectCode(
            adapter.validate(reviewed, context),
            "budget-exhausted"
          );
          yield* expectCode(
            executeStep(adapter, reviewed, context),
            "budget-exhausted"
          );
          yield* expectCode(
            probe(
              adapter,
              reviewed,
              operationStep("install-codex-guidance"),
              receiptFor(reviewed),
              context
            ),
            "budget-exhausted"
          );
          expect(calls.count).toBe(0);
          expect((yield* context.budget.measurements).requests).toBe(0);
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
        })
      )
  );

  it.effect(
    "counts failed Git invocations and exhausts one shared apply quota",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* cumulativeNativeRequests() {
          const calls = { count: 0 };

          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* countedNativeSpawn() {
              calls.count += 1;

              return yield* fixture.spawner.spawn(command);
            })
          );

          const adapter = requiredAdapter(
            makeAppOperationAdapters({
              scope: fixture.scope,
              skillsSource: fixture.source,
              spawner,
              store: fixture.store,
              worktree: fixture.worktree,
            }),
            "configure"
          );

          const bounds = { ...fixtureBounds, maxRequests: 1 };

          const plan = yield* planFor(
            fixture,
            adapter,
            guidanceArguments(fixture),
            bounds
          );

          expect(calls.count).toBe(1);

          const context = yield* contextFor(bounds);

          expect(yield* validate(adapter, plan, context)).toEqual([]);
          expect(calls.count).toBe(2);
          expect((yield* context.budget.measurements).requests).toBe(1);
          yield* expectCode(
            executeStep(adapter, plan, context),
            "budget-exhausted"
          );
          expect(calls.count).toBe(2);
          expect((yield* context.budget.measurements).requests).toBe(1);
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );

          const accepted = { ...plan, bounds: { ...bounds, maxRequests: 2 } };
          const acceptedContext = yield* contextFor(accepted.bounds);

          const result = yield* execute(
            adapter,
            accepted,
            undefined,
            acceptedContext
          );

          expect(result.step.state).toBe("committed");
          expect(result.resources?.requests).toBe(1);
          expect((yield* acceptedContext.budget.measurements).requests).toBe(2);
          expect(calls.count).toBe(4);
          expect(result.resources?.retries).toBe(0);
        })
      )
  );

  it.effect(
    "settles a failed spawn attempt without exposing platform diagnostics",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* failedNativeAttempt() {
          const calls = { count: 0 };

          const missing = path.join(
            fixture.root,
            "synthetic-private-missing-executable"
          );

          const spawner = ChildProcessSpawner.make(() =>
            Effect.gen(function* failedNativeSpawn() {
              calls.count += 1;

              return yield* fixture.spawner.spawn(
                ChildProcess.make(missing, [], { killSignal: "SIGKILL" })
              );
            })
          );

          const adapter = requiredAdapter(
            makeAppOperationAdapters({
              scope: fixture.scope,
              skillsSource: fixture.source,
              spawner,
              store: fixture.store,
              worktree: fixture.worktree,
            }),
            "configure"
          );

          const bounds = { ...fixtureBounds, maxRequests: 1 };
          const context = yield* contextFor(bounds);

          const failure = yield* expectCode(
            adapter.prepare(
              inputFor(fixture, guidanceArguments(fixture), bounds),
              context
            ),
            "source-unavailable"
          );

          expect(JSON.stringify(failure)).not.toContain(missing);
          expect(calls.count).toBe(1);
          expect((yield* context.budget.measurements).requests).toBe(1);
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
        })
      )
  );

  it.effect(
    "refuses unused legacy plans before resolving or launching native work",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* oldNativeAdapterVersion() {
          const current = yield* planFor(
            fixture,
            fixture.configure,
            guidanceArguments(fixture)
          );

          const calls = { resolve: 0, spawn: 0 };

          const adapter = requiredAdapter(
            makeAppOperationAdapters({
              resolveCurrentTarget: () =>
                Effect.sync(() => {
                  calls.resolve += 1;

                  return { scope: fixture.scope, worktree: fixture.worktree };
                }),
              scope: fixture.scope,
              skillsSource: fixture.source,
              spawner: ChildProcessSpawner.make((command) =>
                Effect.gen(function* legacyNativeSpawn() {
                  calls.spawn += 1;

                  return yield* fixture.spawner.spawn(command);
                })
              ),
              store: fixture.store,
              worktree: fixture.worktree,
            }),
            "configure"
          );

          const legacy = {
            ...current,
            preconditions: current.preconditions.filter(
              (item) => item.kind !== "parser-version"
            ),
          };

          const context = yield* contextFor(legacy.bounds);

          yield* expectCode(adapter.validate(legacy, context), "plan-stale");
          yield* expectCode(
            executeStep(adapter, legacy, context),
            "plan-stale"
          );

          const recovered = yield* probe(
            adapter,
            legacy,
            operationStep("install-codex-guidance"),
            receiptFor(legacy),
            context
          );

          expect(recovered.state).toBe("indeterminate");
          expect(calls).toEqual({ resolve: 0, spawn: 0 });
          expect((yield* context.budget.measurements).requests).toBe(0);
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
        })
      )
  );

  it.effect(
    "reaps a ready owned child that ignored SIGTERM when its query times out",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* ignoredNativeTermination() {
          const ready = yield* Deferred.make<boolean>();
          const ignored = yield* Deferred.make<boolean>();
          const launched = yield* Deferred.make<boolean>();

          const handle = yield* fixture.spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                "process.on('SIGTERM', () => console.log('IGNORED')); console.log('READY'); setInterval(() => {}, 1000)",
              ],
              { killSignal: "SIGKILL", stdin: "ignore" }
            )
          );

          const messages = { text: "" };

          const reader = yield* handle.stdout.pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* readinessMessage() {
                messages.text += new TextDecoder().decode(chunk);

                if (messages.text.includes("READY\n")) {
                  yield* Deferred.succeed(ready, true);
                }

                if (messages.text.includes("IGNORED\n")) {
                  yield* Deferred.succeed(ignored, true);
                }
              })
            ),
            Effect.forkScoped
          );

          yield* Deferred.await(ready);
          yield* Effect.sync(() => {
            process.kill(Number(handle.pid), "SIGTERM");
          });
          yield* Deferred.await(ignored);
          expect(yield* handle.isRunning).toBe(true);

          const calls = { count: 0 };

          const adapter = requiredAdapter(
            makeAppOperationAdapters({
              scope: fixture.scope,
              skillsSource: fixture.source,
              spawner: ChildProcessSpawner.make(() =>
                Effect.gen(function* admittedOwnedChild() {
                  calls.count += 1;
                  yield* Deferred.succeed(launched, true);

                  return {
                    ...handle,
                    stderr: Stream.never,
                    stdout: Stream.never,
                  };
                })
              ),
              store: fixture.store,
              worktree: fixture.worktree,
            }),
            "configure"
          );

          const bounds = {
            ...fixtureBounds,
            maxRequests: 1,
          };

          const context = yield* contextFor(bounds);

          const running = yield* adapter
            .prepare(
              inputFor(fixture, guidanceArguments(fixture), bounds),
              context
            )
            .pipe(Effect.forkScoped);

          yield* Deferred.await(launched);
          yield* TestClock.adjust(bounds.maxElapsedMs);
          yield* expectCode(Fiber.join(running), "budget-exhausted");
          expect(calls.count).toBe(1);
          expect((yield* context.budget.measurements).requests).toBe(1);
          expect(yield* handle.isRunning).toBe(false);
          expect(Exit.isFailure(yield* Effect.exit(handle.exitCode))).toBe(
            true
          );
          expect(() => process.kill(Number(handle.pid), 0)).toThrow();
          yield* Fiber.await(reader);
          expect(existsSync(path.join(fixture.worktree, ".agents"))).toBe(
            false
          );
        })
      )
  );
});

describe("reviewed basis metadata exports", () => {
  it.effect(
    "shares the reviewed record cap across validation and execution before any export write",
    () =>
      Effect.gen(function* cumulativeExportRecordCap() {
        const bounds = { ...fixtureBounds, maxRecords: 1 };

        yield* withFixture((fixture) =>
          Effect.gen(function* standaloneExportWithinCap() {
            const plan = yield* planFor(
              fixture,
              fixture.exportMetadata,
              exportArguments(fixture),
              bounds
            );

            const context = yield* contextFor(bounds);

            const result = yield* executeStep(
              fixture.exportMetadata,
              plan,
              context
            );

            expect(result.step.state).toBe("committed");
            expect((yield* context.budget.measurements).recordsDecoded).toBe(1);
            expect(
              existsSync(
                path.join(fixture.worktree, ".dft", "exports", "selected.json")
              )
            ).toBe(true);
          })
        );

        yield* withFixture((fixture) =>
          Effect.gen(function* cumulativeExportStopsBeforeWrite() {
            const plan = yield* planFor(
              fixture,
              fixture.exportMetadata,
              exportArguments(fixture),
              bounds
            );

            const context = yield* contextFor(bounds);

            expect(
              yield* validate(fixture.exportMetadata, plan, context)
            ).toEqual([]);
            expect((yield* context.budget.measurements).recordsDecoded).toBe(1);
            yield* expectCode(
              executeStep(fixture.exportMetadata, plan, context),
              "budget-exhausted"
            );
            expect(existsSync(path.join(fixture.worktree, ".dft"))).toBe(false);
            expect(fixture.reads.metadata).toBe(2);
          })
        );

        yield* withFixture((fixture) =>
          Effect.gen(function* planningHonorsRemainingRecordCap() {
            const context = yield* contextFor(bounds);

            yield* context.budget.charge({
              bytesRead: 0,
              filesRead: 0,
              recordsDecoded: 1,
              requests: 0,
              retries: 0,
            });
            yield* expectCode(
              fixture.exportMetadata.prepare(
                inputFor(fixture, exportArguments(fixture), bounds),
                context
              ),
              "budget-exhausted"
            );
            expect(fixture.reads.metadata).toBe(0);
            expect(existsSync(path.join(fixture.worktree, ".dft"))).toBe(false);
          })
        );
      })
  );

  it.effect(
    "prepares only the selected retained metadata without files, events or price-sheet contents",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* metadataOnlyExport() {
          const plan = yield* planFor(
            fixture,
            fixture.exportMetadata,
            exportArguments(fixture)
          );

          expect(fixture.reads.metadata).toBe(1);
          expect(existsSync(path.join(fixture.worktree, ".dft"))).toBe(false);
          expect(plan.effects.reads).toContain("fixture-selected-basis");
          expect(plan.effects.networkDestinations).toEqual([]);
          const result = yield* execute(fixture.exportMetadata, plan);

          const destination = path.join(
            fixture.worktree,
            ".dft",
            "exports",
            "selected.json"
          );

          const body = readFileSync(destination, "utf-8");

          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Json)
          )(body);

          expect(decoded).toMatchObject({
            basis: {
              id: "fixture-selected-basis",
              originMix: [{ count: 3, origin: "fixture" }],
              retainedEventCount: 3,
            },
            disclosure: "metadata-only",
            schemaVersion: "dft.basis-export.v1",
          });
          expect(body).not.toContain("retainedEvents");
          expect(body).not.toContain("interpretationInputs");
          expect(body).not.toContain('"content":');
          expect(result.effects?.exportArtifacts).toEqual([
            {
              basisId: "fixture-selected-basis",
              contentDigest: skillDigest(body),
              destination,
              disclosure: "metadata-only",
            },
          ]);
          expect(result.effects?.filesChanged).toEqual([destination]);
        })
      )
  );

  it.effect(
    "backs up the reviewed destination before replacing it and verifies exact replay including backup contents",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* exportBackupAndProbe() {
          const destination = path.join(
            fixture.worktree,
            ".dft",
            "exports",
            "selected.json"
          );

          const previous = "previous user export\n";
          yield* Effect.sync(() => {
            mkdirSync(path.dirname(destination), { recursive: true });
            writeFileSync(destination, previous);
          });

          const plan = yield* planFor(
            fixture,
            fixture.exportMetadata,
            exportArguments(fixture)
          );

          const step = operationStep("fixture-step");
          expect(
            (yield* probe(fixture.exportMetadata, plan, step, receiptFor(plan)))
              .state
          ).toBe("absent");
          const result = yield* execute(fixture.exportMetadata, plan);
          const backup = result.effects?.backupArtifacts[0];
          expect(backup).toBeDefined();

          if (backup !== undefined) {
            expect(readFileSync(backup.id, "utf-8")).toBe(previous);
            expect(backup.contentDigest).toBe(skillDigest(previous));
            expect(
              (yield* probe(
                fixture.exportMetadata,
                plan,
                step,
                receiptFor(plan, result)
              )).state
            ).toBe("complete");
            yield* Effect.sync(() => {
              writeFileSync(backup.id, "altered backup\n");
            });
            expect(
              (yield* probe(
                fixture.exportMetadata,
                plan,
                step,
                receiptFor(plan, result)
              )).state
            ).toBe("indeterminate");
          }

          yield* Effect.sync(() => {
            writeFileSync(destination, "altered export\n");
          });
          expect(
            (yield* probe(
              fixture.exportMetadata,
              plan,
              step,
              receiptFor(plan, result)
            )).state
          ).toBe("indeterminate");
          yield* expectCode(
            probe(
              fixture.exportMetadata,
              { ...plan, storeGeneration: 2 },
              step,
              receiptFor(plan, result)
            ),
            "stale-generation"
          );
        })
      )
  );

  it.effect(
    "rejects changed basis metadata and destination contents before replacing anything",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* staleExportInputs() {
          const plan = yield* planFor(
            fixture,
            fixture.exportMetadata,
            exportArguments(fixture)
          );

          const selected = selectedMetadata(fixture);

          fixture.metadata[0] = {
            ...selected,
            configDigest: "fixture-config-v2",
          };
          expect(yield* validate(fixture.exportMetadata, plan)).toContain(
            "basis-metadata"
          );
          yield* expectCode(
            execute(fixture.exportMetadata, plan),
            "plan-stale"
          );
          expect(existsSync(path.join(fixture.worktree, ".dft"))).toBe(false);
          fixture.metadata[0] = selected;

          const destination = path.join(
            fixture.worktree,
            ".dft",
            "exports",
            "selected.json"
          );

          yield* Effect.sync(() => {
            mkdirSync(path.dirname(destination), { recursive: true });
            writeFileSync(destination, "a concurrent user export\n");
          });
          expect(yield* validate(fixture.exportMetadata, plan)).toContain(
            destination
          );
          yield* expectCode(
            execute(fixture.exportMetadata, plan),
            "plan-stale"
          );
          expect(readFileSync(destination, "utf-8")).toBe(
            "a concurrent user export\n"
          );
        })
      )
  );

  it.effect(
    "rejects traversal, linked outputs and a retained basis from another scope",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* rejectedExportScope() {
          const input = inputFor(fixture, exportArguments(fixture));
          yield* expectCode(
            prepare(fixture.exportMetadata, {
              ...input,
              arguments: {
                basisId: "fixture-selected-basis",
                destination: path.join(fixture.root, "selected.json"),
                disclosure: "metadata-only",
                kind: "export",
              },
            }),
            "scope-denied"
          );
          const selected = selectedMetadata(fixture);

          fixture.metadata[0] = {
            ...selected,
            scope: { ...fixture.scope, repoId: "another-fixture-repo" },
          };
          yield* expectCode(
            prepare(fixture.exportMetadata, input),
            "scope-denied"
          );
          fixture.metadata[0] = selected;
          const external = path.join(fixture.root, "external-export.json");

          const destination = path.join(
            fixture.worktree,
            ".dft",
            "exports",
            "selected.json"
          );

          yield* Effect.sync(() => {
            mkdirSync(path.dirname(destination), { recursive: true });
            writeFileSync(external, "preserve this external file\n");
            symlinkSync(external, destination);
          });
          yield* expectCode(
            prepare(fixture.exportMetadata, input),
            "scope-denied"
          );
          expect(readFileSync(external, "utf-8")).toBe(
            "preserve this external file\n"
          );
        })
      )
  );

  it.effect(
    "rejects metadata and output that cannot fit the reviewed byte or record bounds without writes",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* boundedExportWrites() {
          yield* expectCode(
            prepare(
              fixture.exportMetadata,
              inputFor(fixture, exportArguments(fixture), {
                ...fixtureBounds,
                maxBytes: 64,
              })
            ),
            "budget-exhausted"
          );
          yield* expectCode(
            prepare(
              fixture.exportMetadata,
              inputFor(fixture, exportArguments(fixture), {
                ...fixtureBounds,
                maxRecords: 0,
              })
            ),
            "budget-exhausted"
          );
          expect(existsSync(path.join(fixture.worktree, ".dft"))).toBe(false);
        })
      )
  );
});
