import { Effect, Predicate } from "effect";
import type { Scope } from "effect";

import type * as CapabilityConstructors from "../../../../src/dx/capabilities.js";
import type { AgentStoreFailure } from "../../../../src/dx/contracts/agent-store.js";
import type { AgentError } from "../../../../src/dx/contracts/error-agent.js";
import {
  readLiveConfig,
  writeLiveConfig,
} from "../../../../src/dx/live/config.js";
import type { LiveConfig } from "../../../../src/dx/live/config.js";
import type * as AdministrationConstructors from "../../../../src/dx/live/engine.js";
import { configPath, liveHome } from "../../../../src/dx/live/home.js";
import type {
  LiveActionError,
  LiveHome,
} from "../../../../src/dx/live/home.js";
import type { AgentScope } from "../../../../src/dx/model/agent-common.js";
import type {
  OperationInput,
  OperationOutput,
  OperationPlan,
} from "../../../../src/dx/model/agent-operation.js";
import type { LiveAdministrationBackend } from "../../../../src/dx/operations/live.js";
import type * as AdministrationAdapterConstructors from "../../../../src/dx/operations/live.js";
import type * as OperationConstructors from "../../../../src/dx/operations/service.js";
import { buildRegistry } from "../../../../src/dx/registry/registry.js";
import { openSqliteEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";
import { fixtureBounds } from "./scenario.js";

type Applied = Extract<OperationOutput, { action: "apply" }>;

type Retrieved = Extract<OperationOutput, { action: "get" }>;

type ApplyInput = Extract<OperationInput, { action: "apply" }>;

type ConfigurationFailure = AgentStoreFailure | LiveActionError;

export interface ConfigurationConstructors {
  readonly makeDxCapabilities: typeof CapabilityConstructors.makeDxCapabilities;
  readonly makeAdministrationBackend: typeof AdministrationConstructors.makeAdministrationBackend;
  readonly makeLiveAdministrationAdapters: typeof AdministrationAdapterConstructors.makeLiveAdministrationAdapters;
  readonly makeOperationService: typeof OperationConstructors.makeOperationService;
}

const configurationBounds = {
  ...fixtureBounds,
  maxFiles: 100,
  maxRecords: 1000,
};

export interface ConfigurationExerciseResult {
  readonly plan: OperationPlan;
  readonly denied: AgentError;
  readonly applied: Applied;
  readonly persisted: Retrieved;
  readonly replayed: Applied;
  readonly resumed: Retrieved;
  readonly before: LiveConfig;
  readonly afterPlanning: LiveConfig;
  readonly after: LiveConfig;
  readonly applyCount: number;
  readonly configFile: string;
}

const configurationScope: AgentScope = {
  branchSelection: { branches: [], kind: "all" },
  flightId: null,
  repoId: null,
  resolution: "Labelled S05 configuration fixture; no live acquisition",
  sources: [],
  tools: [],
  worktreeId: null,
};

const withConfigurationStore = <Value>(
  storePath: string,
  use: (
    opened: OpenedEventStore
  ) => Effect.Effect<Value, ConfigurationFailure, Scope.Scope>
): Effect.Effect<Value, ConfigurationFailure> =>
  Effect.acquireUseRelease(
    openSqliteEventStore({ kind: "live", path: storePath }),
    (opened) => Effect.scoped(use(opened)),
    (opened) => Effect.sync(opened.close)
  );

const configurationCapability = Effect.fn(
  "fixture.s05.configurationCapability"
)(function* configurationCapability(
  opened: OpenedEventStore,
  home: LiveHome,
  onApply: () => void,
  constructors: ConfigurationConstructors
) {
  const engine = yield* constructors.makeAdministrationBackend({
    agentStore: opened.agentService,
    home,
    store: opened.service,
  });

  const backend: LiveAdministrationBackend = {
    ...engine,
    applyReviewedAdministration: (...args) =>
      Effect.sync(onApply).pipe(
        Effect.andThen(engine.applyReviewedAdministration(...args))
      ),
  };

  const service = yield* constructors.makeOperationService(
    opened.agentService,
    constructors.makeLiveAdministrationAdapters(backend, opened.agentService)
  );

  const capabilities = constructors.makeDxCapabilities({
    collectors: [],
    defaultRepo: home.dftHome,
    operation: service.run,
    registry: buildRegistry([], [], []),
    storePath: home.storePath,
  });

  return { backend, capability: capabilities[9] };
});

const firstConfigurationSession = Effect.fn(
  "fixture.s05.firstConfigurationSession"
)(function* firstConfigurationSession(
  opened: OpenedEventStore,
  home: LiveHome,
  onApply: () => void,
  constructors: ConfigurationConstructors
) {
  const { backend, capability } = yield* configurationCapability(
    opened,
    home,
    onApply,
    constructors
  );

  const before = yield* readLiveConfig(home);

  const preview = yield* backend.previewAdministration(
    { action: "cursor-usage", enabled: true, kind: "configure" },
    configurationBounds
  );

  const target = yield* opened.agentService.identity;

  const plan = yield* capability.handler({
    request: {
      action: "plan",
      arguments: {
        expectedContentDigest: preview.configDigest,
        kind: "configure",
        path: configPath(home),
        settings: { action: "cursor-usage", enabled: "true" },
      },
      bounds: configurationBounds,
      purpose: "Enable usage only in the labelled S05 configuration fixture",
      scope: configurationScope,
      target,
    },
  });

  if (plan.action !== "plan") {
    return yield* Effect.die(new Error("Configuration did not return a plan"));
  }

  const afterPlanning = yield* readLiveConfig(home);

  const input: ApplyInput = {
    action: "apply",
    confirmation: "configure cursor-usage true",
    consentReceiptIds: [],
    expectedDigest: plan.plan.planDigest,
    idempotencyKey: "fixture:s05:configure",
    plan: plan.plan,
  };

  const denied = yield* capability
    .handler({
      request: { ...input, confirmation: "fixture:wrong-confirmation" },
    })
    .pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Predicate.isTagged(error, "AgentError")
            ? Effect.succeed(error)
            : Effect.fail(error),
        onSuccess: () =>
          Effect.die(new Error("Incorrect confirmation was accepted")),
      })
    );

  const applied = yield* capability.handler({ request: input });

  if (applied.action !== "apply") {
    return yield* Effect.die(
      new Error("Configuration did not return an apply receipt")
    );
  }

  const persisted = yield* capability.handler({
    request: { action: "get", operation: applied.receipt },
  });

  if (persisted.action !== "get") {
    return yield* Effect.die(
      new Error("Configuration receipt could not be retrieved")
    );
  }

  const after = yield* readLiveConfig(home);

  return {
    after,
    afterPlanning,
    applied,
    before,
    denied,
    input,
    persisted,
    plan: plan.plan,
  };
});

