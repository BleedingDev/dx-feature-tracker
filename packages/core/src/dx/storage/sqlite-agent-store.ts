import { DateTime, Effect, Option, Schema } from "effect";

import type {
  AgentEventPageInput,
  AgentStoreService,
} from "../contracts/agent-store.js";
import { AgentScopeSchema } from "../model/agent-common.js";
import type { AgentScope } from "../model/agent-common.js";
import { SourceCoverageSchema } from "../model/coverage.js";
import { DxEventEnvelopeSchema } from "../model/event.js";
import type { SnapshotSelector } from "../model/snapshot.js";
import {
  agentDecoded,
  agentEncoded,
  agentError,
  agentHash,
  canonicalAgentJson,
} from "./agent-db.js";
import type { AgentDbContext } from "./agent-db.js";
import { resolveAgentRefs } from "./agent-ref-resolver.js";
import { sqliteBasisMethods } from "./sqlite-agent-bases.js";
import {
  selectAgentCoverage,
  sqliteCoverageMethods,
} from "./sqlite-agent-coverage.js";
import { sqliteLearningMethods } from "./sqlite-agent-learning.js";
import { sqliteOperationMethods } from "./sqlite-agent-operations.js";

const CoverageListSchema = Schema.Array(SourceCoverageSchema);

const decodeBody = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const decodeSeq = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Int }));

const decodeEventRow = Schema.decodeUnknownSync(
  Schema.Struct({ bytes: Schema.Int, seq: Schema.Int })
);

const decodeCoverageRow = Schema.decodeUnknownSync(
  Schema.Struct({
    adapter_id: Schema.String,
    branch: Schema.String,
    bytes: Schema.Int,
    flight_id: Schema.String,
    repo_id: Schema.String,
  })
);

const decodeReadRow = Schema.decodeUnknownSync(
  Schema.Struct({
    coverage: Schema.String,
    epoch: Schema.String,
    generation: Schema.Int,
    id: Schema.String,
    selector_key: Schema.String,
    store_id: Schema.String,
    upper_seq: Schema.Int,
  })
);

