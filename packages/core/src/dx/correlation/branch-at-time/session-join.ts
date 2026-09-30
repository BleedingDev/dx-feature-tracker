import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../../model/event.js";

const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString);

const UNSPLIT_PARENT_NOTE =
  "tokens of this chat could not be split per subagent; they stay on the parent chat's branch";

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

const isJoinedRow = (event: DxEventEnvelope): boolean =>
  event.payload.sessionJoin !== undefined && event.payload.sessionJoin !== null;

const isAccountRow = (event: DxEventEnvelope): boolean =>
  event.context.repoCommonDir === null || isJoinedRow(event);

const parentSessionIds = (
  events: readonly DxEventEnvelope[]
): ReadonlySet<string> =>
  new Set(
    events.flatMap((e) =>
      Option.match(decodeText(e.payload.parentSessionId), {
        onNone: () => [],
        onSome: (parent) => [parent],
      })
    )
  );

export const joinAccountRows = (
  events: readonly DxEventEnvelope[]
): readonly DxEventEnvelope[] => {
  const local = new Map<string, DxEventEnvelope[]>();
  const parents = parentSessionIds(events);

  for (const e of events) {
    const { sessionId } = e.identity;

    if (sessionId !== null && sessionId !== "" && !isAccountRow(e)) {
      local.set(sessionId, [...(local.get(sessionId) ?? []), e]);
    }
  }

  return events.map((e) => {
    const { sessionId } = e.identity;

    if (!isAccountRow(e) || sessionId === null) {
      return e;
    }

    const members = local.get(sessionId) ?? [];
    const nearest = nearestInTime(members, e);

    if (nearest === undefined) {
      return e;
    }

    const join = {
      attribution: "provisional",
      branchFrom: nearest.eventId,
      method: "nearest-session-event",
    };

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
        sessionJoin: parents.has(sessionId)
          ? { ...join, note: UNSPLIT_PARENT_NOTE, unsplitParent: true }
          : join,
      },
    };
  });
};
