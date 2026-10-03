// @effect-diagnostics-next-line nodeBuiltinImport:off -- Live acquisition selects exact local paths without discovering or opening source contents.
import path from "node:path";

import { Clock, Effect, Option, Schema } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../contracts/agent-store.js";
import type { EventStoreService } from "../contracts/services.js";
import type {
  LiveAcquisitionEnvironment,
  LiveAcquisitionExecutor,
} from "../live/engine.js";
import type { AgentScope, StoreIdentity } from "../model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import { CollectCursorSchema } from "../model/coverage.js";
import type {
  PlannedSource,
  SyncStep,
  SyncStepState,
} from "../registry/sync.js";
import { unchangedRef } from "../storage/harness-cursors.js";
import type { StoredCursor } from "../storage/harness-cursors.js";
import { createOperationWorkBudget } from "./budget.js";
import type {
  ExplicitSourceMapping,
  PlannedSourceSelection,
  SelectedSourceRequest,
} from "./collector.js";
import { operationStep } from "./ports.js";
import type { OperationAdapter, OperationWorkContext } from "./ports.js";
import { operationError } from "./service.js";
import type { OperationServiceApi } from "./service.js";

export interface CollectionOperationRoute {
  readonly adapter: OperationAdapter;
  readonly parserVersions?: readonly string[];
  readonly sources: readonly string[];
}

const collectionUnavailable = () =>
  operationError(
    "source-unavailable",
    "Exactly one installed bounded collection adapter must own the selected source."
  );

export const composeCollectionOperationAdapters = (
  routes: readonly CollectionOperationRoute[]
): OperationAdapter => {
  const selected = (args: OperationArguments): OperationAdapter | null => {
    if (args.kind !== "collect") {
      return null;
    }

    const matching = routes.filter(
      (route) =>
        route.sources.includes(args.source) &&
        (route.parserVersions === undefined ||
          route.parserVersions.includes(args.parserVersion))
    );

    const route = matching.length === 1 ? matching[0] : undefined;

    return route?.adapter.descriptor.kind === "collect" &&
      route.adapter.descriptor.enabled
      ? route.adapter
      : null;
  };

  const adapters = routes.map((route) => route.adapter);

  const enabled = routes.some(
    (route) =>
      route.adapter.descriptor.kind === "collect" &&
      route.adapter.descriptor.enabled &&
      route.sources.length > 0 &&
      route.parserVersions?.length !== 0
  );

  return {
    authorize: (plan, input, context) =>
      selected(plan.arguments)?.authorize(plan, input, context) ??
      Effect.succeed(false),
    descriptor: {
      authorization: adapters.some(
        (adapter) =>
          adapter.descriptor.authorization === "explicit-confirmation"
      )
        ? "explicit-confirmation"
        : "existing-enrollment",
      cancellation: adapters.some(
        (adapter) => adapter.descriptor.cancellation === "before-start-only"
      )
        ? "before-start-only"
        : "between-steps",
      effects: {
        destructive: adapters.some(
          (adapter) => adapter.descriptor.effects.destructive
        ),
        networkDestinations: [
          ...new Set(
            adapters.flatMap(
              (adapter) => adapter.descriptor.effects.networkDestinations
            )
          ),
        ],
        reads: [
          ...new Set(
            adapters.flatMap((adapter) => adapter.descriptor.effects.reads)
          ),
        ],
        writes: [
          ...new Set(
            adapters.flatMap((adapter) => adapter.descriptor.effects.writes)
          ),
        ],
      },
      enabled,
      idempotency: adapters.every(
        (adapter) => adapter.descriptor.idempotency === "durable-key"
      )
        ? "durable-key"
        : "disabled",
      kind: "collect",
      reason: enabled ? null : "No bounded collection route is available.",
      requiredInputs: [
        "source",
        "inputRefs",
        "selectedRoots",
        "parserVersion",
        "scope",
        "bounds",
      ],
      version: "dx.collection-routes.v1",
    },
    execute: (plan, step, context) =>
      selected(plan.arguments)?.execute(plan, step, context) ??
      Effect.fail(collectionUnavailable()),
    meteredWork: adapters.every((adapter) => adapter.meteredWork === true),
    prepare: (input, context) =>
      selected(input.arguments)?.prepare(input, context) ??
      Effect.fail(collectionUnavailable()),
    probe: (plan, step, receipt, context) =>
      selected(plan.arguments)?.probe(plan, step, receipt, context) ??
      Effect.fail(collectionUnavailable()),
    replay: adapters.every((adapter) => adapter.replay === "safe")
      ? "safe"
      : "probe-required",
    steps: (plan) =>
      selected(plan.arguments)?.steps(plan) ?? [
        {
          ...operationStep(
            "unavailable-source",
            plan.arguments.kind === "collect" ? plan.arguments.source : null
          ),
          gaps: [collectionUnavailable().message],
          state: "unavailable",
        },
      ],
    unmeasuredValidationResources: [
      ...new Set(
        adapters.flatMap(
          (adapter) => adapter.unmeasuredValidationResources ?? []
        )
      ),
    ],
    validate: (plan, context) =>
      selected(plan.arguments)?.validate(plan, context) ??
      Effect.succeed([collectionUnavailable().message]),
  };
};

