import { Schema } from "effect";

import type {
  AgentRef,
  AgentRefResolution,
  AgentScope,
  StoreIdentity,
} from "../model/agent-common.js";
import { agentError } from "./agent-db.js";
import type { AgentDbContext } from "./agent-db.js";

const RefMetadataSchema = Schema.Struct({
  content_available: Schema.Int,
  generation: Schema.Int,
  repo_id: Schema.NullOr(Schema.String),
  store_id: Schema.String,
});

type RefMetadata = typeof RefMetadataSchema.Type;

const decodeMetadata = Schema.decodeUnknownSync(RefMetadataSchema);

const decodeResultMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    ...RefMetadataSchema.fields,
    basis_id: Schema.String,
  })
);

const decodeOperationMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    ...RefMetadataSchema.fields,
    revision: Schema.Int,
  })
);

const decodeEventMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    event_id: Schema.String,
    repo_id: Schema.NullOr(Schema.String),
  })
);

const decodeBasisMember = Schema.decodeUnknownSync(
  Schema.Struct({ event_id: Schema.String })
);

const EVIDENCE_CANDIDATE_LIMIT = 32;

const resolution = (
  ref: AgentRef,
  state: AgentRefResolution["state"],
  reason: string | null
): AgentRefResolution => ({ reason, ref, state });

const missing = (ref: AgentRef, reason: string): AgentRefResolution =>
  resolution(ref, "missing-in-basis", reason);

const withheld = (ref: AgentRef): AgentRefResolution =>
  resolution(
    ref,
    "withheld",
    "The reference is outside the selected repository scope"
  );

const stale = (ref: AgentRef): AgentRefResolution =>
  resolution(
    ref,
    "stale-generation",
    "The reference belongs to another store identity or generation"
  );

const outsideScope = (repoId: string | null, scope?: AgentScope): boolean =>
  scope !== undefined && scope.repoId !== null && repoId !== scope.repoId;

const metadataResolution = (
  ref: AgentRef,
  record: RefMetadata | undefined,
  scope?: AgentScope
): AgentRefResolution => {
  if (record === undefined) {
    return missing(ref, "The typed reference has no retained storage record");
  }

  if (
    record.store_id !== ref.storeId ||
    record.generation !== ref.storeGeneration
  ) {
    return stale(ref);
  }

  if (outsideScope(record.repo_id, scope)) {
    return withheld(ref);
  }

  if (record.content_available !== 1) {
    return missing(ref, "The referenced content was removed or is unavailable");
  }

  return resolution(ref, "found", null);
};

const basisMetadata = (
  ctx: AgentDbContext,
  id: string
): RefMetadata | undefined => {
  const row = ctx.db
    .prepare(
      "SELECT store_id,generation,repo_id,content_available FROM agent_bases WHERE id = ?"
    )
    .get(id);

  return row === undefined ? undefined : decodeMetadata(row);
};

const basisResolution = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution =>
  metadataResolution(ref, basisMetadata(ctx, ref.id), scope);

const resultResolution = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  const row = ctx.db
    .prepare(
      "SELECT r.store_id,r.generation,r.basis_id,b.repo_id,CASE WHEN r.projection IS NOT NULL AND b.content_available = 1 THEN 1 ELSE 0 END AS content_available FROM agent_results r LEFT JOIN agent_bases b ON b.id = r.basis_id AND b.store_id = r.store_id AND b.generation = r.generation WHERE r.id = ?"
    )
    .get(ref.id);

  if (row === undefined) {
    return missing(ref, "The result reference has no retained storage record");
  }

  const record = decodeResultMetadata(row);
  const resolved = metadataResolution(ref, record, scope);

  if (resolved.state !== "found") {
    return resolved;
  }

  if (ref.basisId !== null && record.basis_id !== ref.basisId) {
    return missing(ref, "The result does not belong to the reference basis");
  }

  return resolved;
};

const isBasisMember = (
  ctx: AgentDbContext,
  basisId: string | null,
  eventId: string
): boolean => {
  if (basisId === null) {
    return true;
  }

  const row = ctx.db
    .prepare(
      "SELECT event_id FROM agent_basis_events WHERE basis_id = ? AND event_id = ?"
    )
    .get(basisId, eventId);

  return row !== undefined && decodeBasisMember(row).event_id === eventId;
};

const eventResolution = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  const row = ctx.db
    .prepare(
      "SELECT event_id,repo_common_dir AS repo_id FROM events WHERE event_id = ?"
    )
    .get(ref.id);

  if (row === undefined) {
    return missing(ref, "The event reference has no retained source event");
  }

  const event = decodeEventMetadata(row);

  if (outsideScope(event.repo_id, scope)) {
    return withheld(ref);
  }

  if (!isBasisMember(ctx, ref.basisId, event.event_id)) {
    return missing(
      ref,
      "The source event is not a member of the reference basis"
    );
  }

  return resolution(ref, "found", null);
};

