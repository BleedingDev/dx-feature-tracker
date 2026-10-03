import { Schema } from "effect";

import type { AgentStoreService } from "../contracts/agent-store.js";
import { AgentCountSchema, AgentScopeSchema } from "../model/agent-common.js";
import type { AgentScope } from "../model/agent-common.js";
import type { AgentCoveragePage } from "../model/agent-query.js";
import { SourceCoverageSchema } from "../model/coverage.js";
import type { SourceCoverage } from "../model/coverage.js";
import { agentDecoded } from "./agent-db.js";
import type { AgentDbContext } from "./agent-db.js";

const decodeCoverageBounds = Schema.decodeUnknownSync(
  Schema.Struct({
    maxDecodedBytes: Schema.Int.check(
      Schema.isBetween({ maximum: 67_108_864, minimum: 1 })
    ),
    maxSources: Schema.Int.check(
      Schema.isBetween({ maximum: 256, minimum: 1 })
    ),
  })
);

const decodeCountRow = Schema.decodeUnknownSync(
  Schema.Struct({ count: AgentCountSchema })
);

const decodeCoverageMetadataRow = Schema.decodeUnknownSync(
  Schema.Struct({
    adapter_id: Schema.String,
    branch: Schema.String,
    bytes: AgentCountSchema,
    flight_id: Schema.String,
    placed: Schema.Int.check(Schema.isBetween({ maximum: 1, minimum: 0 })),
    repo_id: Schema.String,
  })
);

const decodeBodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const coverageSelection = (scope: AgentScope) => {
  const clauses: string[] = [];
  const params: string[] = [];

  if (scope.repoId !== null) {
    clauses.push("(repo_id = '' OR repo_id = ?)");
    params.push(scope.repoId);
  }

  if (scope.flightId !== null) {
    clauses.push("(flight_id = '' OR flight_id = ?)");
    params.push(scope.flightId);
  }

  if (
    scope.branchSelection.kind !== "all" &&
    scope.branchSelection.branches.length > 0
  ) {
    clauses.push(
      `(branch = '' OR branch IN (${scope.branchSelection.branches.map(() => "?").join(",")}))`
    );
    params.push(...scope.branchSelection.branches);
  }

  if (scope.sources.length > 0) {
    clauses.push(`adapter_id IN (${scope.sources.map(() => "?").join(",")})`);
    params.push(...scope.sources);
  }

  return {
    params,
    where: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "),
  };
};

const associationSelection = (scope: AgentScope) => {
  const exact: string[] = [];
  const compatible: string[] = [];
  const params: string[] = [];

  for (const [column, values] of [
    ["repo_id", scope.repoId === null ? [] : [scope.repoId]],
    ["flight_id", scope.flightId === null ? [] : [scope.flightId]],
    ["worktree_id", scope.worktreeId === null ? [] : [scope.worktreeId]],
    [
      "branch",
      scope.branchSelection.kind === "all"
        ? []
        : scope.branchSelection.branches,
    ],
    ["tool", scope.tools],
  ] as const) {
    if (values.length > 0) {
      const selected = `a.${column} IN (${values.map(() => "?").join(",")})`;
      exact.push(selected);
      compatible.push(`(a.${column} = '' OR ${selected})`);
      params.push(...values);
    }
  }

  const association =
    "SELECT 1 FROM agent_source_associations a WHERE a.adapter_id = l.adapter_id";

  const placed =
    exact.length === 0
      ? "1 = 1"
      : `EXISTS (${association} AND ${exact.join(" AND ")})`;

  const eligible =
    compatible.length === 0 || scope.sources.length > 0
      ? "1 = 1"
      : `(EXISTS (${association} AND ${compatible.join(" AND ")}) OR NOT EXISTS (${association}))`;

  return {
    eligible,
    eligibleParams: eligible === "1 = 1" ? [] : params,
    placed,
    placedParams: placed === "1 = 1" ? [] : params,
  };
};

export const selectAgentCoverage = (
  ctx: AgentDbContext,
  scope: AgentScope,
  maxSources: number,
  maxDecodedBytes: number
): AgentCoveragePage => {
  Schema.decodeUnknownSync(AgentScopeSchema)(scope);
  const bounds = decodeCoverageBounds({ maxDecodedBytes, maxSources });
  const selection = coverageSelection(scope);
  const associations = associationSelection(scope);
  const where = `(${selection.where}) AND ${associations.eligible}`;
  const params = [...selection.params, ...associations.eligibleParams];

  const total = decodeCountRow(
    ctx.db
      .prepare(
        `SELECT COUNT(DISTINCT l.adapter_id) AS count FROM agent_coverage_latest l WHERE ${where}`
      )
      .get(...params)
  ).count;

  const unresolvedBranch =
    scope.branchSelection.kind === "unresolved" ||
    (scope.branchSelection.kind !== "all" &&
      scope.branchSelection.branches.length === 0);

  const rows = ctx.db
    .prepare(
      `WITH scoped AS (SELECT l.adapter_id, l.flight_id, l.repo_id, l.branch, length(CAST(l.body AS BLOB)) AS bytes, CASE WHEN ${associations.placed} THEN 1 ELSE 0 END AS placed, ROW_NUMBER() OVER (PARTITION BY l.adapter_id ORDER BY l.seq DESC, l.flight_id, l.repo_id, l.branch) AS position FROM agent_coverage_latest l WHERE ${where}) SELECT adapter_id, flight_id, repo_id, branch, bytes, placed FROM scoped WHERE position = 1 ORDER BY adapter_id LIMIT ?`
    )
    .all(...associations.placedParams, ...params, bounds.maxSources);

  const coverage: SourceCoverage[] = [];
  let decodedBytes = 0;

  for (const raw of rows) {
    const row = decodeCoverageMetadataRow(raw);

    if (decodedBytes + row.bytes > bounds.maxDecodedBytes) {
      continue;
    }

    const { body } = decodeBodyRow(
      ctx.db
        .prepare(
          "SELECT body FROM agent_coverage_latest WHERE adapter_id = ? AND flight_id = ? AND repo_id = ? AND branch = ?"
        )
        .get(row.adapter_id, row.flight_id, row.repo_id, row.branch)
    );

    const recorded = agentDecoded(SourceCoverageSchema, body);
    const gaps = [...recorded.gaps];

    if (unresolvedBranch) {
      gaps.push({
        code: "unresolved-branch-placement",
        message:
          "The selected branch is unresolved; recorded source coverage does not verify current branch placement",
      });
    }

    if (row.placed === 0) {
      gaps.push({
        code: "unresolved-tool-placement",
        message:
          "Recorded source coverage does not verify every selected repository, branch, flight, tool and worktree constraint",
      });
    }

    coverage.push(
      row.placed === 1 && !unresolvedBranch
        ? recorded
        : {
            ...recorded,
            gaps,
            state: recorded.state === "complete" ? "partial" : recorded.state,
          }
    );
    decodedBytes += row.bytes;
  }

  return {
    coverage,
    decodedBytes,
    factsExamined: rows.length,
    omitted: total - coverage.length,
  };
};

export const sqliteCoverageMethods = (
  ctx: AgentDbContext
): Pick<AgentStoreService, "readCoverage"> => ({
  readCoverage: (scope, maxSources, maxDecodedBytes) =>
    ctx.read("agent.readCoverage", () =>
      selectAgentCoverage(ctx, scope, maxSources, maxDecodedBytes)
    ),
});