type CollectionArguments = Extract<
  OperationArguments,
  { readonly kind: "collect" }
>;

export type LiveCollectionArgumentResolver = (
  planned: PlannedSource,
  identity: StoreIdentity
) => Effect.Effect<CollectionArguments | null, AgentStoreFailure>;

export type LiveSelectedSourceRegistration = (
  planned: PlannedSource,
  identity: StoreIdentity,
  scope: AgentScope
) => Effect.Effect<void, AgentStoreFailure>;

export interface LiveSelectedSourceCatalog {
  readonly register: LiveSelectedSourceRegistration;
  readonly selected: (
    request: SelectedSourceRequest
  ) => Effect.Effect<readonly PlannedSourceSelection[], AgentStoreFailure>;
}

export interface LiveSelectedSourceCatalogOptions {
  readonly mappings: readonly ExplicitSourceMapping[];
  readonly selected: LiveSelectedSourceCatalog["selected"];
}

const selectedSourceKey = (
  source: string,
  input: string,
  identity: Pick<StoreIdentity, "storeId" | "storeGeneration">,
  scope: AgentScope
): string =>
  JSON.stringify({
    input,
    scope,
    source,
    storeGeneration: identity.storeGeneration,
    storeId: identity.storeId,
  });

export const makeLiveSelectedSourceCatalog = (
  options: LiveSelectedSourceCatalogOptions
): LiveSelectedSourceCatalog => {
  const explicit = options.selected;
  const registered = new Map<string, PlannedSource>();

  const register = Effect.fn("liveSelectedSourceCatalog.register")(
    function* register(
      planned: PlannedSource,
      identity: StoreIdentity,
      scope: AgentScope
    ) {
      const { ref } = planned;

      if (
        ref === null ||
        !options.mappings.some(
          (mapping) =>
            mapping.source === planned.source &&
            mapping.harness === ref.harness &&
            mapping.channel === ref.channel
        )
      ) {
        return yield* Effect.void;
      }

      if (
        planned.input !== ref.path ||
        planned.source !== ref.source ||
        planned.harness !== ref.harness ||
        !path.isAbsolute(ref.path) ||
        path.resolve(ref.path) !== ref.path ||
        planned.context.repoCommonDir !== scope.repoId ||
        planned.context.worktreePath !== scope.worktreeId ||
        planned.context.flightId !== scope.flightId
      ) {
        return yield* operationError(
          "scope-denied",
          "The live source registration must preserve its exact native reference and selected context."
        );
      }

      const key = selectedSourceKey(planned.source, ref.path, identity, scope);

      if (!registered.has(key) && registered.size >= 256) {
        const oldest = registered.keys().next().value;

        if (oldest !== undefined) {
          registered.delete(oldest);
        }
      }

      registered.set(key, planned);

      return yield* Effect.void;
    }
  );

  const selected = Effect.fn("liveSelectedSourceCatalog.selected")(
    function* selected(request: SelectedSourceRequest) {
      const exact = yield* explicit(request);

      if (request.arguments.kind !== "collect") {
        return exact;
      }

      const { source } = request.arguments;

      return yield* Effect.forEach((selection: PlannedSourceSelection) => {
        const live = registered.get(
          selectedSourceKey(
            source,
            selection.inputRef.id,
            request,
            request.scope
          )
        );

        return live === undefined &&
          selection.inputRef.version === "dx.live-input.v1"
          ? Effect.fail(
              operationError(
                "plan-stale",
                "The exact native live selection was released; select this source again before applying."
              )
            )
          : Effect.succeed(
              live === undefined ? selection : { ...selection, planned: live }
            );
      })(exact);
    }
  );

  return { register, selected };
};

