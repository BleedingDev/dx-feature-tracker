// @effect-diagnostics-next-line nodeBuiltinImport:off -- Agent runtime confines selected imports to explicitly enrolled local roots.
import path from "node:path";

import {
  ACCOUNT_OPERATION_SOURCE,
  ACCOUNT_OPERATION_BOUNDS,
  BOUNDED_GIT_SOURCES,
  BOUNDED_GIT_OPERATION_VERSION,
  BOUNDED_CURSOR_OPERATION_SOURCES,
  BOUNDED_CURSOR_OPERATION_VERSION,
  BOUNDED_CURSOR_HOOK_OPERATION_VERSION,
  CURSOR_HOOK_OPERATION_SOURCE,
  BOUNDED_HOOK_PARSER_VERSION,
  BOUNDED_OPENCODE_OPERATION_VERSION,
  BoundedEventReplacement,
  AgentError,
  AgentStore,
  EventStore,
  DxEventEnvelopeSchema,
  HarnessRegistry,
  HarnessHome,
  HarnessCursors,
  accountOperationArguments,
  accountOperationScope,
  composeCollectionOperationAdapters,
  contextForRepo,
  cursorStateDbPath,
  liveHome,
  makeAdministrationBackend,
  makeLiveOperationAcquisitionExecutor,
  makeDxCapabilities,
  buildRegistry,
  makeExplicitSelectedSourceCatalog,
  makeLiveSelectedSourceCatalog,
  makeLearningService,
  makeBoundedAccountReplacement,
  makeBoundedAccountOperationAdapter,
  makeBoundedGitOperationAdapter,
  makeBoundedGitCommitChecker,
  makeBoundedGitWorktreeLister,
  makeBoundedGitTargetResolver,
  makeBoundedCursorOperationAdapter,
  makeBoundedCursorHookOperationAdapter,
  makeBoundedCursorHookIdentityProbe,
  makeBoundedOpencodeOperationAdapter,
  makeLiveAdministrationAdapters,
  makeOperationService,
  makePlannedSourceOperationAdapter,
  nativeBoundedSnapshotHarness,
  boundedHookSnapshotHarness,
  boundedCompressedSnapshotHarness,
  operationSnapshotEncoding,
} from "@rat-stack/core/dx";
import type {
  AgentScope,
  ExplicitSourceMapping,
  LearningInput,
  LearningOutput,
  LearningServiceApi,
  LiveEngine,
  LiveAcquisitionExecutor,
  OperationAdapter,
  OperationInput,
  OperationOutput,
  OperationServiceApi,
  PlannedSource,
  OperationBounds,
  OperationArguments,
  StoreIdentity,
} from "@rat-stack/core/dx";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { AppOperationAdapters } from "./dft-agent-adapters.js";
import { TrackedSourceEnrollment } from "./dft-agent-enrollment.js";
import { dftInvocation } from "./dft-install.js";

const unavailable = (message: string) =>
  new AgentError({
    code: "view-not-ready",
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "none", ref: null },
    ref: null,
    retryable: false,
  });

export const agentScopeFor = (repo: string): AgentScope => {
  const current = contextForRepo(repo);

  return {
    branchSelection: {
      branches: current.branch === null ? [] : [current.branch],
      kind: current.branch === null ? "unresolved" : "current",
    },
    flightId: current.flightId,
    repoId: current.repoCommonDir,
    resolution: "Resolved once from the configured agent session repository.",
    sources: [],
    tools: [],
    worktreeId: current.worktreePath,
  };
};

const isGuidance = (
  args: Parameters<OperationAdapter["prepare"]>[0]["arguments"]
): boolean =>
  args.kind === "configure" &&
  ["install-guidance", "install-hooks"].includes(args.settings.action ?? "");

