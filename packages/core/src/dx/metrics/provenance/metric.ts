import type {
  DxMetric,
  MetricOutput,
  StoreSnapshot,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type {
  AttributionState,
  MeasurementState,
  ValueMethod,
} from "../../model/common.js";
import type { SourceCoverage } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { EvidenceId } from "../../model/ids.js";
import {
  DescriptorIdSchema,
  EvidenceIdSchema,
  MetricIdSchema,
} from "../../model/ids.js";
import type { MetricDefinitionRef, MetricResult } from "../../model/metric.js";
import type { CheckpointEvidence, Located } from "./evidence.js";
import { extractProvenanceEvidence } from "./evidence.js";
import type { FileSurvival } from "./survival.js";
import { projectFileSurvival } from "./survival.js";

export const PROVENANCE_METRIC_VERSION = "1.0.0" as const;

const definition = (
  id: string,
  unit: string,
  description: string
): MetricDefinitionRef => ({
  description,
  id: MetricIdSchema.make(id),
  unit,
  version: PROVENANCE_METRIC_VERSION,
});

export const strictSurvivalDefinition = definition(
  "dx.provenance.ai-line-survival.strict",
  "ratio",
  "Observed AI-introduced line instances still present at the named checkpoint divided by AI-introduced line instances, over files with fully ordered edit/preimage evidence."
);

export const aiLinesIntroducedDefinition = definition(
  "dx.provenance.ai-lines-introduced.observed",
  "lines",
  "AI-introduced line instances observed in resolved files."
);

export const humanRewriteDefinition = definition(
  "dx.provenance.ai-lines-rewritten-by-human.observed",
  "lines",
  "AI line instances removed by an edit carrying human actor evidence. Unknown-actor removals are not counted."
);

export const unresolvedFilesDefinition = definition(
  "dx.provenance.unresolved-files",
  "files",
  "Files whose line lineage could not be resolved strictly; excluded from survival."
);

export const sourceAttributedDefinition = definition(
  "dx.provenance.ai-line-share.source-attributed",
  "ratio",
  "AI line share as reported by the source itself; not observed lineage and never merged with strict survival."
);

export const heuristicSimilarityDefinition = definition(
  "dx.provenance.ai-line-survival.heuristic-similarity",
  "ratio",
  "Experimental semantic-similarity survival. Not implemented; always unsupported."
);

export const provenanceDefinitions: readonly MetricDefinitionRef[] = [
  strictSurvivalDefinition,
  aiLinesIntroducedDefinition,
  humanRewriteDefinition,
  unresolvedFilesDefinition,
  sourceAttributedDefinition,
  heuristicSimilarityDefinition,
];

export const provenanceDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [
    "b33-clean-lineage",
    "b33-unresolved-states",
    "b33-no-evidence",
    "b33-source-attributed",
  ],
  gaps: [
    {
      code: "no-producer",
      message:
        "No collector on this host emits dx.provenance.edit.v1 ordered edit/preimage line-hash evidence or dx.provenance.checkpoint.v1 checkpoints; the metric is fixture-tested only and reports unavailable on real snapshots.",
    },
    {
      code: "formatting-detection",
      message:
        "Formatting-only and rename changes are recognised only when the producer flags them; otherwise they surface as unresolved changes.",
    },
    {
      code: "heuristic-similarity",
      message:
        "Heuristic semantic-similarity survival is not implemented and is always reported unsupported.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metric.provenance"),
  kind: "metric",
  owner: "B33",
  readiness: "disabled",
  requiredInputs: ["dx.provenance.edit.v1", "dx.provenance.checkpoint.v1"],
  supportedFields: provenanceDefinitions.map((def) => def.id),
  version: PROVENANCE_METRIC_VERSION,
};

interface ResultInput {
  readonly asOf: string;
  readonly attribution: AttributionState;
  readonly checkpoint: string | null;
  readonly coverage: readonly SourceCoverage[];
  readonly def: MetricDefinitionRef;
  readonly denominator: number | null;
  readonly evidenceIds: readonly EvidenceId[];
  readonly measurement: MeasurementState;
  readonly method: ValueMethod;
  readonly numerator: number | null;
  readonly reason: string | null;
  readonly value: number | null;
}

const result = (input: ResultInput): MetricResult => ({
  asOf: input.asOf,
  attribution: input.attribution,
  checkpoint: input.checkpoint,
  coverage: input.coverage,
  definition: input.def,
  denominator: input.denominator,
  evidenceIds: input.evidenceIds,
  measurement: input.measurement,
  method: input.method,
  metricId: input.def.id,
  numerator: input.numerator,
  reason: input.reason,
  unit: input.def.unit,
  value: input.value,
});

const timeOf = (located: Located<unknown>): string =>
  located.event.occurredAt ?? located.event.observedAt;

const selectCheckpointName = (
  checkpoints: readonly Located<CheckpointEvidence>[]
): string | null => {
  const [latest] = [...checkpoints].toSorted((a, b) =>
    timeOf(a) < timeOf(b) ? 1 : -1
  );

  return latest === undefined ? null : latest.value.checkpoint;
};

const sum = (
  files: readonly FileSurvival[],
  pick: (file: FileSurvival) => number
): number => files.reduce((total, file) => total + pick(file), 0);

const heuristicResult = (
  asOf: string,
  coverage: readonly SourceCoverage[]
): MetricResult =>
  result({
    asOf,
    attribution: "not-applicable",
    checkpoint: null,
    coverage,
    def: heuristicSimilarityDefinition,
    denominator: null,
    evidenceIds: [],
    measurement: "unsupported",
    method: "estimated",
    numerator: null,
    reason: "Heuristic semantic-similarity survival is not implemented.",
    value: null,
  });

const sourceAttributedResult = (
  asOf: string,
  coverage: readonly SourceCoverage[],
  located: ReturnType<typeof extractProvenanceEvidence>["sourceAttributed"]
): MetricResult => {
  const usable = located.filter(
    (item) =>
      item.value.aiLines !== null &&
      item.value.totalLines !== null &&
      item.value.totalLines > 0
  );

  const evidenceIds = usable.map((item) =>
    EvidenceIdSchema.make(item.event.eventId)
  );

  const numerator = usable.reduce(
    (total, item) => total + (item.value.aiLines ?? 0),
    0
  );

  const denominator = usable.reduce(
    (total, item) => total + (item.value.totalLines ?? 0),
    0
  );

  if (denominator === 0) {
    return result({
      asOf,
      attribution: "not-applicable",
      checkpoint: null,
      coverage,
      def: sourceAttributedDefinition,
      denominator: null,
      evidenceIds,
      measurement: "unavailable",
      method: "source-reported",
      numerator: null,
      reason:
        located.length === 0
          ? "No source-attributed AI line share evidence in snapshot."
          : "Source-attributed evidence lacks AI or total line counts.",
      value: null,
    });
  }

  return result({
    asOf,
    attribution: "provisional",
    checkpoint: null,
    coverage,
    def: sourceAttributedDefinition,
    denominator,
    evidenceIds,
    measurement: usable.length === located.length ? "measured" : "partial",
    method: "source-reported",
    numerator,
    reason: `Reported by ${[...new Set(usable.map((item) => item.value.sourceName))].join(", ")}; not observed lineage.`,
    value: numerator / denominator,
  });
};

const relevantCoverage = (
  snapshot: StoreSnapshot,
  adapterIds: ReadonlySet<string>
): readonly SourceCoverage[] =>
  snapshot.coverage.filter((cov) => adapterIds.has(cov.adapterId));

const unavailableReason = (
  editCount: number,
  checkpointName: string | null,
  introduced: number,
  partialReason: string
): string | null => {
  if (editCount === 0) {
    return "No ordered edit/preimage provenance evidence in snapshot.";
  }

  if (checkpointName === null) {
    return "No named checkpoint observed; strict survival requires one.";
  }

  if (introduced === 0) {
    const suffix = partialReason === "" ? "" : `; ${partialReason}`;

    return `No AI-introduced line instances in resolved files${suffix}.`;
  }

  return null;
};

export const computeProvenance = (snapshot: StoreSnapshot): MetricOutput => {
  const asOf = snapshot.manifest.createdAt;
  const evidence = extractProvenanceEvidence(snapshot.events);

  const adapterIds = new Set(
    [...evidence.edits, ...evidence.checkpoints].map(
      (item) => item.event.adapterId
    )
  );

  const coverage = relevantCoverage(snapshot, adapterIds);
  const checkpointName = selectCheckpointName(evidence.checkpoints);

  const filePaths = [
    ...new Set(evidence.edits.map((edit) => edit.value.filePath)),
  ].toSorted();

  const files = filePaths.map((filePath) =>
    projectFileSurvival(
      filePath,
      evidence.edits.filter((edit) => edit.value.filePath === filePath),
      evidence.checkpoints.find(
        (cp) =>
          cp.value.filePath === filePath &&
          cp.value.checkpoint === checkpointName
      ) ?? null
    )
  );

  const resolved = files.filter((file) => file.unresolved === null);
  const unresolved = files.filter((file) => file.unresolved !== null);
  const introduced = sum(resolved, (file) => file.aiIntroduced);
  const surviving = sum(resolved, (file) => file.aiSurviving);
  const humanRewritten = sum(resolved, (file) => file.aiRemovedByHuman);
  const evidenceIds = files.flatMap((file) => file.evidenceIds);

  const coverageIncomplete =
    coverage.length === 0 || coverage.some((cov) => cov.state !== "complete");

  const partial =
    unresolved.length > 0 ||
    evidence.malformed.length > 0 ||
    coverageIncomplete;

  const unresolvedSummary = [
    ...new Set(unresolved.map((file) => file.unresolved ?? "")),
  ]
    .toSorted()
    .join(", ");

  const partialReason = [
    unresolved.length > 0
      ? `${unresolved.length} file(s) unresolved (${unresolvedSummary}) and excluded`
      : null,
    evidence.malformed.length > 0
      ? `${evidence.malformed.length} malformed provenance event(s) ignored`
      : null,
    coverageIncomplete ? "observed-generation coverage not complete" : null,
  ]
    .filter((part) => part !== null)
    .join("; ");

  const reasonOr = (fallback: string | null): string | null =>
    partialReason === "" ? fallback : partialReason;

  const survivalUnavailableReason = unavailableReason(
    evidence.edits.length,
    checkpointName,
    introduced,
    partialReason
  );

  const state: MeasurementState = partial ? "partial" : "measured";

  const survival =
    survivalUnavailableReason === null
      ? result({
          asOf,
          attribution: "strong",
          checkpoint: checkpointName,
          coverage,
          def: strictSurvivalDefinition,
          denominator: introduced,
          evidenceIds,
          measurement: state,
          method: "observed",
          numerator: surviving,
          reason: reasonOr(null),
          value: surviving / introduced,
        })
      : result({
          asOf,
          attribution: "unassigned",
          checkpoint: checkpointName,
          coverage,
          def: strictSurvivalDefinition,
          denominator: null,
          evidenceIds,
          measurement: "unavailable",
          method: "observed",
          numerator: null,
          reason: survivalUnavailableReason,
          value: null,
        });

  const hasLineage = evidence.edits.length > 0 && checkpointName !== null;

  const count = (
    def: MetricDefinitionRef,
    value: number,
    attribution: AttributionState
  ): MetricResult =>
    hasLineage
      ? result({
          asOf,
          attribution,
          checkpoint: checkpointName,
          coverage,
          def,
          denominator: null,
          evidenceIds,
          measurement: state,
          method: "observed",
          numerator: null,
          reason: reasonOr(null),
          value,
        })
      : result({
          asOf,
          attribution: "unassigned",
          checkpoint: checkpointName,
          coverage,
          def,
          denominator: null,
          evidenceIds,
          measurement: "unavailable",
          method: "observed",
          numerator: null,
          reason:
            survivalUnavailableReason ?? "No provenance lineage in snapshot.",
          value: null,
        });

  return {
    findings: [],
    results: [
      survival,
      count(aiLinesIntroducedDefinition, introduced, "strong"),
      count(humanRewriteDefinition, humanRewritten, "strong"),
      count(unresolvedFilesDefinition, unresolved.length, "not-applicable"),
      sourceAttributedResult(asOf, coverage, evidence.sourceAttributed),
      heuristicResult(asOf, coverage),
    ],
  };
};

export const provenanceMetric: DxMetric = {
  compute: computeProvenance,
  definitions: provenanceDefinitions,
  descriptor: provenanceDescriptor,
};