export interface LiveOperationAcquisitionOptions {
  readonly agentStore: AgentStoreService;
  readonly bounds?: OperationBounds;
  readonly completedAcquisitionIdentity?: LiveCompletedAcquisitionIdentity;
  readonly completedAcquisitionIdentitySources?: readonly string[];
  readonly operations: OperationServiceApi;
  readonly parserVersion: string;
  readonly registerSelectedSource?: LiveSelectedSourceRegistration;
  readonly resolveArguments?: LiveCollectionArgumentResolver;
  readonly resolveBounds?: (planned: PlannedSource) => OperationBounds | null;
  readonly resolveScope?: (planned: PlannedSource) => AgentScope | null;
  readonly sources: readonly ExplicitSourceMapping[];
  readonly store: EventStoreService;
}

export type LiveCompletedAcquisitionIdentity = (
  planned: PlannedSource,
  args: CollectionArguments,
  identity: StoreIdentity,
  scope: AgentScope,
  bounds: OperationBounds,
  context: OperationWorkContext
) => Effect.Effect<string | null, AgentStoreFailure>;

export const LIVE_OPERATION_BOUNDS: OperationBounds = {
  maxBytes: 8_388_608,
  maxElapsedMs: 5000,
  maxFiles: 4,
  maxRecords: 100_000,
  maxRequests: 0,
  maxRetries: 1,
};

const liveScope = (planned: PlannedSource): AgentScope => ({
  branchSelection: {
    branches: planned.context.branch === null ? [] : [planned.context.branch],
    kind: planned.context.branch === null ? "unresolved" : "current",
  },
  flightId: planned.context.flightId,
  repoId: planned.context.repoCommonDir,
  resolution: "Resolved from the live engine's selected source context.",
  sources: [planned.source],
  tools: [],
  worktreeId: planned.context.worktreePath,
});

const unavailableSync = (planned: PlannedSource, reason: string): SyncStep => ({
  coverage: null,
  duplicates: null,
  eventsRead: null,
  gaps: [{ code: "operation.unavailable", message: reason }],
  input: planned.input,
  inserted: null,
  lastEventId: null,
  readCursor: null,
  reason,
  recordsRead: null,
  rejected: null,
  safeCursor: null,
  source: planned.source,
  spooledRefs: [],
  state: "unavailable",
  status: "unavailable",
  unavailableReasons: [reason],
  unsettled: null,
});

const rejectedCount = (steps: readonly OperationStep[]): number | null => {
  let total = 0;

  for (const step of steps) {
    if (step.rejected === null) {
      return null;
    }

    total += step.rejected;
  }

  return total;
};

const receiptState = (receipt: OperationReceipt): SyncStepState => {
  const { steps } = receipt;

  if (steps.some((step) => step.state === "spooled")) {
    return "spooled";
  }

  if (
    steps.length === 0 ||
    steps.some((step) =>
      [
        "unavailable",
        "rejected",
        "failed",
        "cancelled",
        "indeterminate",
        "running",
        "not-attempted",
      ].includes(step.state)
    )
  ) {
    return steps.some((step) => step.inserted > 0 || step.duplicates > 0)
      ? "partial"
      : "unavailable";
  }

  if (
    receipt.executionState !== "succeeded" ||
    receipt.verificationState !== "verified" ||
    steps.some((step) => step.state === "partial")
  ) {
    return "partial";
  }

  if (steps.every((step) => step.state === "unchanged")) {
    return "unchanged";
  }

  return steps.every(
    (step) => step.state === "already-applied" || step.state === "unchanged"
  )
    ? "duplicate"
    : "committed";
};

const decodeCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(CollectCursorSchema)
);

