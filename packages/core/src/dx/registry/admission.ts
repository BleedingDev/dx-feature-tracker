import { CONTRACT_VERSION } from "../contracts/version.js";
import type { ModuleDescriptor } from "../model/descriptor.js";

export type RejectionReason =
  | "not-ready"
  | "contract-mismatch"
  | "duplicate-id"
  | "missing-fixture";

export interface AdmissionRejection {
  readonly id: string;
  readonly reason: RejectionReason;
  readonly readiness: ModuleDescriptor["readiness"];
}

export interface AdmissionResult {
  readonly admitted: readonly ModuleDescriptor[];
  readonly listed: readonly ModuleDescriptor[];
  readonly rejected: readonly AdmissionRejection[];
}

export interface AdmissionOptions {
  readonly contractVersion?: string;
  readonly requireFixtures?: boolean;
}

const admissible = (r: ModuleDescriptor["readiness"]): boolean =>
  r === "ready" || r === "degraded";

const byId = (a: ModuleDescriptor, b: ModuleDescriptor): number =>
  a.id.localeCompare(b.id);

export const admitDescriptors = (
  descriptors: readonly ModuleDescriptor[],
  options: AdmissionOptions = {}
): AdmissionResult => {
  const contractVersion = options.contractVersion ?? CONTRACT_VERSION;
  const seen = new Set<string>();
  const admitted: ModuleDescriptor[] = [];
  const rejected: AdmissionRejection[] = [];

  for (const d of descriptors) {
    const reject = (reason: RejectionReason) =>
      rejected.push({ id: d.id, readiness: d.readiness, reason });

    if (seen.has(d.id)) {
      reject("duplicate-id");
      continue;
    }

    seen.add(d.id);

    if (!admissible(d.readiness)) {
      reject("not-ready");
    } else if (d.contractVersion !== contractVersion) {
      reject("contract-mismatch");
    } else if (options.requireFixtures === true && d.fixtureIds.length === 0) {
      reject("missing-fixture");
    } else {
      admitted.push(d);
    }
  }

  return {
    admitted: admitted.toSorted(byId),
    listed: descriptors.toSorted(byId),
    rejected,
  };
};

export interface DescriptorRef {
  readonly id: string;
  readonly version: string;
}

export const enabledDescriptorRefs = (
  result: AdmissionResult
): readonly DescriptorRef[] =>
  result.admitted.map((d) => ({ id: d.id, version: d.version }));

export const snapshotCompatible = (
  snapshotEnabled: readonly DescriptorRef[],
  current: AdmissionResult
): boolean => {
  const now = new Map<string, string>(
    current.admitted.map((d) => [d.id, d.version])
  );

  return snapshotEnabled.every((ref) => now.get(ref.id) === ref.version);
};

export type NodeStatus =
  | "ready"
  | "degraded"
  | "disabled"
  | "failed"
  | "blocked";

export const eligibleNodes = (
  statuses: Readonly<Record<string, NodeStatus>>
): readonly string[] =>
  Object.entries(statuses)
    .filter(([, s]) => s === "ready" || s === "degraded")
    .map(([id]) => id)
    .toSorted();