const evidenceResolution = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  const rows = ctx.db
    .prepare(
      "SELECT event_id,repo_common_dir AS repo_id FROM events WHERE json_extract(body,'$.evidence.ref') = ? LIMIT ?"
    )
    .all(ref.id, EVIDENCE_CANDIDATE_LIMIT + 1);

  const candidates = rows
    .slice(0, EVIDENCE_CANDIDATE_LIMIT)
    .map((row) => decodeEventMetadata(row));

  const selected = candidates.filter(
    (event) => !outsideScope(event.repo_id, scope)
  );

  if (
    selected.some((event) => isBasisMember(ctx, ref.basisId, event.event_id))
  ) {
    return resolution(ref, "found", null);
  }

  if (rows.length > EVIDENCE_CANDIDATE_LIMIT) {
    return resolution(
      ref,
      "over-budget",
      "The evidence pointer exceeds its retained candidate lookup bound"
    );
  }

  if (candidates.length > 0 && selected.length === 0) {
    return withheld(ref);
  }

  return missing(
    ref,
    "The evidence reference has no retained member in the selected basis"
  );
};

const learningResolution = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  const row =
    ref.revision === undefined
      ? ctx.db
          .prepare(
            "SELECT store_id,generation,repo_id,1 AS content_available FROM agent_learning WHERE id = ? AND kind = ?"
          )
          .get(ref.id, ref.kind)
      : ctx.db
          .prepare(
            "SELECT l.store_id,l.generation,json_extract(h.body,'$.applicability.scope.repoId') AS repo_id,1 AS content_available FROM agent_learning_history h JOIN agent_learning l ON l.id = h.id WHERE h.id = ? AND h.revision = ? AND json_extract(h.body,'$.kind') = ?"
          )
          .get(ref.id, ref.revision, ref.kind);

  return metadataResolution(
    ref,
    row === undefined ? undefined : decodeMetadata(row),
    scope
  );
};

const evaluationResolution = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  if (ref.revision !== undefined) {
    return resolution(
      ref,
      "invalid",
      "Immutable evaluations do not have record revisions"
    );
  }

  const row = ctx.db
    .prepare(
      "SELECT e.store_id,e.generation,json_extract(h.body,'$.applicability.scope.repoId') AS repo_id,CASE WHEN h.id IS NOT NULL AND json_extract(h.body,'$.kind') = e.target_kind THEN 1 ELSE 0 END AS content_available FROM agent_evaluations e LEFT JOIN agent_learning_history h ON h.id = e.target_id AND h.revision = e.target_revision WHERE e.id = ?"
    )
    .get(ref.id);

  return metadataResolution(
    ref,
    row === undefined ? undefined : decodeMetadata(row),
    scope
  );
};

const operationResolution = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  const row = ctx.db
    .prepare(
      "SELECT o.store_id,o.generation,o.revision,json_extract(p.body,'$.scope.repoId') AS repo_id,CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END AS content_available FROM agent_operations o LEFT JOIN agent_operation_plans p ON p.id = json_extract(o.body,'$.planId') AND p.store_id = o.store_id AND p.generation = o.generation WHERE o.id = ?"
    )
    .get(ref.id);

  if (row === undefined) {
    return missing(
      ref,
      "The operation reference has no retained storage record"
    );
  }

  const record = decodeOperationMetadata(row);
  const resolved = metadataResolution(ref, record, scope);

  if (resolved.state !== "found") {
    return resolved;
  }

  if (ref.revision !== undefined && ref.revision !== record.revision) {
    return missing(ref, "The operation receipt revision is no longer retained");
  }

  return resolved;
};

const resolveStoredRef = (
  ctx: AgentDbContext,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  switch (ref.kind) {
    case "basis": {
      return basisResolution(ctx, ref, scope);
    }

    case "result": {
      return resultResolution(ctx, ref, scope);
    }

    case "event": {
      return eventResolution(ctx, ref, scope);
    }

    case "evidence": {
      return evidenceResolution(ctx, ref, scope);
    }

    case "investigation":
    case "lesson": {
      return learningResolution(ctx, ref, scope);
    }

    case "evaluation": {
      return evaluationResolution(ctx, ref, scope);
    }

    case "operation": {
      return operationResolution(ctx, ref, scope);
    }

    case "request":
    case "metric":
    case "finding":
    case "attribution": {
      return missing(
        ref,
        `The ${ref.kind} reference kind has no retained storage index`
      );
    }

    default: {
      return resolution(ref, "invalid", "The reference kind is unsupported");
    }
  }
};

const resolveRef = (
  ctx: AgentDbContext,
  identity: StoreIdentity,
  ref: AgentRef,
  scope?: AgentScope
): AgentRefResolution => {
  if (
    ref.storeId !== identity.storeId ||
    ref.storeGeneration !== identity.storeGeneration
  ) {
    return stale(ref);
  }

  if (ref.basisId !== null) {
    const basis = metadataResolution(
      ref,
      basisMetadata(ctx, ref.basisId),
      scope
    );

    if (basis.state !== "found") {
      return basis;
    }
  }

  return resolveStoredRef(ctx, ref, scope);
};

export const resolveAgentRefs = (
  ctx: AgentDbContext,
  refs: readonly AgentRef[],
  scope?: AgentScope
): readonly AgentRefResolution[] => {
  if (refs.length > 500) {
    throw agentError(
      "budget-exhausted",
      "The reference request exceeds its item bound"
    );
  }

  const identity = ctx.identity();

  return refs.map((ref) => resolveRef(ctx, identity, ref, scope));
};