export const syncStepFromOperationReceipt = (
  planned: PlannedSource,
  receipt: OperationReceipt
): SyncStep => {
  const state = receiptState(receipt);

  const gaps = [
    ...new Set(
      receipt.steps.flatMap((step) => [
        ...step.gaps,
        ...(step.remainingWork === null ? [] : [step.remainingWork]),
      ])
    ),
  ];

  if (state === "unavailable" && gaps.length === 0) {
    gaps.push(
      `This acquisition is ${receipt.executionState}; verification is ${receipt.verificationState}. No completed source receipt is available.`
    );
  }

  const last = receipt.steps.at(-1);

  const cursor =
    receipt.steps.findLast((step) => step.safeCursor !== null)?.safeCursor ??
    null;

  const reason = gaps.length === 0 ? null : gaps.join("\n").slice(0, 4096);

  return {
    coverage: null,
    duplicates:
      receipt.steps.length === 0
        ? null
        : receipt.steps.reduce((total, step) => total + step.duplicates, 0),
    eventsRead: null,
    gaps: gaps.map((message) => ({ code: "operation.receipt", message })),
    input: planned.input,
    inserted:
      receipt.steps.length === 0
        ? null
        : receipt.steps.reduce((total, step) => total + step.inserted, 0),
    lastEventId: last?.committedThrough ?? null,
    readCursor: null,
    reason,
    recordsRead: receipt.resources.recordsDecoded,
    rejected: receipt.steps.length === 0 ? null : rejectedCount(receipt.steps),
    safeCursor: cursor === null ? null : Option.getOrNull(decodeCursor(cursor)),
    source: planned.source,
    spooledRefs: [
      ...new Set(receipt.steps.flatMap((step) => step.spooledRefs)),
    ],
    state,
    status: state === "unavailable" ? "unavailable" : "synced",
    unavailableReasons:
      state === "unavailable" && reason !== null ? [reason] : [],
    unsettled: state === "unchanged" ? false : null,
  };
};

const fileArguments = (
  options: LiveOperationAcquisitionOptions,
  planned: PlannedSource,
  identity: StoreIdentity
): CollectionArguments | null => {
  const { ref } = planned;

  if (ref === null) {
    return null;
  }

  const mapping = options.sources.find(
    (source) =>
      source.source === planned.source &&
      source.harness === ref.harness &&
      source.channel === ref.channel
  );

  if (
    mapping === undefined ||
    planned.harness !== ref.harness ||
    planned.source !== ref.source ||
    planned.input !== ref.path ||
    !path.isAbsolute(ref.path) ||
    path.resolve(ref.path) !== ref.path
  ) {
    return null;
  }

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
        version:
          options.registerSelectedSource === undefined
            ? "dx.selected-input.v1"
            : "dx.live-input.v1",
      },
    ],
    kind: "collect",
    parserVersion: options.parserVersion,
    selectedRoots: [path.dirname(ref.path)],
    source: planned.source,
  };
};

const markLiveArguments = (
  options: LiveOperationAcquisitionOptions,
  planned: PlannedSource,
  args: CollectionArguments | null
): CollectionArguments | null => {
  if (
    args === null ||
    options.registerSelectedSource === undefined ||
    planned.ref === null
  ) {
    return args;
  }

  const selectedPath = planned.ref.path;

  return {
    ...args,
    inputRefs: args.inputRefs.map((ref) =>
      ref.id === selectedPath ? { ...ref, version: "dx.live-input.v1" } : ref
    ),
  };
};

const unchangedSync = (
  planned: PlannedSource,
  stored: StoredCursor | null
): SyncStep => ({
  coverage: null,
  duplicates: 0,
  eventsRead: 0,
  gaps: [],
  input: planned.input,
  inserted: 0,
  lastEventId: stored?.lastEventId ?? null,
  readCursor: null,
  reason: null,
  recordsRead: 0,
  rejected: 0,
  safeCursor: stored?.cursor ?? null,
  source: planned.source,
  spooledRefs: [],
  state: "unchanged",
  status: "synced",
  unavailableReasons: [],
  unsettled: false,
});

interface PendingLiveCollection {
  readonly plan: OperationPlan;
  readonly retries: number;
}

interface CompletedLiveCollection {
  readonly receipt: OperationReceipt;
  readonly result: SyncStep;
}

interface LiveCollectionState {
  readonly completed: Map<string, CompletedLiveCollection>;
  readonly pending: Map<string, PendingLiveCollection>;
}

interface CompletedCollectionProbe {
  readonly identity: string | null;
  readonly metadataChecked: boolean;
}

