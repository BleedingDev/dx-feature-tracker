// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import type {
  AiAttribution,
  AiTokens,
  AiUsage,
  ToolFigure,
} from "../../model/attribution.js";
import { unknownTokens } from "../../model/attribution.js";
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
import type { BranchSource } from "../ids.js";
import { harnessAdapterId } from "../pending.js";
import { inferVia, normalizeModel, providerFor } from "../provider.js";
import type { ClaudeUsage, CostRow } from "./rows.js";
import type { ChatInfo, RequestPick } from "./scan.js";

export const CLAUDE_CODE_ADAPTER_ID = harnessAdapterId("claude-code");

export const CLAUDE_CODE_ADAPTER_VERSION = "0.2.0";

export const CLAUDE_SOURCE_KIND = "claude-jsonl";

export interface Placement {
  readonly branchSource: BranchSource;
  readonly context: FlightContext;
}

export interface EventInput {
  readonly observedAt: string;
  readonly origin: Origin;
}

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const eventIdOf = (upstreamKey: string, kind: EventKind) =>
  EventIdSchema.make(
    sha256(`${CLAUDE_CODE_ADAPTER_ID}\u0000${upstreamKey}\u0000${kind}`)
  );

const sumKnown = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value) => value !== null);

  return known.length === 0
    ? null
    : known.reduce((total, value) => total + value, 0);
};

const count = (value: number | null | undefined): number | null =>
  value === undefined || value === null || value < 0 ? null : value;

export const tokensOf = (usage: ClaudeUsage): AiTokens => {
  const inputFresh = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  const thinking = count(usage.output_tokens_details?.thinking_tokens);

  return {
    cacheRead,
    cacheWrite,
    cacheWrite1h: count(usage.cache_creation?.ephemeral_1h_input_tokens),
    cacheWrite5m: count(usage.cache_creation?.ephemeral_5m_input_tokens),
    inputFresh,
    output,
    reasoning:
      thinking === null || output === null
        ? thinking
        : Math.min(thinking, output),
    total: sumKnown([inputFresh, cacheRead, cacheWrite, output]),
  };
};

export const reportsNothing = (tokens: AiTokens): boolean =>
  [tokens.inputFresh, tokens.cacheRead, tokens.cacheWrite, tokens.output].every(
    (value) => value === null || value === 0
  );

const VIA_BY_ID_PREFIX: readonly (readonly [string, string])[] = [
  ["msg_bdrk_", "bedrock"],
  ["msg_vrtx_", "vertex"],
];

export const GATEWAY_VIA = "gateway";

export const viaOfRequest = (
  model: string | null,
  messageId: string | null,
  requestId: string | null
): string | null => {
  const named = inferVia(model);

  if (named !== null) {
    return named;
  }

  const cloud = VIA_BY_ID_PREFIX.find(
    ([prefix]) => messageId?.startsWith(prefix) === true
  );

  if (cloud !== undefined) {
    return cloud[1];
  }

  return requestId === null ? GATEWAY_VIA : null;
};

export const requestKeyOf = (pick: RequestPick): string => {
  const { requestId, messageId } = pick.row;

  if (requestId !== null) {
    return `source:${CLAUDE_SOURCE_KIND}:request:${requestId}`;
  }

  return messageId === null
    ? `source:${CLAUDE_SOURCE_KIND}:${pick.key}`
    : `source:${CLAUDE_SOURCE_KIND}:message:${messageId}`;
};

export const effortOf = (pick: RequestPick): string | null =>
  pick.row.perTurnEffort ?? pick.row.effort;

const attribution = (
  chat: ChatInfo,
  placement: Placement,
  fields: {
    readonly cwd: string | null;
    readonly effort: string | null;
    readonly model: string | null;
    readonly version: string | null;
    readonly via: string | null;
  }
): AiAttribution => ({
  agentId: chat.agentId,
  agentType: chat.agentType,
  branchSource:
    placement.context.branch === null ? "unassigned" : placement.branchSource,
  channel: "session-file",
  cwd: fields.cwd,
  effort: fields.effort,
  effortSource: fields.effort === null ? null : "harness-recorded",
  harness: "claude-code",
  harnessVersion: fields.version,
  model: normalizeModel(fields.model),
  modelRaw: fields.model,
  parentSessionId: chat.parentChatId,
  provider: providerFor(fields.model, null),
  sessionId: chat.chatId,
  via: fields.via,
});

