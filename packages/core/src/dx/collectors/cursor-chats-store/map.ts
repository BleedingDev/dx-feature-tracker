// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs need a synchronous deterministic sha256 inside the pure mapper; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { DateTime, Option } from "effect";

import { withCollectorBlocks } from "../../harness/collector-blocks.js";
import type { Origin } from "../../model/common.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventIdentity,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import { normalizePath, ownsPath } from "../cursor-local-db/scope.js";
import type { WorktreeScope } from "../cursor-local-db/scope.js";
import type { ChatModel, ChatTurn, TrackedRepo } from "./decode.js";

export const CHAT_STORE_SOURCE_KIND = "cursor-cli-store";

export const CHAT_STORE_TOKENS_REASON =
  "the cursor-agent chat store keeps no token counts; exact tokens come from the stop hook or Cursor account usage for the same chat";

export interface ChatMapContext {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly scope: WorktreeScope | null;
  readonly sourceHash: string;
}

const sha256 = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const toIso = (ms: number | null): string | null =>
  ms === null || ms <= 0
    ? null
    : Option.match(DateTime.make(ms), {
        onNone: () => null,
        onSome: DateTime.formatIso,
      });

const reported = (
  field: string,
  rawName: string,
  unit: string | null,
  note: string | null = null
): FieldSemantics => ({
  field,
  method: "source-reported",
  note,
  rawName,
  unit,
});

const repoForWorktree = (
  repos: readonly TrackedRepo[],
  ctx: ChatMapContext
): TrackedRepo | null => {
  const { scope } = ctx;

  if (scope === null) {
    return repos[0] ?? null;
  }

  return repos.find((repo) => ownsPath(scope, repo.path)) ?? null;
};

interface BranchChoice {
  readonly branch: string | null;
  readonly source: string | null;
}

const branchOf = (
  repos: readonly TrackedRepo[],
  activeBranch: string | null,
  ctx: ChatMapContext
): BranchChoice => {
  const repo = repoForWorktree(repos, ctx);

  if (
    repo?.branch !== null &&
    repo?.branch !== undefined &&
    repo.branch !== ""
  ) {
    return { branch: repo.branch, source: "cursor-agent-store" };
  }

  if (activeBranch !== null && activeBranch !== "") {
    return { branch: activeBranch, source: "cursor-agent-store" };
  }

  return {
    branch: ctx.context.branch,
    source: ctx.context.branch === null ? null : "collect-context",
  };
};

interface EnvelopeInput {
  readonly branch: BranchChoice;
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly identity: Partial<EventIdentity>;
  readonly kind: EventKind;
  readonly occurredAt: string | null;
  readonly payload: DxEventEnvelope["payload"];
  readonly upstreamKey: string;
}

const envelope = (ctx: ChatMapContext, input: EnvelopeInput): DxEventEnvelope =>
  withCollectorBlocks({
    acquisition: "db-snapshot",
    adapterId: ctx.adapterId,
    adapterVersion: ctx.adapterVersion,
    context: { ...ctx.context, branch: input.branch.branch },
    eventId: EventIdSchema.make(
      sha256(`${ctx.adapterId}\u0000${input.upstreamKey}\u0000${input.kind}`)
    ),
    evidence: {
      bounded: true,
      hash: ctx.sourceHash,
      ref: `${ctx.adapterId}:${input.upstreamKey}`,
    },
    fieldSemantics: input.fieldSemantics,
    identity: { ...emptyEventIdentity, ...input.identity },
    kind: input.kind,
    observedAt: ctx.observedAt,
    occurredAt: input.occurredAt,
    occurredAtPrecision: input.occurredAt === null ? "unknown" : "exact",
    origin: ctx.origin,
    payload: {
      ...input.payload,
      branchSource: input.branch.source,
      sourceKind: CHAT_STORE_SOURCE_KIND,
      tokensUnavailableReason: CHAT_STORE_TOKENS_REASON,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: null,
    upstreamKey: input.upstreamKey,
  });

const SESSION_SEMANTICS: readonly FieldSemantics[] = [
  reported(
    "contextMeter.tokensUsed",
    "ConversationStateStructure.token_details.used_tokens",
    "tokens",
    "Context window occupancy meter; not token spend and not billed"
  ),
  reported(
    "model",
    "root_prompt_messages_json[].content[].providerOptions.cursor.modelName",
    null,
    "last model name on an assistant message"
  ),
  reported(
    "branch",
    "ConversationStateStructure.tracked_git_repo_branches",
    null,
    "branch cursor-agent recorded for the worktree when the chat started"
  ),
];

const TURN_SEMANTICS: readonly FieldSemantics[] = [
  reported("requestId", "AgentConversationTurnStructure.request_id", null),
  reported("startedAt", "UserMessage.started_at_ms", "ms"),
  reported(
    "toolCalls",
    "AgentConversationTurnStructure.steps[].tool_call",
    "calls"
  ),
  reported(
    "branch",
    "ConversationStateStructure.tracked_git_repo_branches",
    null,
    "branch recorded in the first saved state that holds this turn"
  ),
];

const sessionEvent = (model: ChatModel, ctx: ChatMapContext) => {
  const { meta } = model;

  return envelope(ctx, {
    branch: branchOf(model.firstRepos, model.firstActiveBranch, ctx),
    fieldSemantics: SESSION_SEMANTICS,
    identity: { sessionId: meta.agentId },
    kind: "ai.session",
    occurredAt: toIso(model.startedAt ?? meta.createdAt),
    payload: {
      agentType: model.agentType,
      contextMeter: {
        limitTokens: model.contextLimit,
        notSpend: true,
        tokensUsed: model.contextUsed,
      },
      createdAt: toIso(meta.createdAt),
      isSubagent: meta.parentAgentId !== null,
      mode: meta.mode,
      model: model.models.at(-1) ?? null,
      models: [...new Set(model.models)],
      parentSessionId: meta.parentAgentId,
      subagentType: meta.subagentType,
      turns: model.turns.length,
    },
    upstreamKey: `chat:${meta.agentId}`,
  });
};

const turnEvent = (turn: ChatTurn, model: ChatModel, ctx: ChatMapContext) =>
  envelope(ctx, {
    branch: branchOf(turn.repos, turn.activeBranch, ctx),
    fieldSemantics: TURN_SEMANTICS,
    identity: {
      requestId: turn.requestId,
      sessionId: model.meta.agentId,
      turnId: turn.userMessageId,
    },
    kind: "ai.turn",
    occurredAt: toIso(turn.startedAt),
    payload: {
      model: turn.routedModel,
      parentSessionId: model.meta.parentAgentId,
      role: "user",
      steps: turn.steps,
      toolCalls: turn.toolCalls,
    },
    upstreamKey: `chat:${model.meta.agentId}:turn:${turn.key}`,
  });

export const chatPaths = (model: ChatModel, cwd: string | null) => [
  ...(cwd === null ? [] : [cwd]),
  ...model.repos.map((repo) => repo.path),
  ...model.workspaceUris.flatMap((uri) => {
    const normalized = normalizePath(uri);

    return normalized === null ? [] : [normalized];
  }),
];

export const chatInScope = (
  model: ChatModel,
  cwd: string | null,
  scope: WorktreeScope | null
): boolean => {
  if (scope === null) {
    return true;
  }

  const [primary] = chatPaths(model, cwd);

  return primary !== undefined && ownsPath(scope, primary);
};

export const mapChatModel = (
  model: ChatModel,
  ctx: ChatMapContext
): readonly DxEventEnvelope[] => [
  sessionEvent(model, ctx),
  ...model.turns.map((turn) => turnEvent(turn, model, ctx)),
];
