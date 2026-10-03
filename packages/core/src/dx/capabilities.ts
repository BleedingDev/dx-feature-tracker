import { implement } from "@rat-stack/capability/define";
import { DateTime, Effect, Option } from "effect";

import * as DxChats from "./chats/capability.js";
import type { dxChatsContract } from "./chats/contract.js";
import { runCollect } from "./cli/commands/collect.js";
import {
  MANUAL_ADAPTER_ID,
  buildMarkerEvent,
} from "./collectors/manual/marker.js";
import { AgentStore } from "./contracts/agent-store.js";
import { dxLearningContract, dxOperationContract } from "./contracts/agent.js";
import type { AgentFailure } from "./contracts/agent.js";
import { dxCollectContract, dxMarkContract } from "./contracts/capabilities.js";
import { InvalidInput } from "./contracts/error-invalid-input.js";
import { SourceUnavailable } from "./contracts/error-source-unavailable.js";
import { EventStore } from "./contracts/event-store.js";
import type { StoreFailure } from "./contracts/services.js";
import { CONTRACT_VERSION } from "./contracts/version.js";
import * as DxHistory from "./history/capability.js";
import type { dxHistoryContract } from "./history/contract.js";
import {
  agentUnavailable,
  normalizeAgentSelectors,
  selectorStrings,
} from "./mcp/handlers/agent-query.js";
import * as DxQueryHandlers from "./mcp/handlers/capabilities.js";
import type { SelectorResolver } from "./mcp/handlers/deps.js";
import { isolateStdout } from "./mcp/handlers/stdio.js";
import type { CostOptions } from "./metrics/cost/metric.js";
import type { AgentScope } from "./model/agent-common.js";
import type { LearningInput, LearningOutput } from "./model/agent-learning.js";
import type {
  OperationInput,
  OperationOutput,
  OperationDescriptor,
} from "./model/agent-operation.js";
import type { AgentQueryInput, AgentQueryOutput } from "./model/agent-query.js";
import type { ModuleDescriptor } from "./model/descriptor.js";
import type { EventBatch } from "./model/event.js";
import { DescriptorIdSchema } from "./model/ids.js";
import type { DxRegistry, RegisteredCollector } from "./registry/registry.js";
import { metricsWithCost } from "./registry/registry.js";
import {
  contextForRepo,
  gitSelectorResolver,
  hookSpoolDirFor,
} from "./registry/runtime.js";
import { runAgentQuery } from "./reports/agent/query.js";
import * as DxUsage from "./usage/capability.js";
import type { DxUsageInputType, DxUsageOutputType } from "./usage/contract.js";
import { dxUsageContract } from "./usage/contract.js";

export interface DxSelectorOverrides {
  readonly allRepos?: boolean;
  readonly branch?: string | null;
  readonly from?: string | null;
}

export interface DxCapabilityDeps {
  readonly registry: DxRegistry;
  readonly collectors: readonly RegisteredCollector[];
  readonly costOptions?: CostOptions;
  readonly resolveCostOptions?: () => CostOptions;
  readonly operation?: (
    input: OperationInput
  ) => Effect.Effect<OperationOutput, AgentFailure>;
  readonly learning?: (
    input: LearningInput
  ) => Effect.Effect<LearningOutput, AgentFailure>;
  readonly agentCatalog?: () => Effect.Effect<{
    readonly operation: boolean;
    readonly learning: boolean;
    readonly operations: readonly OperationDescriptor[];
  }>;
  readonly defaultRepo: string;
  readonly persistSnapshots?: boolean;
  readonly selector?: DxSelectorOverrides;
  readonly storePath: string;
}

const nonEmptyOrNull = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

export const withSelectorOverrides = (
  base: SelectorResolver,
  overrides: DxSelectorOverrides = {}
): SelectorResolver => {
  const branch = nonEmptyOrNull(overrides.branch);
  const from = nonEmptyOrNull(overrides.from);

  return (input) =>
    Effect.map(base(input), (selector) => ({
      ...selector,
      branch: overrides.allRepos === true ? null : (branch ?? selector.branch),
      from: from ?? selector.from,
      repoCommonDir:
        overrides.allRepos === true ? null : selector.repoCommonDir,
    }));
};

const CURSOR_HOOKS_SOURCE = "collector.cursor-hooks";