const combineConfigure = (
  administration: OperationAdapter,
  guidance: OperationAdapter
): OperationAdapter => {
  const selected = (
    args: Parameters<OperationAdapter["prepare"]>[0]["arguments"]
  ) => (isGuidance(args) ? guidance : administration);

  return {
    authorize: (plan, input, context) =>
      selected(plan.arguments).authorize(plan, input, context),
    descriptor: {
      ...administration.descriptor,
      effects: {
        destructive: false,
        networkDestinations: [],
        reads: [
          ...new Set([
            ...administration.descriptor.effects.reads,
            ...guidance.descriptor.effects.reads,
          ]),
        ],
        writes: [
          ...new Set([
            ...administration.descriptor.effects.writes,
            ...guidance.descriptor.effects.writes,
          ]),
        ],
      },
      requiredInputs: [
        ...new Set([
          ...administration.descriptor.requiredInputs,
          ...guidance.descriptor.requiredInputs,
        ]),
      ],
    },
    execute: (plan, step, execution) =>
      selected(plan.arguments).execute(plan, step, execution),
    meteredWork:
      administration.meteredWork === true && guidance.meteredWork === true,
    prepare: (input, context) =>
      selected(input.arguments).prepare(input, context),
    probe: (plan, step, receipt, context) =>
      selected(plan.arguments).probe(plan, step, receipt, context),
    replay: "probe-required",
    steps: (plan) => selected(plan.arguments).steps(plan),
    unmeasuredValidationResources: ["bytesRead", "recordsDecoded"],
    validate: (plan, context) =>
      selected(plan.arguments).validate(plan, context),
  };
};

export const SELECTED_FILE_SOURCES: readonly ExplicitSourceMapping[] = [
  {
    channel: "session-file",
    harness: "claude-code",
    source: "harness.claude-code",
  },
  { channel: "session-file", harness: "codex", source: "harness.codex" },
  {
    channel: "transcript",
    harness: "cursor",
    source: "collector.cursor-transcripts",
  },
  { channel: "session-file", harness: "deepseek", source: "harness.deepseek" },
  { channel: "session-file", harness: "omp", source: "harness.omp" },
  { channel: "session-file", harness: "pi", source: "harness.pi" },
];

export const SELECTED_FILE_PARSER = "dx.explicit-files.v1";

const SELECTED_HOOK_SOURCES: readonly ExplicitSourceMapping[] = [
  { channel: "hooks", harness: "claude-code", source: "harness.claude-code" },
  { channel: "hooks", harness: "codex", source: "harness.codex" },
  { channel: "extension", harness: "deepseek", source: "harness.deepseek" },
  { channel: "extension", harness: "omp", source: "harness.omp" },
  { channel: "extension", harness: "opencode", source: "harness.opencode" },
  { channel: "extension", harness: "pi", source: "harness.pi" },
];

const SELECTED_DATABASE_SOURCES: readonly ExplicitSourceMapping[] = [
  { channel: "local-db", harness: "opencode", source: "harness.opencode" },
  ...BOUNDED_CURSOR_OPERATION_SOURCES.map((source): ExplicitSourceMapping => ({
    channel: "local-db",
    harness: "cursor",
    source,
  })),
];

const SELECTED_CURSOR_HOOK_SOURCES: readonly ExplicitSourceMapping[] = [
  { channel: "hooks", harness: "cursor", source: CURSOR_HOOK_OPERATION_SOURCE },
];

const SELECTED_SOURCES: readonly ExplicitSourceMapping[] = [
  ...SELECTED_FILE_SOURCES,
  ...SELECTED_HOOK_SOURCES,
  ...SELECTED_DATABASE_SOURCES,
  ...SELECTED_CURSOR_HOOK_SOURCES,
];

const GIT_ACQUISITION_BOUNDS: OperationBounds = {
  maxBytes: 1_048_576,
  maxElapsedMs: 60_000,
  maxFiles: 100,
  maxRecords: 100_000,
  maxRequests: 100,
  maxRetries: 0,
};

const CURSOR_ACQUISITION_BOUNDS: OperationBounds = {
  maxBytes: 67_108_864,
  maxElapsedMs: 60_000,
  maxFiles: 1000,
  maxRecords: 100_000,
  maxRequests: 100,
  maxRetries: 1,
};

