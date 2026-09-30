import { Effect, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type {
  EventStoreService,
  StoreFailure,
  StoreSnapshot,
} from "../../contracts/services.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import { summarizeAttribution } from "./attribute.js";
import type { BranchAttributionSummary } from "./attribute.js";
import { reattributeHistoricalBranches } from "./pipeline.js";

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

const instantOf = (event: DxEventEnvelope): number | null => {
  const ms = Date.parse(event.occurredAt ?? event.observedAt);

  return Number.isNaN(ms) ? null : ms;
};

const nearestInTime = (
  candidates: readonly DxEventEnvelope[],
  target: DxEventEnvelope
): DxEventEnvelope | undefined => {
  const at = instantOf(target);

  if (at === null) {
    return candidates[0];
  }

  let best: DxEventEnvelope | undefined;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const t = instantOf(candidate);
    const gap = t === null ? Number.POSITIVE_INFINITY : Math.abs(t - at);

    if (best === undefined || gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }

  return best;
};

export const joinAccountRows = (
  events: readonly DxEventEnvelope[]
): readonly DxEventEnvelope[] => {
  const local = new Map<string, DxEventEnvelope[]>();

  for (const e of events) {
    const { sessionId } = e.identity;

    if (
      sessionId !== null &&
      sessionId !== "" &&
      e.context.repoCommonDir !== null
    ) {
      local.set(sessionId, [...(local.get(sessionId) ?? []), e]);
    }
  }

  return events.map((e) => {
    const { sessionId } = e.identity;

    if (e.context.repoCommonDir !== null || sessionId === null) {
      return e;
    }

    const members = local.get(sessionId) ?? [];
    const nearest = nearestInTime(members, e);

    if (nearest === undefined) {
      return e;
    }

    const withWorktree = nearestInTime(
      members.filter((m) => m.context.worktreePath !== null),
      e
    );

    return {
      ...e,
      context: {
        ...e.context,
        branch: nearest.context.branch,
        flightId: nearest.context.flightId,
        repoCommonDir: nearest.context.repoCommonDir,
        worktreePath:
          withWorktree?.context.worktreePath ?? nearest.context.worktreePath,
      },
      payload: {
        ...e.payload,
        sessionJoin: {
          attribution: "provisional",
          branchFrom: nearest.eventId,
          method: "nearest-session-event",
        },
      },
    };
  });
};

const joinWithinRepo = (
  repoEvents: readonly DxEventEnvelope[],
  accountRows: readonly DxEventEnvelope[],
  repoCommonDir: string | null
): readonly DxEventEnvelope[] =>
  joinAccountRows([
    ...new Map(
      [...repoEvents, ...accountRows].map((e) => [e.eventId, e] as const)
    ).values(),
  ]).filter(
    (e) => repoCommonDir === null || e.context.repoCommonDir === repoCommonDir
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

    return joinWithinRepo(
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
    const joined = joinWithinRepo(wide.events, account, selector.repoCommonDir);

    return { events: joined, wide };
  });
