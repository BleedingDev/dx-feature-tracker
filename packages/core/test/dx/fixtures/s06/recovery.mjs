import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

const handleSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  storeGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storeId: Schema.String.check(Schema.isMinLength(1)),
});

const inputSchema = Schema.Struct({
  handles: Schema.Struct({
    basis: handleSchema,
    cursor: Schema.optional(handleSchema),
    learning: Schema.Struct({
      ...handleSchema.fields,
      revision: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
      ),
    }),
    operation: handleSchema,
    result: handleSchema,
  }),
  storePath: Schema.String.check(Schema.isMinLength(1)),
});

const input = Schema.decodeUnknownSync(Schema.fromJsonString(inputSchema), {
  onExcessProperty: "error",
})(readFileSync(0, "utf-8"));

const storePath = realpathSync(input.storePath);

if (
  !path.basename(path.dirname(storePath)).startsWith("dft-s06-") ||
  !statSync(storePath).isFile()
) {
  throw new Error("Recovery requires an existing S06 fixture store");
}

const loadSource = async () => {
  const sourceRoot = new URL("../../../../src/dx/", import.meta.url);

  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(sourceRoot.href) && url.endsWith(".ts")) {
        return {
          format: "module",
          shortCircuit: true,
          source: stripTypeScriptTypes(
            readFileSync(fileURLToPath(url), "utf-8")
          ),
        };
      }

      return nextLoad(url, context);
    },
    resolve(specifier, context, nextResolve) {
      if (
        specifier.startsWith(".") &&
        specifier.endsWith(".js") &&
        context.parentURL?.startsWith("file:") === true
      ) {
        const candidate = new URL(
          `${specifier.slice(0, -3)}.ts`,
          context.parentURL
        );

        if (
          candidate.href.startsWith(sourceRoot.href) &&
          existsSync(fileURLToPath(candidate))
        ) {
          return { shortCircuit: true, url: candidate.href };
        }
      }

      return nextResolve(specifier, context);
    },
  });

  const [storage, operations, learning, versions] = await Promise.all([
    import("../../../../src/dx/storage/sqlite-event-store.js"),
    import("../../../../src/dx/operations/service.js"),
    import("../../../../src/dx/learning/service.js"),
    import("../../../../src/dx/contracts/agent-version.js"),
  ]);

  return { ...storage, ...operations, ...learning, ...versions };
};

const sourceMode = process.argv.includes("--source");

const dx = await (sourceMode ? loadSource() : import("@rat-stack/core/dx"));

