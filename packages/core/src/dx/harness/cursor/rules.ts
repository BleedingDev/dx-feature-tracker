import { Option, Schema } from "effect";

import {
  CURSOR_HOOKS_ADAPTER_ID,
  CURSOR_STOP_SOURCE_KIND,
} from "../../collectors/cursor-hooks/ids.js";
import { stopTokenUsage } from "../../collectors/cursor-hooks/stop-usage.js";
import type { DxEventEnvelope } from "../../model/event.js";
import type { ChatChannelRole, HarnessRules, ModelEffort } from "../rules.js";

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "thinking",
  "fast",
]);

const AUTO_MODELS: ReadonlySet<string> = new Set(["auto", "default"]);

const splitSuffix = (raw: string) => {
  const tokens = raw.split("-");
  const stripped: string[] = [];

  while (tokens.length > 1) {
    const last = tokens.at(-1)?.toLowerCase() ?? "";

    if (!EFFORT_LEVELS.has(last)) {
      break;
    }

    stripped.unshift(last);
    tokens.pop();
  }

  return { base: tokens.join("-"), stripped };
};

export const cursorModelEffort = (
  rawModel: string,
  sourceEffort: string | null = null
): ModelEffort => {
  const trimmed = rawModel.trim();
  const { base, stripped } = splitSuffix(trimmed);

  if (sourceEffort !== null) {
    return {
      effort: sourceEffort,
      effortReason: null,
      effortSource: "source-field",
      model: stripped.length > 0 ? base : trimmed,
    };
  }

  if (stripped.length > 0) {
    return {
      effort: stripped.join("+"),
      effortReason:
        "parsed from the model name suffix; Cursor encodes the reasoning variant in the model id",
      effortSource: "model-name-suffix",
      model: base,
    };
  }

  return {
    effort: null,
    effortReason: AUTO_MODELS.has(trimmed.toLowerCase())
      ? "Cursor auto model selection; the concrete model and effort are not reported locally"
      : "the source reports no reasoning level and the model name carries no effort suffix",
    effortSource: "unavailable",
    model: trimmed,
  };
};

export const CURSOR_LIST_PRICE_FIELD = "tokenUsage.totalCents";

const CURSOR_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "cursor-cli",
  "cursor-transcript",
  "dashboard-json",
  "dashboard-response",
  CURSOR_STOP_SOURCE_KIND,
  "local-db",
  "sdk",
  "transcript-estimate",
  "usage-csv",
]);

const decodeText = Schema.decodeUnknownOption(Schema.String);

const sourceKindOf = (event: DxEventEnvelope): string | null =>
  Option.getOrNull(decodeText(event.payload.sourceKind));

const PROMPT_HOOKS: ChatChannelRole = {
  idKind: "conversationId",
  labels: {
    duration: "cursor-hooks stop duration",
    requests: "cursor-hooks beforeSubmitPrompt",
    toolCalls: "cursor-hooks postToolUse",
  },
  role: "prompt-hooks",
};

const CHAT_STORE: ChatChannelRole = {
  idKind: "composerId",
  labels: {
    requests: "cursor-local-db user bubbles",
    toolCalls: "cursor-local-db tool bubbles",
  },
  role: "chat-store",
};

const AGENT_STREAM: ChatChannelRole = {
  idKind: "sessionId",
  labels: {
    duration: "cursor-cli result duration_ms",
    toolCalls: "cursor-cli stream tool calls",
  },
  role: "agent-stream",
};

const TRANSCRIPT: ChatChannelRole = {
  idKind: "sessionId",
  labels: { toolCalls: "cursor-transcripts tool calls" },
  role: "transcript",
};

const cursorChatRole = (event: DxEventEnvelope): ChatChannelRole | null => {
  if (event.adapterId.includes(CURSOR_HOOKS_ADAPTER_ID)) {
    return PROMPT_HOOKS;
  }

  if (event.adapterId.includes("cursor-local-db")) {
    return CHAT_STORE;
  }

  const sourceKind = sourceKindOf(event);

  if (sourceKind === "cursor-cli") {
    return AGENT_STREAM;
  }

  return sourceKind === "transcript-estimate" ? TRANSCRIPT : null;
};

const claimsEvent = (event: DxEventEnvelope): boolean => {
  if (event.adapterId.includes("cursor")) {
    return true;
  }

  const sourceKind = sourceKindOf(event);

  return sourceKind !== null && CURSOR_SOURCE_KINDS.has(sourceKind);
};

export const CURSOR_RULES: HarnessRules = {
  chatRole: cursorChatRole,
  claims: claimsEvent,
  effort: cursorModelEffort,
  listPrice: { field: CURSOR_LIST_PRICE_FIELD },
  rawUsage: {
    adapterId: CURSOR_HOOKS_ADAPTER_ID,
    read: stopTokenUsage,
    reason:
      "Cursor stop-hook usage fields have unverified semantics; not summed until a probe verifies them",
    sourceKind: CURSOR_STOP_SOURCE_KIND,
  },
  sourceKindAliases: new Map([
    ["cursor-cli", "sdk"],
    ["cursor-transcript", "transcript-estimate"],
  ]),
  takesHookTurn: () => false,
};
