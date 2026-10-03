import { DateTime, Effect, Schema } from "effect";

import type { AgentStoreService } from "../contracts/agent-store.js";
import type { AgentHandle } from "../model/agent-common.js";
import {
  OPERATION_SCHEMA_VERSION,
  OperationPlanSchema,
  OperationReceiptSchema,
  OperationStepSchema,
} from "../model/agent-operation.js";
import type {
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import {
  agentDecoded,
  agentEncoded,
  agentError,
  agentHash,
  enforceAgentBytes,
} from "./agent-db.js";
import type { AgentDbContext } from "./agent-db.js";

const decodePlanRow = Schema.decodeUnknownSync(
  Schema.Struct({
    body: Schema.String,
    validity: OperationPlanSchema.fields.validity,
  })
);

const decodeBodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const BoundedOperationBodySchema = Schema.Struct({
  body: Schema.NullOr(Schema.String),
});

type BoundedOperationBody = typeof BoundedOperationBodySchema.Type;

const decodeBoundedBodyRow = Schema.decodeUnknownSync(
  BoundedOperationBodySchema
);

const decodeRecoveryPlanRow = Schema.decodeUnknownSync(
  Schema.Struct({
    generation: Schema.Int,
    plan_digest: Schema.String,
    plan_id: Schema.String,
    store_id: Schema.String,
    validity: OperationPlanSchema.fields.validity,
  })
);

const decodeOwnerRow = Schema.decodeUnknownSync(
  Schema.Struct({ owner_id: Schema.NullOr(Schema.String) })
);

const decodeReservationRow = Schema.decodeUnknownSync(
  Schema.Struct({
    active: Schema.Int,
    operation_id: Schema.String,
    plan_digest: Schema.String,
    plan_id: Schema.String,
  })
);

const decodeAliasRow = Schema.decodeUnknownSync(
  Schema.Struct({
    target_generation: Schema.Int,
    target_store_id: Schema.String,
  })
);

type OperationStore = Pick<
  AgentStoreService,
  | "putOperationPlan"
  | "getOperationPlan"
  | "getOperationPlanForReceipt"
  | "reserveOperation"
  | "getOperation"
  | "updateOperation"
  | "appendOperationStep"
  | "requestOperationCancellation"
>;

const boundedOperationBody = (row: BoundedOperationBody): string => {
  const { body } = row;

  if (body === null) {
    throw agentError(
      "budget-exhausted",
      "The durable operation record exceeds its declared storage byte limit"
    );
  }

  return body;
};

const retainIds = (
  previous: readonly string[],
  next: readonly string[]
): void => {
  const selected = new Set(next);

  if (previous.some((id) => !selected.has(id))) {
    throw agentError(
      "invalid-transition",
      "An operation update cannot remove recorded effects"
    );
  }
};

const retainStep = (previous: OperationStep, next: OperationStep): void => {
  if (
    previous.source !== next.source ||
    previous.inserted > next.inserted ||
    previous.duplicates > next.duplicates ||
    (previous.rejected !== null &&
      (next.rejected === null
        ? previous.rejected > 0 ||
          !["running", "not-attempted"].includes(previous.state)
        : previous.rejected > next.rejected)) ||
    previous.retries > next.retries ||
    (previous.committedThrough !== null && next.committedThrough === null)
  ) {
    throw agentError(
      "invalid-transition",
      "An operation update cannot discard committed step progress"
    );
  }

  retainIds(previous.spooledRefs, next.spooledRefs);

  if (
    ["committed", "unchanged", "already-applied"].includes(previous.state) &&
    agentEncoded(OperationStepSchema, previous) !==
      agentEncoded(OperationStepSchema, next)
  ) {
    throw agentError(
      "invalid-transition",
      "A completed operation step is immutable"
    );
  }
};

const retainReceiptBinding = (
  previous: OperationReceipt,
  next: OperationReceipt
): void => {
  const resuming =
    ["partial", "interrupted"].includes(previous.executionState) &&
    next.executionState === "running";

  if (
    previous.planId !== next.planId ||
    previous.planDigest !== next.planDigest ||
    previous.idempotencyKey !== next.idempotencyKey ||
    previous.beforeRevision !== next.beforeRevision ||
    (previous.cancellationRequested && !next.cancellationRequested) ||
    (previous.startedAt !== null && previous.startedAt !== next.startedAt) ||
    (previous.completedAt !== null &&
      previous.completedAt !== next.completedAt &&
      !(resuming && next.completedAt === null)) ||
    (["succeeded", "failed", "cancelled", "rejected", "expired"].includes(
      previous.executionState
    ) &&
      previous.executionState !== next.executionState)
  ) {
    throw agentError(
      "invalid-transition",
      "An operation update cannot change its reservation or discard completed state"
    );
  }
};

const retainReceipt = (
  previous: OperationReceipt,
  next: OperationReceipt
): void => {
  retainReceiptBinding(previous, next);

  retainIds(previous.effects.filesChanged, next.effects.filesChanged);
  retainIds(previous.effects.evidenceIds, next.effects.evidenceIds);
  retainIds(previous.effects.backupIds, next.effects.backupIds);
  retainIds(previous.effects.exports, next.effects.exports);

  const backupSchema =
    OperationReceiptSchema.fields.effects.fields.backupArtifacts;

  const exportSchema =
    OperationReceiptSchema.fields.effects.fields.exportArtifacts;

  const removedSchema =
    OperationReceiptSchema.fields.effects.fields.removedRefs;

  retainIds(
    previous.effects.backupArtifacts.map((artifact) =>
      agentEncoded(backupSchema, [artifact])
    ),
    next.effects.backupArtifacts.map((artifact) =>
      agentEncoded(backupSchema, [artifact])
    )
  );
  retainIds(
    previous.effects.exportArtifacts.map((artifact) =>
      agentEncoded(exportSchema, [artifact])
    ),
    next.effects.exportArtifacts.map((artifact) =>
      agentEncoded(exportSchema, [artifact])
    )
  );
  retainIds(
    previous.effects.removedRefs.map((ref) =>
      agentEncoded(removedSchema, [ref])
    ),
    next.effects.removedRefs.map((ref) => agentEncoded(removedSchema, [ref]))
  );

  if (
    previous.effects.remainingStoreGeneration >
      next.effects.remainingStoreGeneration ||
    (previous.effects.removedCount !== null &&
      (next.effects.removedCount === null ||
        previous.effects.removedCount > next.effects.removedCount)) ||
    (previous.effects.configDigest !== null &&
      previous.effects.configDigest !== next.effects.configDigest)
  ) {
    throw agentError(
      "invalid-transition",
      "An operation update cannot discard recorded mutation results"
    );
  }

  const nextSteps = new Map(next.steps.map((step) => [step.id, step]));

  if (nextSteps.size !== next.steps.length) {
    throw agentError(
      "invalid-transition",
      "Each operation step must have a distinct ID"
    );
  }

  for (const step of previous.steps) {
    const replacement = nextSteps.get(step.id);

    if (replacement === undefined) {
      throw agentError(
        "invalid-transition",
        "An operation update cannot remove a journalled step"
      );
    }

    retainStep(step, replacement);
  }
};

const newReceipt = (
  plan: OperationPlan,
  idempotencyKey: string,
  beforeRevision: string
): OperationReceipt => ({
  afterRevision: null,
  beforeRevision,
  cancellationRequested: false,
  completedAt: null,
  effects: {
    backupArtifacts: [],
    backupIds: [],
    configDigest: null,
    evidenceIds: [],
    exportArtifacts: [],
    exports: [],
    filesChanged: [],
    remainingStoreGeneration: plan.storeGeneration,
    removalReason: null,
    removedCount: null,
    removedRefs: [],
  },
  executionState: "planned",
  id: `operation-${agentHash(JSON.stringify([plan.storeId, plan.storeGeneration, idempotencyKey]))}`,
  idempotencyKey,
  planDigest: plan.planDigest,
  planId: plan.id,
  recovery: "none",
  resources: {
    bytesRead: null,
    elapsedMs: null,
    recordsDecoded: null,
    requests: null,
    retries: null,
  },
  resultingBasisId: null,
  revision: 0,
  schemaVersion: OPERATION_SCHEMA_VERSION,
  startedAt: null,
  steps: [],
  storeGeneration: plan.storeGeneration,
  storeId: plan.storeId,
  verificationRefs: [],
  verificationState: "not-attempted",
});

const compareRevision = (
  receipt: OperationReceipt,
  expectedRevision: number
): void => {
  if (receipt.revision !== expectedRevision) {
    throw agentError(
      "revision-conflict",
      "The operation receipt changed before this update",
      {
        current: String(receipt.revision),
        expected: String(expectedRevision),
      }
    );
  }
};

export const sqliteOperationMethods = (ctx: AgentDbContext): OperationStore => {
  const readPlan = (handle: AgentHandle): OperationPlan => {
    ctx.assertHandle(handle);

    const row = ctx.db
      .prepare(
        "SELECT body, validity FROM agent_operation_plans WHERE id = ? AND store_id = ? AND generation = ?"
      )
      .get(handle.id, handle.storeId, handle.storeGeneration);

    if (row === undefined) {
      throw agentError(
        "operation-not-found",
        "The operation plan is unavailable in this store generation"
      );
    }

    const stored = decodePlanRow(row);

    return {
      ...agentDecoded(OperationPlanSchema, stored.body),
      validity: stored.validity,
    };
  };

  const readReceipt = (handle: AgentHandle): OperationReceipt => {
    ctx.assertHandle(handle);

    const row = ctx.db
      .prepare(
        "SELECT CASE WHEN length(CAST(body AS BLOB)) <= ? THEN body ELSE NULL END AS body FROM agent_operations WHERE id = ? AND store_id = ? AND generation = ?"
      )
      .get(
        ctx.limits.maxOperationBytes,
        handle.id,
        handle.storeId,
        handle.storeGeneration
      );

    if (row === undefined) {
      throw agentError(
        "operation-not-found",
        "The operation receipt is unavailable in this store generation"
      );
    }

    const receipt = agentDecoded(
      OperationReceiptSchema,
      boundedOperationBody(decodeBoundedBodyRow(row))
    );

    if (
      receipt.id !== handle.id ||
      receipt.storeId !== handle.storeId ||
      receipt.storeGeneration !== handle.storeGeneration
    ) {
      throw agentError(
        "idempotency-conflict",
        "The operation receipt does not match its durable handle binding"
      );
    }

    return receipt;
  };

  const readRecoveredReceipt = (handle: AgentHandle): OperationReceipt => {
    const visited = new Set<string>();
    let target = handle;

    for (let depth = 0; depth < 16; depth += 1) {
      const identity = JSON.stringify([
        target.storeId,
        target.storeGeneration,
        target.id,
      ]);

      if (visited.has(identity)) {
        throw agentError(
          "stale-generation",
          "The operation recovery aliases contain a cycle"
        );
      }

      visited.add(identity);

      const row = ctx.db
        .prepare(
          "SELECT target_store_id, target_generation FROM agent_operation_aliases WHERE store_id = ? AND generation = ? AND operation_id = ?"
        )
        .get(target.storeId, target.storeGeneration, target.id);

      if (row === undefined) {
        return readReceipt(target);
      }

      const alias = decodeAliasRow(row);

      if (
        alias.target_store_id === target.storeId &&
        alias.target_generation === target.storeGeneration
      ) {
        return readReceipt(target);
      }

      target = {
        id: target.id,
        storeGeneration: alias.target_generation,
        storeId: alias.target_store_id,
      };
    }

    throw agentError(
      "stale-generation",
      "The operation recovery alias chain exceeds its bounded lookup limit"
    );
  };

  const readReceiptPlan = (handle: AgentHandle): OperationPlan | null => {
    const receipt = readRecoveredReceipt(handle);

    const row = ctx.db
      .prepare(
        "SELECT CASE WHEN length(CAST(p.body AS BLOB)) <= ? THEN p.body ELSE NULL END AS body, p.validity, p.id AS plan_id, p.plan_digest, p.store_id, p.generation FROM agent_operation_plans p CROSS JOIN agent_reservations r WHERE p.id = ? AND p.plan_digest = ? AND r.store_id = p.store_id AND r.generation = p.generation AND r.key = ? AND r.operation_id = ? AND r.plan_id = p.id AND r.plan_digest = p.plan_digest LIMIT 1"
      )
      .get(
        ctx.limits.maxOperationBytes,
        receipt.planId,
        receipt.planDigest,
        receipt.idempotencyKey,
        receipt.id
      );

    if (row === undefined) {
      return null;
    }

    const binding = decodeRecoveryPlanRow(row);

    const originalReceipt = readRecoveredReceipt({
      id: receipt.id,
      storeGeneration: binding.generation,
      storeId: binding.store_id,
    });

    if (
      originalReceipt.id !== receipt.id ||
      originalReceipt.storeId !== receipt.storeId ||
      originalReceipt.storeGeneration !== receipt.storeGeneration
    ) {
      return null;
    }

    const plan = agentDecoded(
      OperationPlanSchema,
      boundedOperationBody(decodeBoundedBodyRow(row))
    );

    if (
      plan.id !== binding.plan_id ||
      plan.planDigest !== binding.plan_digest ||
      plan.storeId !== binding.store_id ||
      plan.storeGeneration !== binding.generation
    ) {
      return null;
    }

    return { ...plan, validity: binding.validity };
  };

  const readReservation = (
    handle: AgentHandle,
    expectedDigest: string,
    idempotencyKey: string
  ): OperationReceipt | null => {
    const row = ctx.db
      .prepare(
        "SELECT active, plan_id, plan_digest, operation_id FROM agent_reservations WHERE store_id = ? AND generation = ? AND key = ?"
      )
      .get(handle.storeId, handle.storeGeneration, idempotencyKey);

    if (row === undefined) {
      return null;
    }

    const reservation = decodeReservationRow(row);

    if (
      reservation.plan_id !== handle.id ||
      reservation.plan_digest !== expectedDigest
    ) {
      throw agentError(
        "idempotency-conflict",
        "The idempotency key is bound to a different operation plan"
      );
    }

    const receipt = readRecoveredReceipt({
      ...handle,
      id: reservation.operation_id,
    });

    if (
      receipt.planId !== reservation.plan_id ||
      receipt.planDigest !== expectedDigest ||
      receipt.idempotencyKey !== idempotencyKey
    ) {
      throw agentError(
        "idempotency-conflict",
        "The recovered receipt does not match its original reservation"
      );
    }

    if (
      reservation.active === 0 ||
      (reservation.active !== 1 && receipt.executionState === "planned")
    ) {
      throw agentError(
        "stale-generation",
        "The unused operation reservation was invalidated by a store generation change"
      );
    }

    return receipt;
  };

  const saveReceipt = (
    previous: OperationReceipt,
    next: OperationReceipt,
    expectedRevision: number,
    journalSteps: readonly OperationStep[],
    preserveOwner = false
  ): OperationReceipt => {
    compareRevision(previous, expectedRevision);
    retainReceipt(previous, next);

    const owner = decodeOwnerRow(
      ctx.db
        .prepare(
          "SELECT owner_id FROM agent_operations WHERE id = ? AND store_id = ? AND generation = ?"
        )
        .get(previous.id, previous.storeId, previous.storeGeneration)
    ).owner_id;

    if (!preserveOwner && owner !== null && owner !== ctx.ownerId) {
      throw agentError(
        "revision-conflict",
        "The persisted operation belongs to another active writer session; get the latest receipt before retrying"
      );
    }

    const receipt = { ...next, revision: expectedRevision + 1 };
    const body = agentEncoded(OperationReceiptSchema, receipt);
    enforceAgentBytes(body, ctx.limits.maxOperationBytes);

    const runningOwner =
      receipt.executionState === "running" ? ctx.ownerId : null;

    const nextOwner = preserveOwner ? owner : runningOwner;

    const result = ctx.db
      .prepare(
        "UPDATE agent_operations SET revision = ?, state = ?, body = ?, owner_id = ? WHERE id = ? AND store_id = ? AND generation = ? AND revision = ? AND owner_id IS ?"
      )
      .run(
        receipt.revision,
        receipt.executionState,
        body,
        nextOwner,
        receipt.id,
        receipt.storeId,
        receipt.storeGeneration,
        expectedRevision,
        owner
      );

    if (result.changes !== 1) {
      throw agentError(
        "revision-conflict",
        "The operation receipt changed before this update"
      );
    }

    for (const step of journalSteps) {
      const stepBody = agentEncoded(OperationStepSchema, step);
      enforceAgentBytes(stepBody, ctx.limits.maxOperationBytes);
      ctx.db
        .prepare(
          "INSERT INTO agent_operation_steps(operation_id, revision, body) VALUES (?, ?, ?)"
        )
        .run(receipt.id, receipt.revision, stepBody);
    }

    return receipt;
  };

  return {
    appendOperationStep: (handle, step, expectedRevision) =>
      ctx.write("agent.operation.appendStep", () => {
        const previous = readReceipt(handle);
        compareRevision(previous, expectedRevision);
        const existing = previous.steps.find((entry) => entry.id === step.id);

        const steps =
          existing === undefined
            ? [...previous.steps, step]
            : previous.steps.map((entry) =>
                entry.id === step.id ? step : entry
              );

        return saveReceipt(previous, { ...previous, steps }, expectedRevision, [
          step,
        ]);
      }),
    getOperation: (handle) =>
      ctx.read("agent.operation.get", () => readRecoveredReceipt(handle)),
    getOperationPlan: (handle) =>
      ctx.read("agent.operation.getPlan", () => readPlan(handle)),
    getOperationPlanForReceipt: (handle) =>
      Effect.gen(function* getOperationPlanForReceipt() {
        const plan = yield* ctx.read("agent.operation.getReceiptPlan", () =>
          readReceiptPlan(handle)
        );

        if (plan === null || plan.validity !== "valid") {
          return plan;
        }

        const now = yield* DateTime.now;

        if (
          DateTime.toEpochMillis(DateTime.makeUnsafe(plan.expiresAt)) <=
          DateTime.toEpochMillis(now)
        ) {
          const expired: OperationPlan = { ...plan, validity: "expired" };

          return expired;
        }

        return plan;
      }),
    putOperationPlan: (plan) =>
      ctx.write("agent.operation.putPlan", () => {
        ctx.assertHandle(plan);
        const body = agentEncoded(OperationPlanSchema, plan);
        enforceAgentBytes(body, ctx.limits.maxOperationBytes);

        const previous = ctx.db
          .prepare("SELECT body FROM agent_operation_plans WHERE id = ?")
          .get(plan.id);

        if (previous !== undefined) {
          if (decodeBodyRow(previous).body !== body) {
            throw agentError(
              "idempotency-conflict",
              "An operation plan ID cannot be rebound to different content"
            );
          }

          return;
        }

        ctx.db
          .prepare(
            "INSERT INTO agent_operation_plans(id, store_id, generation, plan_digest, validity, body) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(
            plan.id,
            plan.storeId,
            plan.storeGeneration,
            plan.planDigest,
            plan.validity,
            body
          );
      }),
    requestOperationCancellation: (handle, expectedRevision) =>
      ctx.write("agent.operation.cancel", () => {
        const previous = readReceipt(handle);

        return saveReceipt(
          previous,
          { ...previous, cancellationRequested: true },
          expectedRevision,
          [],
          true
        );
      }),
    reserveOperation: (handle, expectedDigest, idempotencyKey) =>
      ctx.write("agent.operation.reserve", () => {
        const existing = readReservation(
          handle,
          expectedDigest,
          idempotencyKey
        );

        if (existing !== null) {
          return { receipt: existing, reused: true };
        }

        const plan = readPlan(handle);

        if (plan.planDigest !== expectedDigest) {
          throw agentError(
            "idempotency-conflict",
            "The supplied operation digest differs from the reviewed plan"
          );
        }

        if (plan.validity !== "valid") {
          throw agentError(
            plan.validity === "expired" ? "plan-expired" : "plan-stale",
            "The operation plan requires replacement before applying effects"
          );
        }

        const receipt = newReceipt(
          plan,
          idempotencyKey,
          ctx.identity().revision
        );

        const body = agentEncoded(OperationReceiptSchema, receipt);
        enforceAgentBytes(body, ctx.limits.maxOperationBytes);
        ctx.db
          .prepare(
            "INSERT INTO agent_operations(id, store_id, generation, revision, state, body, owner_id) VALUES (?, ?, ?, ?, ?, ?, NULL)"
          )
          .run(
            receipt.id,
            receipt.storeId,
            receipt.storeGeneration,
            receipt.revision,
            receipt.executionState,
            body
          );
        ctx.db
          .prepare(
            "INSERT INTO agent_reservations(store_id, generation, key, plan_id, plan_digest, operation_id) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(
            plan.storeId,
            plan.storeGeneration,
            idempotencyKey,
            plan.id,
            plan.planDigest,
            receipt.id
          );

        return { receipt, reused: false };
      }),
    updateOperation: (receipt, expectedRevision) =>
      ctx.write("agent.operation.update", () => {
        const previous = readReceipt(receipt);

        const previousSteps = new Map(
          previous.steps.map((step) => [step.id, step])
        );

        const journalSteps = receipt.steps.filter((step) => {
          const existing = previousSteps.get(step.id);

          return (
            existing === undefined ||
            agentEncoded(OperationStepSchema, existing) !==
              agentEncoded(OperationStepSchema, step)
          );
        });

        return saveReceipt(previous, receipt, expectedRevision, journalSteps);
      }),
  };
};
