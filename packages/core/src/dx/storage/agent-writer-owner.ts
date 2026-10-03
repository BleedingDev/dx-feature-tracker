// @effect-diagnostics-next-line nodeBuiltinImport:off -- Store acquisition checks only the persisted owner's process start time before crash recovery.
import { spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A random nonce identifies each independently opened writer session.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

import {
  OperationReceiptSchema,
  OperationStepSchema,
} from "../model/agent-operation.js";
import { agentDecoded, agentEncoded } from "./agent-db.js";

export interface AgentWriterOwner {
  readonly id: string;
  readonly close: () => void;
}

const decodeProcessError = Schema.is(Schema.Struct({ code: Schema.String }));

const processStart = (pid: number): string | null => {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf-8",
    maxBuffer: 1024,
    timeout: 1000,
  });

  if (result.error !== undefined || result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
};

const ownerAbsent = (pid: number, recordedStart: string | null): boolean => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return decodeProcessError(error) && error.code === "ESRCH";
  }

  if (recordedStart === null) {
    return false;
  }

  const currentStart = processStart(pid);

  return currentStart !== null && currentStart !== recordedStart;
};

const decodeOwner = Schema.decodeUnknownSync(
  Schema.Struct({
    closed: Schema.Int,
    id: Schema.String,
    pid: Schema.Int,
    process_start: Schema.NullOr(Schema.String),
  })
);

const decodeReceiptRow = Schema.decodeUnknownSync(
  Schema.Struct({
    body: Schema.String,
    id: Schema.String,
    revision: Schema.Int,
  })
);

const recoverOwner = (db: DatabaseSync, ownerId: string): void => {
  const rows = db
    .prepare(
      "SELECT id,revision,body FROM agent_operations WHERE state = 'running' AND owner_id = ? ORDER BY id"
    )
    .all(ownerId);

  for (const raw of rows) {
    const row = decodeReceiptRow(raw);
    const receipt = agentDecoded(OperationReceiptSchema, row.body);

    const steps = receipt.steps.map((step) =>
      step.state === "running"
        ? { ...step, state: "indeterminate" as const }
        : step
    );

    const next = {
      ...receipt,
      executionState: "interrupted" as const,
      recovery: "verify-indeterminate" as const,
      revision: receipt.revision + 1,
      steps,
      verificationState: "indeterminate" as const,
    };

    const result = db
      .prepare(
        "UPDATE agent_operations SET revision = ?,state = 'interrupted',owner_id = NULL,body = ? WHERE id = ? AND revision = ? AND state = 'running' AND owner_id = ?"
      )
      .run(
        next.revision,
        agentEncoded(OperationReceiptSchema, next),
        row.id,
        row.revision,
        ownerId
      );

    if (result.changes !== 1) {
      continue;
    }

    for (const [position, step] of steps.entries()) {
      if (receipt.steps[position]?.state !== "running") {
        continue;
      }

      db.prepare(
        "INSERT INTO agent_operation_steps(operation_id,revision,body) VALUES (?,?,?)"
      ).run(receipt.id, next.revision, agentEncoded(OperationStepSchema, step));
    }
  }
};

export const registerAgentWriter = (db: DatabaseSync): AgentWriterOwner => {
  const id = randomUUID();
  const recordedStart = processStart(process.pid);
  const absentOwners: string[] = [];

  for (const raw of db
    .prepare(
      "SELECT id,pid,process_start,closed FROM agent_writer_owners WHERE id IN (SELECT DISTINCT owner_id FROM agent_operations WHERE state = 'running' AND owner_id IS NOT NULL)"
    )
    .all()) {
    const owner = decodeOwner(raw);

    if (owner.closed === 1 || ownerAbsent(owner.pid, owner.process_start)) {
      absentOwners.push(owner.id);
    }
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    db.prepare(
      "INSERT INTO agent_writer_owners(id,pid,process_start,closed) VALUES (?,?,?,0)"
    ).run(id, process.pid, recordedStart);

    for (const ownerId of absentOwners) {
      recoverOwner(db, ownerId);
    }

    db.prepare(
      "DELETE FROM agent_writer_owners WHERE closed = 1 AND id NOT IN (SELECT DISTINCT owner_id FROM agent_operations WHERE owner_id IS NOT NULL)"
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }

    throw error;
  }

  return {
    close: () => {
      db.prepare("UPDATE agent_writer_owners SET closed = 1 WHERE id = ?").run(
        id
      );
    },
    id,
  };
};
