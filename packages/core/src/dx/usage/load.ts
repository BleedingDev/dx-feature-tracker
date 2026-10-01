import { DateTime, Effect, Option } from "effect";

import { EventStore } from "../contracts/event-store.js";
import type { StoreFailure } from "../contracts/services.js";
import { attributeReposIfPossible } from "../correlation/attribution/ambient.js";
import {
  WorktreeTimelines,
  sharedTimelines,
} from "../correlation/branch-at-time/pipeline.js";
import {
  joinAccountRows,
  reattributeIfPossible,
} from "../correlation/branch-at-time/snapshot.js";
import type { DxEventEnvelope } from "../model/event.js";
import { deriveUsageRows, usageOfRows } from "./derive.js";
import type { DerivedRows, UsageFact } from "./fact.js";
import type { DisagreementCount, FactSelection, UsageSource } from "./store.js";
import { UsageFactStore, countDisagreements } from "./store.js";

export interface UsageFactsView {
  readonly builtAt: string | null;
  readonly disagreements: readonly DisagreementCount[];
  readonly facts: number;
  readonly select: (
    selection: FactSelection
  ) => Effect.Effect<readonly UsageFact[], StoreFailure>;
  readonly tools: readonly string[];
  readonly unresolved: number;
}

const EVERYTHING = {
  branch: null,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
} as const;

export const deriveRowsOf = (
  events: readonly DxEventEnvelope[]
): Effect.Effect<DerivedRows> =>
  Effect.gen(function* deriveRows() {
    const placed = yield* attributeReposIfPossible(events);
    const retro = yield* reattributeIfPossible(joinAccountRows(placed));

    return deriveUsageRows(retro.events);
  });

const sourceOf = (store: EventStore["Service"]): UsageSource => {
  const timelines = sharedTimelines();

  return {
    derive: (events) =>
      deriveRowsOf(events).pipe(
        Effect.provideService(WorktreeTimelines, timelines)
      ),
    everything: Effect.map(store.snapshot(EVERYTHING), (snapshot) => [
      ...snapshot.events,
    ]),
  };
};

export const rebuildUsageFacts: Effect.Effect<void, StoreFailure, EventStore> =
  Effect.gen(function* rebuildUsage() {
    const store = yield* EventStore;
    const cache = yield* Effect.serviceOption(UsageFactStore);

    if (Option.isSome(cache)) {
      yield* cache.value.refresh(sourceOf(store));
    }
  });

const toolsOf = (facts: readonly UsageFact[]): readonly string[] =>
  [
    ...new Set(
      facts.flatMap((fact) => (fact.harness === null ? [] : [fact.harness]))
    ),
  ].toSorted();

export const usageFacts: Effect.Effect<
  UsageFactsView,
  StoreFailure,
  EventStore
> = Effect.gen(function* readUsage() {
  const store = yield* EventStore;
  const cache = yield* Effect.serviceOption(UsageFactStore);

  if (Option.isNone(cache)) {
    const snapshot = yield* store.snapshot(EVERYTHING);
    const derived = usageOfRows(yield* deriveRowsOf(snapshot.events));

    return {
      builtAt: DateTime.formatIso(yield* DateTime.now),
      disagreements: countDisagreements(derived.disagreements),
      facts: derived.facts.length,
      select: () => Effect.succeed(derived.facts),
      tools: toolsOf(derived.facts),
      unresolved: derived.unresolved,
    };
  }

  yield* cache.value.refresh(sourceOf(store));

  const summary = yield* cache.value.summary;

  return {
    builtAt: summary.builtAt,
    disagreements: yield* cache.value.disagreements,
    facts: summary.facts,
    select: cache.value.select,
    tools: summary.tools,
    unresolved: summary.unresolved,
  };
});
