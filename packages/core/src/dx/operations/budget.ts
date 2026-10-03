import { Clock, Effect, Schema, Semaphore } from "effect";

import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { AgentCountSchema } from "../model/agent-common.js";
import {
  OperationBoundsSchema,
  OperationReceiptSchema,
} from "../model/agent-operation.js";
import type {
  OperationBounds,
  OperationReceipt,
} from "../model/agent-operation.js";

const OperationWorkUsageSchema = Schema.Struct({
  byteUnits: Schema.optional(AgentCountSchema),
  bytesRead: Schema.NullOr(AgentCountSchema),
  filesRead: AgentCountSchema,
  recordUnits: Schema.optional(AgentCountSchema),
  recordsDecoded: Schema.NullOr(AgentCountSchema),
  requests: AgentCountSchema,
  retries: AgentCountSchema,
});

export type OperationWorkUsage = typeof OperationWorkUsageSchema.Type;

const KnownBudgetUnitsSchema = Schema.Struct({
  bytesRead: AgentCountSchema,
  filesRead: AgentCountSchema,
  recordsDecoded: AgentCountSchema,
  requests: AgentCountSchema,
  retries: AgentCountSchema,
});

type KnownBudgetUnits = typeof KnownBudgetUnitsSchema.Type;

export interface OperationWorkReservation {
  readonly complete: (
    actual: OperationWorkUsage
  ) => Effect.Effect<void, AgentStoreFailure>;
}

export interface OperationWorkBudget {
  readonly remaining: Effect.Effect<OperationBounds, AgentStoreFailure>;
  readonly charge: (
    usage: OperationWorkUsage
  ) => Effect.Effect<void, AgentStoreFailure>;
  readonly reserve: (
    usage: OperationWorkUsage
  ) => Effect.Effect<OperationWorkReservation, AgentStoreFailure>;
  readonly measurements: Effect.Effect<
    OperationReceipt["resources"],
    AgentStoreFailure
  >;
}

interface BudgetUnits {
  bytesRead: number | null;
  filesRead: number;
  recordsDecoded: number | null;
  requests: number | null;
  retries: number | null;
}

interface BudgetState {
  units: BudgetUnits;
  measurements: OperationReceipt["resources"];
  nextReservation: number;
}

const budgetError = (message: string): AgentError =>
  new AgentError({
    code: "budget-exhausted",
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "replan", ref: null },
    ref: null,
    retryable: false,
  });

const addMeasured = (
  previous: number | null,
  observed: number | null
): number | null =>
  previous === null || observed === null ? null : previous + observed;

const usageUnits = (usage: OperationWorkUsage): BudgetUnits => ({
  bytesRead: usage.byteUnits ?? usage.bytesRead,
  filesRead: usage.filesRead,
  recordsDecoded: usage.recordUnits ?? usage.recordsDecoded,
  requests: usage.requests,
  retries: usage.retries,
});

const addUnits = (previous: BudgetUnits, usage: BudgetUnits): BudgetUnits => ({
  bytesRead: addMeasured(previous.bytesRead, usage.bytesRead),
  filesRead: previous.filesRead + usage.filesRead,
  recordsDecoded: addMeasured(previous.recordsDecoded, usage.recordsDecoded),
  requests: addMeasured(previous.requests, usage.requests),
  retries: addMeasured(previous.retries, usage.retries),
});

const overLimit = (
  units: BudgetUnits,
  bounds: OperationBounds
): string | null => {
  if (
    units.bytesRead === null ||
    units.recordsDecoded === null ||
    units.requests === null ||
    units.retries === null
  ) {
    return "The cumulative work includes an unknown amount without a conservative bound; new effects require a new reviewed plan.";
  }

  if (
    units.filesRead > bounds.maxFiles ||
    units.bytesRead > bounds.maxBytes ||
    units.recordsDecoded > bounds.maxRecords ||
    units.requests > bounds.maxRequests ||
    units.retries > bounds.maxRetries
  ) {
    return "The cumulative work exceeds the reviewed operation bounds.";
  }

  return null;
};