const TOKEN_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "usage.tokens.inputFresh",
    method: "source-reported",
    note: "Claude Code reports input without cache reads and writes",
    rawName: "message.usage.input_tokens",
    unit: "tokens",
  },
  {
    field: "usage.tokens.output",
    method: "source-reported",
    note: "largest streamed row of the request wins across every session file; rows are never summed",
    rawName: "message.usage.output_tokens",
    unit: "tokens",
  },
  {
    field: "usage.tokens.reasoning",
    method: "source-reported",
    note: "thinking tokens are part of output",
    rawName: "message.usage.output_tokens_details.thinking_tokens",
    unit: "tokens",
  },
];

interface EnvelopeParts {
  readonly ai: AiAttribution;
  readonly identity: Partial<EventIdentity>;
  readonly kind: EventKind;
  readonly occurredAt: string | null;
  readonly payload: DxEventEnvelope["payload"];
  readonly placement: Placement;
  readonly semantics: readonly FieldSemantics[];
  readonly upstreamKey: string;
  readonly usage: AiUsage | null;
  readonly version: string | null;
}

const envelope = (
  input: EventInput,
  parts: EnvelopeParts
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: CLAUDE_CODE_ADAPTER_ID,
  adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
  ai: parts.ai,
  context: parts.placement.context,
  eventId: eventIdOf(parts.upstreamKey, parts.kind),
  evidence: {
    bounded: true,
    hash: null,
    ref: `${CLAUDE_CODE_ADAPTER_ID}:${parts.upstreamKey}`,
  },
  fieldSemantics: [...parts.semantics],
  identity: { ...emptyEventIdentity, ...parts.identity },
  kind: parts.kind,
  observedAt: input.observedAt,
  occurredAt: parts.occurredAt,
  occurredAtPrecision: parts.occurredAt === null ? "unknown" : "exact",
  origin: input.origin,
  payload: parts.payload,
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: parts.version,
  upstreamKey: parts.upstreamKey,
  usage: parts.usage,
});

const legacyTokens = (tokens: AiTokens) => ({
  "cache-write": tokens.cacheWrite,
  "cached-input": tokens.cacheRead,
  input: tokens.inputFresh,
  output: tokens.output,
});

export const usageEvent = (
  pick: RequestPick,
  placement: Placement,
  input: EventInput
): DxEventEnvelope | null => {
  const { row, chat } = pick;

  if (row.usage === null) {
    return null;
  }

  const tokens = tokensOf(row.usage);

  if (reportsNothing(tokens)) {
    return null;
  }

  const requestKey = requestKeyOf(pick);
  const effort = effortOf(pick);
  const via = viaOfRequest(row.model, row.messageId, row.requestId);
  const serverTools = row.usage.server_tool_use ?? null;

  return envelope(input, {
    ai: attribution(chat, placement, {
      cwd: row.cwd,
      effort,
      model: row.model,
      version: row.version,
      via,
    }),
    identity: {
      generationId: row.messageId,
      requestId: row.requestId,
      sessionId: chat.chatId,
      turnId: pick.turnId,
    },
    kind: "ai.usage",
    occurredAt: pick.firstTimestamp ?? row.timestamp,
    payload: {
      agentType: chat.agentType,
      branchSource: placement.branchSource,
      cwd: row.cwd,
      effort,
      entrypoint: row.entrypoint,
      isSubagent: chat.parentChatId !== null,
      model: row.model,
      parentSessionId: chat.parentChatId,
      requestKey,
      rowCount: pick.rows,
      sourceKind: CLAUDE_SOURCE_KIND,
      stopReason: row.stopReason,
      tokens: legacyTokens(tokens),
      webFetchRequests: count(serverTools?.web_fetch_requests),
      webSearchRequests: count(serverTools?.web_search_requests),
    },
    placement,
    semantics: TOKEN_SEMANTICS,
    upstreamKey: requestKey,
    usage: {
      premiumRequests: null,
      requestKey,
      serviceTier: row.usage.service_tier ?? null,
      speed: row.usage.speed ?? null,
      tokens,
      toolFigure: null,
    },
    version: row.version,
  });
};

