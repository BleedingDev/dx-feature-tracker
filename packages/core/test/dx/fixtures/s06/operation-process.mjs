import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

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

  const [storage, operations, ports, model, events, errors, versions] =
    await Promise.all([
      import("../../../../src/dx/storage/sqlite-event-store.js"),
      import("../../../../src/dx/operations/service.js"),
      import("../../../../src/dx/operations/ports.js"),
      import("../../../../src/dx/model/agent-operation.js"),
      import("../../../../src/dx/model/event.js"),
      import("../../../../src/dx/contracts/error-agent.js"),
      import("../../../../src/dx/contracts/agent-version.js"),
    ]);

  return {
    AGENT_CONTRACT_DIGEST: versions.AGENT_CONTRACT_DIGEST,
    AgentError: errors.AgentError,
    DxEventEnvelopeSchema: events.DxEventEnvelopeSchema,
    OperationInputSchema: model.OperationInputSchema,
    makeOperationService: operations.makeOperationService,
    openSqliteEventStore: storage.openSqliteEventStore,
    operationStep: ports.operationStep,
  };
};

const sourceMode = process.argv.includes("--source");

const dx = await (sourceMode ? loadSource() : import("@rat-stack/core/dx"));

const fixtureBatchSchema = Schema.Struct({
  coverage: Schema.Struct({
    adapterId: Schema.Literal("fixture.s06"),
    expectedItems: Schema.NullOr(Schema.Int),
    gaps: Schema.Array(
      Schema.Struct({ code: Schema.String, message: Schema.String })
    ),
    observedItems: Schema.NullOr(Schema.Int),
    state: Schema.Literals(["complete", "partial"]),
    watermark: Schema.NullOr(Schema.String),
    windowFrom: Schema.NullOr(Schema.String),
    windowTo: Schema.NullOr(Schema.String),
  }),
  cursor: Schema.Null,
  events: Schema.Array(dx.DxEventEnvelopeSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1)
  ),
});

const inputSchema = Schema.Struct({
  apply: dx.OperationInputSchema,
  firstBatch: fixtureBatchSchema,
  secondBatch: fixtureBatchSchema,
  storePath: Schema.String.check(Schema.isMinLength(1)),
});

const input = Schema.decodeUnknownSync(Schema.fromJsonString(inputSchema), {
  onExcessProperty: "error",
})(readFileSync(0, "utf-8"));

const storePath = realpathSync(input.storePath);

if (
  input.apply.action !== "apply" ||
  !path.basename(path.dirname(storePath)).startsWith("dft-s06-") ||
  !statSync(storePath).isFile()
) {
  throw new Error(
    "Execution requires an apply request and an existing S06 fixture store"
  );
}

const batches = [input.firstBatch, input.secondBatch];

if (
  batches.some((batch) =>
    batch.events.some(
      (event) => event.origin !== "fixture" || event.adapterId !== "fixture.s06"
    )
  ) ||
  input.firstBatch.events[0]?.eventId === input.secondBatch.events[0]?.eventId
) {
  throw new Error("Execution requires two distinct labelled fixture events");
}

const firstStep = dx.operationStep("s06-process-first", "fixture.s06");

const secondStep = dx.operationStep("s06-process-second", "fixture.s06");

/** @param {string} message */
const failure = (message) =>
  new dx.AgentError({
    code: "invalid-selector",
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "none", ref: null },
    ref: null,
    retryable: false,
  });