const nativeHook = (planned: PlannedSource): boolean =>
  planned.ref !== null &&
  [...SELECTED_HOOK_SOURCES, ...SELECTED_CURSOR_HOOK_SOURCES].some(
    (mapping) =>
      mapping.source === planned.source &&
      mapping.harness === planned.ref?.harness &&
      mapping.channel === planned.ref?.channel
  );

const sourceContext = (request: { readonly scope: AgentScope }) =>
  Schema.decodeEffect(DxEventEnvelopeSchema.fields.context)({
    branch: request.scope.branchSelection.branches[0] ?? null,
    flightId: request.scope.flightId,
    headSha: null,
    repoCommonDir: request.scope.repoId,
    worktreePath: request.scope.worktreeId,
  }).pipe(
    Effect.mapError(
      () =>
        new AgentError({
          code: "scope-denied",
          currentRevision: null,
          expectedRevision: null,
          message: "The selected source scope has invalid domain identifiers.",
          recovery: { action: "replan", ref: null },
          ref: null,
          retryable: false,
        })
    )
  );

const nativeParserVersion = (planned: PlannedSource): string => {
  if (planned.source === CURSOR_HOOK_OPERATION_SOURCE) {
    return BOUNDED_CURSOR_HOOK_OPERATION_VERSION;
  }

  if (nativeHook(planned)) {
    return BOUNDED_HOOK_PARSER_VERSION;
  }

  if (BOUNDED_CURSOR_OPERATION_SOURCES.includes(planned.source)) {
    return BOUNDED_CURSOR_OPERATION_VERSION;
  }

  return planned.ref?.harness === "opencode" &&
    planned.ref.channel === "local-db"
    ? BOUNDED_OPENCODE_OPERATION_VERSION
    : SELECTED_FILE_PARSER;
};

const nativeArguments = (
  planned: PlannedSource,
  identity: StoreIdentity,
  home: string
): Extract<OperationArguments, { readonly kind: "collect" }> | null => {
  const { ref } = planned;

  if (
    ref === null ||
    planned.input !== ref.path ||
    planned.source !== ref.source ||
    planned.harness !== ref.harness ||
    !path.isAbsolute(ref.path) ||
    path.resolve(ref.path) !== ref.path ||
    !SELECTED_SOURCES.some(
      (mapping) =>
        mapping.source === planned.source &&
        mapping.harness === ref.harness &&
        mapping.channel === ref.channel
    )
  ) {
    return null;
  }

  const selectedRoot =
    ref.harness === "cursor" &&
    ref.channel === "local-db" &&
    ref.path === cursorStateDbPath(home)
      ? path.dirname(path.dirname(ref.path))
      : path.dirname(ref.path);

  return {
    allowSourceGrowth: true,
    cursor: null,
    inputRefs: [
      {
        basisId: null,
        id: ref.path,
        kind: "evidence",
        storeGeneration: identity.storeGeneration,
        storeId: identity.storeId,
        version: "dx.live-input.v1",
      },
    ],
    kind: "collect",
    parserVersion: nativeParserVersion(planned),
    selectedRoots: [selectedRoot],
    source: planned.source,
  };
};

const sourceBounds = (planned: PlannedSource): OperationBounds | null => {
  if (planned.source === ACCOUNT_OPERATION_SOURCE) {
    return ACCOUNT_OPERATION_BOUNDS;
  }

  if (BOUNDED_GIT_SOURCES.includes(planned.source)) {
    return GIT_ACQUISITION_BOUNDS;
  }

  return BOUNDED_CURSOR_OPERATION_SOURCES.includes(planned.source) ||
    planned.source === CURSOR_HOOK_OPERATION_SOURCE
    ? CURSOR_ACQUISITION_BOUNDS
    : null;
};