const completedCollection = (receipt: OperationReceipt): boolean =>
  receipt.executionState === "succeeded" &&
  receipt.verificationState === "verified" &&
  receipt.recovery === "none" &&
  receipt.steps.length > 0 &&
  receipt.steps.every(
    (step) =>
      ["committed", "already-applied", "unchanged"].includes(step.state) &&
      step.spooledRefs.length === 0 &&
      step.remainingWork === null
  );

const strongNativeIdentity = (planned: PlannedSource): string | null => {
  const { ref } = planned;

  if (
    ref === null ||
    ref.mtimeMs === null ||
    ref.size === null ||
    !["session-file", "transcript", "hooks", "extension"].includes(
      ref.channel
    ) ||
    (ref.harness === "cursor" && ref.channel === "hooks")
  ) {
    return null;
  }

  return JSON.stringify(ref);
};

const probeCompletedCollection = Effect.fn(
  "liveOperationAcquisition.probeCompletedCollection"
)(function* probeCompletedCollection(
  options: LiveOperationAcquisitionOptions,
  planned: PlannedSource,
  args: CollectionArguments,
  identity: StoreIdentity,
  scope: AgentScope,
  bounds: OperationBounds
): Effect.fn.Return<CompletedCollectionProbe, AgentStoreFailure> {
  if (
    options.completedAcquisitionIdentity === undefined ||
    (options.completedAcquisitionIdentitySources !== undefined &&
      !options.completedAcquisitionIdentitySources.includes(planned.source))
  ) {
    return { identity: strongNativeIdentity(planned), metadataChecked: false };
  }

  const budget = yield* createOperationWorkBudget(
    bounds,
    yield* Clock.currentTimeMillis
  );

  const fingerprint = yield* options
    .completedAcquisitionIdentity(planned, args, identity, scope, bounds, {
      budget,
    })
    .pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }));

  return { identity: fingerprint, metadataChecked: true };
});

const metadataProbeGap = {
  code: "live.metadata-admission",
  message:
    "The read-only metadata admission phase has its own work budget. Acquisition receipt measurements do not include its filesystem or control-store I/O.",
};

const withMetadataProbeGap = (
  result: SyncStep,
  metadataChecked: boolean
): SyncStep =>
  !metadataChecked ||
  result.gaps?.some((gap) => gap.code === metadataProbeGap.code) === true
    ? result
    : { ...result, gaps: [...(result.gaps ?? []), metadataProbeGap] };

const completedIdleResult = (
  previous: CompletedLiveCollection,
  metadataChecked: boolean
): SyncStep =>
  withMetadataProbeGap(
    {
      ...previous.result,
      duplicates: 0,
      eventsRead: 0,
      gaps: [
        ...(previous.result.gaps ?? []),
        {
          code: "live.completed-acquisition",
          message: `Verified acquisition ${previous.receipt.id} covers this unchanged selected scope.`,
        },
      ],
      inserted: 0,
      readCursor: null,
      recordsRead: 0,
      rejected: 0,
      spooledRefs: [],
      state: "unchanged",
      status: "synced",
      unavailableReasons: [],
      unsettled: false,
    },
    metadataChecked
  );

const completedCacheKey = (
  retryKey: string,
  identity: StoreIdentity,
  probe: CompletedCollectionProbe
): string | null =>
  probe.identity === null
    ? null
    : JSON.stringify({
        probe: probe.identity,
        retryKey,
        revision: identity.revision,
        storeGeneration: identity.storeGeneration,
        storeId: identity.storeId,
      });