export const canonicalSource = (
  collectors: readonly RegisteredCollector[],
  source: string
): string => {
  const trimmed = source.trim();
  const ids = new Set<string>(collectors.map((c) => c.descriptor.id));

  const alias = [trimmed, `collector.${trimmed}`, `collector/${trimmed}`].find(
    (candidate) => ids.has(candidate)
  );

  return alias ?? trimmed;
};

export const defaultInputFor = (
  source: string,
  worktreePath: string | null
): string | null =>
  source === CURSOR_HOOKS_SOURCE && worktreePath !== null
    ? hookSpoolDirFor(worktreePath)
    : null;

const serviceDescriptor = (
  name: "operation" | "learning",
  enabled: boolean
): ModuleDescriptor => ({
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [],
  gaps: enabled
    ? []
    : [
        {
          code: "service-not-composed",
          message: `The ${name} service is disabled in this installed composition.`,
        },
      ],
  id: DescriptorIdSchema.make(`dx.service.${name}`),
  kind: "service",
  owner: name === "operation" ? "S03" : "S04",
  readiness: enabled ? "ready" : "disabled",
  requiredInputs: ["AgentStore"],
  supportedFields: enabled
    ? [name === "operation" ? "dx_operation" : "dx_learning"]
    : [],
  version: "1.0.0",
});

const operationDescriptor = (item: OperationDescriptor): ModuleDescriptor => ({
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [],
  gaps: item.enabled
    ? []
    : [
        {
          code: "operation-not-supported",
          message: item.reason ?? "This effect is not supported.",
        },
      ],
  id: DescriptorIdSchema.make(`dx.operation.${item.kind}`),
  kind: "service",
  owner: "S03/S05",
  readiness: item.enabled ? "ready" : "disabled",
  requiredInputs: item.requiredInputs,
  supportedFields: item.enabled
    ? [
        `dx_operation:${item.kind}`,
        `authorization:${item.authorization}`,
        `cancellation:${item.cancellation}`,
        `idempotency:${item.idempotency}`,
      ]
    : [],
  version: item.version,
});

const validateAgentRead = (input: AgentQueryInput) =>
  Effect.gen(function* validateRead() {
    if (input.selectors.snapshotId !== undefined) {
      return yield* new InvalidInput({
        field: "snapshotId",
        message:
          "Legacy snapshots retain evidence selection only. Select an agent basisId for the negotiated profile.",
      });
    }

    if (
      input.agent.basisId === undefined &&
      input.cursor === undefined &&
      input.agent.policies.prices === "pinned"
    ) {
      return yield* new InvalidInput({
        field: "basisId",
        message: "Pinned prices require a retained basisId or cursor.",
      });
    }

    if (
      input.agent.policies.acquisition !== "recorded-only" ||
      input.agent.policies.prices === "refresh-selected"
    ) {
      return yield* agentUnavailable(
        "Recorded queries require recorded-only acquisition and cached-only or pinned prices. Refresh is an explicit operation."
      );
    }

    if (
      input.agent.basisId === undefined &&
      input.cursor === undefined &&
      input.agent.policies.derivation === "ready-only"
    ) {
      return yield* agentUnavailable(
        "No retained basisId was selected. Choose an available basis or request bounded-refresh derivation."
      );
    }

    return yield* Effect.void;
  });