const hookScope = (planned: PlannedSource): AgentScope => ({
  branchSelection: {
    branches: planned.context.branch === null ? [] : [planned.context.branch],
    kind: planned.context.branch === null ? "all" : "current",
  },
  flightId: null,
  repoId: planned.context.repoCommonDir,
  resolution:
    "Native hook acquisition selects recorded repository and branch context without assigning flight ownership.",
  sources: [planned.source],
  tools: [],
  worktreeId: planned.context.worktreePath,
});

const sourceScope = (planned: PlannedSource): AgentScope | null => {
  if (planned.source === ACCOUNT_OPERATION_SOURCE) {
    return accountOperationScope();
  }

  if (BOUNDED_CURSOR_OPERATION_SOURCES.includes(planned.source)) {
    return {
      branchSelection: { branches: [], kind: "all" },
      flightId: null,
      repoId: planned.context.repoCommonDir,
      resolution:
        "Cursor database acquisition selects the recorded repository without assigning branch, revision or flight ownership.",
      sources: [planned.source],
      tools: [],
      worktreeId: planned.context.worktreePath,
    };
  }

  return nativeHook(planned) ? hookScope(planned) : null;
};

const registeredSource = (planned: PlannedSource): PlannedSource => {
  if (BOUNDED_CURSOR_OPERATION_SOURCES.includes(planned.source)) {
    return {
      ...planned,
      context: {
        ...planned.context,
        branch: null,
        flightId: null,
        headSha: null,
      },
    };
  }

  return nativeHook(planned)
    ? { ...planned, context: { ...planned.context, flightId: null } }
    : planned;
};

const accountScopeMatches = (scope: AgentScope): boolean =>
  scope.branchSelection.kind === "all" &&
  scope.branchSelection.branches.length === 0 &&
  scope.flightId === null &&
  scope.repoId === null &&
  scope.worktreeId === null &&
  scope.sources.length === 1 &&
  scope.sources[0] === ACCOUNT_OPERATION_SOURCE &&
  scope.tools.length === 1 &&
  scope.tools[0] === "cursor";

export interface AgentApplicationOptions {
  readonly repo: string;
  readonly dftHome: string;
  readonly home: string;
  readonly storePath: string;
  readonly engine?: LiveEngine;
}

export interface AgentApplicationApi {
  readonly acquire: LiveAcquisitionExecutor;
  readonly operations: OperationServiceApi;
  readonly learning: LearningServiceApi;
  readonly scope: AgentScope;
}

