import { Option, Schema } from "effect";

import { HarnessIdSchema } from "./ids.js";
import type { HarnessId } from "./ids.js";

export const HOOK_OBSERVATION_SCHEMA = "dft.hook.v1" as const;

export const MAX_HOOK_FIELD_CHARS = 512;

export const HookFieldsSchema = Schema.Struct({
  agentId: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  parentSessionId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  transcriptPath: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
});

export type HookFields = typeof HookFieldsSchema.Type;

export const noHookFields: HookFields = {
  agentId: null,
  cwd: null,
  model: null,
  parentSessionId: null,
  sessionId: null,
  transcriptPath: null,
  turnId: null,
};

export const HookGitSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  repoCommonDir: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});

export type HookGit = typeof HookGitSchema.Type;

export const HookObservationSchema = Schema.Struct({
  event: Schema.String,
  fields: HookFieldsSchema,
  git: HookGitSchema,
  observedAt: Schema.String,
  payloadValid: Schema.Boolean,
  schema: Schema.Literal(HOOK_OBSERVATION_SCHEMA),
  tool: HarnessIdSchema,
});

export type HookObservation = typeof HookObservationSchema.Type;

export interface HookDecoder {
  readonly decode: (stdinText: string, event: string) => HookFields | null;
  readonly respond: (event: string) => string;
}

const Text = Schema.optional(Schema.NullOr(Schema.String));

const StandardPayloadSchema = Schema.Struct({
  agentId: Text,
  agent_id: Text,
  conversation_id: Text,
  cwd: Text,
  generation_id: Text,
  model: Text,
  parentSessionId: Text,
  parent_session_id: Text,
  prompt_id: Text,
  sessionId: Text,
  session_id: Text,
  transcriptPath: Text,
  transcript_path: Text,
  turnId: Text,
  turn_id: Text,
});

const decodeStandard = Schema.decodeUnknownOption(
  Schema.fromJsonString(StandardPayloadSchema)
);

export const boundedField = (
  value: string | null | undefined
): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed.slice(0, MAX_HOOK_FIELD_CHARS);
};

export const standardHookFields = (stdinText: string): HookFields | null =>
  Option.match(decodeStandard(stdinText), {
    onNone: () => null,
    onSome: (payload) => ({
      agentId: boundedField(payload.agent_id ?? payload.agentId),
      cwd: boundedField(payload.cwd),
      model: boundedField(payload.model),
      parentSessionId: boundedField(
        payload.parent_session_id ?? payload.parentSessionId
      ),
      sessionId: boundedField(
        payload.session_id ?? payload.sessionId ?? payload.conversation_id
      ),
      transcriptPath: boundedField(
        payload.transcript_path ?? payload.transcriptPath
      ),
      turnId: boundedField(
        payload.turn_id ??
          payload.turnId ??
          payload.prompt_id ??
          payload.generation_id
      ),
    }),
  });

export const standardHookDecoder: HookDecoder = {
  decode: (stdinText) => standardHookFields(stdinText),
  respond: () => "",
};

const EventNameSchema = Schema.Struct({
  hookEventName: Schema.optional(Schema.String),
  hook_event_name: Schema.optional(Schema.String),
});

const decodeEventName = Schema.decodeUnknownOption(
  Schema.fromJsonString(EventNameSchema)
);

export const hookEventNameOf = (stdinText: string): string | null =>
  Option.match(decodeEventName(stdinText), {
    onNone: () => null,
    onSome: (payload) =>
      boundedField(payload.hook_event_name ?? payload.hookEventName),
  });

export const hookToolOf = (name: string): HarnessId | null =>
  Option.getOrNull(Schema.decodeUnknownOption(HarnessIdSchema)(name));
