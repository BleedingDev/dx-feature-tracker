import { Context, Effect, Layer, Schema } from "effect";

import { AgentStore } from "../contracts/agent-store.js";
import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import type {
  AgentHandle,
  AgentRef,
  StoreIdentity,
} from "../model/agent-common.js";
import {
  EvaluationSchema,
  LEARNING_SCHEMA_VERSION,
  LearningInputSchema,
  LearningOutputSchema,
} from "../model/agent-learning.js";
import type {
  Evaluation,
  LearningInput,
  LearningMatch,
  LearningOutput,
  LearningRecord,
  LearningApplicability,
  Lesson,
} from "../model/agent-learning.js";
import type { AnalysisBasis } from "../model/agent-query.js";
import type { LearningContext } from "./applicability.js";
import { matchApplicability, scopeVisible } from "./applicability.js";
import { learningCandidates } from "./candidates.js";
import {
  evaluationRefs,
  recordRefs,
  refFor,
  resolveLearningEvidence,
  uniqueRefs,
} from "./evidence.js";
import type { LearningEvidence } from "./evidence.js";
import { compactLearningMatch, visibleEvaluation } from "./presentation.js";
import { redactEvaluation, redactLearningRecord } from "./text.js";

export type { LearningContext } from "./applicability.js";

export interface LearningServiceOptions {
  readonly context?: LearningContext;
  readonly resolveContext?: () => Effect.Effect<
    LearningContext,
    AgentStoreFailure
  >;
  readonly maxEvaluations?: number;
  readonly maxReferenceChecks?: number;
  readonly maxBasisChecks?: number;
  readonly maxOutputBytes?: number;
}

export interface LearningServiceApi {
  readonly run: (
    input: LearningInput
  ) => Effect.Effect<LearningOutput, AgentStoreFailure>;
}

const learningError = (
  code: AgentError["code"],
  message: string,
  ref: AgentRef | null = null
): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: {
      action: code === "stale-generation" ? "use-current-generation" : "none",
      ref,
    },
    ref,
    retryable: false,
  });

const bound = (
  requested: number | undefined,
  fallback: number,
  maximum: number
): number =>
  Number.isInteger(requested) && requested !== undefined && requested > 0
    ? Math.min(requested, maximum)
    : fallback;

const readContext = (
  scope: LearningContext["scope"],
  applicability: LearningApplicability | undefined,
  fallback: LearningContext | undefined
): LearningContext => ({
  coverageRequirements:
    applicability?.coverageRequirements ?? fallback?.coverageRequirements,
  metricDefinitions:
    applicability?.metricDefinitions ?? fallback?.metricDefinitions,
  origin: fallback?.origin,
  scope,
  sourceVersions: applicability?.sourceVersions ?? fallback?.sourceVersions,
  toolVersions: applicability?.toolVersions ?? fallback?.toolVersions,
  window: applicability?.window ?? fallback?.window,
  workflowConditions:
    applicability?.workflowConditions ?? fallback?.workflowConditions,
});

const validateHandle = (
  identity: StoreIdentity,
  handle: Pick<AgentHandle, "storeId" | "storeGeneration">
): Effect.Effect<void, AgentError> =>
  identity.storeId === handle.storeId &&
  identity.storeGeneration === handle.storeGeneration
    ? Effect.void
    : Effect.fail(
        learningError(
          "stale-generation",
          "The learning handle belongs to another store generation"
        )
      );

const latestEvaluation = (
  evaluations: readonly Evaluation[]
): Evaluation | null =>
  evaluations.toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id)
  )[0] ?? null;

const syntheticBasis = (basis: AnalysisBasis): boolean =>
  basis.originMix.some(
    (entry) =>
      entry.count > 0 &&
      ["fixture", "synthetic", "replay"].includes(entry.origin)
  );

const liveContext = (context: LearningContext): boolean =>
  context.origin === undefined || ["live", "imported"].includes(context.origin);

const selectedEvaluationContext = (
  context: LearningContext | undefined
): Effect.Effect<LearningContext, AgentError> =>
  context === undefined || context.scope.repoId === null
    ? Effect.fail(
        learningError(
          "scope-denied",
          "Fresh evaluations require the caller's selected repository and evidence visibility"
        )
      )
    : Effect.succeed(context);

