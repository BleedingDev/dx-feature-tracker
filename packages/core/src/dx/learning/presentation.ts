import type {
  Evaluation,
  LearningMatch,
  LearningSummary,
} from "../model/agent-learning.js";
import { LEARNING_SCHEMA_VERSION } from "../model/agent-learning.js";
import type { LearningEvidence } from "./evidence.js";
import { evaluationRefs, refFor } from "./evidence.js";
import { redactEvaluation } from "./text.js";

export const visibleEvaluation = (
  storedEvaluation: Evaluation,
  evidence: LearningEvidence
): Evaluation => {
  const evaluation = redactEvaluation(storedEvaluation);

  const inaccessible = evaluationRefs(evaluation).some(
    (ref) =>
      !evidence.resolutions.some(
        (entry) =>
          JSON.stringify(entry.ref) === JSON.stringify(ref) &&
          entry.state === "found"
      )
  );

  return inaccessible
    ? {
        ...evaluation,
        comparabilityLimitations: [
          ...evaluation.comparabilityLimitations.slice(0, 31),
          "Evidence metadata is withheld or unavailable under the caller's selected visibility",
        ],
        coverage: [],
        originMix: [],
      }
    : evaluation;
};

export const compactLearningMatch = (
  item: LearningMatch,
  omittedReferences = 0
): LearningSummary => {
  const { record } = item;

  const ref = {
    ...refFor(record, record.id, record.kind, LEARNING_SCHEMA_VERSION),
    revision: record.revision,
  };

  const text = record.kind === "lesson" ? record.claim : record.question;

  const count = (states: readonly string[]): number =>
    item.evidence.filter((entry) => states.includes(entry.state)).length;

  return {
    applicable: item.applicable,
    claimOrQuestion: text.slice(0, 512),
    claimTruncated: text.length > 512,
    drilldown: ref,
    evidence: {
      found: count(["found"]),
      missing: count(["invalid", "missing-in-basis"]),
      omitted: omittedReferences,
      stale: count(["stale-generation"]),
      unchecked: count(["over-budget"]),
      withheld: count(["withheld"]),
    },
    inapplicableReason: item.inapplicableReason,
    kind: record.kind,
    latestEvaluationRef:
      item.latestEvaluation === null
        ? null
        : refFor(
            item.latestEvaluation,
            item.latestEvaluation.id,
            "evaluation",
            LEARNING_SCHEMA_VERSION
          ),
    matchReason: `${item.matchReason}; ranking applies within this bounded candidate page`,
    ref,
    status: record.kind === "lesson" ? record.status : record.state,
  };
};
