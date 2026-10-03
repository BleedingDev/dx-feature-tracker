import { watchActor } from "@rat-stack/capability/actor-watch";
import {
  createEffectActor,
  fromEffect,
  join,
  setupEffect,
} from "@xstate/effect";
import { Context, Effect, Schema } from "effect";
import { types } from "xstate";

import type { AgentStoreFailure } from "../contracts/agent-store.js";
import type { OperationReceipt } from "../model/agent-operation.js";

export interface OperationPhaseOutcome {
  readonly phase:
    | "done"
    | "next"
    | "recover"
    | "execute"
    | "commit"
    | "cancel"
    | "finalize";
  readonly receipt: OperationReceipt | null;
}

type OperationPhaseEffect = (
  id: string
) => Effect.Effect<OperationPhaseOutcome, AgentStoreFailure>;

interface OperationExecutionApi {
  readonly prepare: OperationPhaseEffect;
  readonly next: OperationPhaseEffect;
  readonly recover: OperationPhaseEffect;
  readonly execute: OperationPhaseEffect;
  readonly commit: OperationPhaseEffect;
  readonly cancel: OperationPhaseEffect;
  readonly finalize: OperationPhaseEffect;
}

export class OperationExecution extends Context.Service<
  OperationExecution,
  OperationExecutionApi
>()("@rat-stack/core/dx/OperationExecution") {}

interface MachineContext {
  readonly id: string;
  readonly receipt: OperationReceipt | undefined;
  readonly error: AgentStoreFailure | undefined;
  readonly phase: OperationPhaseOutcome["phase"] | null;
}

export interface OperationMachineOutcome {
  readonly error: AgentStoreFailure | undefined;
  readonly receipt: OperationReceipt | undefined;
}

const phaseActor = (phase: keyof OperationExecutionApi) =>
  fromEffect({
    effect: ({ input }) =>
      OperationExecution.use((execution) => execution[phase](input.id)),
    schemas: { input: Schema.Struct({ id: Schema.String }) },
  });

const prepareOperation = phaseActor("prepare");

const selectStep = phaseActor("next");

const recoverStep = phaseActor("recover");

const executeStep = phaseActor("execute");

const commitStep = phaseActor("commit");

const cancelStep = phaseActor("cancel");

const finalizeOperation = phaseActor("finalize");

const operationMachine = setupEffect({
  actors: {
    cancelStep,
    commitStep,
    executeStep,
    finalizeOperation,
    prepareOperation,
    recoverStep,
    selectStep,
  },
  schemas: {
    context: types<MachineContext>(),
    input: Schema.Struct({ id: Schema.String }),
    output: types<OperationMachineOutcome>(),
  },
}).createMachine({
  context: ({ input }) => ({
    error: undefined,
    id: input.id,
    phase: null,
    receipt: undefined,
  }),
  initial: "preparing",
  output: ({ context }): OperationMachineOutcome => ({
    error: context.error,
    receipt: context.receipt,
  }),
  states: {
    cancelling: {
      invoke: {
        input: ({ context }) => ({ id: context.id }),
        onDone: {
          context: ({ context, event }) => ({
            phase: event.output.phase,
            receipt: event.output.receipt ?? context.receipt,
          }),
          target: "routing",
        },
        onError: {
          context: ({ event }) => ({ error: event.error }),
          target: "interrupted",
        },
        src: "cancelStep",
      },
    },
    committing: {
      invoke: {
        input: ({ context }) => ({ id: context.id }),
        onDone: {
          context: ({ context, event }) => ({
            phase: event.output.phase,
            receipt: event.output.receipt ?? context.receipt,
          }),
          target: "routing",
        },
        onError: {
          context: ({ event }) => ({ error: event.error }),
          target: "interrupted",
        },
        src: "commitStep",
      },
    },
    completed: { type: "final" },
    executing: {
      invoke: {
        input: ({ context }) => ({ id: context.id }),
        onDone: {
          context: ({ context, event }) => ({
            phase: event.output.phase,
            receipt: event.output.receipt ?? context.receipt,
          }),
          target: "routing",
        },
        onError: {
          context: ({ event }) => ({ error: event.error }),
          target: "interrupted",
        },
        src: "executeStep",
      },
    },
    finalizing: {
      invoke: {
        input: ({ context }) => ({ id: context.id }),
        onDone: {
          context: ({ context, event }) => ({
            phase: event.output.phase,
            receipt: event.output.receipt ?? context.receipt,
          }),
          target: "routing",
        },
        onError: {
          context: ({ event }) => ({ error: event.error }),
          target: "interrupted",
        },
        src: "finalizeOperation",
      },
    },
    interrupted: { type: "final" },
    preparing: {
      invoke: {
        input: ({ context }) => ({ id: context.id }),
        onDone: {
          context: ({ context, event }) => ({
            phase: event.output.phase,
            receipt: event.output.receipt ?? context.receipt,
          }),
          target: "routing",
        },
        onError: {
          context: ({ event }) => ({ error: event.error }),
          target: "interrupted",
        },
        src: "prepareOperation",
      },
    },
    recovering: {
      invoke: {
        input: ({ context }) => ({ id: context.id }),
        onDone: {
          context: ({ context, event }) => ({
            phase: event.output.phase,
            receipt: event.output.receipt ?? context.receipt,
          }),
          target: "routing",
        },
        onError: {
          context: ({ event }) => ({ error: event.error }),
          target: "interrupted",
        },
        src: "recoverStep",
      },
    },
    routing: {
      always: ({ context }) => {
        switch (context.phase) {
          case "done": {
            return { target: "completed" };
          }

          case "next": {
            return { target: "selecting" };
          }

          case "recover": {
            return { target: "recovering" };
          }

          case "execute": {
            return { target: "executing" };
          }

          case "commit": {
            return { target: "committing" };
          }

          case "cancel": {
            return { target: "cancelling" };
          }

          case "finalize": {
            return { target: "finalizing" };
          }

          case null: {
            return { target: "interrupted" };
          }

          default: {
            return { target: "interrupted" };
          }
        }
      },
    },
    selecting: {
      invoke: {
        input: ({ context }) => ({ id: context.id }),
        onDone: {
          context: ({ context, event }) => ({
            phase: event.output.phase,
            receipt: event.output.receipt ?? context.receipt,
          }),
          target: "routing",
        },
        onError: {
          context: ({ event }) => ({ error: event.error }),
          target: "interrupted",
        },
        src: "selectStep",
      },
    },
  },
});

export const runOperationMachine = Effect.fn("runOperationMachine")(
  function* runOperationMachine(id: string) {
    const actor = yield* createEffectActor(operationMachine, { input: { id } });
    yield* watchActor("operationMachine", actor);

    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Domain failures are typed actor outcomes; only interpreter defects reach join.
    return yield* join(actor).pipe(Effect.orDie);
  }
);
