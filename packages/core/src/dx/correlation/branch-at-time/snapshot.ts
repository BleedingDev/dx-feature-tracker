import { Effect, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type {
  EventStoreService,
  StoreFailure,
  StoreSnapshot,
} from "../../contracts/services.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import { attributeReposIfPossible } from "../attribution/ambient.js";
import { summarizeAttribution } from "./attribute.js";
import type { BranchAttributionSummary } from "./attribute.js";
import { reattributeHistoricalBranches } from "./pipeline.js";
import { joinAccountRows } from "./session-join.js";

export { joinAccountRows } from "./session-join.js";

export interface RetroactiveEvents {
  readonly applied: boolean;
  readonly events: readonly DxEventEnvelope[];
  readonly summary: readonly BranchAttributionSummary[];
}

export const reattributeIfPossible = (
  events: readonly DxEventEnvelope[]
): Effect.Effect<RetroactiveEvents> =>
  Effect.gen(function* reattributeOptional() {
    const spawner = yield* Effect.serviceOption(
      ChildProcessSpawner.ChildProcessSpawner
    );

    if (Option.isNone(spawner) || events.length === 0) {
      return { applied: false, events, summary: [] };
    }

    const result = yield* reattributeHistoricalBranches(events).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        spawner.value
      )
    );

    return {
      applied: true,
      events: result.events,
      summary: summarizeAttribution(result.attributions),
    };
  });

export const narrowToBranch = (
  wide: StoreSnapshot,
  selector: SnapshotSelector,
  events: readonly DxEventEnvelope[]
): StoreSnapshot => ({
  ...wide,
  events:
    selector.branch === null
      ? events
      : events.filter((e) => e.context.branch === selector.branch),
  manifest: {
    ...wide.manifest,
    selector: { ...wide.manifest.selector, branch: selector.branch },
  },
});

export const summaryToJson = (summary: readonly BranchAttributionSummary[]) =>
  summary.map((s) => ({
    branch: s.branch,
    byBasis: Object.fromEntries(s.byBasis),
    byMethod: Object.fromEntries(s.byMethod),
    events: s.events,
    movedFromCollectedBranch: s.movedFromCollectedBranch,
  }));

const joinWithinRepo = (
  repoEvents: readonly DxEventEnvelope[],
  accountRows: readonly DxEventEnvelope[],
  repoCommonDir: string | null
): Effect.Effect<readonly DxEventEnvelope[]> =>
  Effect.map(
    attributeReposIfPossible([
      ...new Map(
        [...repoEvents, ...accountRows].map((e) => [e.eventId, e] as const)
      ).values(),
    ]),
    (placed) =>
      joinAccountRows(placed).filter(
        (e) =>
          repoCommonDir === null || e.context.repoCommonDir === repoCommonDir
      )
  );

const accountRowsFor = (
  store: EventStoreService,
  selector: SnapshotSelector
): Effect.Effect<readonly DxEventEnvelope[], StoreFailure> =>
  selector.repoCommonDir === null
    ? Effect.succeed([])
    : Effect.map(
        store.snapshot({
          ...selector,
          branch: null,
          flightId: null,
          repoCommonDir: null,
        }),
        (snapshot) =>
          snapshot.events.filter((e) => e.context.repoCommonDir === null)
      );

export const replayAccountAwareEvents = (
  store: EventStoreService,
  pinned: StoreSnapshot
): Effect.Effect<readonly DxEventEnvelope[], StoreFailure> =>
  Effect.gen(function* replayAccountAware() {
    const { selector, createdAt } = pinned.manifest;
    const account = yield* accountRowsFor(store, selector);
    const createdAtMs = Date.parse(createdAt);

    return yield* joinWithinRepo(
      pinned.events,
      account.filter((e) => Date.parse(e.observedAt) <= createdAtMs),
      selector.repoCommonDir
    );
  });

export const accountAwareEvents = (
  store: EventStoreService,
  selector: SnapshotSelector
): Effect.Effect<
  { readonly wide: StoreSnapshot; readonly events: readonly DxEventEnvelope[] },
  StoreFailure
> =>
  Effect.gen(function* accountAware() {
    const wide = yield* store.snapshot({ ...selector, branch: null });

    const account = yield* accountRowsFor(store, selector);

    const joined = yield* joinWithinRepo(
      wide.events,
      account,
      selector.repoCommonDir
    );

    return { events: joined, wide };
  });