export const turnEvent = (
  pick: RequestPick,
  placement: Placement,
  input: EventInput
): DxEventEnvelope => {
  const { row, chat } = pick;
  const effort = effortOf(pick);
  const turn = pick.turnId ?? "-";

  return envelope(input, {
    ai: attribution(chat, placement, {
      cwd: row.cwd,
      effort,
      model: row.model,
      version: row.version,
      via: viaOfRequest(row.model, row.messageId, row.requestId),
    }),
    identity: { sessionId: chat.chatId, turnId: pick.turnId },
    kind: "ai.turn",
    occurredAt: pick.firstTimestamp ?? row.timestamp,
    payload: {
      effort,
      model: row.model,
      parentSessionId: chat.parentChatId,
      sourceKind: CLAUDE_SOURCE_KIND,
    },
    placement,
    semantics: [],
    upstreamKey: `turn:${chat.chatId}:${turn}:${row.model ?? "-"}:${effort ?? "-"}`,
    usage: null,
    version: row.version,
  });
};

export const turnKeyOf = (pick: RequestPick): string =>
  `${pick.chat.chatId}\u0000${pick.turnId ?? "-"}\u0000${pick.row.model ?? "-"}\u0000${effortOf(pick) ?? "-"}`;

export interface SessionFacts {
  readonly chat: ChatInfo;
  readonly cwd: string | null;
  readonly startedAt: string | null;
  readonly title: string | null;
  readonly version: string | null;
}

export const sessionEvent = (
  facts: SessionFacts,
  placement: Placement,
  input: EventInput
): DxEventEnvelope => {
  const { chat } = facts;

  return envelope(input, {
    ai: attribution(chat, placement, {
      cwd: facts.cwd,
      effort: null,
      model: null,
      version: facts.version,
      via: null,
    }),
    identity: { sessionId: chat.chatId },
    kind: "ai.session",
    occurredAt: facts.startedAt,
    payload: {
      agentId: chat.agentId,
      agentType: chat.agentType,
      isSubagent: chat.parentChatId !== null || chat.isSidechain,
      parentSessionId: chat.parentChatId,
      sourceKind: CLAUDE_SOURCE_KIND,
      title: facts.title,
    },
    placement,
    semantics: [],
    upstreamKey: `session:${chat.chatId}:${facts.title ?? ""}`,
    usage: null,
    version: facts.version,
  });
};

const COST_SEMANTICS: FieldSemantics = {
  field: "usage.toolFigure",
  method: "source-reported",
  note: "Claude Code's own running session cost (cost-state), cumulative across resumes; a session figure, never per request",
  rawName: "cost-state.totalCostUSD",
  unit: "USD",
};

const costFigure = (row: CostRow): ToolFigure | null =>
  row.totalCostUsd === null || row.totalCostUsd <= 0
    ? null
    : { amount: row.totalCostUsd, currency: "USD", kind: "api-equivalent" };

const crossCheckOf = (row: CostRow) =>
  Object.fromEntries(
    Object.entries(row.models).map(([model, usage]) => [
      model,
      {
        cacheRead: count(usage.cacheReadInputTokens),
        cacheWrite: count(usage.cacheCreationInputTokens),
        costUsd: usage.costUSD ?? null,
        inputFresh: count(usage.inputTokens),
        output: count(usage.outputTokens),
        webSearchRequests: count(usage.webSearchRequests),
      },
    ])
  );

export const costEvent = (
  facts: SessionFacts,
  row: CostRow,
  placement: Placement,
  input: EventInput
): DxEventEnvelope => {
  const figure = costFigure(row);
  const amount = row.totalCostUsd ?? 0;

  return envelope(input, {
    ai: attribution(facts.chat, placement, {
      cwd: facts.cwd,
      effort: null,
      model: null,
      version: facts.version,
      via: null,
    }),
    identity: { sessionId: facts.chat.chatId },
    kind: "ai.session",
    occurredAt: facts.startedAt,
    payload: {
      costState: {
        cumulative: true,
        hasUnknownModelCost: row.hasUnknownModelCost,
        models: crossCheckOf(row),
        totalCostUsd: row.totalCostUsd,
      },
      sourceKind: CLAUDE_SOURCE_KIND,
    },
    placement,
    semantics: [COST_SEMANTICS],
    upstreamKey: `cost:${facts.chat.chatId}:${String(amount)}`,
    usage:
      figure === null
        ? null
        : {
            premiumRequests: null,
            requestKey: null,
            serviceTier: null,
            speed: null,
            tokens: unknownTokens,
            toolFigure: figure,
          },
    version: facts.version,
  });
};
