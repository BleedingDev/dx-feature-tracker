import type { CollectCursor, SourceGap } from "../../model/coverage.js";
import { emptyFlightContext } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FlightContext,
} from "../../model/event.js";
import {
  OMP_ADAPTER_ID,
  ompRequestEvent,
  ompSessionEvent,
  ompTurnEvent,
} from "./events.js";
import type { OmpEventInput, OmpPlacement, OmpSessionFacts } from "./events.js";
import type { OmpHeader, OmpRequest, ParsedOmpSession } from "./parse.js";
import { requestTokenTotal } from "./parse.js";
import { isInside } from "./paths.js";
import { statsMismatch } from "./stats.js";
import type { OmpStatsTotal } from "./stats.js";

export interface Ancestor {
  readonly id: string;
  readonly present: boolean;
  readonly timestamp: string | null;
}

export interface Owner {
  readonly id: string;
  readonly present: boolean;
}

export const timeOf = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }

  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? null : ms;
};

const ancestorOwner = (
  lineage: readonly Ancestor[],
  at: number,
  fallback: string
): Owner => {
  for (const ancestor of lineage) {
    const born = timeOf(ancestor.timestamp);

    if (!ancestor.present || born === null || at >= born) {
      return { id: ancestor.id, present: ancestor.present };
    }
  }

  const last = lineage.at(-1);

  return last === undefined
    ? { id: fallback, present: false }
    : { id: last.id, present: last.present };
};

export const ownerOf = (
  header: OmpHeader,
  lineage: readonly Ancestor[],
  entryAt: string | null
): Owner => {
  const at = timeOf(entryAt);
  const created = timeOf(header.timestamp);

  if (
    header.parentSession === null ||
    at === null ||
    created === null ||
    at >= created
  ) {
    return { id: header.id, present: true };
  }

  return ancestorOwner(lineage, at, header.parentSession);
};

export interface Placer {
  readonly forTurn: (turnIndex: number) => OmpPlacement | null;
  readonly session: OmpPlacement;
}

export const unplaced: OmpPlacement = {
  branchSource: "unassigned",
  context: emptyFlightContext,
};

export const placementFor = (
  context: FlightContext,
  worktree: string,
  source: "cwd-inferred" | "tool-calls"
): OmpPlacement => ({
  branchSource: context.branch === null ? "unassigned" : source,
  context: { ...context, worktreePath: worktree },
});

export const fixedPlacer = (placement: OmpPlacement): Placer => ({
  forTurn: () => placement,
  session: placement,
});

const turnPaths = (requests: readonly OmpRequest[]) => {
  const byTurn = new Map<number, string[]>();

  for (const request of requests) {
    const paths = byTurn.get(request.turn.index) ?? [];

    paths.push(...request.toolPaths);
    byTurn.set(request.turn.index, paths);
  }

  return byTurn;
};

export const toolCallPlacer = (
  parsed: ParsedOmpSession,
  placement: OmpPlacement,
  worktreeForms: readonly string[]
): Placer => {
  const touched = turnPaths(parsed.requests);

  return {
    forTurn: (turnIndex) =>
      (touched.get(turnIndex) ?? []).some((path) =>
        worktreeForms.some((form) => isInside(path, form))
      )
        ? placement
        : null,
    session: placement,
  };
};

export interface SessionReading {
  readonly facts: OmpSessionFacts;
  readonly header: OmpHeader;
  readonly input: OmpEventInput;
  readonly lineage: readonly Ancestor[];
  readonly parsed: ParsedOmpSession;
  readonly placer: Placer;
}

const ownedHere = (reading: SessionReading, at: string | null) => {
  const owner = ownerOf(reading.header, reading.lineage, at);

  return owner.id === reading.header.id || !owner.present ? owner.id : null;
};

export const sessionEventsOf = (
  reading: SessionReading
): readonly DxEventEnvelope[] => {
  const { header, parsed } = reading;

  const firstRequest = parsed.requests.find(
    (request) => request.model !== null
  );

  const event = ompSessionEvent({
    facts: reading.facts,
    forkedFrom: header.parentSession,
    input: reading.input,
    modelRaw: parsed.state.firstModel,
    placement: reading.placer.session,
    startedAt: header.timestamp,
    thinkingLevel: firstRequest?.effort ?? parsed.state.thinkingLevel,
    title: parsed.slotTitle ?? parsed.state.title,
  });

  return event === null ? [] : [event];
};

export const turnEventsOf = (
  reading: SessionReading
): readonly DxEventEnvelope[] => {
  const { parsed } = reading;
  const lastTurn = parsed.turns.at(-1);

  return parsed.turns.flatMap((turn) => {
    const placement = reading.placer.forTurn(turn.start.index);
    const owner = ownedHere(reading, turn.start.at);

    const first =
      parsed.requests.find(
        (request) => request.turn.index === turn.start.index
      ) ?? null;

    if (
      placement === null ||
      owner === null ||
      (first === null && turn === lastTurn)
    ) {
      return [];
    }

    const event = ompTurnEvent({
      facts: reading.facts,
      first,
      input: reading.input,
      owner,
      placement,
      turn,
    });

    return event === null ? [] : [event];
  });
};

export const requestEventsOf = (
  reading: SessionReading
): readonly DxEventEnvelope[] =>
  reading.parsed.requests.flatMap((request) => {
    const placement = reading.placer.forTurn(request.turn.index);
    const owner = ownedHere(reading, request.timestamp);

    return placement === null || owner === null
      ? []
      : [
          ompRequestEvent({
            facts: reading.facts,
            input: reading.input,
            owner,
            placement,
            request,
          }),
        ];
  });

export const parseGaps = (parsed: ParsedOmpSession): readonly SourceGap[] => [
  ...(parsed.invalidLines > 0
    ? [
        {
          code: "invalid-lines",
          message: `${parsed.invalidLines} line(s) are not valid JSON and were skipped`,
        },
      ]
    : []),
  ...(parsed.unrecognizedLines > 0
    ? [
        {
          code: "unrecognized-lines",
          message: `${parsed.unrecognizedLines} line(s) did not match the OMP entry format and were skipped`,
        },
      ]
    : []),
];

export const statsGaps = (
  stats: OmpStatsTotal | undefined,
  parsed: ParsedOmpSession
): readonly SourceGap[] => {
  const mismatch = statsMismatch(
    stats,
    parsed.requests.length,
    parsed.requests.reduce(
      (sum, request) => sum + requestTokenTotal(request),
      0
    )
  );

  return mismatch === null
    ? []
    : [
        {
          code: "stats-db-differs",
          message: `OMP stats.db has ${mismatch.statsRows} request(s) and ${mismatch.statsTokens} tokens for this file; the session file has ${mismatch.fileRows} and ${mismatch.fileTokens}`,
        },
      ];
};

export const batchOf = (
  events: readonly DxEventEnvelope[],
  gaps: readonly SourceGap[],
  cursor: CollectCursor | null
): EventBatch => ({
  coverage: {
    adapterId: OMP_ADAPTER_ID,
    expectedItems: null,
    gaps: [...gaps],
    observedItems: events.length,
    state: gaps.some((gap) => gap.code === "invalid-lines")
      ? "partial"
      : "complete",
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor,
  events,
});
