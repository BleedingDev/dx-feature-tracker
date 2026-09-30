import type {
  Correlation,
  CorrelationMapping,
  DxCorrelator,
} from "../../contracts/services.js";
import type { OverlapGroup } from "../../model/ai.js";
import type { AttributionState } from "../../model/common.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type {
  EvidenceId,
  OverlapGroupId,
  RequestKey,
} from "../../model/ids.js";
import { attributeBranch, buildBranchIndex } from "./branch-join.js";
import type { BranchAttribution } from "./branch-join.js";
import { compareText, toClaim } from "./claim.js";
import type { AiClaim, ClaimAmount } from "./claim.js";
import { aiCorrelationDescriptor } from "./descriptor.js";
import { amountKey, bucketOf, emptyTally, summarize } from "./fractions.js";
import type {
  AllocationBucket,
  FractionSummary,
  MutableTally,
} from "./fractions.js";
import { resolveOverlap } from "./overlap.js";
import type { ClaimCluster } from "./overlap.js";

export type ClaimRole =
  | "preferred"
  | "duplicate"
  | "single"
  | "unresolved"
  | "alternative";

export interface ClaimAttribution {
  readonly attribution: AttributionState;
  readonly branch: string | null;
  readonly branchEvidenceIds: readonly EvidenceId[];
  readonly bucket: AllocationBucket | "excluded";
  readonly eventId: string;
  readonly groupId: OverlapGroupId | null;
  readonly reason: string;
  readonly requestAttribution: AttributionState;
  readonly requestKey: RequestKey | null;
  readonly role: ClaimRole;
  readonly sourceKind: string;
  readonly turnKey: string | null;
}

export interface BranchAllocation {
  readonly amounts: Readonly<
    Record<string, { readonly provisional: number; readonly strong: number }>
  >;
  readonly branch: string;
  readonly provisionalUnits: number;
  readonly strongUnits: number;
}

export interface AiCorrelationResult {
  readonly alternatives: readonly {
    readonly amounts: readonly ClaimAmount[];
    readonly eventId: string;
    readonly sourceKind: string;
  }[];
  readonly branches: readonly BranchAllocation[];
  readonly claims: readonly ClaimAttribution[];
  readonly fractions: {
    readonly amounts: Readonly<Record<string, FractionSummary>>;
    readonly units: FractionSummary;
  };
  readonly overlapGroups: readonly OverlapGroup[];
}

interface ClusterDecision {
  readonly bucket: AllocationBucket;
  readonly branch: BranchAttribution;
  readonly representative: AiClaim;
}

const decideCluster = (
  cluster: ClaimCluster,
  attributions: ReadonlyMap<string, BranchAttribution>
): ClusterDecision | null => {
  const representative = cluster.preferred ?? cluster.members[0];

  if (representative === undefined) {
    return null;
  }

  const unresolved = cluster.group?.resolution === "unresolved";
  const own = attributions.get(representative.event.eventId);

  const placed = cluster.members
    .map((member) => attributions.get(member.event.eventId))
    .filter(
      (entry): entry is BranchAttribution =>
        entry !== undefined && entry.branch !== null
    );

  const names = new Set(placed.map((entry) => entry.branch));

  let branch: BranchAttribution = own ?? {
    attribution: "unassigned",
    branch: null,
    evidenceIds: [],
    reason: "no attribution",
  };

  if (names.size > 1) {
    branch = {
      attribution: "unassigned",
      branch: null,
      evidenceIds: placed.flatMap((entry) => entry.evidenceIds),
      reason: `overlap members disagree on branch: ${[...names].join(",")}`,
    };
  } else if (branch.branch === null) {
    const strongest =
      placed.find((entry) => entry.attribution === "strong") ?? placed[0];

    if (strongest !== undefined) {
      branch = strongest;
    }
  }

  return {
    branch,
    bucket: bucketOf(branch.attribution, unresolved),
    representative,
  };
};

const roleOf = (cluster: ClaimCluster, claim: AiClaim): ClaimRole => {
  if (cluster.group?.resolution === "unresolved") {
    return "unresolved";
  }

  if (cluster.members.length === 1) {
    return "single";
  }

  return cluster.preferred === claim ? "preferred" : "duplicate";
};

const add = (
  tallies: Map<string, MutableTally>,
  key: string,
  bucket: AllocationBucket,
  value: number
) => {
  const tally = tallies.get(key) ?? emptyTally();
  tally[bucket] += value;
  tallies.set(key, tally);
};

interface BranchEntry {
  amounts: Map<string, { strong: number; provisional: number }>;
  provisional: number;
  strong: number;
}

interface Accumulator {
  readonly amountTallies: Map<string, MutableTally>;
  readonly branches: Map<string, BranchEntry>;
  readonly rows: ClaimAttribution[];
  readonly unitTally: MutableTally;
}