const evaluationFound = (
  evaluation: Evaluation,
  evidence: LearningEvidence
): boolean => {
  const refs = evaluationRefs(evaluation);

  return (
    refs.length > 0 &&
    refs.every((ref) =>
      evidence.resolutions.some(
        (entry) =>
          JSON.stringify(entry.ref) === JSON.stringify(ref) &&
          entry.state === "found"
      )
    )
  );
};

const projectStatus = (
  lesson: Lesson,
  evaluations: readonly Evaluation[],
  evidence: LearningEvidence,
  applicable: boolean,
  omitted: number,
  context: LearningContext
): Lesson["status"] => {
  if (lesson.status === "superseded") {
    return "superseded";
  }

  if (
    !applicable ||
    !evidence.complete ||
    !evidence.bases.some((basis) =>
      basis.originMix.some((entry) => entry.count > 0)
    ) ||
    (liveContext(context) && evidence.bases.some(syntheticBasis))
  ) {
    return "proposed";
  }

  const current = evaluations.filter(
    (entry) =>
      entry.target.revision === lesson.revision &&
      entry.criterion === lesson.criterion &&
      evaluationFound(entry, evidence)
  );

  if (current.some((entry) => entry.conclusion === "contradicts")) {
    return "contradicted";
  }

  return omitted === 0 &&
    current.some(
      (entry) =>
        entry.conclusion === "supports" && entry.relation !== "causal-criterion"
    )
    ? "supported-within-scope"
    : "proposed";
};

const uniqueTexts = (texts: readonly string[]): readonly string[] => [
  ...new Set(texts),
];

const canonicalEvaluation = (
  evaluation: Evaluation,
  bases: readonly AnalysisBasis[]
): Evaluation => {
  const origins = new Map<Evaluation["originMix"][number]["origin"], number>();
  const coverage = new Map<string, Evaluation["coverage"][number]>();

  for (const basis of bases) {
    for (const entry of basis.originMix) {
      origins.set(entry.origin, (origins.get(entry.origin) ?? 0) + entry.count);
    }

    for (const entry of basis.coverage) {
      coverage.set(JSON.stringify(entry), entry);
    }
  }

  return {
    ...evaluation,
    comparabilityLimitations: uniqueTexts([
      ...evaluation.comparabilityLimitations,
      ...(evaluation.relation === "descriptive-association"
        ? [
            "An observed association does not establish causal savings, elapsed time or correctness",
          ]
        : []),
    ]).slice(0, 32),
    coverage: [...coverage.values()].slice(0, 64),
    originMix: [...origins.entries()].map(([origin, count]) => ({
      count,
      origin,
    })),
  };
};

