import type {
  AiSourceKind,
  LedgerKind,
  OverlapGroup,
  TokenCategory,
} from "../../model/ai.js";
import { AI_SOURCE_PRECEDENCE } from "../../model/ai.js";
import type { ValueMethod } from "../../model/common.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { EvidenceId } from "../../model/ids.js";
import { OverlapGroupIdSchema, RequestKeySchema } from "../../model/ids.js";
import type { AiUsageRow, UncoveredUsage } from "./normalize.js";
import { normalizeAiUsage } from "./normalize.js";

export interface LedgerTotal {
  readonly category: TokenCategory;
  readonly currency: string | null;
  readonly evidenceIds: readonly EvidenceId[];
  readonly ledger: LedgerKind;
  readonly methods: readonly ValueMethod[];
  readonly sources: readonly AiSourceKind[];
  readonly value: number;
}

export interface AlternativeLedger {
  readonly sourceKind: AiSourceKind;
  readonly totals: readonly LedgerTotal[];
}

export interface AiUsageAccount {
  readonly alternatives: readonly AlternativeLedger[];
  readonly duplicateRowsCollapsed: number;
  readonly groups: readonly OverlapGroup[];
  readonly requestCount: number;
  readonly totals: readonly LedgerTotal[];
  readonly uncovered: readonly UncoveredUsage[];
  readonly unresolved: readonly LedgerTotal[];
  readonly usageEvents: number;
}

const rank = (kind: AiSourceKind): number => {
  const index = AI_SOURCE_PRECEDENCE.indexOf(kind);

  return index === -1 ? AI_SOURCE_PRECEDENCE.length : index;
};

const slotOf = (row: AiUsageRow): string =>
  `${row.ledger}|${row.category}|${row.currency ?? ""}`;

const sumRows = (rows: readonly AiUsageRow[]): LedgerTotal[] => {
  const bySlot = new Map<string, AiUsageRow[]>();

  for (const row of rows) {
    const slot = slotOf(row);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), row]);
  }

  return [...bySlot.values()]
    .map((members) => {
      const [first] = members;

      return {
        category: first?.category ?? "other",
        currency: first?.currency ?? null,
        evidenceIds: [
          ...new Set(members.map((row) => row.evidenceId)),
        ].toSorted(),
        ledger: first?.ledger ?? "unallocated",
        methods: [...new Set(members.map((row) => row.method))].toSorted(),
        sources: [...new Set(members.map((row) => row.sourceKind))].toSorted(),
        value: members.reduce((total, row) => total + row.value, 0),
      };
    })
    .toSorted((a, b) =>
      `${a.ledger}|${a.category}`.localeCompare(`${b.ledger}|${b.category}`)
    );
};

const groupByKeys = (rows: readonly AiUsageRow[]): AiUsageRow[][] => {
  const parent = new Map<string, string>();

  const find = (key: string): string => {
    let current = key;

    while (parent.get(current) !== current) {
      current = parent.get(current) ?? current;
    }

    parent.set(key, current);

    return current;
  };

  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  for (const row of rows) {
    const node = `evidence:${row.evidenceId}`;

    if (!parent.has(node)) {
      parent.set(node, node);
    }

    for (const key of row.matchKeys) {
      if (!parent.has(key)) {
        parent.set(key, key);
      }

      union(node, key);
    }
  }

  const groups = new Map<string, AiUsageRow[]>();

  for (const row of rows) {
    const root = find(`evidence:${row.evidenceId}`);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  }

  return [...groups.values()];
};

const pickPerSlot = (members: readonly AiUsageRow[]): AiUsageRow[] => {
  const best = new Map<string, AiUsageRow>();

  for (const row of members.toSorted(
    (a, b) =>
      rank(a.sourceKind) - rank(b.sourceKind) ||
      a.evidenceId.localeCompare(b.evidenceId)
  )) {
    const slot = slotOf(row);

    if (!best.has(slot)) {
      best.set(slot, row);
    }
  }

  return [...best.values()];
};

const overlapGroup = (
  members: readonly AiUsageRow[],
  chosen: readonly AiUsageRow[]
): OverlapGroup => {
  const memberEvidenceIds = [
    ...new Set(members.map((row) => row.evidenceId)),
  ].toSorted();

  const key = members[0]?.matchKeys[0] ?? memberEvidenceIds[0] ?? "none";

  const preferred =
    chosen.toSorted((a, b) => rank(a.sourceKind) - rank(b.sourceKind))[0] ??
    null;

  const sources = [...new Set(members.map((row) => row.sourceKind))];

  return {
    groupId: OverlapGroupIdSchema.make(`ai-usage:${key}`),
    memberEvidenceIds,
    preferredEvidenceId: preferred?.evidenceId ?? null,
    reason:
      sources.length > 1
        ? `same request/turn reported by ${sources.toSorted().join(", ")}; per-field source precedence applied`
        : "duplicate emissions of one request/turn collapsed",
    requestKey: RequestKeySchema.make(key),
    resolution: "collapsed",
  };
};

