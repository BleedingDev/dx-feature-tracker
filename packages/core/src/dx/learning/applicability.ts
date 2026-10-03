import type { AgentScope, AgentWindow } from "../model/agent-common.js";
import type { LearningApplicability } from "../model/agent-learning.js";
import type { Origin } from "../model/common.js";
import type { VersionedIdSchema } from "../model/snapshot.js";

type VersionedId = typeof VersionedIdSchema.Type;

export interface LearningContext {
  readonly scope: AgentScope;
  readonly window?: AgentWindow | undefined;
  readonly toolVersions?: readonly VersionedId[] | undefined;
  readonly sourceVersions?: readonly VersionedId[] | undefined;
  readonly metricDefinitions?: readonly VersionedId[] | undefined;
  readonly workflowConditions?: readonly string[] | undefined;
  readonly coverageRequirements?: readonly string[] | undefined;
  readonly origin?: Origin | undefined;
}

export interface ApplicabilityMatch {
  readonly applicable: boolean;
  readonly compatible: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

const versionMatch = (
  required: readonly VersionedId[],
  actual: readonly VersionedId[] | undefined,
  label: string
): readonly string[] => {
  if (required.length === 0) {
    return [];
  }

  if (actual === undefined) {
    return [`${label} compatibility is unknown`];
  }

  return required.flatMap((requirement) => {
    const found = actual.find((entry) => entry.id === requirement.id);

    return found?.version === requirement.version
      ? []
      : [`${label} ${requirement.id} requires ${requirement.version}`];
  });
};

const conditionMatch = (
  required: readonly string[],
  actual: readonly string[] | undefined,
  label: string
): readonly string[] => {
  if (required.length === 0) {
    return [];
  }

  if (actual === undefined) {
    return [`${label} compatibility is unknown`];
  }

  return required.flatMap((entry) =>
    actual.includes(entry) ? [] : [`${label} requires ${entry}`]
  );
};

const compatibleWindow = (
  required: AgentWindow,
  actual: AgentWindow | undefined
): readonly string[] => {
  if (actual === undefined) {
    return [];
  }

  return (required.sinceInclusive !== null &&
    (actual.sinceInclusive === null ||
      actual.sinceInclusive < required.sinceInclusive)) ||
    actual.untilExclusive > required.untilExclusive ||
    actual.timezone !== required.timezone
    ? ["The requested window is outside the recorded applicability window"]
    : [];
};

const compatibilityLimits = (
  applicability: LearningApplicability,
  context: LearningContext
): readonly string[] => [
  ...versionMatch(
    applicability.toolVersions,
    context.toolVersions,
    "Tool version"
  ),
  ...versionMatch(
    applicability.sourceVersions,
    context.sourceVersions,
    "Source version"
  ),
  ...versionMatch(
    applicability.metricDefinitions,
    context.metricDefinitions,
    "Metric definition"
  ),
  ...conditionMatch(
    applicability.workflowConditions,
    context.workflowConditions,
    "Workflow"
  ),
  ...conditionMatch(
    applicability.coverageRequirements,
    context.coverageRequirements,
    "Coverage"
  ),
  ...compatibleWindow(applicability.window, context.window),
  ...(context.toolVersions === undefined ||
  context.sourceVersions === undefined ||
  context.metricDefinitions === undefined ||
  context.workflowConditions === undefined ||
  context.coverageRequirements === undefined
    ? [
        "Version, workflow or coverage compatibility is unknown in this scope-only recall",
      ]
    : []),
];

export const scopeVisible = (
  selected: AgentScope,
  actual: AgentScope
): boolean =>
  selected.repoId !== null &&
  selected.repoId === actual.repoId &&
  (selected.worktreeId === null || selected.worktreeId === actual.worktreeId) &&
  actual.sources.every((source) => selected.sources.includes(source)) &&
  actual.tools.every((tool) => selected.tools.includes(tool)) &&
  (selected.branchSelection.kind !== "selected" ||
    (actual.branchSelection.kind !== "all" &&
      actual.branchSelection.branches.every((branch) =>
        selected.branchSelection.branches.includes(branch)
      )));

export const matchApplicability = (
  applicability: LearningApplicability,
  context: LearningContext
): ApplicabilityMatch => {
  const { scope } = applicability;
  const selected = context.scope;
  const reasons: string[] = [];

  if (selected.repoId === null) {
    reasons.push("Select a repository before recalling learning");
  } else if (scope.repoId !== selected.repoId && !applicability.widerScope) {
    reasons.push("The repository is outside this record's applicability");
  }

  if (scope.worktreeId !== null && scope.worktreeId !== selected.worktreeId) {
    reasons.push("The worktree does not match");
  }

  if (scope.flightId !== null && scope.flightId !== selected.flightId) {
    reasons.push("The recorded episode does not match");
  }

  if (!scope.tools.every((tool) => selected.tools.includes(tool))) {
    reasons.push("Required tools are outside the selected scope");
  }

  if (!scope.sources.every((source) => selected.sources.includes(source))) {
    reasons.push("Required sources are outside the selected scope");
  }

  if (
    scope.branchSelection.kind === "selected" &&
    !scope.branchSelection.branches.every((branch) =>
      selected.branchSelection.branches.includes(branch)
    )
  ) {
    reasons.push("The selected branches do not match");
  }

  const compatibilityReasons = compatibilityLimits(applicability, context);

  return {
    applicable: reasons.length === 0 && compatibilityReasons.length === 0,
    compatible: compatibilityReasons.length === 0,
    reasons: [...reasons, ...compatibilityReasons],
    score:
      (scope.repoId === selected.repoId ? 100 : 0) +
      (scope.worktreeId === null ? 0 : 10) +
      scope.tools.length +
      scope.sources.length +
      applicability.toolVersions.length +
      applicability.sourceVersions.length +
      applicability.metricDefinitions.length +
      applicability.workflowConditions.length +
      applicability.coverageRequirements.length,
  };
};
