import { Schema } from "effect";

const OptionalString = Schema.optionalKey(Schema.NullOr(Schema.String));

const OptionalNumber = Schema.optionalKey(Schema.NullOr(Schema.Finite));

const OptionalBoolean = Schema.optionalKey(Schema.NullOr(Schema.Boolean));

const OptionalAny = Schema.optionalKey(Schema.Unknown);

export const RawEditSchema = Schema.Struct({
  new_string: OptionalString,
  old_string: OptionalString,
});

export type RawEdit = typeof RawEditSchema.Type;

export const RawToolInputSchema = Schema.Struct({
  command: OptionalString,
  cwd: OptionalAny,
  file_path: OptionalString,
  path: OptionalAny,
  working_directory: OptionalAny,
});

export type RawToolInput = typeof RawToolInputSchema.Type;

export const RawHookPayloadSchema = Schema.Struct({
  attachments: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  child_conversation_id: OptionalAny,
  command: OptionalString,
  composer_mode: OptionalString,
  conversation_id: OptionalString,
  cursor_version: OptionalString,
  cwd: OptionalAny,
  duration: OptionalNumber,
  duration_ms: OptionalNumber,
  edits: Schema.optionalKey(Schema.Array(RawEditSchema)),
  file_path: OptionalString,
  final_status: OptionalString,
  generation_id: OptionalString,
  git_branch: OptionalAny,
  hook_event_name: Schema.String,
  is_background_agent: OptionalBoolean,
  loop_count: OptionalNumber,
  model: OptionalString,
  modified_files: OptionalAny,
  parent_conversation_id: OptionalAny,
  parent_tool_call_id: OptionalAny,
  prompt: OptionalString,
  reason: OptionalString,
  session_id: OptionalString,
  status: OptionalString,
  subagent_id: OptionalAny,
  subagent_model: OptionalAny,
  subagent_type: OptionalAny,
  tool_call_id: OptionalAny,
  tool_input: Schema.optionalKey(Schema.NullOr(RawToolInputSchema)),
  tool_name: OptionalString,
  tool_use_id: OptionalString,
  workspace_roots: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type RawHookPayload = typeof RawHookPayloadSchema.Type;

export const RawObjectSchema = Schema.Record(Schema.String, Schema.Unknown);

export type RawObject = typeof RawObjectSchema.Type;