const detailSlotsBySource = (rows: readonly AiUsageRow[]) => {
  const slots = new Map<string, Set<AiSourceKind>>();

  for (const row of rows) {
    const slot = slotOf(row);
    const set = slots.get(slot) ?? new Set<AiSourceKind>();
    set.add(row.sourceKind);
    slots.set(slot, set);
  }

  return slots;
};

const REQUEST_PREFIX = "request:";

interface BridgedRows {
  readonly ambiguous: readonly AiUsageRow[];
  readonly rows: readonly AiUsageRow[];
}

const sessionlessRequestIds = (row: AiUsageRow): string[] =>
  row.matchKeys.every((key) => key.startsWith(REQUEST_PREFIX))
    ? row.matchKeys.map((key) => key.slice(REQUEST_PREFIX.length))
    : [];

const sessionKeysById = (rows: readonly AiUsageRow[]) => {
  const byId = new Map<string, Set<string>>();

  for (const row of rows) {
    for (const key of row.matchKeys) {
      const id = /^session:(?<session>.+):id:(?<id>.+)$/u.exec(key)?.groups?.id;

      if (id !== undefined) {
        byId.set(id, (byId.get(id) ?? new Set<string>()).add(key));
      }
    }
  }

  return byId;
};

const bridgeRequestKeys = (rows: readonly AiUsageRow[]): BridgedRows => {
  const byId = sessionKeysById(rows);
  const bridged: AiUsageRow[] = [];
  const ambiguous: AiUsageRow[] = [];

  for (const row of rows) {
    const aliases = sessionlessRequestIds(row).flatMap((id) => [
      ...(byId.get(id) ?? []),
    ]);

    if (aliases.length > 1) {
      ambiguous.push(row);
    } else {
      bridged.push(
        aliases.length === 0
          ? row
          : { ...row, matchKeys: [...row.matchKeys, ...aliases] }
      );
    }
  }

  return { ambiguous, rows: bridged };
};

const dedupeIdentical = (rows: readonly AiUsageRow[]): AiUsageRow[] => {
  const seen = new Map<string, AiUsageRow>();

  for (const row of rows) {
    const identity = `${row.evidenceId}|${slotOf(row)}`;

    if (!seen.has(identity)) {
      seen.set(identity, row);
    }
  }

  return [...seen.values()];
};

interface DetailPartition {
  readonly ambiguous: readonly AiUsageRow[];
  readonly duplicateUnkeyed: number;
  readonly keyedGroups: readonly AiUsageRow[][];
  readonly unkeyed: readonly AiUsageRow[];
}

const partitionDetail = (detail: readonly AiUsageRow[]): DetailPartition => {
  const bridged = bridgeRequestKeys(
    detail.filter((row) => row.matchKeys.length > 0)
  );

  const rawUnkeyed = detail.filter((row) => row.matchKeys.length === 0);
  const unkeyed = dedupeIdentical(rawUnkeyed);

  return {
    ambiguous: dedupeIdentical(bridged.ambiguous),
    duplicateUnkeyed: rawUnkeyed.length - unkeyed.length,
    keyedGroups: groupByKeys(bridged.rows),
    unkeyed,
  };
};

const unresolvedGroup = (row: AiUsageRow, reason: string): OverlapGroup => ({
  groupId: OverlapGroupIdSchema.make(`ai-usage:unresolved:${row.evidenceId}`),
  memberEvidenceIds: [row.evidenceId],
  preferredEvidenceId: null,
  reason,
  requestKey: null,
  resolution: "unresolved",
});

