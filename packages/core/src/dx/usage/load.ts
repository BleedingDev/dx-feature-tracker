import { DateTime, Effect, Option } from "effect";

import { EventStore } from "../contracts/event-store.js";
import type { EventStoreService, StoreFailure } from "../contracts/services.js";
import {
  joinAccountRows,
  reattributeIfPossible,
} from "../correlation/branch-at-time/snapshot.js";
import { deriveUsageFacts } from "./derive.js";
import type { DerivedUsage, UsageFact } from "./fact.js";
import type { DisagreementCount } from "./store.js";
import { UsageFactStore, countDisagreements } from "./store.js";

export interface UsageFactsView {
  readonly builtAt: string | null;
  readonly disagreements: readonly DisagreementCount[];
  readonly facts: readonly UsageFact[];
  readonly unresolved: number;
}

const EVERYTHING = {
  branch: null,
  flightId: null,
  from: null,
  repoCommonDir: null,
  to: null,
} as const;

export const deriveFromStore = (
  store: EventStoreService
): Effect.Effect<DerivedUsage, StoreFailure> =>
  Effect.gen(function* deriveStored() {
    const snapshot = yield* store.snapshot(EVERYTHING);

    const retro = yield* reattributeIfPossible(
      joinAccountRows(snapshot.events)
    );

    return deriveUsageFacts(retro.events);
  });

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const rebuildUsageFacts: Effect.Effect<
  UsageFactsView,
  StoreFailure,
  EventStore
> = Effect.gen(function* rebuildUsage() {
  const store = yield* EventStore;
  const cache = yield* Effect.serviceOption(UsageFactStore);
  const mark = Option.isSome(cache) ? yield* cache.value.watermark : null;
  const derived = yield* deriveFromStore(store);
  const builtAt = yield* nowIso;

  if (Option.isSome(cache) && mark !== null) {
    yield* cache.value.replace(derived, mark, builtAt);
  }

  return {
    builtAt,
    disagreements: countDisagreements(derived.disagreements),
    facts: derived.facts,
    unresolved: derived.unresolved,
  };
});

export const usageFacts: Effect.Effect<
  UsageFactsView,
  StoreFailure,
  EventStore
> = Effect.gen(function* readUsage() {
  const cache = yield* Effect.serviceOption(UsageFactStore);

  if (Option.isNone(cache)) {
    return yield* rebuildUsageFacts;
  }

  const mark = yield* cache.value.watermark;
  const meta = yield* cache.value.meta;

  if (mark === null || meta === null || meta.watermark !== mark) {
    return yield* rebuildUsageFacts;
  }

  return {
    builtAt: meta.builtAt,
    disagreements: yield* cache.value.disagreements,
    facts: yield* cache.value.facts,
    unresolved: meta.unresolved,
  };
});
