import type {
  Evaluation,
  LearningApplicability,
  LearningRecord,
} from "../model/agent-learning.js";
import { redactText } from "../reports/evidence/redact.js";

const authoredText = (text: string): string => redactText(text).text;

const authoredTexts = (texts: readonly string[]): readonly string[] =>
  texts.map(authoredText);

const redactApplicability = (
  applicability: LearningApplicability
): LearningApplicability => ({
  ...applicability,
  coverageRequirements: authoredTexts(applicability.coverageRequirements),
  scope: {
    ...applicability.scope,
    resolution: authoredText(applicability.scope.resolution),
  },
  workflowConditions: authoredTexts(applicability.workflowConditions),
});

export const redactLearningRecord = (
  record: LearningRecord
): LearningRecord => {
  const common = {
    applicability: redactApplicability(record.applicability),
    limitations: authoredTexts(record.limitations),
  };

  return record.kind === "investigation"
    ? {
        ...record,
        ...common,
        conclusion:
          record.conclusion === null ? null : authoredText(record.conclusion),
        question: authoredText(record.question),
      }
    : {
        ...record,
        ...common,
        claim: authoredText(record.claim),
        criterion: authoredText(record.criterion),
        invalidationConditions: authoredTexts(record.invalidationConditions),
      };
};

export const redactEvaluation = (evaluation: Evaluation): Evaluation => ({
  ...evaluation,
  comparabilityLimitations: authoredTexts(evaluation.comparabilityLimitations),
  coverage: evaluation.coverage.map((entry) => ({
    ...entry,
    gaps: entry.gaps.map((gap) => ({
      ...gap,
      message: authoredText(gap.message),
    })),
  })),
  criterion: authoredText(evaluation.criterion),
  outcome: authoredText(evaluation.outcome),
});
