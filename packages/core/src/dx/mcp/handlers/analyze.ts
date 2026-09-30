import { Effect } from "effect";

import type { InvalidInput } from "../../contracts/error-invalid-input.js";
import type { SnapshotNotFound } from "../../contracts/error-snapshot-not-found.js";
import { EventStore } from "../../contracts/event-store.js";
import type {
  DxMetric,
  MetricOutput,
  StoreFailure,
  StoreSnapshot,
} from "../../contracts/services.js";
import type { AnalyzeReport } from "../../model/report.js";
import type { VersionedId } from "../../model/snapshot.js";
import { composeAnalyzeReport } from "../../reports/analyze/compose.js";
import { selectAnalyzeSnapshot } from "../../reports/analyze/select.js";
import type { DxHandlerDeps } from "./deps.js";
import { parseQuery } from "./selector.js";
import type { QueryInput } from "./selector.js";
import { sortedDescriptors } from "./status.js";

const versionedKey = (v: VersionedId): string => `${v.id}@${v.version}`;

const uniqueSorted = (items: readonly VersionedId[]): VersionedId[] => {
  const seen = new Map<string, VersionedId>();

  for (const item of items) {
    seen.set(versionedKey(item), { id: item.id, version: item.version });
  }

  return [...seen.values()].toSorted((a, b) =>
    versionedKey(a).localeCompare(versionedKey(b))
  );
};

export const enabledDescriptorIds = (deps: DxHandlerDeps): VersionedId[] =>
  uniqueSorted(
    sortedDescriptors(deps.descriptors)
      .filter((d) => d.readiness === "ready" || d.readiness === "degraded")
      .map((d) => ({ id: d.id, version: d.version }))
  );

export const metricDefinitionIds = (deps: DxHandlerDeps): VersionedId[] =>
  uniqueSorted(
    deps.metrics.flatMap((m) =>
      m.definitions.map((d) => ({ id: d.id, version: d.version }))
    )
  );

interface ComputedOutputs {
  readonly outputs: readonly MetricOutput[];
  readonly notes: readonly string[];
}

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message.slice(0, 200) : "non-error thrown";

export const computeMetrics = (
  metrics: readonly DxMetric[],
  snapshot: StoreSnapshot
): ComputedOutputs => {
  const outputs: MetricOutput[] = [];
  const notes: string[] = [];

  for (const metric of metrics) {
    try {
      outputs.push(metric.compute(snapshot));
    } catch (error) {
      notes.push(
        `Metric module ${metric.descriptor.id} failed and contributed nothing: ${describeError(error)}`
      );
    }
  }

  return { notes, outputs };
};

const definitionDriftNote = (
  stored: readonly VersionedId[],
  current: readonly VersionedId[]
): string[] => {
  const storedKeys = stored.map(versionedKey).join(",");
  const currentKeys = current.map(versionedKey).join(",");

  return stored.length > 0 && storedKeys !== currentKeys
    ? [
        `Pinned snapshot recorded metric definitions [${storedKeys}]; current modules are [${currentKeys}], so some values may come from different definitions.`,
      ]
    : [];
};

export type AnalyzeFailure = StoreFailure | SnapshotNotFound | InvalidInput;

export const handleAnalyze = (
  deps: DxHandlerDeps,
  input: QueryInput
): Effect.Effect<AnalyzeReport, AnalyzeFailure, EventStore> =>
  Effect.gen(function* analyzeHandler() {
    const store = yield* EventStore;
    const query = yield* parseQuery(input, deps.resolveSelector);
    const selected = yield* selectAnalyzeSnapshot(store, query);
    const metricDefinitions = metricDefinitionIds(deps);

    const snapshot: StoreSnapshot =
      selected.mode === "pinned"
        ? selected.snapshot
        : {
            ...selected.snapshot,
            manifest: {
              ...selected.snapshot.manifest,
              enabledDescriptors: enabledDescriptorIds(deps),
              metricDefinitions,
            },
          };

    if (selected.mode !== "pinned") {
      yield* store.putSnapshotManifest(snapshot.manifest);
    }

    const computed = computeMetrics(deps.metrics, snapshot);

    const persistence =
      selected.mode === "pinned"
        ? []
        : [
            `Persisted snapshot metadata ${snapshot.manifest.snapshotId}; reuse it with snapshotId for explain/evidence.`,
          ];

    return composeAnalyzeReport(snapshot, computed.outputs, [
      ...selected.disclosures,
      ...persistence,
      ...(selected.mode === "pinned"
        ? definitionDriftNote(
            selected.snapshot.manifest.metricDefinitions,
            metricDefinitions
          )
        : []),
      ...computed.notes,
    ]);
  });
