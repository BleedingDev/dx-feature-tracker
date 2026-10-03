import { Schema } from "effect";

import type { AgentStoreService } from "../contracts/agent-store.js";
import { AgentCountSchema } from "../model/agent-common.js";
import type { AgentHandle } from "../model/agent-common.js";
import {
  EvaluationSchema,
  LearningFilterSchema,
  LearningRecordSchema,
} from "../model/agent-learning.js";
import type {
  Evaluation,
  LearningFilter,
  LearningRecord,
} from "../model/agent-learning.js";
import {
  agentDecoded,
  agentEncoded,
  agentError,
  agentHash,
  canonicalAgentJson,
  enforceAgentBytes,
} from "./agent-db.js";
import type { AgentDbContext } from "./agent-db.js";

const decodeBodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const decodeLearningRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String, seq: Schema.Int })
);

const decodeCountRow = Schema.decodeUnknownSync(
  Schema.Struct({ count: Schema.Int })
);

const decodeMutationRow = Schema.decodeUnknownSync(
  Schema.Struct({
    action: Schema.String,
    body: Schema.String,
    digest: Schema.String,
  })
);

const LearningCursorSchema = Schema.Struct({
  scopeDigest: Schema.String,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  version: Schema.Literal("dx.learning.cursor.v1"),
});

type LearningStore = Pick<
  AgentStoreService,
  | "appendEvaluation"
  | "createLearning"
  | "getEvaluation"
  | "getLearning"
  | "listEvaluations"
  | "listLearning"
  | "updateLearning"
>;

const recordColumns = (record: LearningRecord) => [
  record.revision,
  record.kind,
  record.applicability.scope.repoId,
  record.applicability.scope.worktreeId,
  record.applicability.scope.flightId,
  Number(record.applicability.widerScope),
  record.kind === "lesson" ? record.status : record.state,
  (record.kind === "lesson" ? record.claim : record.question).toLowerCase(),
  record.updatedAt,
];