export const makeDxCapabilities = (deps: DxCapabilityDeps) => {
  const resolveSelector = withSelectorOverrides(
    gitSelectorResolver(deps.defaultRepo),
    deps.selector
  );

  const optionsFor = () => deps.resolveCostOptions?.() ?? deps.costOptions;

  const metricsFor = () => {
    const options = optionsFor();

    return options === undefined
      ? deps.registry.metrics
      : metricsWithCost(options, deps.registry.metrics);
  };

  const scopeFor = (): AgentScope => {
    const context = contextForRepo(deps.defaultRepo);
    const branch = deps.selector?.branch ?? context.branch;
    let branchKind: AgentScope["branchSelection"]["kind"] = "current";

    if (deps.selector?.allRepos === true) {
      branchKind = "all";
    } else if (
      deps.selector?.branch !== undefined &&
      deps.selector.branch !== null
    ) {
      branchKind = "selected";
    }

    return {
      branchSelection: {
        branches:
          branch === null || deps.selector?.allRepos === true ? [] : [branch],
        kind: branchKind,
      },
      flightId: context.flightId,
      repoId: deps.selector?.allRepos === true ? null : context.repoCommonDir,
      resolution:
        deps.selector?.allRepos === true
          ? "Explicit all-repository selection."
          : "Resolved from the configured repository and selected branch.",
      sources: [],
      tools: [],
      worktreeId: context.worktreePath,
    };
  };

  const descriptors = [
    ...deps.registry.descriptors,
    serviceDescriptor("operation", deps.operation !== undefined),
    serviceDescriptor("learning", deps.learning !== undefined),
  ];

  const resolveDescriptors = () =>
    deps.agentCatalog === undefined
      ? Effect.succeed(descriptors)
      : Effect.map(deps.agentCatalog(), (catalog) => [
          ...deps.registry.descriptors,
          serviceDescriptor("operation", catalog.operation),
          serviceDescriptor("learning", catalog.learning),
          ...catalog.operations.map(operationDescriptor),
        ]);

  const agentQuery = (input: AgentQueryInput) =>
    Effect.gen(function* negotiatedQuery() {
      const available = yield* Effect.serviceOption(AgentStore);

      if (Option.isNone(available)) {
        return yield* agentUnavailable(
          "The installed composition has no durable agent store."
        );
      }

      yield* validateAgentRead(input);

      const retained =
        input.agent.basisId !== undefined || input.cursor !== undefined;

      const scope = retained ? undefined : scopeFor();

      const costOptions =
        !retained &&
        (input.capability === "dx_analyze" || input.capability === "dx_usage")
          ? optionsFor()
          : undefined;

      const ids = input.selectors.evidenceIds;

      const selectors = normalizeAgentSelectors(
        input,
        deps.selector?.from,
        deps.selector?.allRepos,
        (repo) => contextForRepo(repo).repoCommonDir
      );

      const request = { ...input, selectors };
      const identity = yield* available.value.identity;

      if (
        ids !== undefined &&
        ids.some((id) => id.trim() === "" || id.length > 256)
      ) {
        return yield* new InvalidInput({
          field: "evidenceIds",
          message:
            "Agent evidence references must contain 1 to 256 characters.",
        });
      }

      const refs =
        ids === undefined
          ? input.refs
          : ids.map((id) => ({
              basisId: null,
              id,
              kind: "evidence" as const,
              storeGeneration: identity.storeGeneration,
              storeId: identity.storeId,
              version: "dx.event.v2",
            }));

      const queryRequest = refs === undefined ? request : { ...request, refs };

      const baseDependencies = {
        descriptors: retained ? descriptors : yield* resolveDescriptors(),
        metrics: deps.registry.metrics,
        store: available.value,
      };

      const scopedDependencies =
        scope === undefined
          ? baseDependencies
          : { ...baseDependencies, defaultScope: scope };

      const queryDependencies =
        costOptions === undefined
          ? scopedDependencies
          : { ...scopedDependencies, costOptions };

      return yield* runAgentQuery(queryRequest, queryDependencies);
    });

  const query = DxQueryHandlers.makeDxQueryCapabilities({
    agentQuery,
    descriptors,
    metrics: deps.registry.metrics,
    persistSnapshots: deps.persistSnapshots ?? true,
    resolveDescriptors,
    resolveMetrics: metricsFor,
    resolveScope: scopeFor,
    resolveSelector,
  });

  const history = {
    ...DxHistory.makeDxHistoryCapability({ defaultRepo: deps.defaultRepo }),
    handler: (input: typeof dxHistoryContract.input.Type) =>
      Effect.suspend(() => {
        const costOptions = optionsFor();

        return DxHistory.makeDxHistoryCapability(
          costOptions === undefined
            ? { defaultRepo: deps.defaultRepo }
            : { costOptions, defaultRepo: deps.defaultRepo }
        ).handler(input);
      }),
  };

  const chats = {
    ...DxChats.makeDxChatsCapability({ resolveSelector }),
    handler: (input: typeof dxChatsContract.input.Type) =>
      Effect.suspend(() => {
        const costOptions = optionsFor();

        return DxChats.makeDxChatsCapability(
          costOptions === undefined
            ? { resolveSelector }
            : { costOptions, resolveSelector }
        ).handler(input);
      }),
  };

  const usage = implement(dxUsageContract, (input) =>
    Effect.suspend<
      DxUsageOutputType | AgentQueryOutput,
      AgentFailure | InvalidInput | StoreFailure,
      EventStore
    >(() => {
      if (input.agentQuery !== undefined) {
        const { agentQuery: agent, cursor, ...selectors } = input;

        const request = {
          agent,
          capability: "dx_usage" as const,
          selectors: selectorStrings(selectors),
        };

        return agentQuery(
          cursor === undefined ? request : { ...request, cursor }
        );
      }

      const costOptions = optionsFor();

      return DxUsage.runUsageQuery(
        input,
        costOptions === undefined ? {} : { costOptions }
      );
    })
  );

  function usageHandler(
    input: DxUsageInputType & {
      readonly agentQuery: NonNullable<DxUsageInputType["agentQuery"]>;
    }
  ): ReturnType<typeof agentQuery>;
  function usageHandler(
    input: Omit<DxUsageInputType, "agentQuery"> & {
      readonly agentQuery?: never;
    }
  ): Effect.Effect<
    DxUsageOutputType,
    AgentFailure | InvalidInput | StoreFailure,
    EventStore
  >;
  function usageHandler(
    input: DxUsageInputType
  ): ReturnType<typeof usage.handler>;
  function usageHandler(
    input: DxUsageInputType
  ): ReturnType<typeof usage.handler> {
    return usage.handler(input);
  }

  const collect = implement(dxCollectContract, (input) =>
    isolateStdout(
      Effect.gen(function* dxCollect() {
        const store = yield* EventStore;

        const context = contextForRepo(
          input.repo ?? deps.defaultRepo,
          input.flight ?? null
        );

        const source = canonicalSource(deps.collectors, input.source);

        const result = yield* runCollect(
          { store, storePath: deps.storePath },
          deps.collectors,
          {
            context,
            input: input.input ?? defaultInputFor(source, context.worktreePath),
            source,
          }
        ).pipe(
          Effect.catchTag("GitHubApiError", (error) =>
            Effect.fail(
              new SourceUnavailable({
                adapterId: input.source,
                message: `GitHub is out of scope: ${error.message}`,
              })
            )
          )
        );

        return {
          adapterId: result.adapterId,
          coverage: result.coverage,
          duplicates: result.duplicates,
          inserted: result.inserted,
        };
      })
    )
  );

  const mark = implement(dxMarkContract, (input) =>
    isolateStdout(
      Effect.gen(function* dxMark() {
        const store = yield* EventStore;
        const context = contextForRepo(input.repo ?? deps.defaultRepo);
        const now = DateTime.formatIso(yield* DateTime.now);

        const event = yield* buildMarkerEvent(
          {
            flight: input.flight,
            kind: input.kind,
            label: input.label,
            note: input.note,
            occurredAt: now,
          },
          { acquisition: "manual", context, observedAt: now, origin: "live" }
        );

        const batch: EventBatch = {
          coverage: {
            adapterId: MANUAL_ADAPTER_ID,
            expectedItems: 1,
            gaps: [],
            observedItems: 1,
            state: "complete",
            watermark: null,
            windowFrom: event.occurredAt,
            windowTo: event.occurredAt,
          },
          cursor: null,
          events: [event],
        };

        yield* store.append(batch);

        return {
          eventId: event.eventId,
          flightId: event.context.flightId ?? "",
        };
      })
    )
  );

  const operation = implement(dxOperationContract, ({ request }) =>
    isolateStdout(
      deps.operation === undefined
        ? Effect.fail(
            agentUnavailable(
              "The operation service is disabled in this installed composition."
            )
          )
        : deps.operation(request)
    )
  );

  const learning = implement(dxLearningContract, ({ request }) =>
    isolateStdout(
      deps.learning === undefined
        ? Effect.fail(
            agentUnavailable(
              "The learning service is disabled in this installed composition."
            )
          )
        : deps.learning(request)
    )
  );

  return [
    ...query,
    collect,
    mark,
    history,
    chats,
    { ...usage, handler: usageHandler },
    operation,
    learning,
  ] as const;
};