const cachedCompletedCollection = Effect.fn(
  "liveOperationAcquisition.cachedCompletedCollection"
)(function* cachedCompletedCollection(
  options: LiveOperationAcquisitionOptions,
  state: LiveCollectionState,
  key: string | null,
  probe: CompletedCollectionProbe,
  identity: StoreIdentity,
  planned: PlannedSource,
  args: CollectionArguments,
  scope: AgentScope,
  bounds: OperationBounds
) {
  const previous = key === null ? undefined : state.completed.get(key);

  if (previous === undefined || key === null) {
    return null;
  }

  const current = yield* options.agentStore
    .getOperation({
      id: previous.receipt.id,
      storeGeneration: previous.receipt.storeGeneration,
      storeId: previous.receipt.storeId,
    })
    .pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }));

  if (
    current === null ||
    current.revision !== previous.receipt.revision ||
    !completedCollection(current)
  ) {
    state.completed.delete(key);

    return null;
  }

  const checked = yield* probeCompletedCollection(
    options,
    planned,
    args,
    identity,
    scope,
    bounds
  ).pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }));

  if (checked === null || checked.identity !== probe.identity) {
    state.completed.delete(key);

    return null;
  }

  const after = yield* options.agentStore.identity.pipe(
    Effect.match({ onFailure: () => null, onSuccess: (value) => value })
  );

  if (
    after === null ||
    after.revision !== identity.revision ||
    after.storeId !== identity.storeId ||
    after.storeGeneration !== identity.storeGeneration
  ) {
    state.completed.delete(key);

    return null;
  }

  return completedIdleResult(previous, probe.metadataChecked);
});

const retainCompletedCollection = (
  completed: Map<string, CompletedLiveCollection>,
  key: string,
  entry: CompletedLiveCollection
) => {
  if (!completed.has(key) && completed.size >= 256) {
    const oldest = completed.keys().next().value;

    if (oldest !== undefined) {
      completed.delete(oldest);
    }
  }

  completed.set(key, entry);
};

const retainCompletedProof = Effect.fn(
  "liveOperationAcquisition.retainCompletedProof"
)(
  function* retainCompletedProof(
    options: LiveOperationAcquisitionOptions,
    planned: PlannedSource,
    args: CollectionArguments,
    scope: AgentScope,
    bounds: OperationBounds,
    state: LiveCollectionState,
    key: string,
    probe: CompletedCollectionProbe,
    receipt: OperationReceipt,
    result: SyncStep
  ): Effect.fn.Return<void, AgentStoreFailure> {
    if (!completedCollection(receipt) || probe.identity === null) {
      return;
    }

    const after = yield* options.agentStore.identity;

    const checked = yield* probeCompletedCollection(
      options,
      planned,
      args,
      after,
      scope,
      bounds
    );

    const retainedKey = completedCacheKey(key, after, checked);
    const confirmed = yield* options.agentStore.identity;

    if (
      retainedKey !== null &&
      checked.identity === probe.identity &&
      after.revision === receipt.afterRevision &&
      confirmed.revision === after.revision &&
      after.storeId === receipt.storeId &&
      confirmed.storeId === after.storeId &&
      after.storeGeneration === receipt.storeGeneration &&
      confirmed.storeGeneration === after.storeGeneration
    ) {
      retainCompletedCollection(state.completed, retainedKey, {
        receipt,
        result,
      });
    }
  },
  (effect) => Effect.ignore(effect)
);

const prepareCollection = Effect.fn(
  "liveOperationAcquisition.prepareCollection"
)(function* prepareCollection(
  options: LiveOperationAcquisitionOptions,
  args: CollectionArguments,
  identity: StoreIdentity,
  bounds: OperationBounds,
  scope: AgentScope
) {
  const plannedOperation = yield* options.operations.run({
    action: "plan",
    arguments: args,
    bounds,
    purpose:
      "Acquire only this selected live source within the configured operation bounds.",
    scope,
    target: identity,
  });

  return plannedOperation.action === "plan" ? plannedOperation.plan : null;
});

const retainPendingCollection = (
  pending: Map<string, PendingLiveCollection>,
  key: string,
  entry: PendingLiveCollection,
  receipt: OperationReceipt
) => {
  if (
    receipt.recovery !== "safe-resume" ||
    entry.plan.bounds.maxRetries === 0
  ) {
    pending.delete(key);

    return;
  }

  if (!pending.has(key) && pending.size >= 256) {
    const oldest = pending.keys().next().value;

    if (oldest !== undefined) {
      pending.delete(oldest);
    }
  }

  pending.set(key, entry);
};

