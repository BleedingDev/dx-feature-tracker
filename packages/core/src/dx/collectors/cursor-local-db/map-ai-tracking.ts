import { buildEnvelope, reported, toIso } from "./envelope.js";
import { maxIso, scopeOfMap } from "./map-state.js";
import type { MapContext, MapResult } from "./map-state.js";
import type { CodeHashRow, ScoredCommitRow } from "./schemas.js";
import { ownsPath } from "./scope.js";
import type { AiTrackingRows } from "./snapshot.js";

const hashEvent = (row: CodeHashRow, ctx: MapContext, version: string) =>
  buildEnvelope({
    context: ctx.context,
    fieldSemantics: [
      reported(
        "source",
        "ai_code_hashes.source",
        null,
        "Cursor attribution of the edit such as composer, tab or cli"
      ),
      reported(
        "toolCallRef",
        "ai_code_hashes.requestId",
        null,
        "Cursor stores a tool-call reference here, not a provider request ID"
      ),
    ],
    identity: { sessionId: row.conversationId },
    kind: "ai.tool-edit",
    observedAt: ctx.observedAt,
    occurredAt: toIso(row.timestamp) ?? toIso(row.createdAt),
    origin: ctx.origin,
    payload: {
      fileExtension: row.fileExtension,
      model: row.model,
      source: row.source,
      sourceKind: "local-db",
      toolCallRef: row.requestId,
    },
    sourceHash: ctx.sourceHash,
    sourceVersion: version,
    upstreamKey: `ai-code-hash:${row.hash}`,
  });

const commitEvent = (row: ScoredCommitRow, ctx: MapContext, version: string) =>
  buildEnvelope({
    context: { ...ctx.context, branch: row.branchName },
    fieldSemantics: [
      reported(
        "linesBySource",
        "scored_commits.*LinesAdded",
        "lines",
        "Cursor-scored attribution; not independent AI ownership proof"
      ),
    ],
    identity: { commitSha: row.commitHash },
    kind: "provenance.attestation",
    observedAt: ctx.observedAt,
    occurredAt: toIso(row.commitDate) ?? toIso(row.scoredAt),
    origin: ctx.origin,
    payload: {
      linesAdded: row.linesAdded,
      linesBySource: {
        composer: {
          added: row.composerLinesAdded,
          deleted: row.composerLinesDeleted,
        },
        human: { added: row.humanLinesAdded, deleted: row.humanLinesDeleted },
        tab: { added: row.tabLinesAdded, deleted: row.tabLinesDeleted },
      },
      linesDeleted: row.linesDeleted,
      sourceKind: "local-db",
    },
    sourceHash: ctx.sourceHash,
    sourceVersion: version,
    upstreamKey: `scored-commit:${row.commitHash}:${row.branchName}`,
  });

export const mapAiTracking = (
  rows: AiTrackingRows,
  ctx: MapContext
): MapResult => {
  const scope = scopeOfMap(ctx);

  const hashes = rows.codeHashes.filter(
    (row) => scope === null || ownsPath(scope, row.fileName ?? "")
  );

  const { branch } = ctx.context;
  const known = ctx.knownCommits ?? null;

  const commits = rows.scoredCommits.filter(
    (row) =>
      (branch === null || row.branchName === branch) &&
      (known === null || known.has(row.commitHash))
  );

  const events = [
    ...hashes.map((row) => hashEvent(row, ctx, rows.layout)),
    ...commits.map((row) => commitEvent(row, ctx, rows.layout)),
  ];

  return {
    events,
    excluded:
      rows.codeHashes.length -
      hashes.length +
      rows.scoredCommits.length -
      commits.length,
    unreadable: 0,
    watermark: maxIso(events.map((event) => event.occurredAt)),
  };
};
