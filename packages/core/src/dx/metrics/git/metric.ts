import type {
  DxMetric,
  MetricOutput,
  StoreSnapshot,
} from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { MeasurementState } from "../../model/common.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type { EvidenceId } from "../../model/ids.js";
import { DescriptorIdSchema, MetricIdSchema } from "../../model/ids.js";
import type { MetricDefinitionRef, MetricResult } from "../../model/metric.js";
import {
  BASE_SHA_DEFINITION,
  GIT_CHURN_SOURCE_ADAPTER_ID,
  summarizeGitChurn,
} from "./summary.js";
import type { GitChurnSummary } from "./summary.js";

export const GIT_CHURN_METRIC_VERSION = "1.0.0" as const;

export const GIT_CHURN_FIXTURE_IDS = [
  "b28-branch-snapshot",
  "b28-live-temp-repo",
] as const;

const definition = (
  id: string,
  unit: string,
  description: string
): MetricDefinitionRef => ({
  description,
  id: MetricIdSchema.make(id),
  unit,
  version: GIT_CHURN_METRIC_VERSION,
});

export const commitsDefinition = definition(
  "dx.git.commits",
  "commits",
  "Distinct commits in baseSha..HEAD, merges included. baseSha is the branch fork point (reflog creation point, closest ancestor branch, or default-branch merge-base, labelled by baseMethod), so a branch created from another feature branch counts only its own commits."
);

export const mergeCommitsDefinition = definition(
  "dx.git.merge-commits",
  "commits",
  "Distinct merge commits in baseSha..HEAD."
);

export const linesAddedDefinition = definition(
  "dx.git.lines-added",
  "lines",
  "Sum of git numstat added lines over non-merge commits in baseSha..HEAD; binary files excluded."
);

export const linesDeletedDefinition = definition(
  "dx.git.lines-deleted",
  "lines",
  "Sum of git numstat deleted lines over non-merge commits in baseSha..HEAD; binary files excluded."
);

export const churnDefinition = definition(
  "dx.git.churn-lines",
  "lines",
  "Committed lines added plus lines deleted in baseSha..HEAD."
);

export const filesChangedDefinition = definition(
  "dx.git.files-changed",
  "files",
  "Distinct paths touched by non-merge commits in baseSha..HEAD."
);

export const filesRetouchedDefinition = definition(
  "dx.git.files-retouched",
  "files",
  "Distinct paths touched by two or more non-merge commits on the branch. An observable rework signal only; it does not claim who reworked or why."
);

export const uncommittedLinesAddedDefinition = definition(
  "dx.git.uncommitted-lines-added",
  "lines",
  "Lines added in the latest observed uncommitted worktree diff against HEAD."
);

export const uncommittedLinesDeletedDefinition = definition(
  "dx.git.uncommitted-lines-deleted",
  "lines",
  "Lines deleted in the latest observed uncommitted worktree diff against HEAD."
);

export const uncommittedFilesDefinition = definition(
  "dx.git.uncommitted-files",
  "files",
  "Tracked files changed in the latest observed uncommitted worktree diff against HEAD."
);

export const untrackedFilesDefinition = definition(
  "dx.git.untracked-files",
  "files",
  "Untracked, non-ignored files in the latest observed worktree snapshot."
);

export const gitChurnDefinitions: readonly MetricDefinitionRef[] = [
  commitsDefinition,
  mergeCommitsDefinition,
  linesAddedDefinition,
  linesDeletedDefinition,
  churnDefinition,
  filesChangedDefinition,
  filesRetouchedDefinition,
  uncommittedLinesAddedDefinition,
  uncommittedLinesDeletedDefinition,
  uncommittedFilesDefinition,
  untrackedFilesDefinition,
];