const applyCollection = Effect.fn("liveOperationAcquisition.applyCollection")(
  function* applyCollection(
    options: LiveOperationAcquisitionOptions,
    planned: PlannedSource,
    args: CollectionArguments,
    identity: StoreIdentity,
    state: LiveCollectionState
  ) {
    const { pending } = state;

    const bounds =
      options.resolveBounds?.(planned) ??
      options.bounds ??
      LIVE_OPERATION_BOUNDS;

    const scope = options.resolveScope?.(planned) ?? liveScope(planned);

    if (options.registerSelectedSource !== undefined) {
      yield* options.registerSelectedSource(planned, identity, scope);
    }

    const key = JSON.stringify({
      arguments: args,
      bounds,
      context: planned.context,
      input: planned.input,
      nativeRef:
        planned.ref === null
          ? null
          : {
              channel: planned.ref.channel,
              id: planned.ref.id,
              sessionId: planned.ref.sessionId,
              splitAcross: planned.ref.splitAcross ?? [],
              worktree: planned.ref.worktree,
            },
      scope,
      source: planned.source,
    });

    const probe = yield* probeCompletedCollection(
      options,
      planned,
      args,
      identity,
      scope,
      bounds
    );

    const completedKey = completedCacheKey(key, identity, probe);

    const cached = yield* cachedCompletedCollection(
      options,
      state,
      completedKey,
      probe,
      identity,
      planned,
      args,
      scope,
      bounds
    );

    if (cached !== null) {
      return cached;
    }

    const prior = pending.get(key);

    const retained =
      prior !== undefined && prior.retries < bounds.maxRetries ? prior : null;

    const plan =
      retained?.plan ??
      (yield* prepareCollection(options, args, identity, bounds, scope));

    if (plan === null) {
      return unavailableSync(
        planned,
        "The operation service did not return a collection plan."
      );
    }

    const entry = {
      plan,
      retries: retained === null ? 0 : retained.retries + 1,
    };

    if (retained === null) {
      pending.delete(key);
    } else {
      pending.set(key, entry);
    }

    const applied = yield* options.operations
      .run({
        action: "apply",
        consentReceiptIds: plan.consent.receiptIds,
        expectedDigest: plan.planDigest,
        idempotencyKey: `live:${plan.id}`,
        plan: {
          id: plan.id,
          storeGeneration: plan.storeGeneration,
          storeId: plan.storeId,
        },
      })
      .pipe(Effect.tapError(() => Effect.sync(() => pending.delete(key))));

    if (applied.action !== "apply") {
      pending.delete(key);

      return unavailableSync(
        planned,
        "The operation service did not return a collection receipt."
      );
    }

    retainPendingCollection(pending, key, entry, applied.receipt);

    const result = withMetadataProbeGap(
      syncStepFromOperationReceipt(planned, applied.receipt),
      probe.metadataChecked
    );

    yield* retainCompletedProof(
      options,
      planned,
      args,
      scope,
      bounds,
      state,
      key,
      probe,
      applied.receipt,
      result
    );

    return result;
  }
);

export const makeLiveOperationAcquisitionExecutor = (
  options: LiveOperationAcquisitionOptions
): LiveAcquisitionExecutor => {
  const state: LiveCollectionState = {
    completed: new Map(),
    pending: new Map(),
  };

  return Effect.fn("liveOperationAcquisition")(
    function* acquire(
      planned: PlannedSource,
      environment: LiveAcquisitionEnvironment
    ) {
      if (environment.store !== options.store) {
        return unavailableSync(
          planned,
          "Live acquisition and the operation service must use the same opened event store."
        );
      }

      if (planned.unavailable !== null) {
        return unavailableSync(planned, planned.unavailable);
      }

      const identity = yield* options.agentStore.identity;

      const selectedFile = fileArguments(options, planned, identity);

      const resolvedArgs =
        (options.resolveArguments === undefined
          ? null
          : yield* options.resolveArguments(planned, identity)) ?? selectedFile;

      const args = markLiveArguments(options, planned, resolvedArgs);

      if (args === null || args.source !== planned.source) {
        return unavailableSync(
          planned,
          "No installed bounded operation mapping owns this live source and input channel."
        );
      }

      if (
        planned.ref !== null &&
        selectedFile !== null &&
        ["session-file", "transcript", "hooks", "extension"].includes(
          planned.ref.channel
        )
      ) {
        const stored = yield* environment.cursors.get(planned.ref);

        if (unchangedRef(stored, planned.ref)) {
          return unchangedSync(planned, stored);
        }
      }

      return yield* applyCollection(options, planned, args, identity, state);
    },
    (effect, planned) =>
      Effect.match(effect, {
        onFailure: (error) => unavailableSync(planned, error.message),
        onSuccess: (step) => step,
      })
  );
};