export const makeAgentApplication = (options: AgentApplicationOptions) =>
  Effect.gen(function* application() {
    const store = yield* AgentStore;
    const events = yield* EventStore;
    const registry = yield* HarnessRegistry;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cursorService = yield* Effect.serviceOption(HarnessCursors);
    const replacement = yield* Effect.serviceOption(BoundedEventReplacement);

    const cursors =
      options.engine?.cursors ??
      (Option.isSome(cursorService) ? cursorService.value : null);

    const scope: AgentScope = {
      branchSelection: { branches: [], kind: "unresolved" },
      flightId: null,
      repoId: null,
      resolution:
        "Session scope is resolved only when a selected write needs it.",
      sources: [],
      tools: [],
      worktreeId: null,
    };

    const home = liveHome(options.dftHome, options.storePath);

    const backend =
      options.engine ??
      (yield* makeAdministrationBackend({
        agentStore: store,
        home,
        store: events,
      }));

    const administration = makeLiveAdministrationAdapters(backend, store);

    const app = (yield* AppOperationAdapters).adapters;

    const guidance = app.find(
      (adapter) => adapter.descriptor.kind === "configure"
    );

    const adapters = administration.map((adapter) =>
      adapter.descriptor.kind === "configure" && guidance !== undefined
        ? combineConfigure(adapter, guidance)
        : adapter
    );

    const plainSelected = makeExplicitSelectedSourceCatalog({
      contextForScope: sourceContext,
      mappings: [...SELECTED_FILE_SOURCES, ...SELECTED_DATABASE_SOURCES],
    });

    const hookSelected = makeExplicitSelectedSourceCatalog({
      contextForScope: sourceContext,
      mappings: [...SELECTED_HOOK_SOURCES, ...SELECTED_CURSOR_HOOK_SOURCES],
    });

    const catalog = makeLiveSelectedSourceCatalog({
      mappings: SELECTED_SOURCES,
      selected: (request) =>
        request.arguments.kind === "collect" &&
        (request.arguments.parserVersion === BOUNDED_HOOK_PARSER_VERSION ||
          request.arguments.parserVersion ===
            BOUNDED_CURSOR_HOOK_OPERATION_VERSION)
          ? hookSelected(request)
          : plainSelected(request),
    });

    const sourceEnrollment = yield* TrackedSourceEnrollment;
    const enrollment = sourceEnrollment.authorize;

    const collection = makePlannedSourceOperationAdapter({
      cursors,
      enrollment,
      env: { store: events, storePath: options.storePath },
      home: options.home,
      parserVersion: SELECTED_FILE_PARSER,
      registry,
      selected: catalog.selected,
      snapshotHarness: (snapshot, bounds, selectedScope, work) =>
        operationSnapshotEncoding(snapshot.ref.path) === "identity"
          ? nativeBoundedSnapshotHarness(
              snapshot,
              bounds,
              selectedScope,
              options.home
            )
          : boundedCompressedSnapshotHarness(
              snapshot,
              bounds,
              selectedScope,
              work
            ),
    });

    const hooks = makePlannedSourceOperationAdapter({
      cursors,
      enrollment,
      env: { store: events, storePath: options.storePath },
      parserVersion: BOUNDED_HOOK_PARSER_VERSION,
      registry,
      selected: catalog.selected,
      snapshotHarness: boundedHookSnapshotHarness,
    });

    const opencode = makeBoundedOpencodeOperationAdapter({
      cursors,
      enrollment,
      env: { store: events, storePath: options.storePath },
      selected: catalog.selected,
    });

    const cursor = makeBoundedCursorOperationAdapter({
      cursors,
      enrollment,
      env: { store: events, storePath: options.storePath },
      knownCommits: makeBoundedGitCommitChecker(spawner),
      selected: catalog.selected,
      worktreeRoots: makeBoundedGitWorktreeLister(spawner),
    });

    const cursorHooks = makeBoundedCursorHookOperationAdapter({
      cursors,
      enrollment,
      env: { store: events, storePath: options.storePath },
      selected: catalog.selected,
    });

    const cursorHookIdentity = makeBoundedCursorHookIdentityProbe({
      cursors,
      enrollment,
      env: { store: events, storePath: options.storePath },
      grantIdentity: (_request, work) =>
        sourceEnrollment
          .readConfig(work)
          .pipe(Effect.map((snapshot) => snapshot.digest)),
      selected: catalog.selected,
    });

    const git = makeBoundedGitOperationAdapter({
      enrollment: (request, work) =>
        Effect.gen(function* gitEnrollment() {
          if (request.arguments.kind !== "collect") {
            return {
              reason: "Select one enrolled Git source.",
              receiptIds: [],
              state: "denied" as const,
            };
          }

          return yield* enrollment(
            {
              bounds: yield* work.budget.remaining,
              inputRefs: request.arguments.inputRefs,
              receiptIds: request.receiptIds,
              scope: request.scope,
              selectedRoots: request.arguments.selectedRoots,
              source: request.arguments.source,
            },
            work
          );
        }),
      env: { store: events, storePath: options.storePath },
      selected: (request) =>
        Effect.gen(function* selectedGitSources() {
          const args = request.arguments;
          const root = request.scope.worktreeId;

          if (
            args.kind !== "collect" ||
            root === null ||
            request.scope.repoId === null ||
            !BOUNDED_GIT_SOURCES.includes(args.source) ||
            args.selectedRoots.length !== 1 ||
            args.selectedRoots[0] !== root ||
            path.resolve(root) !== root
          ) {
            return [];
          }

          const context = yield* sourceContext(request);

          return [
            {
              context,
              harness: null,
              input: root,
              ref: null,
              source: args.source,
              unavailable: null,
            },
          ];
        }),
      spawner,
    });

    const replacementPort =
      options.engine?.appendBounded ??
      Option.getOrUndefined(replacement)?.appendBounded;

    const replacementOptions =
      replacementPort === undefined
        ? {}
        : { appendReplacement: makeBoundedAccountReplacement(replacementPort) };

    const account = makeBoundedAccountOperationAdapter({
      ...replacementOptions,
      dftHome: options.dftHome,
      enrollment: (request, work) =>
        Effect.gen(function* accountEnrollment() {
          const snapshot = yield* sourceEnrollment.readConfig(work);

          const [inputRef] = request.inputRefs;
          const [root] = request.selectedRoots;

          const exact =
            accountScopeMatches(request.scope) &&
            request.source === ACCOUNT_OPERATION_SOURCE &&
            request.selectedRoots.length === 1 &&
            root ===
              "https://cursor.com/api/dashboard/get-filtered-usage-events" &&
            request.inputRefs.length === 1 &&
            inputRef?.id === root;

          const authorized =
            exact &&
            snapshot.cursorUsageEnrolled &&
            snapshot.digest !== null &&
            snapshot.digest === request.configuration.digest;

          return {
            reason: authorized
              ? "The exact persisted account import setting authorizes the fixed Cursor endpoint and full account scope."
              : "Enable the persisted Cursor account import setting and select its exact fixed endpoint and full account scope.",
            receiptIds: authorized ? snapshot.receiptIds : [],
            state: authorized ? ("authorized" as const) : ("denied" as const),
          };
        }),
      env: { store: events, storePath: options.storePath },
      environment: process.env,
      home: options.home,
      readConfiguration: (work) =>
        Effect.gen(function* accountConfiguration() {
          const snapshot = yield* sourceEnrollment.readConfig(work);

          return {
            cursorUsageImport: snapshot.cursorUsageEnrolled,
            digest: snapshot.digest ?? "missing-denied",
          };
        }),
    });

    const collect = composeCollectionOperationAdapters([
      {
        adapter: collection,
        parserVersions: [SELECTED_FILE_PARSER],
        sources: SELECTED_FILE_SOURCES.map((entry) => entry.source),
      },
      {
        adapter: hooks,
        parserVersions: [BOUNDED_HOOK_PARSER_VERSION],
        sources: SELECTED_HOOK_SOURCES.map((entry) => entry.source),
      },
      {
        adapter: opencode,
        parserVersions: [BOUNDED_OPENCODE_OPERATION_VERSION],
        sources: ["harness.opencode"],
      },
      {
        adapter: cursor,
        parserVersions: [BOUNDED_CURSOR_OPERATION_VERSION],
        sources: BOUNDED_CURSOR_OPERATION_SOURCES,
      },
      {
        adapter: cursorHooks,
        parserVersions: [BOUNDED_CURSOR_HOOK_OPERATION_VERSION],
        sources: [CURSOR_HOOK_OPERATION_SOURCE],
      },
      {
        adapter: git,
        parserVersions: [BOUNDED_GIT_OPERATION_VERSION],
        sources: BOUNDED_GIT_SOURCES,
      },
      { adapter: account, sources: [ACCOUNT_OPERATION_SOURCE] },
    ]);

    const operations = yield* makeOperationService(store, [
      ...adapters,
      ...app.filter((adapter) => adapter.descriptor.kind !== "configure"),
      collect,
    ]);

    const { 9: operationCapability } = makeDxCapabilities({
      collectors: [],
      defaultRepo: options.repo,
      operation: operations.run,
      registry: buildRegistry([]),
      storePath: options.storePath,
    });

    const acquire = makeLiveOperationAcquisitionExecutor({
      agentStore: store,
      bounds: {
        maxBytes: 67_108_864,
        maxElapsedMs: 60_000,
        maxFiles: 256,
        maxRecords: 100_000,
        maxRequests: 100,
        maxRetries: 1,
      },
      completedAcquisitionIdentity: (
        planned,
        args,
        identity,
        selectedScope,
        bounds,
        work
      ) =>
        planned.source === CURSOR_HOOK_OPERATION_SOURCE
          ? cursorHookIdentity(
              {
                arguments: args,
                bounds,
                scope: selectedScope,
                storeGeneration: identity.storeGeneration,
                storeId: identity.storeId,
              },
              work
            )
          : Effect.succeed(null),
      completedAcquisitionIdentitySources: [CURSOR_HOOK_OPERATION_SOURCE],
      operations: {
        descriptors: operations.descriptors,
        run: (request) => operationCapability.handler({ request }),
      },
      parserVersion: SELECTED_FILE_PARSER,
      registerSelectedSource: (planned, identity, selectedScope) =>
        catalog.register(registeredSource(planned), identity, selectedScope),
      resolveArguments: (planned, identity) =>
        Effect.sync(() => {
          if (
            planned.source === ACCOUNT_OPERATION_SOURCE &&
            planned.input ===
              "https://cursor.com/api/dashboard/get-filtered-usage-events"
          ) {
            return accountOperationArguments(identity);
          }

          const fileArguments = nativeArguments(
            planned,
            identity,
            options.home
          );

          if (fileArguments !== null) {
            return fileArguments;
          }

          const root = planned.input ?? planned.context.worktreePath;

          if (
            !BOUNDED_GIT_SOURCES.includes(planned.source) ||
            root === null ||
            root !== planned.context.worktreePath ||
            path.resolve(root) !== root
          ) {
            return null;
          }

          return {
            allowSourceGrowth: false,
            cursor: null,
            inputRefs: [],
            kind: "collect" as const,
            parserVersion: BOUNDED_GIT_OPERATION_VERSION,
            selectedRoots: [root],
            source: planned.source,
          };
        }),
      resolveBounds: sourceBounds,
      resolveScope: sourceScope,
      sources: SELECTED_SOURCES,
      store: events,
    });

    const learning = makeLearningService(store, {
      context: { origin: "live", scope },
      resolveContext: () =>
        Effect.sync(() => ({
          origin: "live" as const,
          scope: agentScopeFor(options.repo),
        })),
    });

    return {
      acquire,
      learning,
      operations,
      scope,
    } satisfies AgentApplicationApi;
  });

