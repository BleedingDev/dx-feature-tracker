import { OverlapPolicy } from "../../model/ai.js";
import type { OverlapGroup } from "../../model/ai.js";
import { OverlapGroupIdSchema } from "../../model/ids.js";
import { compareClaims } from "./claim.js";
import type { AiClaim } from "./claim.js";

export const DEFAULT_PROXIMITY_MS = 60_000;

export interface ClaimCluster {
  readonly group: OverlapGroup | null;
  readonly members: readonly AiClaim[];
  readonly preferred: AiClaim | null;
}

export interface OverlapResult {
  readonly alternatives: readonly AiClaim[];
  readonly clusters: readonly ClaimCluster[];
  readonly groups: readonly OverlapGroup[];
  readonly unassigned: readonly AiClaim[];
}

const find = (parent: number[], index: number): number => {
  let root = index;

  while (parent[root] !== root) {
    root = parent[root] ?? root;
  }

  return root;
};

const strongClusters = (claims: readonly AiClaim[]): AiClaim[][] => {
  const parent = claims.map((_, index) => index);
  const owner = new Map<string, number>();

  for (const [index, claim] of claims.entries()) {
    for (const key of claim.strongKeys) {
      const seen = owner.get(key);

      if (seen === undefined) {
        owner.set(key, index);
      } else {
        parent[find(parent, index)] = find(parent, seen);
      }
    }
  }

  const byRoot = new Map<number, AiClaim[]>();

  for (const [index, claim] of claims.entries()) {
    const root = find(parent, index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), claim]);
  }

  return [...byRoot.values()].map((members) => members.toSorted(compareClaims));
};

const groupId = (kind: string, members: readonly AiClaim[]) =>
  OverlapGroupIdSchema.make(
    `ai-overlap:${kind}:${members.map((member) => member.event.eventId).join("+")}`
  );

const collapsed = (members: readonly AiClaim[]): ClaimCluster => {
  const [preferred] = members;
  const sources = [...new Set(members.map((member) => member.sourceKind))];

  const sameTurnOnly =
    sources.length === 1 &&
    members.every((member) => member.turnKey === preferred?.turnKey);

  return {
    group: {
      groupId: groupId("collapsed", members),
      memberEvidenceIds: members.map((member) => member.evidenceId),
      preferredEvidenceId: preferred?.evidenceId ?? null,
      reason: sameTurnOnly
        ? `duplicate emissions of turn ${preferred?.turnKey ?? "?"} from ${sources.join(",")} collapse to one`
        : `shared strong request/turn id across ${sources.join(",")}; ${preferred?.sourceKind ?? "?"} preferred by its harness channel precedence`,
      requestKey: preferred?.requestKey ?? null,
      resolution: sameTurnOnly
        ? OverlapPolicy.duplicateStopSameTurn
        : OverlapPolicy.sameRequestKey,
    },
    members,
    preferred: preferred ?? null,
  };
};

const near = (a: AiClaim, b: AiClaim, windowMs: number) =>
  a.occurredMs !== null &&
  b.occurredMs !== null &&
  Math.abs(a.occurredMs - b.occurredMs) <= windowMs;

export const resolveOverlap = (
  claims: readonly AiClaim[],
  windowMs: number = DEFAULT_PROXIMITY_MS
): OverlapResult => {
  const aggregates = claims.filter((claim) => claim.aggregate);
  const detail = claims.filter((claim) => !claim.aggregate);
  const keyed = detail.filter((claim) => claim.strongKeys.length > 0);
  const keyless = detail.filter((claim) => claim.strongKeys.length === 0);

  const clusters: ClaimCluster[] = strongClusters(keyed).map((members) =>
    members.length > 1
      ? collapsed(members)
      : { group: null, members, preferred: members[0] ?? null }
  );

  const unassigned: AiClaim[] = [];

  for (const claim of keyless.toSorted(compareClaims)) {
    const neighbours = keyed.filter(
      (other) =>
        other.sourceKind !== claim.sourceKind && near(claim, other, windowMs)
    );

    if (neighbours.length === 0) {
      unassigned.push(claim);
      clusters.push({ group: null, members: [claim], preferred: null });
      continue;
    }

    const members = [claim, ...neighbours];
    clusters.push({
      group: {
        groupId: groupId("unresolved", members),
        memberEvidenceIds: members.map((member) => member.evidenceId),
        preferredEvidenceId: null,
        reason: `no strong id on ${claim.sourceKind} claim; within ${String(windowMs)}ms of ${neighbours.map((n) => n.sourceKind).join(",")} claims (time proximity only, never summed)`,
        requestKey: null,
        resolution: OverlapPolicy.noStrongKey,
      },
      members: [claim],
      preferred: null,
    });
  }

  const alternativeGroups: OverlapGroup[] = aggregates.map((claim) => ({
    groupId: groupId("alternative", [claim]),
    memberEvidenceIds: [
      claim.evidenceId,
      ...detail.flatMap((other) =>
        other.event.adapterId === claim.event.adapterId
          ? []
          : [other.evidenceId]
      ),
    ],
    preferredEvidenceId: null,
    reason: `${claim.sourceKind} is an aggregate ledger; alternative view of detail claims, never summed with them`,
    requestKey: null,
    resolution: OverlapPolicy.aggregateVsDetail,
  }));

  return {
    alternatives: aggregates,
    clusters,
    groups: [
      ...clusters.flatMap((cluster) =>
        cluster.group === null ? [] : [cluster.group]
      ),
      ...alternativeGroups,
    ],
    unassigned,
  };
};
