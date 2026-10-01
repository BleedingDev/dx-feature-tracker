import {
  allCollectors,
  buildRegistry,
  defaultCostOptions,
  defaultPriceProvider,
  loadUserPriceTable,
  makeDxCapabilities,
  metricsWithCost,
  selectPriceTable,
} from "@rat-stack/core/dx";
import { Console, Effect } from "effect";

export type CostOptions = NonNullable<
  Parameters<typeof makeDxCapabilities>[0]["costOptions"]
>;

export interface CapabilitySelector {
  readonly allRepos: boolean;
  readonly branch: string | null;
  readonly from: string | null;
}

export const costOptionsFor = (dftHome: string, home: string) =>
  Effect.gen(function* costOptions() {
    const userTable = yield* loadUserPriceTable(dftHome);
    const selection = selectPriceTable(userTable);

    if (selection.warning !== null) {
      yield* Console.error(selection.warning);
    }

    if (userTable.kind === "loaded") {
      return defaultCostOptions(userTable) satisfies CostOptions;
    }

    const provider = yield* defaultPriceProvider(home);

    if (provider.warnings.length > 0) {
      yield* Console.error(provider.warnings.join("\n"));
    }

    return {
      priceBook: provider.book,
      priceTable: provider.table,
      subscription: null,
    } satisfies CostOptions;
  });

export const capabilitiesFor = (input: {
  readonly costOptions: CostOptions;
  readonly repo: string;
  readonly selector: CapabilitySelector;
  readonly storePath: string;
}) =>
  makeDxCapabilities({
    collectors: allCollectors,
    costOptions: input.costOptions,
    defaultRepo: input.repo,
    registry: buildRegistry(allCollectors, metricsWithCost(input.costOptions)),
    selector: input.selector,
    storePath: input.storePath,
  });

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
  ] = capabilities;

  return {
    analyze,
    chats,
    collect,
    evidence,
    explain,
    history,
    mark,
    status,
    usage,
  };
};