export class AgentApplication extends Context.Service<
  AgentApplication,
  AgentApplicationApi
>()("dft/AgentApplication") {
  static readonly make = makeAgentApplication;
  static readonly layer = (options: AgentApplicationOptions) => {
    const enrollmentLayer = Layer.unwrap(
      Effect.gen(function* boundedSourceEnrollment() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        return TrackedSourceEnrollment.layer({
          home: liveHome(options.dftHome, options.storePath),
          mappings: SELECTED_SOURCES,
          resolveContext: makeBoundedGitTargetResolver(spawner),
          sourceRoots: (source) => {
            if (BOUNDED_GIT_SOURCES.includes(source)) {
              return [options.repo];
            }

            if (source === CURSOR_HOOK_OPERATION_SOURCE) {
              return [path.join(options.dftHome, "spool")];
            }

            if (BOUNDED_CURSOR_OPERATION_SOURCES.includes(source)) {
              return [
                path.dirname(path.dirname(cursorStateDbPath(options.home))),
              ];
            }

            const hook = SELECTED_HOOK_SOURCES.find(
              (mapping) => mapping.source === source
            );

            return hook === undefined
              ? []
              : [path.join(options.dftHome, "hooks", hook.harness)];
          },
        });
      })
    ).pipe(Layer.provideMerge(HarnessHome.forHome(options.home)));

    const appLayer = Layer.unwrap(
      Effect.gen(function* installedOperationAdapters() {
        const enrollment = yield* TrackedSourceEnrollment;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const resolveCurrent = makeBoundedGitTargetResolver(spawner);

        return AppOperationAdapters.layer({
          hookCommand: () =>
            `${dftInvocation(process.execPath, process.argv[1] ?? "dft")} hook`,
          resolveCurrentTarget: (selectedScope, work) =>
            Effect.gen(function* currentOperationTarget() {
              const current = yield* resolveCurrent(
                path.resolve(options.repo),
                work
              );

              const branchMatches =
                ["current", "selected"].includes(
                  selectedScope.branchSelection.kind
                ) &&
                selectedScope.branchSelection.branches.length === 1 &&
                selectedScope.branchSelection.branches[0] === current.branch;

              if (
                current.worktreePath === null ||
                current.repoCommonDir === null ||
                current.branch === null ||
                selectedScope.worktreeId !== current.worktreePath ||
                selectedScope.repoId !== current.repoCommonDir ||
                selectedScope.flightId !== null ||
                selectedScope.sources.length !== 0 ||
                selectedScope.tools.length !== 0 ||
                !branchMatches
              ) {
                return yield* new AgentError({
                  code: "scope-denied",
                  currentRevision: null,
                  expectedRevision: null,
                  message:
                    "Guidance and export operations require the configured repository's exact current worktree and branch without flight or source scope widening.",
                  recovery: { action: "replan", ref: null },
                  ref: null,
                  retryable: false,
                });
              }

              return { scope: selectedScope, worktree: current.worktreePath };
            }),
          resolveCursorTarget: (selectedScope, work) =>
            Effect.gen(function* enrolledCursorTarget() {
              const snapshot = yield* enrollment.readConfig(work);
              const worktree = selectedScope.worktreeId;

              if (
                worktree === null ||
                !path.isAbsolute(worktree) ||
                path.resolve(worktree) !== worktree ||
                snapshot.config === null ||
                !snapshot.config.repos.includes(worktree)
              ) {
                return yield* new AgentError({
                  code: "scope-denied",
                  currentRevision: null,
                  expectedRevision: null,
                  message:
                    "Cursor hook installation requires the exact canonical worktree in the persisted tracked repository list.",
                  recovery: { action: "replan", ref: null },
                  ref: null,
                  retryable: false,
                });
              }

              return { scope: selectedScope, worktree };
            }),
          scope: () => agentScopeFor(options.repo),
          worktree: () =>
            agentScopeFor(options.repo).worktreeId ?? options.repo,
        });
      })
    ).pipe(Layer.provideMerge(enrollmentLayer));

    return Layer.effect(this, this.make(options)).pipe(
      Layer.provideMerge(appLayer)
    );
  };
}

export const runInstalledOperation = (
  input: OperationInput
): Effect.Effect<
  OperationOutput,
  AgentError | Effect.Error<ReturnType<OperationServiceApi["run"]>>
> =>
  Effect.flatMap(Effect.serviceOption(AgentApplication), (available) =>
    Option.isSome(available)
      ? available.value.operations.run(input)
      : Effect.fail(
          unavailable("The operation service is not composed in this runtime.")
        )
  );

export const runInstalledLearning = (
  input: LearningInput
): Effect.Effect<
  LearningOutput,
  AgentError | Effect.Error<ReturnType<LearningServiceApi["run"]>>
> =>
  Effect.flatMap(Effect.serviceOption(AgentApplication), (available) =>
    Option.isSome(available)
      ? available.value.learning.run(input)
      : Effect.fail(
          unavailable("The learning service is not composed in this runtime.")
        )
  );

export const installedAgentCatalog = () =>
  Effect.map(Effect.serviceOption(AgentApplication), (available) =>
    Option.isSome(available)
      ? {
          learning: true,
          operation: true,
          operations: available.value.operations.descriptors,
        }
      : { learning: false, operation: false, operations: [] }
  );
