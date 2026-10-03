// @effect-diagnostics-next-line nodeBuiltinImport:off -- Agent identities and immutable storage keys use local cryptographic digests.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { Effect, Schema } from "effect";

import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import { StoreBusy } from "../contracts/error-store-busy.js";
import { StoreError } from "../contracts/error-store-error.js";
import type { AgentHandle, StoreIdentity } from "../model/agent-common.js";

export interface AgentRetentionOptions {
  readonly maxProjectionBytes?: number;
  readonly maxBasisBytes?: number;
  readonly maxLearningBytes?: number;
  readonly maxOperationBytes?: number;
}

export const AGENT_RETENTION_DEFAULTS = {
  maxBasisBytes: 67_108_864,
  maxLearningBytes: 65_536,
  maxOperationBytes: 262_144,
  maxProjectionBytes: 33_554_432,
} as const;

export const agentError = (
  code: AgentError["code"],
  message: string,
  revisions?: { readonly expected: string; readonly current: string }
): AgentError =>
  new AgentError({
    code,
    currentRevision: revisions?.current ?? null,
    expectedRevision: revisions?.expected ?? null,
    message,
    recovery: {
      action: code === "stale-generation" ? "use-current-generation" : "none",
      ref: null,
    },
    ref: null,
    retryable: code === "revision-conflict" || code === "store-busy",
  });

const decodeMeta = Schema.decodeUnknownSync(
  Schema.Struct({ value: Schema.String })
);

export const agentMeta = (db: DatabaseSync, key: string): string => {
  const row = db.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);

  if (row === undefined) {
    throw new StoreError({
      message: "Agent store metadata is unavailable",
      operation: "agent.identity",
    });
  }

  return decodeMeta(row).value;
};

export const agentIdentity = (db: DatabaseSync): StoreIdentity => ({
  revision: `${agentMeta(db, "agent_epoch")}:${agentMeta(db, "agent_revision")}`,
  storeGeneration: Number(agentMeta(db, "agent_generation")),
  storeId: agentMeta(db, "agent_store_id"),
});

export const assertAgentHandle = (
  db: DatabaseSync,
  handle: AgentHandle
): void => {
  const current = agentIdentity(db);

  if (
    current.storeId !== handle.storeId ||
    current.storeGeneration !== handle.storeGeneration
  ) {
    throw agentError(
      "stale-generation",
      "The handle belongs to another store identity or generation"
    );
  }
};

export const agentHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const sortAgentJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map((item: Schema.Json) => sortAgentJson(item));
  }

  if (Schema.is(Schema.JsonObject)(value)) {
    const object = Schema.decodeUnknownSync(Schema.JsonObject)(value);

    return Object.fromEntries(
      Object.entries(object)
        .toSorted(([left], [right]) =>
          left < right ? -1 : Number(left > right)
        )
        .map(([key, item]) => [key, sortAgentJson(item)])
    );
  }

  return value;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonicalization parses the JSON boundary before sorting typed values.
export const canonicalAgentJson = (value: unknown): string =>
  JSON.stringify(sortAgentJson(Schema.decodeUnknownSync(Schema.Json)(value)));

export const agentEncoded = <A, I>(
  schema: Schema.Codec<A, I>,
  value: A
): string => JSON.stringify(Schema.encodeSync(schema)(value));

export const agentDecoded = <A, I>(
  schema: Schema.Codec<A, I>,
  body: string
): A => Schema.decodeUnknownSync(Schema.fromJsonString(schema))(body);

export const enforceAgentBytes = (body: string, limit: number): void => {
  if (Buffer.byteLength(body, "utf-8") > limit) {
    throw agentError(
      "budget-exhausted",
      "The durable record exceeds its declared storage byte limit"
    );
  }
};

const sqliteCode = Schema.is(Schema.Struct({ errcode: Schema.Int }));

const agentFailure = (operation: string, cause: unknown): AgentStoreFailure => {
  if (
    Schema.is(AgentError)(cause) ||
    Schema.is(StoreError)(cause) ||
    Schema.is(StoreBusy)(cause)
  ) {
    return cause;
  }

  if (sqliteCode(cause) && (cause.errcode === 5 || cause.errcode === 6)) {
    return new StoreBusy({
      message: `Store writer is busy during ${operation}`,
    });
  }

  return new StoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
};

export interface AgentDbContext {
  readonly db: DatabaseSync;
  readonly ownerId: string;
  readonly identity: () => StoreIdentity;
  readonly epoch: () => string;
  readonly assertHandle: (handle: AgentHandle) => void;
  readonly limits: {
    readonly [K in keyof typeof AGENT_RETENTION_DEFAULTS]: number;
  };
  readonly read: <A>(
    operation: string,
    body: () => A
  ) => Effect.Effect<A, AgentStoreFailure>;
  readonly write: <A>(
    operation: string,
    body: () => A
  ) => Effect.Effect<A, AgentStoreFailure>;
}

export const agentDbContext = (
  db: DatabaseSync,
  ownerId: string,
  options: AgentRetentionOptions = {}
): AgentDbContext => {
  const transaction = <A>(
    operation: string,
    body: () => A,
    mode: "DEFERRED" | "IMMEDIATE"
  ) =>
    Effect.try({
      catch: (cause) => agentFailure(operation, cause),
      try: () => {
        db.exec(`BEGIN ${mode}`);

        try {
          const value = body();
          db.exec("COMMIT");

          return value;
        } catch (error) {
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }

          throw error;
        }
      },
    });

  return {
    assertHandle: (handle) => {
      assertAgentHandle(db, handle);
    },
    db,
    epoch: () => agentMeta(db, "agent_epoch"),
    identity: () => agentIdentity(db),
    limits: { ...AGENT_RETENTION_DEFAULTS, ...options },
    ownerId,
    read: (operation, body) => transaction(operation, body, "DEFERRED"),
    write: (operation, body) => transaction(operation, body, "IMMEDIATE"),
  };
};
