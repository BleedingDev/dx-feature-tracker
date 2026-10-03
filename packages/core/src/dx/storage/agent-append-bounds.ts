// @effect-diagnostics-next-line nodeBuiltinImport:off -- Replacement proofs hash exact retained source JSON without buffering a second full ledger.
import { createHash } from "node:crypto";

import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { StoreError } from "../contracts/error-store-error.js";
import type { AppendResult } from "../contracts/services.js";
import type { EventBatch } from "../model/event.js";
import { agentDecoded, agentError, canonicalAgentJson } from "./agent-db.js";
import type { AgentDbContext } from "./agent-db.js";

export interface BoundedAppendLimits {
  readonly maxRemovedRecords: number;
  readonly maxRemovedBytes: number;
  readonly maxElapsedMs: number;
}

export interface BoundedReplacementProof {
  readonly removedCount: number;
  readonly removedEventIds: readonly string[];
  readonly removedIdsOmitted: number;
  readonly removedBytes: number;
  readonly removedDigest: string | null;
  readonly factsExamined: number;
  readonly decodedBytes: number;
  readonly elapsedMs: number;
}

export type BoundedAppendResult = AppendResult & BoundedReplacementProof;

export class BoundedEventReplacement extends Context.Service<
  BoundedEventReplacement,
  {
    readonly appendBounded: (
      batch: EventBatch,
      limits: BoundedAppendLimits
    ) => Effect.Effect<BoundedAppendResult, AgentStoreFailure>;
  }
>()("@rat-stack/core/dx/BoundedEventReplacement") {}

const boundedAppendLimitsSchema = Schema.Struct({
  maxElapsedMs: Schema.Int.check(
    Schema.isBetween({ maximum: 60_000, minimum: 1 })
  ),
  maxRemovedBytes: Schema.Int.check(
    Schema.isBetween({ maximum: 67_108_864, minimum: 1 })
  ),
  maxRemovedRecords: Schema.Int.check(
    Schema.isBetween({ maximum: 100_000, minimum: 1 })
  ),
});

const replacementMetadataSchema = Schema.Struct({
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  event_id: Schema.String,
  seq: Schema.Int,
});

const decodeReplacementMetadata = Schema.decodeUnknownSync(
  replacementMetadataSchema
);

const decodeReplacementBody = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String, event_id: Schema.String })
);

export const inspectBoundedReplacement = (
  context: AgentDbContext,
  batch: EventBatch,
  limits: BoundedAppendLimits,
  startedAt: number
): BoundedReplacementProof => {
  if (!Schema.is(boundedAppendLimitsSchema)(limits)) {
    throw agentError(
      "budget-exhausted",
      "Replacement limits must be positive bounded record, byte and elapsed-time values"
    );
  }

  const checkElapsed = (): void => {
    if (performance.now() - startedAt >= limits.maxElapsedMs) {
      throw agentError(
        "budget-exhausted",
        "Replacement inspection exceeded its elapsed-time limit before mutation"
      );
    }
  };

  checkElapsed();

  if (batch.replace === undefined) {
    return {
      decodedBytes: 0,
      elapsedMs: Math.ceil(performance.now() - startedAt),
      factsExamined: 0,
      removedBytes: 0,
      removedCount: 0,
      removedDigest: null,
      removedEventIds: [],
      removedIdsOmitted: 0,
    };
  }

  const rows: (typeof replacementMetadataSchema.Type)[] = [];

  const metadata = context.db
    .prepare(
      "SELECT event_id,seq,length(CAST(body AS BLOB)) AS bytes FROM events INDEXED BY events_agent_replacement WHERE adapter_id = ? AND occurred_at >= ? ORDER BY occurred_at,seq LIMIT ?"
    )
    .iterate(
      batch.replace.adapterId,
      batch.replace.fromOccurredAt,
      limits.maxRemovedRecords + 1
    );

  let removedBytes = 0;

  for (const candidate of metadata) {
    checkElapsed();
    const row = decodeReplacementMetadata(candidate);

    if (rows.length >= limits.maxRemovedRecords) {
      throw agentError(
        "budget-exhausted",
        "Replacement would remove more records than its declared limit"
      );
    }

    if (removedBytes + row.bytes > limits.maxRemovedBytes) {
      throw agentError(
        "budget-exhausted",
        "Replacement would remove more stored source bytes than its declared limit"
      );
    }

    removedBytes += row.bytes;
    rows.push(row);
  }

  checkElapsed();

  const bodyAt = context.db.prepare(
    "SELECT event_id,body FROM events WHERE seq = ? AND event_id = ?"
  );

  const digest = createHash("sha256").update("[");
  let decodedBytes = 0;

  for (const [position, row] of rows.entries()) {
    checkElapsed();
    const candidate = bodyAt.get(row.seq, row.event_id);

    if (candidate === undefined) {
      throw new StoreError({
        message: "Replacement source metadata no longer has its matching event",
        operation: "appendBounded",
      });
    }

    const source = decodeReplacementBody(candidate);
    const sourceBytes = Buffer.byteLength(source.body, "utf-8");

    if (source.event_id !== row.event_id || sourceBytes !== row.bytes) {
      throw new StoreError({
        message: "Replacement source bytes do not match inspected metadata",
        operation: "appendBounded",
      });
    }

    decodedBytes += sourceBytes;

    if (decodedBytes > limits.maxRemovedBytes) {
      throw agentError(
        "budget-exhausted",
        "Replacement source decoding exceeded its declared byte limit"
      );
    }

    const body = agentDecoded(Schema.Json, source.body);

    if (position > 0) {
      digest.update(",");
    }

    digest.update(canonicalAgentJson({ body, eventId: row.event_id }));
    checkElapsed();
  }

  digest.update("]");
  checkElapsed();

  return {
    decodedBytes,
    elapsedMs: Math.ceil(performance.now() - startedAt),
    factsExamined: rows.length,
    removedBytes,
    removedCount: rows.length,
    removedDigest: `sha256:${digest.digest("hex")}`,
    removedEventIds: rows.slice(0, 500).map((row) => row.event_id),
    removedIdsOmitted: Math.max(0, rows.length - 500),
  };
};
