import { Effect } from "effect";

import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../contracts/agent-store.js";
import type {
  AgentRef,
  AgentRefResolution,
  StoreIdentity,
} from "../model/agent-common.js";
import type { Evaluation, LearningRecord } from "../model/agent-learning.js";
import { OPERATION_SCHEMA_VERSION } from "../model/agent-operation.js";
import type { AnalysisBasis } from "../model/agent-query.js";
import { ANALYSIS_BASIS_VERSION } from "../model/agent-query.js";
import type { LearningContext } from "./applicability.js";
import { scopeVisible } from "./applicability.js";

export interface LearningEvidence {
  readonly resolutions: readonly AgentRefResolution[];
  readonly bases: readonly AnalysisBasis[];
  readonly complete: boolean;
  readonly limitations: readonly string[];
  readonly omitted: number;
}

export const refFor = (
  record: { readonly storeId: string; readonly storeGeneration: number },
  id: string,
  kind: AgentRef["kind"],
  version: string,
  basisId: string | null = null
): AgentRef => ({
  basisId,
  id,
  kind,
  storeGeneration: record.storeGeneration,
  storeId: record.storeId,
  version,
});

export const uniqueRefs = (refs: readonly AgentRef[]): readonly AgentRef[] => {
  const found = new Map<string, AgentRef>();

  for (const ref of refs) {
    const key = JSON.stringify(ref);

    if (!found.has(key)) {
      found.set(key, ref);
    }
  }

  return [...found.values()];
};

export const recordRefs = (record: LearningRecord): readonly AgentRef[] =>
  uniqueRefs(
    record.kind === "lesson"
      ? [...record.supportingRefs, ...record.contradictingRefs]
      : [
          ...record.inspectedRefs,
          ...record.observedResultRefs,
          ...record.nextQueryRefs,
          ...(record.startingBasisId === null
            ? []
            : [
                refFor(
                  record,
                  record.startingBasisId,
                  "basis",
                  ANALYSIS_BASIS_VERSION
                ),
              ]),
          ...record.comparedBasisIds.map((id) =>
            refFor(record, id, "basis", ANALYSIS_BASIS_VERSION)
          ),
          ...record.operationIds.map((id) =>
            refFor(record, id, "operation", OPERATION_SCHEMA_VERSION)
          ),
        ]
  );

export const evaluationRefs = (evaluation: Evaluation): readonly AgentRef[] =>
  uniqueRefs([
    ...evaluation.evidenceRefs,
    ...evaluation.basisIds.map((id) =>
      refFor(evaluation, id, "basis", ANALYSIS_BASIS_VERSION)
    ),
    ...evaluation.operationIds.map((id) =>
      refFor(evaluation, id, "operation", OPERATION_SCHEMA_VERSION)
    ),
  ]);

const missingBasis = (
  store: AgentStoreService,
  ref: AgentRef
): Effect.Effect<AnalysisBasis | null, AgentStoreFailure> =>
  store
    .getBasis(ref)
    .pipe(
      Effect.catchTag("AgentError", (failure) =>
        failure.code === "basis-not-found" ||
        failure.code === "basis-content-unavailable" ||
        failure.code === "stale-generation"
          ? Effect.succeed(null)
          : Effect.fail(failure)
      )
    );

export const resolveLearningEvidence = Effect.fn("resolveLearningEvidence")(
  function* resolveLearningEvidence(
    store: AgentStoreService,
    identity: StoreIdentity,
    refs: readonly AgentRef[],
    context: LearningContext,
    maxReferences: number,
    maxBases: number
  ): Effect.fn.Return<LearningEvidence, AgentStoreFailure> {
    const selected = uniqueRefs(refs);
    const bounded = selected.slice(0, 512);
    const resolutions: AgentRefResolution[] = [];
    const bases = new Map<string, AnalysisBasis | null>();
    const checked: AgentRef[] = [];
    const limitations: string[] = [];

    const initial = yield* store.resolveRefs(
      bounded
        .slice(0, maxReferences)
        .filter(
          (ref) =>
            ref.storeId === identity.storeId &&
            ref.storeGeneration === identity.storeGeneration
        ),
      context.scope
    );

    for (const [index, ref] of bounded.entries()) {
      if (
        ref.storeId !== identity.storeId ||
        ref.storeGeneration !== identity.storeGeneration
      ) {
        resolutions.push({
          reason: "The citation belongs to another store generation",
          ref,
          state: "stale-generation",
        });
        continue;
      }

      if (index >= maxReferences) {
        resolutions.push({
          reason: "The citation check limit was reached",
          ref,
          state: "over-budget",
        });
        continue;
      }

      const selectedResolution = initial.find(
        (entry) => JSON.stringify(entry.ref) === JSON.stringify(ref)
      );

      if (
        selectedResolution !== undefined &&
        selectedResolution.state !== "found"
      ) {
        resolutions.push(selectedResolution);
        continue;
      }

      const basisId = ref.kind === "basis" ? ref.id : ref.basisId;

      if (basisId !== null) {
        if (!bases.has(basisId)) {
          if (bases.size >= maxBases) {
            resolutions.push({
              reason: "The basis check limit was reached",
              ref,
              state: "over-budget",
            });
            continue;
          }

          bases.set(
            basisId,
            yield* missingBasis(
              store,
              refFor(ref, basisId, "basis", ANALYSIS_BASIS_VERSION)
            )
          );
        }

        const basis = bases.get(basisId);

        if (basis === null || basis === undefined) {
          resolutions.push({
            reason: "The retained basis is unavailable",
            ref,
            state: "missing-in-basis",
          });
          continue;
        }

        if (!scopeVisible(context.scope, basis.scope)) {
          resolutions.push({
            reason: "The citation is outside the caller's evidence visibility",
            ref,
            state: "withheld",
          });
          continue;
        }
      } else if (
        [
          "metric",
          "finding",
          "event",
          "evidence",
          "request",
          "attribution",
          "result",
        ].includes(ref.kind)
      ) {
        resolutions.push({
          reason: "The citation does not name a retained basis",
          ref,
          state: "invalid",
        });
        continue;
      }

      checked.push(ref);
    }

    if (checked.length > 0) {
      for (const ref of checked) {
        resolutions.push(
          initial.find(
            (entry) => JSON.stringify(entry.ref) === JSON.stringify(ref)
          ) ?? {
            reason: "The store did not resolve this citation",
            ref,
            state: "missing-in-basis",
          }
        );
      }
    }

    if (selected.length > bounded.length) {
      limitations.push(
        `${selected.length - bounded.length} additional citations were omitted from this bounded response`
      );
    }

    const ordered = bounded.map(
      (ref) =>
        resolutions.find(
          (entry) => JSON.stringify(entry.ref) === JSON.stringify(ref)
        ) ?? {
          reason: "The citation was not checked",
          ref,
          state: "over-budget" as const,
        }
    );

    return {
      bases: [...bases.values()].flatMap((basis) =>
        basis === null || !scopeVisible(context.scope, basis.scope)
          ? []
          : [basis]
      ),
      complete:
        selected.length <= bounded.length &&
        ordered.every((entry) => entry.state === "found"),
      limitations,
      omitted: selected.length - bounded.length,
      resolutions: ordered,
    };
  }
);
