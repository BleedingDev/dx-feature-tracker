import { Option, Predicate, Schema } from "effect";

import type { EventKind } from "../../model/event.js";
import type { HookDecoder, HookFields } from "../hook-observation.js";
import { boundedField } from "../hook-observation.js";
import { subagentChatId } from "./paths.js";

const Text = Schema.optional(Schema.NullOr(Schema.String));

const EffortSchema = Schema.optional(
  Schema.NullOr(Schema.Union([Schema.String, Schema.Struct({ level: Text })]))
);

const ClaudeHookPayloadSchema = Schema.Struct({
  agent_id: Text,
  agent_type: Text,
  cwd: Text,
  effort: EffortSchema,
  model: Text,
  prompt_id: Text,
  session_id: Text,
  transcript_path: Text,
});

type ClaudeHookPayload = typeof ClaudeHookPayloadSchema.Type;

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeHookPayloadSchema)
);

const effortOf = (effort: ClaudeHookPayload["effort"]): string | null => {
  if (effort === undefined || effort === null) {
    return null;
  }

  return boundedField(Predicate.isString(effort) ? effort : effort.level);
};

const fieldsOf = (payload: ClaudeHookPayload): HookFields => {
  const session = boundedField(payload.session_id);
  const agent = boundedField(payload.agent_id);
  const isSubagent = session !== null && agent !== null;

  return {
    agentId: agent,
    agentType: boundedField(payload.agent_type),
    cwd: boundedField(payload.cwd),
    effort: effortOf(payload.effort),
    model: boundedField(payload.model),
    parentSessionId: isSubagent ? session : null,
    sessionId: isSubagent ? subagentChatId(session, agent) : session,
    transcriptPath: boundedField(payload.transcript_path),
    turnId: boundedField(payload.prompt_id),
  };
};

export const decodeClaudeHook = (stdinText: string): HookFields | null =>
  Option.match(decodePayload(stdinText), {
    onNone: () => null,
    onSome: fieldsOf,
  });

const HOOK_KINDS = new Map<string, EventKind>([
  ["PostToolUse", "other"],
  ["PreCompact", "other"],
  ["SessionEnd", "ai.session"],
  ["SessionStart", "ai.session"],
  ["Stop", "ai.turn"],
  ["SubagentStart", "ai.session"],
  ["SubagentStop", "ai.turn"],
  ["UserPromptSubmit", "ai.request"],
]);

export const claudeCodeHookKind = (event: string): EventKind =>
  HOOK_KINDS.get(event) ?? "other";

export const CLAUDE_CODE_HOOK_EVENTS: readonly string[] = [
  ...HOOK_KINDS.keys(),
];

export const claudeCodeHookDecoder: HookDecoder = {
  decode: decodeClaudeHook,
  kind: claudeCodeHookKind,
  respond: () => "",
};