export const gitChurnDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...GIT_CHURN_FIXTURE_IDS],
  gaps: [
    {
      code: "base-sha-definition",
      message: BASE_SHA_DEFINITION,
    },
    {
      code: "merge-lines-excluded",
      message:
        "Merge commits have no numstat from the collector; their lines are not counted in branch churn.",
    },
    {
      code: "binary-lines-excluded",
      message:
        "Binary files have no line counts; they count as files changed but add no lines.",
    },
    {
      code: "rewritten-history",
      message:
        "Totals describe the history visible at collection time; rebased or amended commits collected earlier remain in the store as distinct SHAs.",
    },
  ],
  id: DescriptorIdSchema.make("dx.metric.git-churn"),
  kind: "metric",
  owner: "B28",
  readiness: "ready",
  requiredInputs: [`${GIT_CHURN_SOURCE_ADAPTER_ID}:git.commit`],
  supportedFields: gitChurnDefinitions.map((def) => def.id),
  version: GIT_CHURN_METRIC_VERSION,
};

interface Frame {
  readonly asOf: string;
  readonly checkpoint: string | null;
  readonly summary: GitChurnSummary;
}

const single = (values: readonly string[], empty: string): string => {
  if (values.length === 0) {
    return empty;
  }

  return values.length === 1 ? (values[0] ?? empty) : "mixed";
};

const rangeCheckpoint = (summary: GitChurnSummary): string | null => {
  if (summary.commits === 0 && summary.headShas.length === 0) {
    return null;
  }

  return `range:${single(summary.baseShas, "unbounded")}..${single(summary.headShas, "unknown")}`;
};

const baseLabel = (summary: GitChurnSummary): readonly string[] => {
  const [base] = summary.bases;

  if (
    summary.bases.length !== 1 ||
    base === undefined ||
    base.method === null
  ) {
    return [];
  }

  return [
    `base: method=${base.method} ref=${base.ref ?? "unknown"} sha=${base.sha}`,
  ];
};

const committedCaveats = (summary: GitChurnSummary): readonly string[] => [
  ...baseLabel(summary),
  ...(summary.baseShas.length === 0 && summary.commits > 0
    ? [
        "no-base-ref: no base SHA resolved; range may include pre-branch commits",
      ]
    : []),
  ...(summary.baseShas.length > 1
    ? ["mixed-base: snapshot holds commits collected against several base SHAs"]
    : []),
  ...(summary.branches.length > 1
    ? [
        `multi-branch: snapshot spans ${summary.branches.length} branches; totals are the union of distinct commits`,
      ]
    : []),
  ...summary.coverage
    .filter((item) => item.state !== "complete")
    .flatMap((item) => item.gaps.map((gap) => `${gap.code}: ${gap.message}`)),
];

const committedState = (summary: GitChurnSummary): MeasurementState =>
  summary.baseShas.length !== 1 ||
  summary.branches.length > 1 ||
  summary.coverage.some((item) => item.state !== "complete")
    ? "partial"
    : "measured";

const unavailable = (
  frame: Frame,
  def: MetricDefinitionRef,
  reason: string
): MetricResult => ({
  asOf: frame.asOf,
  attribution: "not-applicable",
  checkpoint: frame.checkpoint,
  coverage: frame.summary.coverage,
  definition: def,
  denominator: null,
  evidenceIds: [],
  measurement: "unavailable",
  method: "observed",
  metricId: def.id,
  numerator: null,
  reason,
  unit: def.unit,
  value: null,
});

const observed = (
  frame: Frame,
  def: MetricDefinitionRef,
  value: number,
  measurement: MeasurementState,
  evidenceIds: readonly EvidenceId[],
  notes: readonly string[]
): MetricResult => ({
  asOf: frame.asOf,
  attribution: "not-applicable",
  checkpoint: frame.checkpoint,
  coverage: frame.summary.coverage,
  definition: def,
  denominator: null,
  evidenceIds,
  measurement,
  method: "observed",
  metricId: def.id,
  numerator: null,
  reason: notes.length === 0 ? null : notes.join("; "),
  unit: def.unit,
  value,
});

