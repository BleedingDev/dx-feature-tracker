import {
  allCollectors,
  AgentRequestSchema,
  buildRegistry,
  defaultCostOptions,
  defaultPriceProvider,
  loadUserPriceTable,
  makeDxCapabilities,
  metricsWithCost,
  priceCatalogEnabled,
  selectPriceTable,
  InvalidInput,
} from "@rat-stack/core/dx";
import type { PriceProvider } from "@rat-stack/core/dx";
import { Console, Effect, Schema } from "effect";

import {
  installedAgentCatalog,
  runInstalledLearning,
  runInstalledOperation,
} from "./dft-agent-runtime.js";

export interface AgentFlagValues {
  readonly acquisition?: string | undefined;
  readonly agentProfile?: string | undefined;
  readonly basis?: string | undefined;
  readonly budgetDecodedBytes?: number | undefined;
  readonly budgetElapsedMs?: number | undefined;
  readonly budgetFacts?: number | undefined;
  readonly budgetItems?: number | undefined;
  readonly budgetNetworkRequests?: number | undefined;
  readonly budgetOutputBytes?: number | undefined;
  readonly budgetSeriesBuckets?: number | undefined;
  readonly budgetStacks?: number | undefined;
  readonly cursor?: string | undefined;
  readonly derivation?: string | undefined;
  readonly detail?: string | undefined;
  readonly learning?: string | undefined;
  readonly previousBasis?: string | undefined;
  readonly prices?: string | undefined;
}

export const agentRequestFrom = (flags: AgentFlagValues) =>
  Effect.gen(function* agentRequest() {
    if (flags.agentProfile === undefined) {
      const keys = [
        "acquisition",
        "basis",
        "budgetDecodedBytes",
        "budgetElapsedMs",
        "budgetFacts",
        "budgetItems",
        "budgetNetworkRequests",
        "budgetOutputBytes",
        "budgetSeriesBuckets",
        "budgetStacks",
        "cursor",
        "derivation",
        "detail",
        "learning",
        "previousBasis",
        "prices",
      ] as const;

      if (keys.some((key) => flags[key] !== undefined)) {
        return yield* new InvalidInput({
          field: "agent-profile",
          message: "Agent query flags require --agent-profile dx.agent.v1.",
        });
      }

      return yield* Effect.void;
    }

    return yield* Schema.decodeUnknownEffect(AgentRequestSchema, {
      onExcessProperty: "error",
    })({
      basisId: flags.basis,
      budget: {
        maxDecodedBytes: flags.budgetDecodedBytes ?? 1_048_576,
        maxElapsedMs: flags.budgetElapsedMs ?? 5000,
        maxFacts: flags.budgetFacts ?? 1000,
        maxItems: flags.budgetItems ?? 20,
        maxNetworkRequests: flags.budgetNetworkRequests ?? 0,
        maxOutputBytes: flags.budgetOutputBytes ?? 16_384,
        maxSeriesBuckets: flags.budgetSeriesBuckets ?? 32,
        maxStacks: flags.budgetStacks ?? 8,
      },
      detail: flags.detail ?? "summary",
      policies: {
        acquisition: flags.acquisition ?? "recorded-only",
        derivation: flags.derivation ?? "ready-only",
        learning: flags.learning ?? "hidden",
        prices: flags.prices ?? "cached-only",
      },
      previousBasisId: flags.previousBasis,
      profileVersion: flags.agentProfile,
    }).pipe(
      Effect.mapError(
        () =>
          new InvalidInput({
            field: "agent-profile",
            message: "Unsupported agent profile, policy or query budget.",
          })
      )
    );
  });

export type CostOptions = NonNullable<
  Parameters<typeof makeDxCapabilities>[0]["costOptions"]
>;

export interface CapabilitySelector {
  readonly allRepos: boolean;
  readonly branch: string | null;
  readonly from: string | null;
}

export const providerCostOptions = (provider: PriceProvider): CostOptions => ({
  priceBook: provider.book,
  priceTable: provider.table,
  subscription: null,
});

export interface PriceEffects {
  readonly networkRequests: number | null;
  readonly origin: "user" | "bundled" | "cache" | "fresh" | "skipped";
  readonly reason: string | null;
  readonly refreshPermitted: boolean;
}

export const costSessionFor = (dftHome: string) =>
  Effect.gen(function* costOptions() {
    const userTable = yield* loadUserPriceTable(dftHome);
    const selection = selectPriceTable(userTable);

    if (selection.warning !== null) {
      yield* Console.error(selection.warning);
    }

    if (userTable.kind === "loaded") {
      return {
        costOptions: defaultCostOptions(userTable) satisfies CostOptions,
        prices: {
          networkRequests: 0,
          origin: "user",
          reason: null,
          refreshPermitted: false,
        } satisfies PriceEffects,
      };
    }

    const catalog = priceCatalogEnabled(process.env);
    const provider = yield* defaultPriceProvider(dftHome, catalog);

    if (catalog && provider.warnings.length > 0) {
      yield* Console.error(provider.warnings.join("\n"));
    }

    return {
      costOptions: providerCostOptions(provider),
      prices: {
        networkRequests: catalog ? null : 0,
        origin: provider.origin,
        reason: catalog
          ? "The legacy price provider does not measure network request counts."
          : null,
        refreshPermitted: catalog,
      } satisfies PriceEffects,
    };
  });

export const costOptionsFor = (dftHome: string) =>
  costSessionFor(dftHome).pipe(Effect.map((session) => session.costOptions));

export const capabilitiesFor = (input: {
  readonly costOptions: CostOptions;
  readonly resolveCostOptions?: (() => CostOptions) | undefined;
  readonly persistSnapshots?: boolean;
  readonly repo: string;
  readonly selector: CapabilitySelector;
  readonly storePath: string;
}) => {
  const deps = {
    agentCatalog: installedAgentCatalog,
    collectors: allCollectors,
    costOptions: input.costOptions,
    defaultRepo: input.repo,
    learning: runInstalledLearning,
    operation: runInstalledOperation,
    persistSnapshots: input.persistSnapshots ?? true,
    registry: buildRegistry(allCollectors, metricsWithCost(input.costOptions)),
    selector: input.selector,
    storePath: input.storePath,
  };

  return input.resolveCostOptions === undefined
    ? makeDxCapabilities(deps)
    : makeDxCapabilities({
        ...deps,
        resolveCostOptions: input.resolveCostOptions,
      });
};

export const capabilityAt = (
  capabilities: ReturnType<typeof capabilitiesFor>
) => {
  const [
    status,
    analyze,
    explain,
    evidence,
    collect,
    mark,
    history,
    chats,
    usage,
    operation,
    learning,
  ] = capabilities;

  return {
    analyze,
    chats,
    collect,
    evidence,
    explain,
    history,
    learning,
    mark,
    operation,
    status,
    usage,
  };
};
