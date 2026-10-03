import { Effect } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../contracts/agent-store.js";
import type { AgentRef } from "../model/agent-common.js";
import type {
  LearningOutput,
  LearningRecord,
} from "../model/agent-learning.js";
import { LEARNING_SCHEMA_VERSION } from "../model/agent-learning.js";
import type { LearningContext } from "./applicability.js";
import { refFor } from "./evidence.js";

const SEARCH_LIMIT = 25;

const recordText = (record: LearningRecord): string =>
  record.kind === "lesson" ? record.claim : record.question;

const words = (text: string): ReadonlySet<string> => {
  const entries = text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);

  return entries === null ? new Set<string>() : new Set(entries);
};

const lexicalSimilarity = (
  left: LearningRecord,
  right: LearningRecord
): number => {
  const first = words(recordText(left));
  const second = words(recordText(right));
  const shared = [...first].filter((word) => second.has(word)).length;
  const total = first.size + second.size - shared;

  return total === 0 ? 0 : shared / total;
};

const versions = (
  entries: LearningRecord["applicability"]["metricDefinitions"]
): string =>
  entries
    .map((entry) => `${entry.id}\u0000${entry.version}`)
    .toSorted()
    .join("\u0001");

const comparableDefinitions = (
  left: LearningRecord,
  right: LearningRecord
): boolean =>
  versions(left.applicability.metricDefinitions) ===
    versions(right.applicability.metricDefinitions) &&
  versions(left.applicability.sourceVersions) ===
    versions(right.applicability.sourceVersions) &&
  versions(left.applicability.toolVersions) ===
    versions(right.applicability.toolVersions);

export const learningCandidates = Effect.fn("learningCandidates")(
  function* learningCandidates(
    store: AgentStoreService,
    record: LearningRecord,
    context: LearningContext | undefined
  ): Effect.fn.Return<
    Pick<
      Extract<LearningOutput, { readonly action: "record" }>,
      "candidates" | "candidateSearch"
    >,
    AgentStoreFailure
  > {
    const scope = context?.scope ?? record.applicability.scope;

    if (scope.repoId === null) {
      return {
        candidateSearch: {
          algorithm: "normalized-lexical-v1",
          examined: 0,
          limit: 0,
          moreAvailable: null,
          reason: "No selected repository context",
        },
        candidates: [],
      };
    }

    const page = yield* store.listLearning({
      cursor: null,
      includeSuperseded: false,
      kinds: [record.kind],
      limit: SEARCH_LIMIT,
      question: null,
      scope,
    });

    const ranked = page.records
      .flatMap((candidate) => {
        if (
          candidate.id === record.id ||
          candidate.kind !== record.kind ||
          candidate.applicability.scope.repoId !== scope.repoId ||
          !comparableDefinitions(record, candidate)
        ) {
          return [];
        }

        const similarity = lexicalSimilarity(record, candidate);

        return similarity >= 0.6 ? [{ candidate, similarity }] : [];
      })
      .toSorted(
        (left, right) =>
          right.similarity - left.similarity ||
          left.candidate.id.localeCompare(right.candidate.id)
      );

    const candidates: readonly AgentRef[] = ranked
      .slice(0, 8)
      .map(({ candidate }) => ({
        ...refFor(
          candidate,
          candidate.id,
          candidate.kind,
          LEARNING_SCHEMA_VERSION
        ),
        revision: candidate.revision,
      }));

    return {
      candidateSearch: {
        algorithm: "normalized-lexical-v1",
        examined: page.records.length,
        limit: SEARCH_LIMIT,
        moreAvailable:
          page.nextCursor !== null || ranked.length > candidates.length,
        reason:
          "Bounded normalized lexical candidates are suggestions; distinct or conflicting claims remain separate",
      },
      candidates,
    };
  }
);
