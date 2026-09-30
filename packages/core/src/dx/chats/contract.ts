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

export const ChatNodeSchema = Schema.Struct({
  adapters: Schema.Array(Schema.String),
  agentTimeMs: ChatValueSchema,
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
  toolCalls: ChatValueSchema,
});

export type ChatNode = typeof ChatNodeSchema.Type;

export const ChatsReportSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  chats: Schema.Array(ChatNodeSchema),
  repoCommonDir: Schema.NullOr(Schema.String),
  rootSessionIds: Schema.Array(Schema.String),
  since: Schema.NullOr(Schema.String),
  unattributed: Schema.Struct({
    adapters: Schema.Array(Schema.String),
    events: Schema.Int,
    reason: Schema.NullOr(Schema.String),
  }),
});

export type ChatsReport = typeof ChatsReportSchema.Type;

export const DxChatsInput = Schema.Struct({
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
    "List the feature's Cursor chats as a subagent tree with per-chat time, requests, tool calls, tokens, money per ledger and a per-turn model and reasoning-level timeline. Titles are local only; no prompt text.",
  failure: QueryFailureSchema,
  input: DxChatsInput,
  output: ChatsReportSchema,
});