await Effect.runPromise(
  Effect.scoped(
    Effect.acquireUseRelease(
      dx.openSqliteEventStore({ kind: "replay", path: storePath }),
      (opened) =>
        Effect.gen(function* blockOperationProcess() {
          /** @type {import("../../../../src/dx/operations/ports.js").OperationAdapter} */
          const adapter = {
            authorize: () => Effect.succeed(true),
            descriptor: {
              authorization: "existing-enrollment",
              cancellation: "between-records",
              effects: {
                destructive: false,
                networkDestinations: [],
                reads: ["fixture.s06"],
                writes: ["fixture-store"],
              },
              enabled: true,
              idempotency: "durable-key",
              kind: "collect",
              reason: null,
              requiredInputs: ["source"],
              version: "1-fixture",
            },
            execute: (_plan, step, context) =>
              Effect.gen(function* executeProcessStep() {
                if (step.id === secondStep.id) {
                  const receipt = yield* opened.agentService.getOperation(
                    context.operation
                  );

                  yield* Effect.sync(() => {
                    process.stdout.write(
                      `${JSON.stringify({
                        loader: sourceMode ? "source" : "built",
                        operation: {
                          id: receipt.id,
                          storeGeneration: receipt.storeGeneration,
                          storeId: receipt.storeId,
                        },
                        pid: process.pid,
                        receipt: {
                          executionState: receipt.executionState,
                          revision: receipt.revision,
                          steps: receipt.steps.map((recorded) => ({
                            duplicates: recorded.duplicates,
                            id: recorded.id,
                            inserted: recorded.inserted,
                            rejected: recorded.rejected,
                            state: recorded.state,
                          })),
                          verificationState: receipt.verificationState,
                        },
                        runtimeContractDigest: dx.AGENT_CONTRACT_DIGEST,
                        state: "ready",
                      })}\n`
                    );
                  });

                  return yield* Effect.never;
                }

                if (step.id !== firstStep.id) {
                  return yield* failure(
                    "The fixture process selected an unknown step"
                  );
                }

                const appended = yield* opened.service.append(input.firstBatch);

                return {
                  resources: {
                    bytesRead: Buffer.byteLength(
                      JSON.stringify(input.firstBatch)
                    ),
                    elapsedMs: null,
                    recordsDecoded: input.firstBatch.events.length,
                    requests: 0,
                    retries: 0,
                  },
                  step: {
                    ...step,
                    committedThrough:
                      input.firstBatch.events[0]?.eventId ?? null,
                    duplicates: appended.duplicates,
                    inserted: appended.inserted,
                    rejected: 0,
                    safeCursor: input.firstBatch.events[0]?.eventId ?? null,
                    state: "committed",
                  },
                };
              }),
            prepare: (planned) =>
              Effect.succeed({
                arguments: planned.arguments,
                consent: {
                  reason: "Explicit fixture-only authorization",
                  receiptIds: ["fixture-enrollment"],
                  scopeDigest: "pending",
                  state: "authorized",
                },
                effects: {
                  destructive: false,
                  networkDestinations: [],
                  reads: ["fixture.s06"],
                  writes: ["fixture-store"],
                },
                expectedEvidenceImprovement:
                  "Append selected labelled S06 fixture records",
                forecast: {
                  bytes: null,
                  cost: null,
                  elapsedMs: null,
                  requests: 0,
                },
                preconditions: [],
                resumeBoundary: "complete-record",
                stopCondition:
                  "Complete the selected labelled fixture records within bounds",
              }),
            probe: (plan, step) =>
              Effect.gen(function* probeProcessStep() {
                const selected =
                  step.id === firstStep.id
                    ? input.firstBatch
                    : input.secondBatch;

                const page = yield* opened.agentService.readEventPage({
                  cursor: null,
                  eventWatermark: null,
                  maxDecodedBytes: plan.bounds.maxBytes,
                  maxElapsedMs: Math.min(1000, plan.bounds.maxElapsedMs),
                  maxFacts: Math.min(100, plan.bounds.maxRecords),
                  scope: plan.scope,
                  selector: {
                    branch: plan.scope.branchSelection.branches[0] ?? null,
                    flightId: plan.scope.flightId,
                    from: null,
                    repoCommonDir: plan.scope.repoId,
                    to: null,
                  },
                });

                if (
                  selected.events.every((event) =>
                    page.events.some(
                      (retained) => retained.eventId === event.eventId
                    )
                  )
                ) {
                  return {
                    result: {
                      resources: {
                        bytesRead: null,
                        elapsedMs: null,
                        recordsDecoded: page.factsExamined,
                        requests: 0,
                        retries: 0,
                      },
                      step: {
                        ...step,
                        committedThrough: selected.events[0]?.eventId ?? null,
                        safeCursor: selected.events[0]?.eventId ?? null,
                        state: "already-applied",
                      },
                    },
                    state: "complete",
                  };
                }

                return page.complete
                  ? { state: "absent" }
                  : {
                      reason:
                        "The bounded fixture probe did not exhaust its selected scope",
                      state: "indeterminate",
                    };
              }),
            replay: "probe-required",
            steps: () => [firstStep, secondStep],
            validate: (plan) =>
              Effect.sync(() => {
                const bytes = batches.reduce(
                  (total, batch) =>
                    total + Buffer.byteLength(JSON.stringify(batch)),
                  0
                );

                const outside = batches.some((batch) =>
                  batch.events.some(
                    (event) =>
                      (plan.scope.repoId !== null &&
                        event.context.repoCommonDir !== plan.scope.repoId) ||
                      (plan.scope.worktreeId !== null &&
                        event.context.worktreePath !== plan.scope.worktreeId) ||
                      (plan.scope.flightId !== null &&
                        event.context.flightId !== plan.scope.flightId) ||
                      (plan.scope.sources.length > 0 &&
                        !plan.scope.sources.includes(event.adapterId)) ||
                      (plan.scope.tools.length > 0 &&
                        !plan.scope.tools.includes(event.ai?.harness ?? "")) ||
                      (["current", "selected"].includes(
                        plan.scope.branchSelection.kind
                      ) &&
                        !plan.scope.branchSelection.branches.includes(
                          event.context.branch ?? ""
                        ))
                  )
                );

                return outside ||
                  bytes > plan.bounds.maxBytes ||
                  plan.bounds.maxRecords < 2 ||
                  plan.bounds.maxFiles < 2
                  ? [
                      "The fixture events are outside the reviewed scope or bounds",
                    ]
                  : [];
              }),
          };

          const service = yield* dx.makeOperationService(opened.agentService, [
            adapter,
          ]);

          yield* service.run(input.apply);
        }),
      (opened) =>
        Effect.sync(() => {
          opened.close();
        })
    )
  )
);