const recovered = await Effect.runPromise(
  Effect.scoped(
    Effect.acquireUseRelease(
      dx.openSqliteEventStore({ kind: "replay", path: storePath }),
      (opened) =>
        Effect.gen(function* recoverFixture() {
          const store = opened.agentService;
          const identity = yield* store.identity;
          const basis = yield* store.getBasisMetadata(input.handles.basis);
          const result = yield* store.getResultMetadata(input.handles.result);

          const cursor = input.handles.cursor
            ? yield* store.getCursor(input.handles.cursor)
            : null;

          const operationService = yield* dx.makeOperationService(store, []);

          const recoveredOperation = yield* operationService.run({
            action: "get",
            operation: input.handles.operation,
          });

          if (recoveredOperation.action !== "get") {
            return yield* Effect.die(
              new Error("Operation recovery returned another action")
            );
          }

          const operation = recoveredOperation.receipt;
          const { reviewedPlan } = recoveredOperation;

          const authoredLearning = yield* store.getLearning(
            input.handles.learning,
            input.handles.learning.revision
          );

          const learningService = dx.makeLearningService(store, {
            context: { ...authoredLearning.applicability, origin: "fixture" },
            maxBasisChecks: 32,
            maxEvaluations: 100,
            maxReferenceChecks: 256,
          });

          const recoveredLearning = yield* learningService.run({
            action: "get",
            applicability: authoredLearning.applicability,
            ref: dx.learningRecordRef(authoredLearning),
            scope: authoredLearning.applicability.scope,
          });

          if (recoveredLearning.action !== "get") {
            return yield* Effect.die(
              new Error("Learning recovery returned another action")
            );
          }

          const learning = recoveredLearning.item.record;

          const latestLearning = yield* store.getLearning(
            input.handles.learning
          );

          return {
            basis: {
              contractDigest: basis.contractDigest,
              contractVersion: basis.contractVersion,
              eventWatermark: basis.eventWatermark,
              id: basis.id,
              retainedEventCount: basis.retainedEventCount,
              schemaVersion: basis.schemaVersion,
              selectedEventDigest: basis.selectedEventDigest,
              storeGeneration: basis.storeGeneration,
              storeId: basis.storeId,
              window: basis.window,
            },
            cursor: cursor
              ? {
                  axis: cursor.axis,
                  basisId: cursor.basisId,
                  id: cursor.id,
                  kind: cursor.kind,
                  position: cursor.position,
                  projectionVersion: cursor.projectionVersion,
                  queryDigest: cursor.queryDigest,
                  resultId: cursor.resultId,
                  state: "valid",
                  storeGeneration: cursor.storeGeneration,
                  storeId: cursor.storeId,
                }
              : null,
            identity,
            learning: {
              applicable: recoveredLearning.item.applicable,
              comparedBasisIds:
                learning.kind === "investigation"
                  ? learning.comparedBasisIds
                  : null,
              evaluationCount: recoveredLearning.evaluations.length,
              evaluations: recoveredLearning.evaluations.map((evaluation) => ({
                conclusion: evaluation.conclusion,
                id: evaluation.id,
                schemaVersion: evaluation.schemaVersion,
                storeGeneration: evaluation.storeGeneration,
                storeId: evaluation.storeId,
                target: evaluation.target,
              })),
              id: learning.id,
              inspectedRefCount:
                learning.kind === "investigation"
                  ? learning.inspectedRefs.length
                  : null,
              kind: learning.kind,
              latestRevision: latestLearning.revision,
              omittedEvaluations: recoveredLearning.omittedEvaluations,
              operationIds:
                learning.kind === "investigation"
                  ? learning.operationIds
                  : null,
              revision: learning.revision,
              schemaVersion: learning.schemaVersion,
              startingBasisId:
                learning.kind === "investigation"
                  ? learning.startingBasisId
                  : null,
              state:
                learning.kind === "lesson" ? learning.status : learning.state,
              storeGeneration: learning.storeGeneration,
              storeId: learning.storeId,
            },
            loader: sourceMode ? "source" : "built",
            operation: {
              executionState: operation.executionState,
              id: operation.id,
              planDigest: operation.planDigest,
              planId: operation.planId,
              reviewedPlan:
                reviewedPlan === null
                  ? null
                  : {
                      bounds: reviewedPlan.bounds,
                      id: reviewedPlan.id,
                      planDigest: reviewedPlan.planDigest,
                      scope: {
                        branchSelection: reviewedPlan.scope.branchSelection,
                        flightId: reviewedPlan.scope.flightId,
                        repoId: reviewedPlan.scope.repoId,
                        sources: reviewedPlan.scope.sources,
                        tools: reviewedPlan.scope.tools,
                        worktreeId: reviewedPlan.scope.worktreeId,
                      },
                      storeGeneration: reviewedPlan.storeGeneration,
                      storeId: reviewedPlan.storeId,
                    },
              reviewedPlanUnavailableReason:
                recoveredOperation.reviewedPlanUnavailableReason,
              revision: operation.revision,
              schemaVersion: operation.schemaVersion,
              stepCount: operation.steps.length,
              steps: operation.steps.map((step) => ({
                duplicates: step.duplicates,
                id: step.id,
                inserted: step.inserted,
                rejected: step.rejected,
                state: step.state,
              })),
              storeGeneration: operation.storeGeneration,
              storeId: operation.storeId,
              verificationState: operation.verificationState,
            },
            pid: process.pid,
            result: {
              aggregation: result.completeness.aggregation,
              basisId: result.basisId,
              byteCount: result.byteCount,
              id: result.id,
              itemCount: result.itemCount,
              items: result.completeness.items,
              projectionVersion: result.projectionVersion,
              queryDigest: result.queryDigest,
              resultDigest: result.resultDigest,
              schemaVersion: result.schemaVersion,
              series: result.completeness.series,
              seriesCount: result.seriesCount,
              storeGeneration: result.storeGeneration,
              storeId: result.storeId,
            },
            runtimeContractDigest: dx.AGENT_CONTRACT_DIGEST,
          };
        }),
      (opened) =>
        Effect.sync(() => {
          opened.close();
        })
    )
  )
);

process.stdout.write(`${JSON.stringify(recovered)}\n`);
