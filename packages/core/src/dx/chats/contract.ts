import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { QueryFailureSchema } from "../contracts/errors.js";

export const ChatValueSchema = Schema.Struct({
  method: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  value: Schema.NullOr(Schema.Finite),
});

export type ChatValue = typeof ChatValueSchema.Type;

export const ChatLedgerLineSchema = Schema.Struct({
  category: Schema.String,
  currency: Schema.NullOr(Schema.String),
  estimate: Schema.Boolean,
  ledger: Schema.String,
  methods: Schema.Array(Schema.String),
  sources: Schema.Array(Schema.String),
  value: Schema.Finite,
});

export type ChatLedgerLine = typeof ChatLedgerLineSchema.Type;

export const ChatSourceIdSchema = Schema.Struct({
  adapterId: Schema.String,
  kind: Schema.Literals(["composerId", "conversationId", "sessionId"]),
  value: Schema.String,
});

export type ChatSourceId = typeof ChatSourceIdSchema.Type;

export const ChatTitleSchema = Schema.Struct({
  exportable: Schema.Literal(false),
  source: Schema.String,
  value: Schema.String,
});

export const ModelTurnSchema = Schema.Struct({
  adapterId: Schema.String,
  at: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  effortReason: Schema.NullOr(Schema.String),
  effortSource: Schema.Literals([
    "model-name-suffix",
    "source-field",
    "unavailable",
  ]),
  generationId: Schema.NullOr(Schema.String),
  maxMode: Schema.NullOr(Schema.Boolean),
  model: Schema.String,
  rawModel: Schema.String,
  requestId: Schema.NullOr(Schema.String),
  scope: Schema.Literals(["turn", "request", "session-setting", "aggregate"]),
  sourceKind: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
});

export type ModelTurn = typeof ModelTurnSchema.Type;

const Amount = Schema.NullOr(Schema.Finite);

export const ChatTokensSchema = Schema.Struct({
  cacheRead: Amount,
  cacheWrite: Amount,
  input: Amount,
  output: Amount,
  reasoning: Amount,
  total: Amount,
});

export type ChatTokens = typeof ChatTokensSchema.Type;

export const ChatUsageSchema = Schema.Struct({
  billed: Amount,
  estimate: Amount,
  requests: Schema.Int,
  tokens: ChatTokensSchema,
  toolFigure: Amount,
  unpriced: Schema.Int,
});

export type ChatUsage = typeof ChatUsageSchema.Type;

export const ChatNodeSchema = Schema.Struct({
  adapters: Schema.Array(Schema.String),
  agentId: Schema.NullOr(Schema.String),
  agentTimeMs: ChatValueSchema,
  agentType: Schema.NullOr(Schema.String),
  branches: Schema.Array(Schema.String),
  childSessionIds: Schema.Array(Schema.String),
  eventCount: Schema.Int,
  isSubagent: Schema.NullOr(Schema.Boolean),
  modelTimeline: Schema.Array(ModelTurnSchema),
  modelTimelineReason: Schema.NullOr(Schema.String),
  models: Schema.Array(Schema.String),
  money: Schema.Array(ChatLedgerLineSchema),
  moneyUnavailableReason: Schema.NullOr(Schema.String),
  parentSessionId: Schema.NullOr(Schema.String),
  parentUnavailableReason: Schema.NullOr(Schema.String),
  providers: Schema.Array(Schema.String),
  requests: ChatValueSchema,
  sessionId: Schema.String,
  sourceIds: Schema.Array(ChatSourceIdSchema),
  span: Schema.Struct({
    end: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
    start: Schema.NullOr(Schema.String),
  }),
  title: Schema.NullOr(ChatTitleSchema),
  titleUnavailableReason: Schema.NullOr(Schema.String),
  tokens: Schema.Array(ChatLedgerLineSchema),
  tokensUnavailableReason: Schema.NullOr(Schema.String),
  tool: Schema.NullOr(Schema.String),
  toolCalls: ChatValueSchema,
  usage: ChatUsageSchema,
});

export type ChatNode = typeof ChatNodeSchema.Type;

export const CHAT_FILTERS = [
  "tool",
  "provider",
  "via",
  "model",
  "effort",
] as const;

export type ChatFilter = (typeof CHAT_FILTERS)[number];

export type ChatFilters = Partial<
  Readonly<Record<ChatFilter, readonly string[] | undefined>>
>;

const filterValues = (description: string) =>
  Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: `${description}; any listed value matches. "(none)" matches a missing value.`,
    })
  );

export const ChatFiltersSchema = Schema.Struct({
  effort: filterValues("Reasoning effort levels"),
  model: filterValues("Normalized model names"),
  provider: filterValues("Model makers (anthropic, openai, ...)"),
  tool: filterValues(
    "Tools (cursor, claude-code, codex, opencode, pi, omp, deepseek)"
  ),
  via: filterValues("Gateways or local runtimes (openrouter, ollama, ...)"),
});

export const ChatsReportSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  chats: Schema.Array(ChatNodeSchema),
  estimateLabel: Schema.String,
  filters: ChatFiltersSchema,
  repoCommonDir: Schema.NullOr(Schema.String),
  rootSessionIds: Schema.Array(Schema.String),
  since: Schema.NullOr(Schema.String),
  tools: Schema.Array(Schema.String),
  totals: ChatUsageSchema,
  unattributed: Schema.Struct({
    adapters: Schema.Array(Schema.String),
    events: Schema.Int,
    reason: Schema.NullOr(Schema.String),
  }),
});

export type ChatsReport = typeof ChatsReportSchema.Type;

export const DxChatsInput = Schema.Struct({
  ...ChatFiltersSchema.fields,
  allBranches: Schema.optional(
    Schema.Boolean.annotate({
      description: "List chats on every branch of the repo, not just one",
    })
  ),
  branch: Schema.optional(
    Schema.String.annotate({ description: "Branch; defaults to current" })
  ),
  repo: Schema.optional(Schema.String),
  since: Schema.optional(
    Schema.String.annotate({
      description: "Lower time bound: 7d, 12h, 30m, 2w or an ISO timestamp",
    })
  ),
});

export const dxChatsContract = defineContract("dx_chats", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "List the chats of every tool (Cursor, Claude Code, Codex, OpenCode, Pi, OMP, DeepSeek Harness) on a branch as one subagent tree: tool, title, per-turn model and reasoning level, per-chat tokens, estimate, billed and the tool's own figure, requests, tool calls and time. Filter by tool, provider, via, model or effort. Titles are local only; no prompt text.",
  failure: QueryFailureSchema,
  input: DxChatsInput,
  output: ChatsReportSchema,
});