export const accountAiUsage = (
  events: readonly DxEventEnvelope[]
): AiUsageAccount => {
  const normalized = normalizeAiUsage(events);
  const detail = normalized.rows.filter((row) => row.scope === "detail");
  const aggregate = normalized.rows.filter((row) => row.scope === "aggregate");

  const { ambiguous, duplicateUnkeyed, keyedGroups, unkeyed } =
    partitionDetail(detail);

  const slotSources = detailSlotsBySource(detail);

  const counted: AiUsageRow[] = [];
  const groups: OverlapGroup[] = [];
  let duplicateRowsCollapsed = duplicateUnkeyed;

  for (const members of keyedGroups) {
    const chosen = pickPerSlot(members);
    counted.push(...chosen);
    duplicateRowsCollapsed += members.length - chosen.length;

    if (new Set(members.map((row) => row.evidenceId)).size > 1) {
      groups.push(overlapGroup(members, chosen));
    }
  }

  const unresolvedRows: AiUsageRow[] = [];

  for (const row of unkeyed) {
    const sources = slotSources.get(slotOf(row));

    if (sources !== undefined && sources.size > 1) {
      unresolvedRows.push(row);
    } else {
      counted.push(row);
    }
  }

  const unresolvedIds = new Set<EvidenceId>();

  for (const row of unresolvedRows) {
    if (!unresolvedIds.has(row.evidenceId)) {
      unresolvedIds.add(row.evidenceId);
      groups.push(
        unresolvedGroup(
          row,
          `no request/turn key while other sources report ${row.ledger}/${row.category}; kept unassigned, not summed`
        )
      );
    }
  }

  for (const row of ambiguous) {
    if (!unresolvedIds.has(row.evidenceId)) {
      unresolvedIds.add(row.evidenceId);
      groups.push(
        unresolvedGroup(
          row,
          "request id matches generations in more than one session; kept unassigned, not summed"
        )
      );
    }
  }

  const aggregateSources = [
    ...new Set(aggregate.map((row) => row.sourceKind)),
  ].toSorted();

  const alternatives = aggregateSources.map((sourceKind) => ({
    sourceKind,
    totals: sumRows(aggregate.filter((row) => row.sourceKind === sourceKind)),
  }));

  for (const alternative of alternatives) {
    groups.push({
      groupId: OverlapGroupIdSchema.make(
        `ai-usage:alternative:${alternative.sourceKind}`
      ),
      memberEvidenceIds: [
        ...new Set(alternative.totals.flatMap((total) => total.evidenceIds)),
      ].toSorted(),
      preferredEvidenceId: null,
      reason:
        "aggregate ledger may include detail usage; reported as an alternative, never summed",
      requestKey: null,
      resolution: "alternative",
    });
  }

  const unkeyedEvents = new Set(
    unkeyed
      .filter((row) => !unresolvedRows.includes(row))
      .map((row) => row.evidenceId)
  );

  return {
    alternatives,
    duplicateRowsCollapsed,
    groups,
    requestCount: keyedGroups.length + unkeyedEvents.size,
    totals: sumRows(counted),
    uncovered: normalized.uncovered,
    unresolved: sumRows([...unresolvedRows, ...ambiguous]),
    usageEvents: normalized.usageEvents,
  };
};

export const UNASSIGNED_BRANCH = "(no branch)" as const;

const branchOfGroup = (members: readonly AiUsageRow[]): string | null => {
  const known = [
    ...new Set(
      members.flatMap((row) => (row.branch === null ? [] : [row.branch]))
    ),
  ];

  if (known.length <= 1) {
    return known[0] ?? null;
  }

  const best = Math.min(...members.map((row) => rank(row.sourceKind)));

  const strongest = [
    ...new Set(
      members.flatMap((row) =>
        rank(row.sourceKind) === best && row.branch !== null ? [row.branch] : []
      )
    ),
  ];

  return strongest.length === 1 ? (strongest[0] ?? null) : null;
};

export const assignedBranches = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, string | null> => {
  const detail = normalizeAiUsage(events).rows.filter(
    (row) => row.scope === "detail"
  );

  const { ambiguous, keyedGroups, unkeyed } = partitionDetail(detail);
  const assigned = new Map<string, string | null>();

  for (const members of [
    ...keyedGroups,
    ...[...ambiguous, ...unkeyed].map((row) => [row]),
  ]) {
    const branch = branchOfGroup(members);

    for (const row of members) {
      assigned.set(row.evidenceId, branch);
    }
  }

  return assigned;
};

export const accountAiUsageByBranch = (
  events: readonly DxEventEnvelope[]
): ReadonlyMap<string, AiUsageAccount> => {
  const assigned = assignedBranches(events);
  const byBranch = new Map<string, DxEventEnvelope[]>();

  for (const event of events) {
    const attributed = assigned.has(event.eventId)
      ? assigned.get(event.eventId)
      : event.context.branch;

    const branch = attributed ?? UNASSIGNED_BRANCH;
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), event]);
  }

  return new Map(
    [...byBranch.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([branch, members]) => [branch, accountAiUsage(members)])
  );
};
