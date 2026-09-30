import type { AttributionState } from "../../model/common.js";
import type { ClaimAmount } from "./claim.js";

export type AllocationBucket =
  | "strong"
  | "provisional"
  | "unallocated"
  | "unresolved";

export interface FractionSummary {
  readonly allocatedFraction: number | null;
  readonly provisional: number;
  readonly reason: string | null;
  readonly strong: number;
  readonly total: number;
  readonly unallocated: number;
  readonly unresolved: number;
}

export interface MutableTally {
  provisional: number;
  strong: number;
  unallocated: number;
  unresolved: number;
}

export const emptyTally = (): MutableTally => ({
  provisional: 0,
  strong: 0,
  unallocated: 0,
  unresolved: 0,
});

export const bucketOf = (
  attribution: AttributionState,
  unresolvedOverlap: boolean
): AllocationBucket => {
  if (unresolvedOverlap) {
    return "unresolved";
  }

  if (attribution === "strong") {
    return "strong";
  }

  return attribution === "provisional" ? "provisional" : "unallocated";
};

export const amountKey = (amount: ClaimAmount, estimated: boolean): string =>
  `${estimated ? "estimated:" : ""}${amount.ledger}:${amount.category ?? amount.currency ?? "unknown"}`;

export const summarize = (tally: MutableTally): FractionSummary => {
  const total =
    tally.strong + tally.provisional + tally.unallocated + tally.unresolved;

  return {
    allocatedFraction:
      total === 0 ? null : (tally.strong + tally.provisional) / total,
    provisional: tally.provisional,
    reason:
      total === 0 ? "no AI claims with this measure in the snapshot" : null,
    strong: tally.strong,
    total,
    unallocated: tally.unallocated,
    unresolved: tally.unresolved,
  };
};