const committedResults = (frame: Frame): readonly MetricResult[] => {
  const { summary } = frame;

  const defs = [
    commitsDefinition,
    mergeCommitsDefinition,
    linesAddedDefinition,
    linesDeletedDefinition,
    churnDefinition,
    filesChangedDefinition,
    filesRetouchedDefinition,
  ];

  if (!summary.sourcePresent) {
    return defs.map((def) =>
      unavailable(
        frame,
        def,
        "no git-history events or coverage in snapshot; run dx collect --source git-history for this branch"
      )
    );
  }

  const state = committedState(summary);
  const caveats = committedCaveats(summary);
  const evidence = summary.commitEvidence;

  const lineNotes = [
    ...caveats,
    ...(summary.unmeasuredCommits > 0
      ? [`${summary.unmeasuredCommits} merge commit(s) contribute no lines`]
      : []),
    ...(summary.binaryFiles > 0
      ? [`${summary.binaryFiles} binary file change(s) have no line counts`]
      : []),
  ];

  const fileNotes = [
    ...caveats,
    ...(summary.pathsTruncated
      ? ["paths truncated in at least one commit; distinct count is a floor"]
      : []),
  ];

  const fileState: MeasurementState = summary.pathsTruncated
    ? "partial"
    : state;

  return [
    observed(
      frame,
      commitsDefinition,
      summary.commits,
      state,
      evidence,
      caveats
    ),
    observed(
      frame,
      mergeCommitsDefinition,
      summary.mergeCommits,
      state,
      evidence,
      caveats
    ),
    observed(
      frame,
      linesAddedDefinition,
      summary.linesAdded,
      state,
      evidence,
      lineNotes
    ),
    observed(
      frame,
      linesDeletedDefinition,
      summary.linesDeleted,
      state,
      evidence,
      lineNotes
    ),
    observed(
      frame,
      churnDefinition,
      summary.linesAdded + summary.linesDeleted,
      state,
      evidence,
      lineNotes
    ),
    observed(
      frame,
      filesChangedDefinition,
      summary.distinctFiles,
      fileState,
      evidence,
      fileNotes
    ),
    observed(
      frame,
      filesRetouchedDefinition,
      summary.filesRetouched,
      fileState,
      evidence,
      fileNotes
    ),
  ];
};

const worktreeResults = (frame: Frame): readonly MetricResult[] => {
  const { worktree } = frame.summary;

  const pairs: readonly [MetricDefinitionRef, number | null | undefined][] = [
    [uncommittedLinesAddedDefinition, worktree?.linesAdded],
    [uncommittedLinesDeletedDefinition, worktree?.linesDeleted],
    [uncommittedFilesDefinition, worktree?.filesChanged],
    [untrackedFilesDefinition, worktree?.untrackedFiles],
  ];

  return pairs.map(([def, value]) =>
    worktree === null || value === null || value === undefined
      ? unavailable(
          frame,
          def,
          worktree === null
            ? "no uncommitted worktree snapshot in selection (clean tree or not collected)"
            : "worktree snapshot lacks this field"
        )
      : observed(
          frame,
          def,
          value,
          "measured",
          [worktree.evidenceId],
          [
            "snapshot at collection time; excludes changes made after the last collect",
          ]
        )
  );
};

export const computeGitChurn = (snapshot: StoreSnapshot): MetricOutput => {
  const summary = summarizeGitChurn(snapshot);

  const frame: Frame = {
    asOf: snapshot.manifest.createdAt,
    checkpoint: rangeCheckpoint(summary),
    summary,
  };

  return {
    findings: [],
    results: [...committedResults(frame), ...worktreeResults(frame)],
  };
};

export const gitChurnMetric: DxMetric = {
  compute: computeGitChurn,
  definitions: gitChurnDefinitions,
  descriptor: gitChurnDescriptor,
};