export const makeLearningService = (
  store: AgentStoreService,
  options: LearningServiceOptions = {}
): LearningServiceApi => {
  const maxEvaluations = bound(options.maxEvaluations, 20, 100);
  const maxReferences = bound(options.maxReferenceChecks, 32, 256);
  const maxBases = bound(options.maxBasisChecks, 8, 32);
  const maxOutputBytes = bound(options.maxOutputBytes, 4_194_304, 4_194_304);

  const writeContext = (): Effect.Effect<
    LearningContext | undefined,
    AgentStoreFailure
  > =>
    options.resolveContext === undefined
      ? Effect.succeed(options.context)
      : options.resolveContext();

  const matchRecord = Effect.fn("LearningService.matchRecord")(
    function* matchRecord(
      storedRecord: LearningRecord,
      context: LearningContext,
      identity: StoreIdentity
    ): Effect.fn.Return<
      {
        readonly item: LearningMatch;
        readonly evaluations: readonly Evaluation[];
        readonly omitted: number;
        readonly omittedReferences: number;
        readonly score: number;
      },
      AgentStoreFailure
    > {
      const record = redactLearningRecord(storedRecord);
      const page = yield* store.listEvaluations(record, maxEvaluations);

      const currentEvaluations = page.evaluations.filter(
        (entry) =>
          entry.target.revision === record.revision &&
          entry.target.id === record.id &&
          entry.target.kind === record.kind
      );

      const evidence = yield* resolveLearningEvidence(
        store,
        identity,
        uniqueRefs([
          ...recordRefs(record),
          ...currentEvaluations.flatMap(evaluationRefs),
        ]),
        context,
        maxReferences,
        maxBases
      );

      const applicability = matchApplicability(record.applicability, context);

      const fixtureLimit =
        liveContext(context) && evidence.bases.some(syntheticBasis);

      const reasons = [
        ...applicability.reasons,
        ...(fixtureLimit
          ? [
              "Fixture, replay or synthetic evidence cannot support a live lesson",
            ]
          : []),
      ];

      const projected =
        record.kind === "lesson"
          ? {
              ...record,
              limitations: uniqueTexts([
                ...record.limitations,
                ...evidence.limitations,
                ...(page.omitted > 0
                  ? [
                      `${page.omitted} evaluations were omitted; unseen evaluations cannot establish current support`,
                    ]
                  : []),
              ]).slice(0, 32),
              status: projectStatus(
                record,
                currentEvaluations,
                evidence,
                applicability.applicable,
                page.omitted,
                context
              ),
            }
          : {
              ...record,
              limitations: uniqueTexts([
                ...record.limitations,
                ...evidence.limitations,
              ]).slice(0, 32),
            };

      const unavailable = evidence.resolutions.filter(
        (entry) => entry.state !== "found"
      ).length;

      return {
        evaluations: page.evaluations.map((entry) =>
          visibleEvaluation(entry, evidence)
        ),
        item: {
          applicable: applicability.applicable && !fixtureLimit,
          evidence: evidence.resolutions,
          inapplicableReason: reasons.length === 0 ? null : reasons.join("; "),
          latestEvaluation: latestEvaluation(
            page.evaluations.map((entry) => visibleEvaluation(entry, evidence))
          ),
          matchReason: `${applicability.applicable ? "Applicability matches the selected conditions" : "Candidate requires applicability checks"}; ${unavailable} unavailable citations; authored text is untrusted data`,
          record: projected,
        },
        omitted: page.omitted,
        omittedReferences: evidence.omitted,
        score: applicability.score + (evidence.complete ? 1000 : 0),
      };
    }
  );

  const recordLearning = Effect.fn("LearningService.record")(
    function* recordLearning(
      input: Extract<LearningInput, { readonly action: "record" }>,
      identity: StoreIdentity
    ): Effect.fn.Return<LearningOutput, AgentStoreFailure> {
      const record = redactLearningRecord(input.record);
      yield* validateHandle(identity, record);

      if (
        record.applicability.scope.repoId === null &&
        !record.applicability.widerScope
      ) {
        return yield* learningError(
          "invalid-selector",
          "Learning defaults to a selected repository; wider applicability must be explicit"
        );
      }

      if (record.kind === "lesson" && record.status !== "proposed") {
        return yield* learningError(
          "invalid-transition",
          "Lesson support and contradiction come from evaluations; supersession uses the supersede action"
        );
      }

      if (input.expectedRevision === null) {
        const result = yield* store.createLearning(
          record,
          input.idempotencyKey
        );

        const candidateContext = result.reused
          ? options.context
          : yield* writeContext();

        return {
          action: "record",
          ...result,
          ...(yield* learningCandidates(
            store,
            result.record,
            candidateContext
          )),
        };
      }

      const current = yield* store.getLearning(record);

      if (
        current.kind !== record.kind ||
        current.createdAt !== record.createdAt ||
        current.applicability.scope.repoId !== record.applicability.scope.repoId
      ) {
        return yield* learningError(
          "invalid-transition",
          "An authored update must preserve the record's identity and repository"
        );
      }

      if (
        current.kind === "lesson" &&
        current.status === "superseded" &&
        input.expectedRevision === current.revision
      ) {
        return yield* learningError(
          "invalid-transition",
          "A superseded lesson retains its history; record a replacement lesson"
        );
      }

      if (record.revision !== input.expectedRevision + 1) {
        return yield* learningError(
          "revision-conflict",
          "The new authored revision must follow the expected revision"
        );
      }

      const revised =
        record.kind === "lesson"
          ? { ...record, previousRevision: input.expectedRevision }
          : record;

      const result = yield* store.updateLearning(
        revised,
        input.expectedRevision,
        input.idempotencyKey
      );

      const candidateContext = result.reused
        ? options.context
        : yield* writeContext();

      return {
        action: "record",
        ...result,
        ...(yield* learningCandidates(store, result.record, candidateContext)),
      };
    }
  );

  const evaluate = Effect.fn("LearningService.evaluate")(function* evaluate(
    input: Extract<LearningInput, { readonly action: "evaluate" }>,
    identity: StoreIdentity
  ): Effect.fn.Return<LearningOutput, AgentStoreFailure> {
    const evaluation = redactEvaluation(input.evaluation);
    yield* validateHandle(identity, evaluation);

    const previous = yield* store
      .getEvaluation(evaluation)
      .pipe(
        Effect.catchTag("AgentError", (failure) =>
          failure.code === "learning-not-found"
            ? Effect.succeed(null)
            : Effect.fail(failure)
        )
      );

    if (previous !== null) {
      const result = yield* store.appendEvaluation(
        {
          ...evaluation,
          comparabilityLimitations: uniqueTexts([
            ...evaluation.comparabilityLimitations,
            ...(evaluation.relation === "descriptive-association"
              ? [
                  "An observed association does not establish causal savings, elapsed time or correctness",
                ]
              : []),
          ]).slice(0, 32),
          coverage: previous.coverage,
          originMix: previous.originMix,
        },
        input.idempotencyKey
      );

      return { action: "evaluate", ...result };
    }

    const handle = {
      id: evaluation.target.id,
      storeGeneration: evaluation.storeGeneration,
      storeId: evaluation.storeId,
    };

    const record = yield* store.getLearning(handle, evaluation.target.revision);

    if (record.kind !== evaluation.target.kind) {
      return yield* learningError(
        "invalid-transition",
        "The evaluation target kind does not match the authored record"
      );
    }

    if (evaluation.target.revision !== record.revision) {
      return yield* learningError(
        "revision-conflict",
        "Evaluate the current authored revision; historical evaluations remain preserved"
      );
    }

    if (
      evaluation.conclusion !== "inconclusive" &&
      evaluation.relation === "causal-criterion"
    ) {
      return yield* learningError(
        "invalid-transition",
        "Causal verification is unavailable; retain an inconclusive evaluation or describe an observed association"
      );
    }

    if (record.kind === "lesson" && evaluation.criterion !== record.criterion) {
      return yield* learningError(
        "invalid-transition",
        "The evaluation must check the criterion authored for this lesson revision"
      );
    }

    const context = yield* selectedEvaluationContext(yield* writeContext());

    const evidence = yield* resolveLearningEvidence(
      store,
      identity,
      evaluationRefs(evaluation),
      context,
      maxReferences,
      maxBases
    );

    if (evaluation.conclusion !== "inconclusive") {
      if (
        !evidence.complete ||
        evidence.resolutions.length === 0 ||
        evidence.bases.length === 0 ||
        !evidence.bases.some((basis) =>
          basis.originMix.some((entry) => entry.count > 0)
        )
      ) {
        return yield* learningError(
          "basis-content-unavailable",
          "Supporting or contradicting evaluations require available generation-bound basis evidence"
        );
      }

      if (liveContext(context) && evidence.bases.some(syntheticBasis)) {
        return yield* learningError(
          "invalid-transition",
          "Fixture, replay or synthetic evidence cannot establish support or contradiction in live scope"
        );
      }

      const definitions = evidence.bases.flatMap(
        (basis) => basis.metricDefinitions
      );

      const actual = { ...context, metricDefinitions: definitions };

      if (!matchApplicability(record.applicability, actual).applicable) {
        return yield* learningError(
          "basis-incompatible",
          "The evaluation evidence does not satisfy this record's applicability requirements"
        );
      }

      if (
        record.applicability.coverageRequirements.length > 0 &&
        evidence.bases.some(
          (basis) =>
            basis.coverage.length === 0 ||
            basis.coverage.some((entry) => entry.state !== "complete")
        )
      ) {
        return yield* learningError(
          "basis-incompatible",
          "The retained coverage does not satisfy a complete-coverage requirement"
        );
      }
    }

    const canonical = yield* Schema.decodeUnknownEffect(EvaluationSchema)(
      canonicalEvaluation(evaluation, evidence.bases)
    ).pipe(
      Effect.mapError(() =>
        learningError(
          "budget-exhausted",
          "Canonical evaluation evidence exceeds the retained learning limits"
        )
      )
    );

    const result = yield* store.appendEvaluation(
      canonical,
      input.idempotencyKey
    );

    return { action: "evaluate", ...result };
  });

  const supersede = Effect.fn("LearningService.supersede")(function* supersede(
    input: Extract<LearningInput, { readonly action: "supersede" }>,
    identity: StoreIdentity
  ): Effect.fn.Return<LearningOutput, AgentStoreFailure> {
    yield* validateHandle(identity, input.ref);
    yield* validateHandle(identity, input.replacement);

    if (
      input.ref.kind !== "lesson" ||
      input.replacement.kind !== "lesson" ||
      input.ref.version !== LEARNING_SCHEMA_VERSION ||
      input.replacement.version !== LEARNING_SCHEMA_VERSION ||
      input.ref.id === input.replacement.id
    ) {
      return yield* learningError(
        "invalid-transition",
        "Supersession requires two distinct lesson references"
      );
    }

    const current = yield* store.getLearning(input.ref);
    const replacement = yield* store.getLearning(input.replacement);

    if (
      current.kind !== "lesson" ||
      replacement.kind !== "lesson" ||
      (replacement.status === "superseded" &&
        !(
          current.status === "superseded" &&
          current.previousRevision === input.expectedRevision &&
          JSON.stringify(current.supersededBy) ===
            JSON.stringify(input.replacement)
        )) ||
      current.applicability.scope.repoId !==
        replacement.applicability.scope.repoId
    ) {
      return yield* learningError(
        "invalid-transition",
        "The replacement must be an active lesson in the same repository"
      );
    }

    const record: Lesson = {
      ...current,
      previousRevision: input.expectedRevision,
      revision: input.expectedRevision + 1,
      status: "superseded",
      supersededBy: input.replacement,
    };

    const result = yield* store.updateLearning(
      record,
      input.expectedRevision,
      input.idempotencyKey
    );

    return { action: "supersede", ...result };
  });

  const get = Effect.fn("LearningService.get")(function* get(
    request: Extract<LearningInput, { readonly action: "get" }>,
    identity: StoreIdentity
  ): Effect.fn.Return<LearningOutput, AgentStoreFailure> {
    yield* validateHandle(identity, request.ref);

    if (
      !["lesson", "investigation", "evaluation"].includes(request.ref.kind) ||
      request.ref.version !== LEARNING_SCHEMA_VERSION
    ) {
      return yield* learningError(
        "invalid-selector",
        "Get requires a versioned lesson, investigation or evaluation reference",
        request.ref
      );
    }

    if (request.scope.repoId === null) {
      return yield* learningError(
        "scope-denied",
        "Get requires the caller's selected repository and evidence visibility",
        request.ref
      );
    }

    const focused =
      request.ref.kind === "evaluation"
        ? yield* store.getEvaluation(request.ref)
        : null;

    const parent =
      focused === null
        ? request.ref
        : {
            ...request.ref,
            id: focused.target.id,
            kind: focused.target.kind,
            revision: focused.target.revision,
          };

    const record = yield* store.getLearning(parent, parent.revision);

    const context = readContext(
      request.scope,
      request.applicability,
      options.context
    );

    if (
      !scopeVisible(context.scope, record.applicability.scope) &&
      !record.applicability.widerScope
    ) {
      return yield* learningError(
        "scope-denied",
        "The learning record is outside the caller's selected visibility",
        request.ref
      );
    }

    const match = yield* matchRecord(record, context, identity);

    const focusedEvidence =
      focused === null
        ? null
        : yield* resolveLearningEvidence(
            store,
            identity,
            evaluationRefs(focused),
            context,
            maxReferences,
            maxBases
          );

    const focusedVisible =
      focused === null || focusedEvidence === null
        ? null
        : visibleEvaluation(focused, focusedEvidence);

    return {
      action: "get",
      evaluations:
        focusedVisible === null ? match.evaluations : [focusedVisible],
      item:
        focusedVisible === null
          ? match.item
          : {
              ...match.item,
              latestEvaluation: focusedVisible,
              matchReason: `${match.item.matchReason}; focused evaluation selected`,
            },
      omittedEvaluations:
        focusedVisible === null
          ? match.omitted
          : Math.max(0, match.omitted + match.evaluations.length - 1),
    };
  });

  const run = Effect.fn("LearningService.run")(function* run(
    input: LearningInput
  ): Effect.fn.Return<LearningOutput, AgentStoreFailure> {
    const request = yield* Schema.decodeUnknownEffect(LearningInputSchema)(
      input
    ).pipe(
      Effect.mapError(() =>
        learningError(
          "invalid-selector",
          "The learning request does not match the declared contract"
        )
      )
    );

    const identity = yield* store.identity;
    let output: LearningOutput;

    switch (request.action) {
      case "record": {
        output = yield* recordLearning(request, identity);
        break;
      }

      case "evaluate": {
        output = yield* evaluate(request, identity);
        break;
      }

      case "supersede": {
        output = yield* supersede(request, identity);
        break;
      }

      case "get": {
        output = yield* get(request, identity);
        break;
      }

      case "list": {
        yield* validateHandle(identity, request.target);

        if (request.filter.scope.repoId === null) {
          return yield* learningError(
            "scope-denied",
            "List requires a selected repository"
          );
        }

        const page = yield* store.listLearning(request.filter);

        let context = readContext(
          request.filter.scope,
          request.filter.applicability,
          options.context
        );

        if (request.filter.basisId !== undefined) {
          const basis = yield* store.getBasis({
            ...identity,
            id: request.filter.basisId,
          });

          if (!scopeVisible(context.scope, basis.scope)) {
            return yield* learningError(
              "scope-denied",
              "The requested recall basis is outside the selected visibility"
            );
          }

          context = {
            ...context,
            metricDefinitions: basis.metricDefinitions,
            window: basis.window,
          };
        }

        const matches = yield* Effect.all(
          page.records.map((record) => matchRecord(record, context, identity))
        );

        const ordered = matches.toSorted(
          (left, right) =>
            Number(right.item.applicable) - Number(left.item.applicable) ||
            right.score - left.score ||
            right.item.record.updatedAt.localeCompare(
              left.item.record.updatedAt
            ) ||
            left.item.record.id.localeCompare(right.item.record.id)
        );

        const visible = ordered.filter(
          (match) =>
            request.filter.includeSuperseded ||
            match.item.record.kind !== "lesson" ||
            match.item.record.status !== "superseded"
        );

        output = {
          action: "list",
          excluded: page.excluded + matches.length - visible.length,
          items: visible.map((match) =>
            compactLearningMatch(match.item, match.omittedReferences)
          ),
          nextCursor: page.nextCursor,
        };
        break;
      }

      default: {
        return yield* learningError(
          "invalid-selector",
          "Unknown learning action"
        );
      }
    }

    if (
      new TextEncoder().encode(JSON.stringify(output)).byteLength >
      maxOutputBytes
    ) {
      return yield* learningError(
        "budget-exhausted",
        "The learning response exceeds the output byte limit; request fewer records or evaluations"
      );
    }

    return yield* Schema.decodeUnknownEffect(LearningOutputSchema)(output).pipe(
      Effect.mapError(() =>
        learningError(
          "budget-exhausted",
          "The learning response exceeds the declared output limits"
        )
      )
    );
  });

  return { run };
};

export class LearningService extends Context.Service<
  LearningService,
  LearningServiceApi
>()("@rat-stack/core/dx/LearningService", {
  make: Effect.gen(function* make() {
    return makeLearningService(yield* AgentStore);
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
  static readonly layerWith = (options: LearningServiceOptions) =>
    Layer.effect(
      this,
      Effect.gen(function* layerWith() {
        return makeLearningService(yield* AgentStore, options);
      })
    );
}

export const runLearning = Effect.fn("runLearning")(function* runLearning(
  input: LearningInput
) {
  return yield* (yield* LearningService).run(input);
});

export const learningRecordRef = (record: LearningRecord): AgentRef => ({
  ...refFor(record, record.id, record.kind, LEARNING_SCHEMA_VERSION),
  revision: record.revision,
});