const decodedUsage = Effect.fnUntraced(function* decodeWorkUsage(
  usage: OperationWorkUsage
) {
  const decoded = yield* Schema.decodeUnknownEffect(OperationWorkUsageSchema)(
    usage
  ).pipe(
    Effect.mapError(() => budgetError("The reported work usage is invalid."))
  );

  if (
    (decoded.bytesRead !== null &&
      decoded.byteUnits !== undefined &&
      decoded.byteUnits < decoded.bytesRead) ||
    (decoded.recordsDecoded !== null &&
      decoded.recordUnits !== undefined &&
      decoded.recordUnits < decoded.recordsDecoded)
  ) {
    return yield* budgetError(
      "A conservative work allowance cannot be smaller than the measured work."
    );
  }

  return decoded;
});

const knownUnits = Effect.fnUntraced(function* decodeKnownUnits(
  units: BudgetUnits
): Effect.fn.Return<KnownBudgetUnits, AgentStoreFailure> {
  return yield* Schema.decodeUnknownEffect(KnownBudgetUnitsSchema)(units).pipe(
    Effect.mapError(() =>
      budgetError("The reviewed work allowance is unavailable.")
    )
  );
});

export const createOperationWorkBudget = Effect.fn("createOperationWorkBudget")(
  function* makeWorkBudget(
    bounds: OperationBounds,
    attemptedAtMs: number,
    initial?: OperationReceipt["resources"]
  ): Effect.fn.Return<OperationWorkBudget, AgentStoreFailure> {
    const reviewed = yield* Schema.decodeUnknownEffect(OperationBoundsSchema)(
      bounds
    ).pipe(
      Effect.mapError(() => budgetError("The operation bounds are invalid."))
    );

    const attemptedAt = yield* Schema.decodeUnknownEffect(Schema.Finite)(
      attemptedAtMs
    ).pipe(
      Effect.mapError(() => budgetError("The operation start time is invalid."))
    );

    const prior = yield* Schema.decodeUnknownEffect(
      OperationReceiptSchema.fields.resources
    )(
      initial ?? {
        bytesRead: 0,
        elapsedMs: 0,
        recordsDecoded: 0,
        requests: 0,
        retries: 0,
      }
    ).pipe(
      Effect.mapError(() =>
        budgetError("The retained resource totals are invalid.")
      )
    );

    const clock = yield* Clock.Clock;
    const lock = yield* Semaphore.make(1);
    const pending = new Map<number, BudgetUnits>();

    const state: BudgetState = {
      measurements: prior,
      nextReservation: 0,
      units: {
        bytesRead: prior.bytesRead,
        filesRead: initial === undefined ? 0 : reviewed.maxFiles,
        recordsDecoded: prior.recordsDecoded,
        requests: prior.requests,
        retries: prior.retries,
      },
    };

    const elapsed = clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        prior.elapsedMs === null
          ? null
          : prior.elapsedMs + Math.max(0, Math.floor(now - attemptedAt))
      )
    );

    const checkTime = Effect.fnUntraced(function* checkWorkTime() {
      const spent = yield* elapsed;

      if (spent === null) {
        return yield* budgetError(
          "The retained elapsed work is unknown; new effects require a new reviewed plan."
        );
      }

      if (spent >= reviewed.maxElapsedMs) {
        return yield* budgetError(
          "The reviewed operation time limit is exhausted."
        );
      }

      return spent;
    });

    const record = (usage: OperationWorkUsage): void => {
      state.measurements = {
        bytesRead: addMeasured(state.measurements.bytesRead, usage.bytesRead),
        elapsedMs: state.measurements.elapsedMs,
        recordsDecoded: addMeasured(
          state.measurements.recordsDecoded,
          usage.recordsDecoded
        ),
        requests: addMeasured(state.measurements.requests, usage.requests),
        retries: addMeasured(state.measurements.retries, usage.retries),
      };
    };

    const remaining = lock.withPermits(1)(
      Effect.gen(function* remainingWork() {
        const spent = yield* checkTime();
        const exceeded = overLimit(state.units, reviewed);

        if (exceeded !== null) {
          return yield* budgetError(exceeded);
        }

        const units = yield* knownUnits(state.units);

        return {
          maxBytes: reviewed.maxBytes - units.bytesRead,
          maxElapsedMs: reviewed.maxElapsedMs - spent,
          maxFiles: reviewed.maxFiles - units.filesRead,
          maxRecords: reviewed.maxRecords - units.recordsDecoded,
          maxRequests: reviewed.maxRequests - units.requests,
          maxRetries: reviewed.maxRetries - units.retries,
        };
      })
    );

    const charge = Effect.fn("OperationWorkBudget.charge")(function* chargeWork(
      usage: OperationWorkUsage
    ) {
      const decoded = yield* decodedUsage(usage);
      state.units = addUnits(state.units, usageUnits(decoded));
      record(decoded);
      const exceeded = overLimit(state.units, reviewed);

      if (exceeded !== null) {
        return yield* budgetError(exceeded);
      }

      return yield* Effect.void;
    }, lock.withPermits(1));

    const reserve = Effect.fn("OperationWorkBudget.reserve")(
      function* reserveWork(usage: OperationWorkUsage) {
        const decoded = yield* decodedUsage(usage);
        const reserved = usageUnits(decoded);
        const next = addUnits(state.units, reserved);
        const exceeded = overLimit(next, reviewed);

        if (exceeded !== null) {
          return yield* budgetError(exceeded);
        }

        yield* checkTime();
        const reservationId = state.nextReservation;
        state.nextReservation += 1;
        state.units = next;
        pending.set(reservationId, reserved);

        const complete = Effect.fn("OperationWorkReservation.complete")(
          function* completeReservedWork(actual: OperationWorkUsage) {
            const retained = pending.get(reservationId);

            if (retained === undefined) {
              return yield* budgetError(
                "The work reservation has already been settled."
              );
            }

            const measured = yield* decodedUsage(actual);
            const actualUnits = usageUnits(measured);

            const settled: BudgetUnits = {
              bytesRead: actualUnits.bytesRead ?? retained.bytesRead,
              filesRead: actualUnits.filesRead,
              recordsDecoded:
                actualUnits.recordsDecoded ?? retained.recordsDecoded,
              requests: actualUnits.requests,
              retries: actualUnits.retries,
            };

            const used = yield* knownUnits(state.units);
            const allowance = yield* knownUnits(retained);
            const observed = yield* knownUnits(settled);
            state.units = {
              bytesRead:
                used.bytesRead - allowance.bytesRead + observed.bytesRead,
              filesRead:
                used.filesRead - allowance.filesRead + observed.filesRead,
              recordsDecoded:
                used.recordsDecoded -
                allowance.recordsDecoded +
                observed.recordsDecoded,
              requests: used.requests - allowance.requests + observed.requests,
              retries: used.retries - allowance.retries + observed.retries,
            };
            pending.delete(reservationId);
            record(measured);

            if (
              observed.bytesRead > allowance.bytesRead ||
              observed.filesRead > allowance.filesRead ||
              observed.recordsDecoded > allowance.recordsDecoded ||
              observed.requests > allowance.requests ||
              observed.retries > allowance.retries
            ) {
              return yield* budgetError(
                "The measured work exceeded its reserved allowance."
              );
            }

            const over = overLimit(state.units, reviewed);

            if (over !== null) {
              return yield* budgetError(over);
            }

            return yield* Effect.void;
          },
          lock.withPermits(1)
        );

        return { complete };
      },
      lock.withPermits(1)
    );

    const measurements = lock.withPermits(1)(
      Effect.gen(function* measuredWork() {
        const current = { ...state.measurements, elapsedMs: yield* elapsed };

        for (const reserved of pending.values()) {
          if (reserved.bytesRead !== 0) {
            current.bytesRead = null;
          }

          if (reserved.recordsDecoded !== 0) {
            current.recordsDecoded = null;
          }

          if (reserved.requests !== 0) {
            current.requests = null;
          }

          if (reserved.retries !== 0) {
            current.retries = null;
          }
        }

        return current;
      })
    );

    return { charge, measurements, remaining, reserve };
  }
);

export const makeOperationWorkBudget = createOperationWorkBudget;