const allocateBranch = (acc: Accumulator, decision: ClusterDecision) => {
  const { bucket, branch, representative } = decision;

  if (bucket === "unallocated" || bucket === "unresolved") {
    return;
  }

  if (branch.branch === null) {
    return;
  }

  const entry = acc.branches.get(branch.branch) ?? {
    amounts: new Map<string, { strong: number; provisional: number }>(),
    provisional: 0,
    strong: 0,
  };

  entry[bucket] += 1;

  for (const amount of representative.amounts) {
    const key = amountKey(amount, representative.estimated);
    const slot = entry.amounts.get(key) ?? { provisional: 0, strong: 0 };

    slot[bucket] += amount.value;
    entry.amounts.set(key, slot);
  }

  acc.branches.set(branch.branch, entry);
};

const memberRow = (
  cluster: ClaimCluster,
  decision: ClusterDecision,
  member: AiClaim,
  own: BranchAttribution | undefined
): ClaimAttribution => {
  const { branch, bucket } = decision;
  const requestKey = cluster.group?.requestKey ?? member.requestKey;

  const memberNote =
    own !== undefined && own.reason !== branch.reason
      ? ` (member: ${own.reason})`
      : "";

  return {
    attribution: branch.attribution,
    branch: branch.branch,
    branchEvidenceIds: branch.evidenceIds,
    bucket,
    eventId: member.event.eventId,
    groupId: cluster.group?.groupId ?? null,
    reason: `${branch.reason}${memberNote}`,
    requestAttribution: requestKey === null ? "unassigned" : "strong",
    requestKey,
    role: roleOf(cluster, member),
    sourceKind: member.sourceKind,
    turnKey: member.turnKey,
  };
};

const accumulate = (
  acc: Accumulator,
  cluster: ClaimCluster,
  attributions: ReadonlyMap<string, BranchAttribution>
) => {
  const decision = decideCluster(cluster, attributions);

  if (decision === null) {
    return;
  }

  const { bucket, representative } = decision;

  acc.unitTally[bucket] += 1;

  for (const amount of representative.amounts) {
    add(
      acc.amountTallies,
      amountKey(amount, representative.estimated),
      bucket,
      amount.value
    );
  }

  allocateBranch(acc, decision);

  for (const member of cluster.members) {
    acc.rows.push(
      memberRow(
        cluster,
        decision,
        member,
        attributions.get(member.event.eventId)
      )
    );
  }
};

const alternativeRow = (
  claim: AiClaim,
  groups: readonly OverlapGroup[],
  own: BranchAttribution | undefined
): ClaimAttribution => ({
  attribution: "unassigned",
  branch: null,
  branchEvidenceIds: [],
  bucket: "excluded",
  eventId: claim.event.eventId,
  groupId:
    groups.find(
      (group) =>
        group.resolution === "alternative" &&
        group.memberEvidenceIds[0] === claim.evidenceId
    )?.groupId ?? null,
  reason: own?.reason ?? "aggregate ledger",
  requestAttribution: "unassigned",
  requestKey: null,
  role: "alternative",
  sourceKind: claim.sourceKind,
  turnKey: null,
});

export const correlateAi = (
  events: readonly DxEventEnvelope[],
  mappings: readonly CorrelationMapping[] = []
): AiCorrelationResult => {
  const claims = events.flatMap((event) => {
    const claim = toClaim(event);

    return claim === null ? [] : [claim];
  });

  const index = buildBranchIndex(events, mappings);

  const attributions = new Map(
    claims.map((claim) => [claim.event.eventId, attributeBranch(claim, index)])
  );

  const overlap = resolveOverlap(claims);

  const acc: Accumulator = {
    amountTallies: new Map(),
    branches: new Map(),
    rows: [],
    unitTally: emptyTally(),
  };

  for (const cluster of overlap.clusters) {
    accumulate(acc, cluster, attributions);
  }

  for (const claim of overlap.alternatives) {
    acc.rows.push(
      alternativeRow(
        claim,
        overlap.groups,
        attributions.get(claim.event.eventId)
      )
    );
  }

  return {
    alternatives: overlap.alternatives.map((claim) => ({
      amounts: claim.amounts,
      eventId: claim.event.eventId,
      sourceKind: claim.sourceKind,
    })),
    branches: [...acc.branches.entries()]
      .toSorted(([a], [b]) => compareText(a, b))
      .map(([branch, entry]) => ({
        amounts: Object.fromEntries(entry.amounts),
        branch,
        provisionalUnits: entry.provisional,
        strongUnits: entry.strong,
      })),
    claims: acc.rows,
    fractions: {
      amounts: Object.fromEntries(
        [...acc.amountTallies.entries()].map(([key, tally]) => [
          key,
          summarize(tally),
        ])
      ),
      units: summarize(acc.unitTally),
    },
    overlapGroups: overlap.groups,
  };
};

export const aiCorrelator: DxCorrelator = {
  correlate: (events, mappings): readonly Correlation[] =>
    correlateAi(events, mappings).claims.map((row) => ({
      attribution: row.attribution,
      eventId: row.eventId,
      evidenceIds: row.branchEvidenceIds,
      reason: `${row.role}${row.groupId === null ? "" : ` in ${row.groupId}`}: ${row.reason}`,
      target: row.branch,
      targetKind: "branch",
    })),
  descriptor: aiCorrelationDescriptor,
};
