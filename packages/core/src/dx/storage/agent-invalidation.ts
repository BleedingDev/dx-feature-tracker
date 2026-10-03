import type { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

import type { AgentHandle, StoreIdentity } from "../model/agent-common.js";
import { OperationReceiptSchema } from "../model/agent-operation.js";
import type { OperationReceipt } from "../model/agent-operation.js";
import {
  AGENT_RETENTION_DEFAULTS,
  agentDecoded,
  agentEncoded,
  agentError,
  agentIdentity,
  enforceAgentBytes,
} from "./agent-db.js";

export const AGENT_RECOVERY_TABLES = [
  "agent_operation_plans",
  "agent_operation_aliases",
  "agent_operations",
  "agent_operation_steps",
  "agent_reservations",
  "agent_writer_owners",
] as const;

const OperationRowSchema = Schema.Struct({
  body: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  id: Schema.String,
  store_id: Schema.String,
});

type OperationRow = typeof OperationRowSchema.Type;

const decodeOperationRow = Schema.decodeUnknownSync(OperationRowSchema);

const invalidationReceipt = (row: OperationRow): OperationReceipt => {
  if (row.body === null) {
    throw agentError(
      "budget-exhausted",
      "A durable operation exceeds the generation invalidation record byte limit"
    );
  }

  const receipt = agentDecoded(OperationReceiptSchema, row.body);

  if (
    receipt.id !== row.id ||
    receipt.storeId !== row.store_id ||
    receipt.storeGeneration !== row.generation
  ) {
    throw agentError(
      "idempotency-conflict",
      "The operation receipt does not match its durable generation binding"
    );
  }

  return receipt;
};

const decodeAliasTarget = Schema.decodeUnknownSync(
  Schema.Struct({
    target_generation: Schema.Int,
    target_store_id: Schema.String,
  })
);

const decodeAliasOrigin = Schema.decodeUnknownSync(
  Schema.Struct({ generation: Schema.Int, store_id: Schema.String })
);

const aliasReachesReceipt = (
  db: DatabaseSync,
  origin: AgentHandle,
  receipt: OperationReceipt
): boolean => {
  const visited = new Set<string>();
  let target = origin;

  for (let depth = 0; depth < 16; depth += 1) {
    if (
      target.storeId === receipt.storeId &&
      target.storeGeneration === receipt.storeGeneration
    ) {
      return true;
    }

    const identity = JSON.stringify([target.storeId, target.storeGeneration]);

    if (visited.has(identity)) {
      return false;
    }

    visited.add(identity);

    const row = db
      .prepare(
        "SELECT target_store_id,target_generation FROM agent_operation_aliases WHERE store_id = ? AND generation = ? AND operation_id = ?"
      )
      .get(target.storeId, target.storeGeneration, receipt.id);

    if (row === undefined) {
      return false;
    }

    const alias = decodeAliasTarget(row);
    target = {
      id: receipt.id,
      storeGeneration: alias.target_generation,
      storeId: alias.target_store_id,
    };
  }

  return false;
};

interface OperationReservationBinding {
  readonly storeId: string;
  readonly storeGeneration: number;
  readonly key: string;
}

const receiptReservation = (
  db: DatabaseSync,
  receipt: OperationReceipt
): OperationReservationBinding | null => {
  const direct = db
    .prepare(
      "SELECT 1 FROM agent_reservations WHERE store_id = ? AND generation = ? AND key = ? AND operation_id = ? AND plan_id = ? AND plan_digest = ?"
    )
    .get(
      receipt.storeId,
      receipt.storeGeneration,
      receipt.idempotencyKey,
      receipt.id,
      receipt.planId,
      receipt.planDigest
    );

  if (direct !== undefined) {
    return {
      key: receipt.idempotencyKey,
      storeGeneration: receipt.storeGeneration,
      storeId: receipt.storeId,
    };
  }

  const original = db
    .prepare(
      "SELECT p.store_id,p.generation FROM agent_operation_plans p CROSS JOIN agent_reservations r WHERE p.id = ? AND p.plan_digest = ? AND r.store_id = p.store_id AND r.generation = p.generation AND r.key = ? AND r.operation_id = ? AND r.plan_id = p.id AND r.plan_digest = p.plan_digest"
    )
    .get(
      receipt.planId,
      receipt.planDigest,
      receipt.idempotencyKey,
      receipt.id
    );

  if (original !== undefined) {
    const origin = decodeAliasOrigin(original);

    if (
      aliasReachesReceipt(
        db,
        {
          id: receipt.id,
          storeGeneration: origin.generation,
          storeId: origin.store_id,
        },
        receipt
      )
    ) {
      return {
        key: receipt.idempotencyKey,
        storeGeneration: origin.generation,
        storeId: origin.store_id,
      };
    }
  }

  for (const raw of db
    .prepare(
      "SELECT a.store_id,a.generation FROM agent_operation_aliases a CROSS JOIN agent_reservations r WHERE a.operation_id = ? AND r.store_id = a.store_id AND r.generation = a.generation AND r.key = ? AND r.operation_id = a.operation_id AND r.plan_id = ? AND r.plan_digest = ?"
    )
    .iterate(
      receipt.id,
      receipt.idempotencyKey,
      receipt.planId,
      receipt.planDigest
    )) {
    const origin = decodeAliasOrigin(raw);

    if (
      aliasReachesReceipt(
        db,
        {
          id: receipt.id,
          storeGeneration: origin.generation,
          storeId: origin.store_id,
        },
        receipt
      )
    ) {
      return {
        key: receipt.idempotencyKey,
        storeGeneration: origin.generation,
        storeId: origin.store_id,
      };
    }
  }

  return null;
};

export const invalidateAgentState = (
  db: DatabaseSync,
  reason: "reset" | "restore" | "replacement",
  options: {
    readonly preserveOperationId?: string;
    readonly maxOperationBytes?: number;
  } = {}
): StoreIdentity => {
  db.exec(
    "UPDATE store_meta SET value = lower(hex(randomblob(16))) WHERE key = 'agent_epoch'"
  );
  db.exec(
    "UPDATE store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'agent_revision'"
  );

  if (reason !== "restore") {
    db.exec(
      "UPDATE store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'agent_generation'"
    );
    db.exec("DELETE FROM agent_bases");
    db.exec("DELETE FROM agent_basis_events");
    db.exec("DELETE FROM agent_basis_headers");
    db.exec("DELETE FROM agent_results");
    db.exec("DELETE FROM agent_result_headers");
    db.exec("DELETE FROM agent_result_items");
    db.exec("DELETE FROM agent_learning");
    db.exec("DELETE FROM agent_learning_history");
    db.exec("DELETE FROM agent_learning_mutations");
    db.exec("DELETE FROM agent_evaluations");
    db.exec("DELETE FROM agent_coverage_latest");
    db.exec("DELETE FROM agent_source_associations");
  }

  db.exec("DELETE FROM agent_cursors");
  db.exec("DELETE FROM agent_event_reads");
  db.exec("UPDATE agent_operation_plans SET validity = 'stale'");
  db.exec("UPDATE agent_reservations SET active = 0");

  const current = agentIdentity(db);

  const maxOperationBytes =
    options.maxOperationBytes ?? AGENT_RETENTION_DEFAULTS.maxOperationBytes;

  const update = db.prepare(
    "UPDATE agent_operations SET store_id = ?,generation = ?,revision = ?,state = ?,body = ?,owner_id = CASE WHEN ? = 1 THEN owner_id ELSE NULL END WHERE id = ?"
  );

  for (const raw of db
    .prepare(
      "SELECT id,store_id,generation,CASE WHEN length(CAST(body AS BLOB)) <= ? THEN body ELSE NULL END AS body FROM agent_operations"
    )
    .iterate(maxOperationBytes)) {
    const row = decodeOperationRow(raw);
    const receipt = invalidationReceipt(row);

    const preserved = row.id === options.preserveOperationId;

    const terminal = [
      "succeeded",
      "failed",
      "cancelled",
      "rejected",
      "expired",
    ].includes(receipt.executionState);

    const binding =
      terminal || preserved ? receiptReservation(db, receipt) : null;

    const retained = binding !== null;

    const pending = ["planned", "running", "interrupted", "partial"].includes(
      receipt.executionState
    );

    if (!retained && !pending) {
      continue;
    }

    if (binding !== null) {
      db.prepare(
        "UPDATE agent_operation_aliases SET target_store_id = ?,target_generation = ? WHERE operation_id = ?"
      ).run(current.storeId, current.storeGeneration, receipt.id);

      db.prepare(
        "UPDATE agent_reservations SET active = 2 WHERE store_id = ? AND generation = ? AND key = ? AND operation_id = ? AND plan_id = ? AND plan_digest = ?"
      ).run(
        binding.storeId,
        binding.storeGeneration,
        binding.key,
        receipt.id,
        receipt.planId,
        receipt.planDigest
      );
    }

    if (
      retained &&
      (receipt.storeId !== current.storeId ||
        receipt.storeGeneration !== current.storeGeneration)
    ) {
      db.prepare(
        "INSERT OR REPLACE INTO agent_operation_aliases(store_id,generation,operation_id,target_store_id,target_generation) VALUES (?,?,?,?,?)"
      ).run(
        receipt.storeId,
        receipt.storeGeneration,
        receipt.id,
        current.storeId,
        current.storeGeneration
      );
    }

    const next = retained
      ? {
          ...receipt,
          storeGeneration: current.storeGeneration,
          storeId: current.storeId,
        }
      : {
          ...receipt,
          cancellationRequested: true,
          executionState: "interrupted" as const,
          recovery: "replan" as const,
          revision: receipt.revision + 1,
          verificationState: "indeterminate" as const,
        };

    const body = agentEncoded(OperationReceiptSchema, next);

    enforceAgentBytes(body, maxOperationBytes);
    update.run(
      next.storeId,
      next.storeGeneration,
      next.revision,
      next.executionState,
      body,
      retained && preserved && receipt.executionState === "running" ? 1 : 0,
      row.id
    );
  }

  return current;
};

export const tombstoneAgentScope = (db: DatabaseSync, repoId: string): void => {
  db.prepare("DELETE FROM agent_coverage_latest WHERE repo_id = ?").run(repoId);
  db.prepare(
    "UPDATE agent_results SET projection = NULL WHERE basis_id IN (SELECT id FROM agent_bases WHERE repo_id = ?)"
  ).run(repoId);
  db.prepare(
    "DELETE FROM agent_result_items WHERE result_id IN (SELECT id FROM agent_results WHERE basis_id IN (SELECT id FROM agent_bases WHERE repo_id = ?))"
  ).run(repoId);
  db.prepare(
    "UPDATE agent_result_headers SET summary = 'null',disclosures = '[]',resolutions = '[]' WHERE id IN (SELECT id FROM agent_results WHERE basis_id IN (SELECT id FROM agent_bases WHERE repo_id = ?))"
  ).run(repoId);
  db.prepare(
    "UPDATE agent_bases SET content_available = 0,body = '{}' WHERE repo_id = ?"
  ).run(repoId);
  db.prepare(
    "DELETE FROM agent_cursors WHERE json_extract(body,'$.basisId') IN (SELECT id FROM agent_bases WHERE repo_id = ?)"
  ).run(repoId);
  db.exec("DELETE FROM agent_event_reads");
};

export const tombstoneReplacedAgentEvents = (
  db: DatabaseSync,
  adapterId: string,
  fromOccurredAt: string
): void => {
  const selection =
    "SELECT DISTINCT basis_id FROM agent_basis_events WHERE event_id IN (SELECT event_id FROM events WHERE adapter_id = ? AND occurred_at >= ?)";

  db.prepare(
    `UPDATE agent_results SET projection = NULL WHERE basis_id IN (${selection})`
  ).run(adapterId, fromOccurredAt);
  db.prepare(
    `DELETE FROM agent_result_items WHERE result_id IN (SELECT id FROM agent_results WHERE basis_id IN (${selection}))`
  ).run(adapterId, fromOccurredAt);
  db.prepare(
    `UPDATE agent_result_headers SET summary = 'null',disclosures = '[]',resolutions = '[]' WHERE id IN (SELECT id FROM agent_results WHERE basis_id IN (${selection}))`
  ).run(adapterId, fromOccurredAt);
  db.prepare(
    `UPDATE agent_bases SET content_available = 0,body = '{}' WHERE id IN (${selection})`
  ).run(adapterId, fromOccurredAt);
  db.prepare(
    `DELETE FROM agent_cursors WHERE json_extract(body,'$.basisId') IN (${selection})`
  ).run(adapterId, fromOccurredAt);
  db.exec("DELETE FROM agent_event_reads");
};
