import type {
  AgentBasisDifference,
  AnalysisBasis,
} from "../../model/agent-query.js";
import { agentDigest } from "./basis.js";

export type ComparableBasis = Pick<
  AnalysisBasis,
  | "id"
  | "selectedEventDigest"
  | "coverage"
  | "attributionVersion"
  | "reconciliationVersion"
  | "metricDefinitions"
  | "configDigest"
  | "scope"
  | "window"
> & {
  readonly priceSheets: readonly {
    readonly id: string;
    readonly contentHash: string;
  }[];
};

export const compareAgentBases = (
  previous: ComparableBasis,
  current: ComparableBasis
): AgentBasisDifference => {
  const changes: AgentBasisDifference["changes"][number][] = [];
  const reasons: string[] = [];

  if (previous.selectedEventDigest !== current.selectedEventDigest) {
    changes.push("evidence");
  }

  if (agentDigest(previous.coverage) !== agentDigest(current.coverage)) {
    changes.push("coverage");
  }

  if (
    previous.attributionVersion !== current.attributionVersion ||
    previous.reconciliationVersion !== current.reconciliationVersion
  ) {
    changes.push("attribution");
  }

  if (
    agentDigest(previous.metricDefinitions) !==
    agentDigest(current.metricDefinitions)
  ) {
    changes.push("definitions");
    reasons.push(
      "Metric definitions changed; arithmetic totals are not comparable under one definition."
    );
  }

  if (
    agentDigest(
      previous.priceSheets.map((sheet) => [sheet.id, sheet.contentHash])
    ) !==
    agentDigest(
      current.priceSheets.map((sheet) => [sheet.id, sheet.contentHash])
    )
  ) {
    changes.push("prices");
  }

  if (
    agentDigest({ ...previous.scope, resolution: "" }) !==
    agentDigest({ ...current.scope, resolution: "" })
  ) {
    changes.push("scope");
    reasons.push("Repository, worktree, branch, tool or source scope changed.");
  }

  if (
    agentDigest({ ...previous.window, resolvedAt: "" }) !==
    agentDigest({ ...current.window, resolvedAt: "" })
  ) {
    changes.push("window");
    reasons.push(
      "Absolute windows or timezones differ; arithmetic totals are not comparable."
    );
  }

  if (previous.configDigest !== current.configDigest) {
    reasons.push("Relevant calculation configuration changed.");
  }

  return {
    changedRefs: [],
    changes,
    comparable: !changes.some(
      (change) =>
        change === "definitions" || change === "scope" || change === "window"
    ),
    currentBasisId: current.id,
    detailReason:
      "This metadata comparison classifies input revisions; changed references and unchanged counts require a separately bounded evidence comparison.",
    previousBasisId: previous.id,
    reasons,
    unchangedCount: null,
  };
};