export const sqliteLearningMethods = (ctx: AgentDbContext): LearningStore => {
  const readMutation = (
    key: string,
    action: string,
    digest: string
  ): string | null => {
    const identity = ctx.identity();

    const row = ctx.db
      .prepare(
        "SELECT action, digest, body FROM agent_learning_mutations WHERE store_id = ? AND generation = ? AND key = ?"
      )
      .get(identity.storeId, identity.storeGeneration, key);

    if (row === undefined) {
      return null;
    }

    const mutation = decodeMutationRow(row);

    if (mutation.action !== action || mutation.digest !== digest) {
      throw agentError(
        "idempotency-conflict",
        "The learning idempotency key already belongs to a different mutation"
      );
    }

    return mutation.body;
  };

  const writeMutation = (
    key: string,
    action: string,
    digest: string,
    body: string
  ): void => {
    const identity = ctx.identity();
    ctx.db
      .prepare(
        "INSERT INTO agent_learning_mutations(store_id, generation, key, action, digest, body) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        identity.storeId,
        identity.storeGeneration,
        key,
        action,
        digest,
        body
      );
  };

  const readLearning = (
    handle: AgentHandle,
    revision?: number
  ): LearningRecord => {
    ctx.assertHandle(handle);

    const row =
      revision === undefined
        ? ctx.db
            .prepare(
              "SELECT body FROM agent_learning WHERE id = ? AND store_id = ? AND generation = ?"
            )
            .get(handle.id, handle.storeId, handle.storeGeneration)
        : ctx.db
            .prepare(
              "SELECT history.body FROM agent_learning_history AS history JOIN agent_learning AS current ON current.id = history.id WHERE current.id = ? AND current.store_id = ? AND current.generation = ? AND history.revision = ?"
            )
            .get(
              handle.id,
              handle.storeId,
              handle.storeGeneration,
              Schema.decodeUnknownSync(AgentCountSchema)(revision)
            );

    if (row === undefined) {
      throw agentError(
        "learning-not-found",
        "The learning record is unavailable"
      );
    }

    const record = agentDecoded(LearningRecordSchema, decodeBodyRow(row).body);

    ctx.assertHandle(record);

    if (
      record.id !== handle.id ||
      (revision !== undefined && record.revision !== revision)
    ) {
      throw agentError(
        "learning-not-found",
        "The requested learning revision is unavailable"
      );
    }

    return record;
  };

  const insertHistory = (record: LearningRecord, body: string): void => {
    ctx.db
      .prepare(
        "INSERT INTO agent_learning_history(id, revision, body) VALUES (?, ?, ?)"
      )
      .run(record.id, record.revision, body);
  };

  const createLearning: LearningStore["createLearning"] = (record, key) =>
    ctx.write("agent.learning.create", () => {
      ctx.assertHandle(record);

      const body = canonicalAgentJson(
        Schema.encodeSync(LearningRecordSchema)(record)
      );

      enforceAgentBytes(body, ctx.limits.maxLearningBytes);
      const digest = agentHash(body);
      const reusedBody = readMutation(key, "create", digest);

      if (reusedBody !== null) {
        return {
          record: agentDecoded(LearningRecordSchema, reusedBody),
          reused: true,
        };
      }

      const previous = ctx.db
        .prepare("SELECT body FROM agent_learning WHERE id = ?")
        .get(record.id);

      if (previous !== undefined) {
        if (decodeBodyRow(previous).body !== body) {
          throw agentError(
            "revision-conflict",
            "The learning record ID already has different content"
          );
        }

        writeMutation(key, "create", digest, body);

        return { record, reused: true };
      }

      ctx.db
        .prepare(
          "INSERT INTO agent_learning(id, store_id, generation, revision, kind, repo_id, worktree_id, flight_id, wider_scope, status, search_text, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          record.id,
          record.storeId,
          record.storeGeneration,
          ...recordColumns(record),
          body
        );
      insertHistory(record, body);
      writeMutation(key, "create", digest, body);

      return { record, reused: false };
    });

  const updateLearning: LearningStore["updateLearning"] = (
    record,
    expectedRevision,
    key
  ) =>
    ctx.write("agent.learning.update", () => {
      ctx.assertHandle(record);

      const body = canonicalAgentJson(
        Schema.encodeSync(LearningRecordSchema)(record)
      );

      enforceAgentBytes(body, ctx.limits.maxLearningBytes);
      const digest = agentHash(`${expectedRevision}\n${body}`);
      const reusedBody = readMutation(key, "update", digest);

      if (reusedBody !== null) {
        return {
          record: agentDecoded(LearningRecordSchema, reusedBody),
          reused: true,
        };
      }

      const current = readLearning(record);

      if (
        current.revision !== expectedRevision ||
        record.revision !== expectedRevision + 1
      ) {
        throw agentError(
          "revision-conflict",
          "The learning mutation does not advance its expected current revision",
          {
            current: String(current.revision),
            expected: String(expectedRevision),
          }
        );
      }

      if (
        current.kind !== record.kind ||
        current.createdAt !== record.createdAt
      ) {
        throw agentError(
          "invalid-transition",
          "A learning revision must preserve its kind and creation time"
        );
      }

      if (
        record.kind === "lesson" &&
        record.previousRevision !== expectedRevision
      ) {
        throw agentError(
          "invalid-transition",
          "A lesson revision must name its expected current revision as its parent"
        );
      }

      const result = ctx.db
        .prepare(
          "UPDATE agent_learning SET revision = ?, kind = ?, repo_id = ?, worktree_id = ?, flight_id = ?, wider_scope = ?, status = ?, search_text = ?, updated_at = ?, body = ? WHERE id = ? AND store_id = ? AND generation = ? AND revision = ?"
        )
        .run(
          ...recordColumns(record),
          body,
          record.id,
          record.storeId,
          record.storeGeneration,
          expectedRevision
        );

      if (Number(result.changes) !== 1) {
        throw agentError("revision-conflict", "The learning revision changed");
      }

      insertHistory(record, body);
      writeMutation(key, "update", digest, body);

      return { record, reused: false };
    });

  const listLearning: LearningStore["listLearning"] = (input) =>
    ctx.read("agent.learning.list", () => {
      const filter: LearningFilter =
        Schema.decodeUnknownSync(LearningFilterSchema)(input);

      const identity = ctx.identity();

      const scopeDigest = agentHash(
        canonicalAgentJson({
          ...filter,
          cursor: null,
          limit: null,
          storeGeneration: identity.storeGeneration,
          storeId: identity.storeId,
        })
      );

      let sequence: number | null = null;

      if (filter.cursor !== null) {
        let cursor: typeof LearningCursorSchema.Type;

        try {
          cursor = agentDecoded(LearningCursorSchema, filter.cursor);
        } catch {
          throw agentError("cursor-mismatch", "The learning cursor is invalid");
        }

        if (cursor.scopeDigest !== scopeDigest) {
          throw agentError(
            "cursor-mismatch",
            "The learning cursor belongs to another scope or store generation"
          );
        }

        ({ sequence } = cursor);
      }

      const scopePredicate =
        "store_id = ? AND generation = ? AND ((repo_id IS ? AND (worktree_id IS NULL OR worktree_id IS ?) AND (flight_id IS NULL OR flight_id IS ?)) OR wider_scope = 1)";

      const scopeValues = [
        identity.storeId,
        identity.storeGeneration,
        filter.scope.repoId,
        filter.scope.worktreeId,
        filter.scope.flightId,
      ];

      const escapedQuestion = (filter.question ?? "")
        .toLowerCase()
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");

      const matchPredicate =
        "(? = 1 OR status <> 'superseded') AND (? = 0 OR kind IN (?, ?)) AND (? = 1 OR search_text LIKE ? ESCAPE '\\')";

      const matchValues = [
        Number(filter.includeSuperseded),
        filter.kinds.length,
        filter.kinds[0] ?? "",
        filter.kinds[1] ?? "",
        Number(filter.question === null),
        `%${escapedQuestion}%`,
      ];

      const excluded = decodeCountRow(
        ctx.db
          .prepare(
            `SELECT COUNT(*) AS count FROM agent_learning WHERE ${scopePredicate} AND NOT (${matchPredicate})`
          )
          .get(...scopeValues, ...matchValues)
      ).count;

      const rows = ctx.db
        .prepare(
          `SELECT seq, body FROM agent_learning WHERE ${scopePredicate} AND ${matchPredicate} AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`
        )
        .all(
          ...scopeValues,
          ...matchValues,
          sequence,
          sequence,
          filter.limit + 1
        )
        .map((row) => decodeLearningRow(row));

      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);

      return {
        excluded,
        nextCursor:
          rows.length > filter.limit && last !== undefined
            ? agentEncoded(LearningCursorSchema, {
                scopeDigest,
                sequence: last.seq,
                version: "dx.learning.cursor.v1",
              })
            : null,
        records: page.map((row) =>
          agentDecoded(LearningRecordSchema, row.body)
        ),
      };
    });

  const appendEvaluation: LearningStore["appendEvaluation"] = (
    evaluation,
    key
  ) =>
    ctx.write("agent.learning.evaluate", () => {
      ctx.assertHandle(evaluation);

      const body = canonicalAgentJson(
        Schema.encodeSync(EvaluationSchema)(evaluation)
      );

      enforceAgentBytes(body, ctx.limits.maxLearningBytes);
      const digest = agentHash(body);
      const reusedBody = readMutation(key, "evaluation", digest);

      if (reusedBody !== null) {
        return {
          evaluation: agentDecoded(EvaluationSchema, reusedBody),
          reused: true,
        };
      }

      const target = readLearning(
        { ...evaluation, id: evaluation.target.id },
        evaluation.target.revision
      );

      if (target.kind !== evaluation.target.kind) {
        throw agentError(
          "learning-not-found",
          "The evaluation's historical learning revision is unavailable"
        );
      }

      const previous = ctx.db
        .prepare("SELECT body FROM agent_evaluations WHERE id = ?")
        .get(evaluation.id);

      if (previous !== undefined) {
        if (decodeBodyRow(previous).body !== body) {
          throw agentError(
            "idempotency-conflict",
            "The evaluation ID already has different content"
          );
        }

        writeMutation(key, "evaluation", digest, body);

        return { evaluation, reused: true };
      }

      ctx.db
        .prepare(
          "INSERT INTO agent_evaluations(id, store_id, generation, target_kind, target_id, target_revision, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          evaluation.id,
          evaluation.storeId,
          evaluation.storeGeneration,
          evaluation.target.kind,
          evaluation.target.id,
          evaluation.target.revision,
          evaluation.createdAt,
          body
        );
      writeMutation(key, "evaluation", digest, body);

      return { evaluation, reused: false };
    });

  const getEvaluation: LearningStore["getEvaluation"] = (handle) =>
    ctx.read("agent.learning.evaluation", () => {
      ctx.assertHandle(handle);

      const row = ctx.db
        .prepare(
          "SELECT body FROM agent_evaluations WHERE id = ? AND store_id = ? AND generation = ?"
        )
        .get(handle.id, handle.storeId, handle.storeGeneration);

      if (row === undefined) {
        throw agentError("learning-not-found", "The evaluation is unavailable");
      }

      const evaluation = agentDecoded(
        EvaluationSchema,
        decodeBodyRow(row).body
      );

      ctx.assertHandle(evaluation);

      if (evaluation.id !== handle.id) {
        throw agentError(
          "learning-not-found",
          "The requested evaluation is unavailable"
        );
      }

      return evaluation;
    });

  const listEvaluations: LearningStore["listEvaluations"] = (handle, limit) =>
    ctx.read("agent.learning.evaluations", () => {
      const target = readLearning(handle);

      const boundedLimit = Schema.decodeUnknownSync(
        Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
      )(limit);

      const { count } = decodeCountRow(
        ctx.db
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_evaluations WHERE store_id = ? AND generation = ? AND target_kind = ? AND target_id = ?"
          )
          .get(handle.storeId, handle.storeGeneration, target.kind, handle.id)
      );

      const evaluations: readonly Evaluation[] = ctx.db
        .prepare(
          "SELECT body FROM agent_evaluations WHERE store_id = ? AND generation = ? AND target_kind = ? AND target_id = ? ORDER BY seq DESC LIMIT ?"
        )
        .all(
          handle.storeId,
          handle.storeGeneration,
          target.kind,
          handle.id,
          boundedLimit
        )
        .map((row) => agentDecoded(EvaluationSchema, decodeBodyRow(row).body));

      return { evaluations, omitted: Math.max(0, count - evaluations.length) };
    });

  return {
    appendEvaluation,
    createLearning,
    getEvaluation,
    getLearning: (handle, revision) =>
      ctx.read("agent.learning.get", () => readLearning(handle, revision)),
    listEvaluations,
    listLearning,
    updateLearning,
  };
};
