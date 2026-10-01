import { Option, Schema } from "effect";

import type { EventKind } from "../../model/event.js";
import type { HookDecoder, HookFields } from "../hook-observation.js";
import { boundedField, standardHookFields } from "../hook-observation.js";

const Text = Schema.optional(Schema.NullOr(Schema.String));

const SubagentPayloadSchema = Schema.Struct({
  agent_id: Text,
  agent_transcript_path: Text,
  session_id: Text,
});

const decodeSubagentPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(SubagentPayloadSchema)
);

export const CODEX_HOOK_KINDS: ReadonlyMap<string, EventKind> = new Map([
  ["SessionStart", "ai.session"],
  ["SessionEnd", "ai.session"],
  ["SubagentStart", "ai.session"],
  ["SubagentStop", "ai.session"],
  ["UserPromptSubmit", "ai.request"],
  ["Stop", "ai.turn"],
]);

const SUBAGENT_EVENTS: ReadonlySet<string> = new Set([
  "SubagentStart",
  "SubagentStop",
]);

const subagentFields = (stdinText: string, fields: HookFields): HookFields =>
  Option.match(decodeSubagentPayload(stdinText), {
    onNone: () => fields,
    onSome: (payload) => {
      const agentId = boundedField(payload.agent_id);
      const parent = boundedField(payload.session_id);

      return agentId === null
        ? fields
        : {
            ...fields,
            agentId,
            parentSessionId:
              parent === agentId ? fields.parentSessionId : parent,
            sessionId: agentId,
            transcriptPath:
              boundedField(payload.agent_transcript_path) ??
              fields.transcriptPath,
          };
    },
  });

export const codexHookDecoder: HookDecoder = {
  decode: (stdinText, event) => {
    const fields = standardHookFields(stdinText);

    if (fields === null) {
      return null;
    }

    return SUBAGENT_EVENTS.has(event)
      ? subagentFields(stdinText, fields)
      : fields;
  },
  kind: (event) => CODEX_HOOK_KINDS.get(event) ?? "other",
  respond: () => "",
};