const PageCursorSchema = Schema.Struct({
  id: Schema.String,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const sourcePageCursor = (encoded: string): typeof PageCursorSchema.Type => {
  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(PageCursorSchema)
  )(Buffer.from(encoded, "base64url").toString("utf-8"));

  const cursor = Option.getOrNull(decoded);

  if (cursor === null) {
    throw agentError(
      "cursor-mismatch",
      "The source continuation is not a valid cursor"
    );
  }

  return cursor;
};

const readBounds = Schema.Struct({
  maxDecodedBytes: Schema.Int.check(
    Schema.isBetween({ maximum: 67_108_864, minimum: 1 })
  ),
  maxElapsedMs: Schema.Int.check(
    Schema.isBetween({ maximum: 60_000, minimum: 1 })
  ),
  maxFacts: Schema.Int.check(
    Schema.isBetween({ maximum: 100_000, minimum: 1 })
  ),
});

const selection = (selector: SnapshotSelector, scope?: AgentScope) => {
  const clauses: string[] = [];
  const params: string[] = [];

  for (const [column, value] of [
    ["flight_id", selector.flightId],
    ["repo_common_dir", selector.repoCommonDir],
    ["branch", selector.branch],
  ]) {
    if (value !== null && value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }

  if (selector.from !== null) {
    clauses.push("COALESCE(occurred_at,observed_at) >= ?");
    params.push(selector.from);
  }

  if (selector.to !== null) {
    clauses.push("COALESCE(occurred_at,observed_at) < ?");
    params.push(selector.to);
  }

  if (scope !== undefined) {
    Schema.decodeSync(AgentScopeSchema)(scope);

    for (const [column, value] of [
      ["repo_common_dir", scope.repoId],
      ["flight_id", scope.flightId],
      ["json_extract(body,'$.context.worktreePath')", scope.worktreeId],
    ]) {
      if (value !== null && value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }

    const selectedBranches =
      scope.branchSelection.kind === "current" ||
      scope.branchSelection.kind === "selected";

    for (const [column, values] of [
      ["branch", selectedBranches ? scope.branchSelection.branches : []],
      ["json_extract(body,'$.ai.harness')", scope.tools],
      ["adapter_id", scope.sources],
    ] as const) {
      if (values.length > 0) {
        clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
        params.push(...values);
      }
    }

    if (selectedBranches && scope.branchSelection.branches.length === 0) {
      clauses.push("0");
    }
  }

  return { clauses, params };
};

const selectedCoverage = (
  ctx: AgentDbContext,
  selector: SnapshotSelector,
  maxDecodedBytes: number
) => {
  const rows = ctx.db
    .prepare(
      "SELECT l.adapter_id,l.flight_id,l.repo_id,l.branch,length(CAST(l.body AS BLOB)) AS bytes FROM agent_coverage_latest l JOIN (SELECT adapter_id,MAX(seq) AS seq FROM agent_coverage_latest WHERE (? IS NULL OR flight_id = '' OR flight_id = ?) AND (? IS NULL OR repo_id = '' OR repo_id = ?) AND (? IS NULL OR branch = '' OR branch = ?) GROUP BY adapter_id) selected ON selected.adapter_id=l.adapter_id AND selected.seq=l.seq GROUP BY l.adapter_id ORDER BY l.adapter_id LIMIT 257"
    )
    .all(
      selector.flightId,
      selector.flightId,
      selector.repoCommonDir,
      selector.repoCommonDir,
      selector.branch,
      selector.branch
    );

  if (rows.length > 256) {
    throw agentError(
      "budget-exhausted",
      "The selected source coverage exceeds the metadata bound"
    );
  }

  const metadata = rows.map((row) => decodeCoverageRow(row));

  if (metadata.reduce((bytes, row) => bytes + row.bytes, 0) > maxDecodedBytes) {
    throw agentError(
      "budget-exhausted",
      "The selected source coverage exceeds the decoded byte budget"
    );
  }

  return metadata.map((row) => {
    const { body } = decodeBody(
      ctx.db
        .prepare(
          "SELECT body FROM agent_coverage_latest WHERE adapter_id = ? AND flight_id = ? AND repo_id = ? AND branch = ?"
        )
        .get(row.adapter_id, row.flight_id, row.repo_id, row.branch)
    );

    return agentDecoded(SourceCoverageSchema, body);
  });
};

const captureCoverage = (ctx: AgentDbContext, input: AgentEventPageInput) => {
  if (input.scope === undefined) {
    return selectedCoverage(ctx, input.selector, input.maxDecodedBytes);
  }

  const page = selectAgentCoverage(
    ctx,
    input.scope,
    256,
    input.maxDecodedBytes
  );

  if (page.omitted > 0) {
    throw agentError(
      "budget-exhausted",
      "The atomic source selection requires all current coverage metadata within its byte and source bounds"
    );
  }

  return page.coverage;
};

const readEventPage = (
  ctx: AgentDbContext,
  input: AgentEventPageInput,
  createdAt: string
) => {
  Schema.decodeUnknownSync(readBounds)(input);
  const started = performance.now();
  const identity = ctx.identity();

  const selectorKey = canonicalAgentJson({
    normalizedFilters: input.normalizedFilters ?? {},
    scope: input.scope ?? null,
    selector: input.selector,
  });

  const query = selection(input.selector, input.scope);

  let captureId: string;
  let lastSeq = 0;

  if (input.cursor !== null) {
    const cursor = sourcePageCursor(input.cursor);

    captureId = cursor.id;
    lastSeq = cursor.seq;

    if (
      input.eventWatermark !== null &&
      input.eventWatermark !== `read:${captureId}`
    ) {
      throw agentError(
        "cursor-mismatch",
        "The cursor belongs to a different evidence watermark"
      );
    }
  } else if (input.eventWatermark === null) {
    const upperSeq = decodeSeq(
      ctx.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get()
    ).seq;

    const coverage = agentEncoded(
      CoverageListSchema,
      captureCoverage(ctx, input)
    );

    captureId = `selection_${agentHash(JSON.stringify([identity.storeId, identity.storeGeneration, ctx.epoch(), selectorKey, upperSeq, coverage]))}`;

    ctx.db
      .prepare(
        "INSERT INTO agent_event_reads(id,store_id,generation,epoch,selector_key,selector_body,scope_body,filters_body,upper_seq,coverage,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
      )
      .run(
        captureId,
        identity.storeId,
        identity.storeGeneration,
        ctx.epoch(),
        selectorKey,
        JSON.stringify(input.selector),
        input.scope === undefined ? null : canonicalAgentJson(input.scope),
        canonicalAgentJson(input.normalizedFilters ?? {}),
        upperSeq,
        coverage,
        createdAt
      );

    ctx.db.exec(
      "DELETE FROM agent_event_reads WHERE rowid NOT IN (SELECT rowid FROM agent_event_reads ORDER BY rowid DESC LIMIT 1024)"
    );
  } else {
    if (input.eventWatermark.startsWith("read:")) {
      captureId = input.eventWatermark.slice(5);
    } else {
      throw agentError(
        "cursor-mismatch",
        "The evidence watermark is not a retained source selection"
      );
    }
  }

  const rawCapture = ctx.db
    .prepare("SELECT * FROM agent_event_reads WHERE id = ?")
    .get(captureId);

  if (rawCapture === undefined) {
    throw agentError(
      "cursor-mismatch",
      "The source continuation was removed or invalidated"
    );
  }

  const capture = decodeReadRow(rawCapture);
  ctx.assertHandle({
    id: capture.id,
    storeGeneration: capture.generation,
    storeId: capture.store_id,
  });

  if (
    capture.selector_key !== selectorKey ||
    capture.epoch !== ctx.epoch() ||
    lastSeq > capture.upper_seq
  ) {
    throw agentError(
      "cursor-mismatch",
      "The source continuation no longer matches the selected scope"
    );
  }

  const coverageBytes = Buffer.byteLength(capture.coverage, "utf-8");

  if (coverageBytes > input.maxDecodedBytes) {
    throw agentError(
      "budget-exhausted",
      "The source coverage requires a larger decoded byte budget"
    );
  }

  const coverage = agentDecoded(CoverageListSchema, capture.coverage);
  const events = [];
  let decodedBytes = coverageBytes;
  let examined = 0;
  const clauses = [...query.clauses, "seq > ?", "seq <= ?"];
  const params = [...query.params, lastSeq, capture.upper_seq];

  const rows = ctx.db
    .prepare(
      `SELECT seq,length(CAST(body AS BLOB)) AS bytes FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`
    )
    .iterate(...params, input.maxFacts);

  for (const raw of rows) {
    const row = decodeEventRow(raw);
    examined += 1;

    if (
      decodedBytes + row.bytes > input.maxDecodedBytes ||
      performance.now() - started >= input.maxElapsedMs
    ) {
      break;
    }

    const { body } = decodeBody(
      ctx.db.prepare("SELECT body FROM events WHERE seq = ?").get(row.seq)
    );

    events.push(agentDecoded(DxEventEnvelopeSchema, body));
    decodedBytes += row.bytes;
    lastSeq = row.seq;
  }

  const moreClauses = [...query.clauses, "seq > ?", "seq <= ?"];

  const more =
    ctx.db
      .prepare(
        `SELECT 1 FROM events WHERE ${moreClauses.join(" AND ")} LIMIT 1`
      )
      .get(...query.params, lastSeq, capture.upper_seq) !== undefined;

  return {
    complete: !more,
    coverage,
    decodedBytes,
    eventWatermark: `read:${captureId}`,
    events,
    factsExamined: examined,
    nextCursor: more
      ? Buffer.from(
          agentEncoded(PageCursorSchema, { id: captureId, seq: lastSeq })
        ).toString("base64url")
      : null,
  };
};

export const sqliteAgentMethods = (ctx: AgentDbContext): AgentStoreService => ({
  ...sqliteBasisMethods(ctx),
  ...sqliteCoverageMethods(ctx),
  ...sqliteLearningMethods(ctx),
  ...sqliteOperationMethods(ctx),
  identity: ctx.read("agent.identity", ctx.identity),
  readEventPage: (input) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        ctx.write("agent.readEventPage", () =>
          readEventPage(ctx, input, DateTime.formatIso(now))
        )
      )
    ),
  resolveRefs: (refs, scope) =>
    ctx.read("agent.resolveRefs", () => resolveAgentRefs(ctx, refs, scope)),
});
