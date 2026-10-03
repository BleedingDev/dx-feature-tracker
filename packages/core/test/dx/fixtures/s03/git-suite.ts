import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import type { AgentScope } from "../../../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
  OperationReceipt,
} from "../../../../src/dx/model/agent-operation.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FlightContext,
} from "../../../../src/dx/model/event.js";
import type {
  BoundedGitEnrollmentRequest,
  BoundedGitOperationOptions,
  BoundedGitSelectionRequest,
} from "../../../../src/dx/operations/git.js";
import type {
  OperationAdapter,
  OperationApplyInput,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type { PlannedSource } from "../../../../src/dx/registry/sync.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";
import type {
  GitOperationFixture,
  GitOperationScript,
} from "./git-operation-fixture.js";

interface GitSuiteFixture {
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
  readonly makeBoundedGitOperationAdapter: (
    options: BoundedGitOperationOptions
  ) => OperationAdapter;
  readonly makeGitOperationFixture: (
    scripts: readonly GitOperationScript[]
  ) => Effect.Effect<GitOperationFixture>;
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

const SOURCE = "collector.git-observation";

const BRANCH = "fixture-main";

const HEAD = "a".repeat(40);

const DEFAULT_BOUNDS: Partial<OperationBounds> = {
  maxBytes: 100_000,
  maxFiles: 100,
  maxRecords: 100_000,
  maxRequests: 100,
};

const prefix = (worktree: string): readonly string[] => [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.quotepath=off",
  "-c",
  "diff.external=",
  "-c",
  "core.fsmonitor=false",
  "-C",
  worktree,
];

const script = (
  worktree: string,
  args: readonly string[],
  stdout: readonly string[],
  overrides: Partial<GitOperationScript> = {}
): GitOperationScript => ({
  args: [...prefix(worktree), ...args],
  stdout,
  ...overrides,
});

const located = (worktree: string): string => `${worktree}\n${worktree}/.git\n`;

const status = (head = HEAD): string =>
  `# branch.oid ${head}\0# branch.head ${BRANCH}\0`;

const pinScripts = (
  worktree: string,
  head = HEAD,
  refLimit = 200
): readonly [GitOperationScript, ...GitOperationScript[]] => [
  script(
    worktree,
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    [located(worktree)]
  ),
  script(worktree, ["rev-parse", "--verify", "HEAD"], [`${head}\n`]),
  script(
    worktree,
    [
      "for-each-ref",
      `--count=${refLimit}`,
      "--format=%(refname)%09%(objectname)",
      "refs/heads/",
      "refs/remotes/",
    ],
    [`refs/heads/${BRANCH}\t${head}\n`]
  ),
  script(
    worktree,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    [status(head)]
  ),
  script(
    worktree,
    ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "HEAD", "--"],
    []
  ),
];

const observationScripts = (
  worktree: string
): readonly GitOperationScript[] => [
  script(worktree, ["version"], ["git version 2.50.0.fixture\n"]),
  script(
    worktree,
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    [located(worktree)]
  ),
  script(
    worktree,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    [status()]
  ),
  script(
    worktree,
    ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--numstat", "-z"],
    []
  ),
  script(
    worktree,
    [
      "log",
      "--max-count=500",
      "--no-ext-diff",
      "--no-textconv",
      "--no-show-signature",
      "-g",
      "--date=iso-strict",
      "--format=%H%x1f%gd%x1f%gs",
      `refs/heads/${BRANCH}`,
      "--",
    ],
    []
  ),
  script(
    worktree,
    [
      "log",
      "--max-count=2001",
      "--no-ext-diff",
      "--no-textconv",
      "--no-show-signature",
      "-g",
      "--date=iso-strict",
      "--format=%gd%x1f%gs",
      "HEAD",
      "--",
    ],
    []
  ),
  script(
    worktree,
    [
      "for-each-ref",
      "--count=200",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    [`refs/heads/${BRANCH}\n`]
  ),
  script(worktree, ["remote"], []),
];

const scriptBytes = (scripts: readonly GitOperationScript[]): number =>
  scripts.reduce(
    (total, entry) =>
      total +
      entry.stdout.reduce(
        (bytes, chunk) => bytes + new TextEncoder().encode(chunk).byteLength,
        0
      ),
    0
  );

const selectedGit = Effect.fn("S03.selectedGit")(function* selectedGit(
  fixture: GitSuiteFixture,
  opened: OpenedEventStore,
  worktree: string,
  scripts: readonly GitOperationScript[],
  contextOverrides: Partial<FlightContext> = {}
) {
  const process = yield* fixture.makeGitOperationFixture(scripts);

  const scope: AgentScope = {
    ...fixture.fixtureScope,
    repoId: `${worktree}/.git`,
    sources: [SOURCE],
    tools: [],
    worktreeId: worktree,
  };

  const args: OperationArguments = {
    allowSourceGrowth: false,
    cursor: null,
    inputRefs: [],
    kind: "collect",
    parserVersion: "dx.bounded-git.v1",
    selectedRoots: [worktree],
    source: SOURCE,
  };

  const context: FlightContext = {
    branch: BRANCH,
    flightId: null,
    headSha: HEAD,
    repoCommonDir: `${worktree}/.git`,
    worktreePath: worktree,
    ...contextOverrides,
  };

  const source: PlannedSource = {
    context,
    harness: null,
    input: worktree,
    ref: null,
    source: SOURCE,
    unavailable: null,
  };

  const selections: BoundedGitSelectionRequest[] = [];
  const enrollments: BoundedGitEnrollmentRequest[] = [];

  const sameScope = (candidate: AgentScope): boolean =>
    JSON.stringify(candidate) === JSON.stringify(scope);

  const adapter = fixture.makeBoundedGitOperationAdapter({
    enrollment: (request) =>
      Effect.sync(() => {
        enrollments.push(request);

        return sameScope(request.scope) && request.receiptIds.length === 0
          ? {
              reason:
                "Synthetic Git fixture enrollment for the exact selected scope",
              receiptIds: [],
              state: "authorized",
            }
          : {
              reason:
                "The synthetic enrollment does not authorize this scope or receipt reference",
              receiptIds: [],
              state: "denied",
            };
      }),
    env: {
      store: {
        ...opened.service,
        append: (batch) =>
          opened.service.append({
            ...batch,
            events: batch.events.map((event): DxEventEnvelope => ({
              ...event,
              origin: "fixture",
            })),
          }),
      },
      storePath: opened.service.storePath ?? `${worktree}/fixture.sqlite`,
    },
    selected: (request) =>
      Effect.sync(() => {
        selections.push(request);

        return sameScope(request.scope) ? [source] : [];
      }),
    spawner: process.spawner,
  });

  const service = yield* fixture.makeOperationService(opened.agentService, [
    adapter,
  ]);

  return { args, enrollments, process, scope, selections, service };
});

const storedEvents = (opened: OpenedEventStore) =>
  opened.service.snapshot({
    branch: null,
    flightId: null,
    from: null,
    repoCommonDir: null,
    to: null,
  });

export const registerGitOperationTests = (fixture: GitSuiteFixture): void => {
  describe("S03 bounded Git operations", () => {
    it.effect(
      "pins the selected Git scope read-only and a durable retry starts no child",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* boundedGitRetry() {
            const pin = pinScripts(root);

            const selected = yield* selectedGit(fixture, opened, root, [
              ...pin,
              ...pin,
              ...pin,
              ...observationScripts(root),
              ...pin,
            ]);

            const plan = yield* fixture.createPlan(
              selected.service,
              opened,
              selected.args,
              selected.scope,
              DEFAULT_BOUNDS
            );

            expect(selected.process.observations).toHaveLength(5);
            expect((yield* storedEvents(opened)).events).toHaveLength(0);
            expect(plan.effects.reads).toEqual([root]);
            expect(plan.effects.networkDestinations).toEqual([]);
            expect(plan.effects.destructive).toBe(false);

            const denied = yield* selected.service
              .run({
                ...fixture.applyInput(plan, "fixture.s03.git.retry"),
                consentReceiptIds: ["fixture.s03.unrelated-consent"],
              })
              .pipe(Effect.flip);

            expect(denied).toMatchObject({ code: "authorization-required" });
            expect(selected.process.observations).toHaveLength(5);

            const applied = yield* fixture.applyReceipt(
              selected.service,
              fixture.applyInput(plan, "fixture.s03.git.retry")
            );

            const count = selected.process.observations.length;

            const retried = yield* fixture.applyReceipt(
              selected.service,
              fixture.applyInput(plan, "fixture.s03.git.retry")
            );

            const snapshot = yield* storedEvents(opened);

            expect(applied.receipt.steps).toMatchObject([
              { inserted: 1, rejected: null, state: "partial" },
            ]);
            expect(applied.receipt.steps[0]?.safeCursor).toBeNull();
            expect(applied.receipt.steps[0]?.remainingWork).toMatch(
              /capped|bounded/u
            );
            expect(applied.receipt.resources.bytesRead).toBe(
              selected.process.observations
                .slice(5)
                .reduce(
                  (total, observation) => total + observation.stdoutBytes,
                  0
                )
            );
            expect(applied.receipt.resources.recordsDecoded).toBeNull();
            expect(applied.receipt.resources.requests).toBe(count - 5);
            expect(retried.reused).toBe(true);
            expect(retried.receipt.id).toBe(applied.receipt.id);
            expect(retried.receipt.effects).toEqual(applied.receipt.effects);
            expect(retried.receipt.steps).toEqual(applied.receipt.steps);
            expect(retried.receipt.resources).toEqual(
              applied.receipt.resources
            );
            expect(selected.process.observations).toHaveLength(count);
            expect(snapshot.events).toHaveLength(1);
            expect(snapshot.events[0]?.origin).toBe("fixture");
            expect(snapshot.events[0]?.sourceVersion).toBe("2.50.0.fixture");
            expect(snapshot.events[0]?.context).toMatchObject({
              branch: BRANCH,
              headSha: HEAD,
              repoCommonDir: `${root}/.git`,
              worktreePath: root,
            });
            expect(
              selected.selections.every(
                (request) =>
                  JSON.stringify(request.scope) ===
                  JSON.stringify(selected.scope)
              )
            ).toBe(true);
            expect(
              selected.enrollments.every(
                (request) =>
                  JSON.stringify(request.scope) ===
                  JSON.stringify(selected.scope)
              )
            ).toBe(true);
            expect(
              selected.process.observations.every(
                (observation) =>
                  observation.finalized &&
                  observation.exitObserved &&
                  !observation.killed
              )
            ).toBe(true);
            yield* selected.process.assertComplete;
          })
        )
    );

    it.effect("rejects changed HEAD before Git evidence collection", () =>
      fixture.withFixtureStore((opened, root) =>
        Effect.gen(function* changedGitHead() {
          const selected = yield* selectedGit(fixture, opened, root, [
            ...pinScripts(root),
            ...pinScripts(root, "b".repeat(40)),
          ]);

          const plan = yield* fixture.createPlan(
            selected.service,
            opened,
            selected.args,
            selected.scope,
            DEFAULT_BOUNDS
          );

          const output = yield* fixture.applyReceipt(
            selected.service,
            fixture.applyInput(plan, "fixture.s03.git.changed-head")
          );

          expect(output.receipt.executionState).toBe("rejected");
          expect(output.receipt.recovery).toBe("replan");
          expect(output.receipt.steps).toMatchObject([
            { inserted: 0, state: "rejected" },
          ]);
          expect(selected.process.observations).toHaveLength(10);
          expect((yield* storedEvents(opened)).events).toHaveLength(0);
          yield* selected.process.assertComplete;
        })
      )
    );

    for (const limit of ["maxBytes", "maxRecords"] as const) {
      it.effect(
        `stops Git stdout at the cumulative ${limit} limit before importing a batch`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* cumulativeGitLimit() {
              const pin = pinScripts(root);
              const [first] = pin;

              const allowance = scriptBytes(pin) + scriptBytes([first]) + 1;
              const precedingRefBytes = scriptBytes(pin.slice(0, 2));

              const refLimit =
                limit === "maxRecords"
                  ? Math.min(200, allowance - precedingRefBytes)
                  : 200;

              const boundedPin = pinScripts(root, HEAD, refLimit);

              const selected = yield* selectedGit(fixture, opened, root, [
                ...boundedPin,
                ...boundedPin,
                first,
                script(
                  root,
                  ["rev-parse", "--verify", "HEAD"],
                  ["a", "b", "fixture-output-that-must-never-be-pulled"]
                ),
              ]);

              const plan = yield* fixture.createPlan(
                selected.service,
                opened,
                selected.args,
                selected.scope,
                { ...DEFAULT_BOUNDS, [limit]: allowance }
              );

              const output = yield* fixture.applyReceipt(
                selected.service,
                fixture.applyInput(plan, `fixture.s03.git.${limit}`)
              );

              const stopped = selected.process.observations.at(-1);

              expect(output.receipt.recovery).toBe("replan");
              expect(output.receipt.steps).toMatchObject([
                { inserted: 0, state: "rejected" },
              ]);
              expect(output.receipt.resources.bytesRead).toBe(allowance + 1);
              expect(output.receipt.resources.recordsDecoded).toBeNull();
              expect(stopped).toMatchObject({
                exitObserved: false,
                finalized: true,
                killed: true,
                stdoutBytes: 2,
                stdoutChunks: 2,
                stdoutClosed: true,
                stdoutComplete: false,
              });
              expect(stopped?.killCalls).toBe(1);
              expect(selected.process.observations).toHaveLength(12);

              const refs = selected.process.observations.filter((observation) =>
                observation.args.includes("for-each-ref")
              );

              expect(refs).toHaveLength(2);

              for (const observation of refs) {
                const countArgument = observation.args.find((arg) =>
                  arg.startsWith("--count=")
                );

                const count = Number(countArgument?.slice("--count=".length));
                expect(count).toBeGreaterThan(0);
                expect(count).toBeLessThanOrEqual(200);
                expect(count).toBeLessThanOrEqual(
                  plan.bounds.maxRecords - precedingRefBytes
                );
              }

              expect((yield* storedEvents(opened)).events).toHaveLength(0);
              yield* selected.process.assertComplete;
            })
          )
      );
    }

    it.effect(
      "a file allowance stops another Git command before collection",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* gitFileLimit() {
            const pin = pinScripts(root);

            const selected = yield* selectedGit(fixture, opened, root, [
              ...pin,
              ...pin,
              ...pin.slice(0, 2),
            ]);

            const plan = yield* fixture.createPlan(
              selected.service,
              opened,
              selected.args,
              selected.scope,
              { ...DEFAULT_BOUNDS, maxFiles: 7 }
            );

            const output = yield* fixture.applyReceipt(
              selected.service,
              fixture.applyInput(plan, "fixture.s03.git.files")
            );

            expect(output.receipt.recovery).toBe("replan");
            expect(output.receipt.steps).toMatchObject([
              { inserted: 0, state: "rejected" },
            ]);
            expect(output.receipt.resources.requests).toBe(7);
            expect(selected.process.observations).toHaveLength(12);
            expect(
              selected.process.observations.every(
                (observation) =>
                  observation.finalized &&
                  observation.exitObserved &&
                  !observation.killed
              )
            ).toBe(true);
            expect((yield* storedEvents(opened)).events).toHaveLength(0);
            yield* selected.process.assertComplete;
          })
        )
    );

    it.effect(
      "interrupting a running Git child retains the receipt and closes it",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* interruptedGitChild() {
            const entered = yield* Deferred.make<boolean>();

            const wait = Deferred.succeed(entered, true).pipe(
              Effect.andThen(Effect.never)
            );

            const pin = pinScripts(root);
            const executionScope = yield* Scope.make();
            yield* Effect.addFinalizer(() =>
              Scope.close(executionScope, Exit.void)
            );

            const selected = yield* selectedGit(fixture, opened, root, [
              ...pin,
              ...pin,
              ...pin,
              script(root, ["version"], ["fixture-never-pulled"], { wait }),
            ]).pipe(Effect.provideService(Scope.Scope, executionScope));

            const plan = yield* fixture.createPlan(
              selected.service,
              opened,
              selected.args,
              selected.scope,
              DEFAULT_BOUNDS
            );

            const running = yield* Effect.forkChild(
              fixture.applyReceipt(
                selected.service,
                fixture.applyInput(plan, "fixture.s03.git.interrupted")
              )
            );

            yield* Deferred.await(entered);

            const reserved = yield* opened.agentService.reserveOperation(
              plan,
              plan.planDigest,
              "fixture.s03.git.interrupted"
            );

            yield* Scope.close(executionScope, Exit.void);
            yield* Fiber.interrupt(running);

            const receipt = yield* opened.agentService.getOperation(
              reserved.receipt
            );

            const stopped = selected.process.observations.at(-1);

            expect(receipt.executionState).toBe("interrupted");
            expect(receipt.verificationState).toBe("indeterminate");
            expect(receipt.steps).toMatchObject([
              { inserted: 0, state: "running" },
            ]);
            expect(receipt.resources.recordsDecoded).toBeNull();
            expect(receipt.resources.bytesRead).toBe(scriptBytes(pin) * 2);
            expect(receipt.resources.requests).toBe(11);
            expect(stopped).toMatchObject({
              cleanupKills: 1,
              exitObserved: false,
              finalized: true,
              killed: true,
              stdoutBytes: 0,
              stdoutChunks: 0,
              stdoutClosed: true,
              stdoutComplete: false,
            });
            expect((yield* storedEvents(opened)).events).toHaveLength(0);
            yield* selected.process.assertComplete;
          })
        )
    );

    it.effect(
      "a failed Git child preserves unavailable evidence and unknown decoded totals",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* failedGitChild() {
            const pin = pinScripts(root);

            const selected = yield* selectedGit(fixture, opened, root, [
              ...pin,
              ...pin,
              ...pin,
              script(root, ["version"], [], {
                exitCode: 128,
                stderr: ["Synthetic fixture process failure"],
              }),
            ]);

            const plan = yield* fixture.createPlan(
              selected.service,
              opened,
              selected.args,
              selected.scope,
              DEFAULT_BOUNDS
            );

            const output = yield* fixture.applyReceipt(
              selected.service,
              fixture.applyInput(plan, "fixture.s03.git.failed")
            );

            expect(output.receipt.verificationState).toBe("unavailable");
            expect(output.receipt.steps).toMatchObject([
              { inserted: 0, state: "unavailable" },
            ]);
            expect(output.receipt.resources.recordsDecoded).toBeNull();
            expect(output.receipt.resources.bytesRead).toBe(
              scriptBytes(pin) * 2
            );
            expect(selected.process.observations.at(-1)).toMatchObject({
              exitObserved: true,
              finalized: true,
              killed: false,
              stdoutBytes: 0,
            });
            expect((yield* storedEvents(opened)).events).toHaveLength(0);
            yield* selected.process.assertComplete;
          })
        )
    );

    it.effect(
      "unselected roots and widened collection arguments start no child",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* rejectedGitSelectors() {
            const selected = yield* selectedGit(fixture, opened, root, []);

            const outside = yield* fixture
              .createPlan(
                selected.service,
                opened,
                { ...selected.args, selectedRoots: [`${root}/../outside`] },
                selected.scope,
                DEFAULT_BOUNDS
              )
              .pipe(Effect.flip);

            const growth = yield* fixture
              .createPlan(
                selected.service,
                opened,
                { ...selected.args, allowSourceGrowth: true },
                selected.scope,
                DEFAULT_BOUNDS
              )
              .pipe(Effect.flip);

            expect(outside).toMatchObject({ code: "scope-denied" });
            expect(growth).toMatchObject({ code: "invalid-selector" });
            expect(selected.process.observations).toHaveLength(0);
            expect((yield* storedEvents(opened)).events).toHaveLength(0);
            yield* selected.process.assertComplete;
          })
        )
    );

    for (const badLocation of [
      {
        name: "outside worktree",
        output: (root: string) => `${root}/../outside\n${root}/.git\n`,
      },
      {
        name: "outside common directory",
        output: (root: string) => `${root}\n${root}/../outside/.git\n`,
      },
      {
        name: "extra location fields",
        output: (root: string) => `${located(root)}${root}/../outside\n`,
      },
    ]) {
      it.effect(
        `rejects Git's ${badLocation.name} before further acquisition`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* escapedGitWorktree() {
              const selected = yield* selectedGit(fixture, opened, root, [
                script(
                  root,
                  [
                    "rev-parse",
                    "--path-format=absolute",
                    "--show-toplevel",
                    "--git-common-dir",
                  ],
                  [badLocation.output(root)]
                ),
              ]);

              const failure = yield* fixture
                .createPlan(
                  selected.service,
                  opened,
                  selected.args,
                  selected.scope,
                  DEFAULT_BOUNDS
                )
                .pipe(Effect.flip);

              expect(failure).toMatchObject({ code: "scope-denied" });
              expect(selected.process.observations).toHaveLength(1);
              expect((yield* storedEvents(opened)).events).toHaveLength(0);
              yield* selected.process.assertComplete;
            })
          )
      );
    }

    it.effect(
      "a resolved branch outside the approved selection starts no child",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* rejectedGitBranch() {
            const selected = yield* selectedGit(fixture, opened, root, [], {
              branch: "fixture-unselected-branch",
            });

            const failure = yield* fixture
              .createPlan(
                selected.service,
                opened,
                selected.args,
                selected.scope,
                DEFAULT_BOUNDS
              )
              .pipe(Effect.flip);

            expect(failure).toMatchObject({ code: "scope-denied" });
            expect(selected.process.observations).toHaveLength(0);
            expect((yield* storedEvents(opened)).events).toHaveLength(0);
            yield* selected.process.assertComplete;
          })
        )
    );

    for (const escapedPath of ["../outside", "/fixture/s03/outside"]) {
      it.effect(
        `rejects the escaping Git fingerprint path ${escapedPath} before starting its child`,
        () =>
          fixture.withFixtureStore((opened, root) =>
            Effect.gen(function* rejectedGitFingerprint() {
              const pin = pinScripts(root);

              const collection = observationScripts(root)
                .slice(0, 3)
                .map((entry, index) =>
                  index === 2
                    ? { ...entry, stdout: [`${status()}? ${escapedPath}\0`] }
                    : entry
                );

              const selected = yield* selectedGit(fixture, opened, root, [
                ...pin,
                ...pin,
                ...pin,
                ...collection,
              ]);

              const plan = yield* fixture.createPlan(
                selected.service,
                opened,
                selected.args,
                selected.scope,
                DEFAULT_BOUNDS
              );

              const output = yield* fixture.applyReceipt(
                selected.service,
                fixture.applyInput(plan, `fixture.s03.git.path.${escapedPath}`)
              );

              expect(output.receipt.verificationState).toBe("unavailable");
              expect(output.receipt.steps).toMatchObject([
                { inserted: 0, state: "unavailable" },
              ]);
              expect(selected.process.observations).toHaveLength(18);
              expect(
                selected.process.observations.some((observation) =>
                  observation.args.includes("hash-object")
                )
              ).toBe(false);
              expect((yield* storedEvents(opened)).events).toHaveLength(0);
              yield* selected.process.assertComplete;
            })
          )
      );
    }
  });
};
