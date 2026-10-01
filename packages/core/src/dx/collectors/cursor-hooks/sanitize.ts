// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs and record hashes are the contract's synchronous sha256; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { Option, Predicate, Schema } from "effect";

import type { RawEdit, RawHookPayload, RawObject } from "./raw-payload.js";
import { RawHookPayloadSchema, RawObjectSchema } from "./raw-payload.js";
import type { RawUsageEntry, SanitizedHook } from "./spool-record.js";

const USAGE_KEY = /token|usage|cost|cache|credit|price|spend/iu;

const MAX_USAGE_ENTRIES = 32;

const MAX_USAGE_DEPTH = 3;

const MAX_ROOTS = 8;

const MAX_MODIFIED_FILES = 16;

const decodeObject = Schema.decodeUnknownOption(RawObjectSchema);

const decodePayload = Schema.decodeUnknownOption(RawHookPayloadSchema);

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const countLines = (text: string | null | undefined): number =>
  text === null || text === undefined || text === ""
    ? 0
    : text.split("\n").length;

const sumLines = (
  edits: readonly RawEdit[],
  pick: (edit: RawEdit) => string | null | undefined
): number => {
  let total = 0;

  for (const edit of edits) {
    total += countLines(pick(edit));
  }

  return total;
};

const collectUsage = (
  source: RawObject,
  prefix: string,
  depth: number,
  out: RawUsageEntry[]
): void => {
  for (const key of Object.keys(source).toSorted()) {
    if (out.length >= MAX_USAGE_ENTRIES) {
      return;
    }

    const value = source[key];
    const path = prefix === "" ? key : `${prefix}.${key}`;

    if (Predicate.isNumber(value) && Number.isFinite(value)) {
      if (USAGE_KEY.test(path)) {
        out.push({ path, value });
      }
    } else if (depth < MAX_USAGE_DEPTH) {
      const nested = decodeObject(value);

      if (Option.isSome(nested)) {
        collectUsage(nested.value, path, depth + 1, out);
      }
    }
  }
};

export const extractRawUsage = (source: RawObject): RawUsageEntry[] => {
  const out: RawUsageEntry[] = [];

  collectUsage(source, "", 0, out);

  return out;
};

const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/u;

const BINARY_NAME = /^[\w.+-]+$/u;

const COMMAND_WRAPPERS = new Set([
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
]);

const shellWords = (command: string): readonly string[] => {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;

  for (const char of command) {
    if (quote !== null) {
      quote = char === quote ? null : quote;
      word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word += char;
    } else if (/\s/u.test(char)) {
      if (word !== "") {
        words.push(word);
      }

      word = "";
    } else {
      word += char;
    }
  }

  return word === "" ? words : [...words, word];
};

const commandBinary = (command: string): string | null => {
  for (const word of shellWords(command)) {
    const name = word.split("/").at(-1) ?? "";

    if (
      !ENV_ASSIGNMENT.test(word) &&
      !word.startsWith("-") &&
      !COMMAND_WRAPPERS.has(name)
    ) {
      return BINARY_NAME.test(name) ? name : null;
    }
  }

  return null;
};

const orNull = <A>(value: A | null | undefined): A | null => value ?? null;

const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString);

const decodeTexts = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const commandFields = (raw: RawHookPayload) => {
  const command = raw.command ?? raw.tool_input?.command ?? null;

  return {
    commandBin: command === null ? null : commandBinary(command),
    commandHash: command === null ? null : sha256Hex(command),
  };
};

const editFields = (raw: RawHookPayload) => {
  const edits = raw.edits ?? null;

  return {
    editCount: edits === null ? null : edits.length,
    filePath:
      raw.file_path ??
      raw.tool_input?.file_path ??
      Option.getOrNull(decodeText(raw.tool_input?.path)),
    linesAdded:
      edits === null ? null : sumLines(edits, (edit) => edit.new_string),
    linesRemoved:
      edits === null ? null : sumLines(edits, (edit) => edit.old_string),
  };
};

const locationFields = (raw: RawHookPayload) => ({
  cwd:
    Option.getOrNull(decodeText(raw.cwd)) ??
    Option.getOrNull(decodeText(raw.tool_input?.cwd)) ??
    Option.getOrNull(decodeText(raw.tool_input?.working_directory)),
  modifiedFiles: Option.getOrElse(decodeTexts(raw.modified_files), () => [])
    .flatMap((item) =>
      Option.match(decodeText(item), {
        onNone: () => [],
        onSome: (text) => [text],
      })
    )
    .slice(0, MAX_MODIFIED_FILES),
  reportedBranch: Option.getOrNull(decodeText(raw.git_branch)),
});

const subagentFields = (raw: RawHookPayload) => ({
  childConversationId: Option.getOrNull(decodeText(raw.child_conversation_id)),
  parentConversationId: Option.getOrNull(
    decodeText(raw.parent_conversation_id)
  ),
  parentToolCallId: Option.getOrNull(decodeText(raw.parent_tool_call_id)),
  subagentId: Option.getOrNull(decodeText(raw.subagent_id)),
  subagentModel: Option.getOrNull(decodeText(raw.subagent_model)),
  subagentType: Option.getOrNull(decodeText(raw.subagent_type)),
  toolCallId: Option.getOrNull(decodeText(raw.tool_call_id)),
});

const identityFields = (raw: RawHookPayload) => ({
  composerMode: orNull(raw.composer_mode),
  conversationId: orNull(raw.conversation_id),
  cursorVersion: orNull(raw.cursor_version),
  generationId: orNull(raw.generation_id),
  hookEvent: raw.hook_event_name,
  model: orNull(raw.model),
  sessionId: orNull(raw.session_id),
  toolName: orNull(raw.tool_name),
  toolUseId: orNull(raw.tool_use_id),
});

const outcomeFields = (raw: RawHookPayload) => ({
  durationMs: raw.duration_ms ?? raw.duration ?? null,
  finalStatus: orNull(raw.final_status),
  isBackgroundAgent: orNull(raw.is_background_agent),
  loopCount: orNull(raw.loop_count),
  reason: orNull(raw.reason),
  status: orNull(raw.status),
});

const sizeFields = (raw: RawHookPayload) => ({
  attachmentCount:
    raw.attachments === undefined ? null : raw.attachments.length,
  promptChars: orNull(raw.prompt?.length),
  workspaceRoots: (raw.workspace_roots ?? []).slice(0, MAX_ROOTS),
});

export const sanitizeHookPayload = (
  source: RawObject
): SanitizedHook | null => {
  const payload = decodePayload(source);

  if (Option.isNone(payload)) {
    return null;
  }

  const raw = payload.value;

  return {
    ...commandFields(raw),
    ...editFields(raw),
    ...identityFields(raw),
    ...locationFields(raw),
    ...outcomeFields(raw),
    ...subagentFields(raw),
    ...sizeFields(raw),
    presentKeys: Object.keys(source).toSorted(),
    rawUsage: extractRawUsage(source),
  };
};