const reopenedConfigurationSession = Effect.fn(
  "fixture.s05.reopenedConfigurationSession"
)(function* reopenedConfigurationSession(
  opened: OpenedEventStore,
  home: LiveHome,
  input: ApplyInput,
  applied: Applied,
  onApply: () => void,
  constructors: ConfigurationConstructors
) {
  const { capability } = yield* configurationCapability(
    opened,
    home,
    onApply,
    constructors
  );

  const resumed = yield* capability.handler({
    request: { action: "get", operation: applied.receipt },
  });

  if (resumed.action !== "get") {
    return yield* Effect.die(
      new Error("Reopened store did not return the retained receipt")
    );
  }

  const replayed = yield* capability.handler({ request: input });

  if (replayed.action !== "apply") {
    return yield* Effect.die(
      new Error("Configuration replay did not return an apply receipt")
    );
  }

  return { replayed, resumed };
});

export const exerciseConfiguration = Effect.fn(
  "fixture.s05.exerciseConfiguration"
)(function* exerciseConfiguration(
  storePath: string,
  root: string,
  constructors: ConfigurationConstructors
): Effect.fn.Return<ConfigurationExerciseResult, ConfigurationFailure> {
  const home = liveHome(root, storePath);

  let applyCount = 0;

  const onApply = () => {
    applyCount += 1;
  };

  yield* writeLiveConfig(home, { cursorUsageImport: false, repos: [] });

  const initial = yield* withConfigurationStore(storePath, (opened) =>
    firstConfigurationSession(opened, home, onApply, constructors)
  );

  const reopened = yield* withConfigurationStore(storePath, (opened) =>
    reopenedConfigurationSession(
      opened,
      home,
      initial.input,
      initial.applied,
      onApply,
      constructors
    )
  );

  return {
    after: initial.after,
    afterPlanning: initial.afterPlanning,
    applied: initial.applied,
    applyCount,
    before: initial.before,
    configFile: configPath(home),
    denied: initial.denied,
    persisted: initial.persisted,
    plan: initial.plan,
    ...reopened,
  };
});
