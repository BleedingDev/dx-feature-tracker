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

const firstToken = (command: string): string | null => {
  const token = command.trim().split(/\s+/u)[0] ?? "";

  if (token === "") {
    return null;
  }

  return token.split("/").at(-1) ?? null;
};

const orNull = <A>(value: A | null | undefined): A | null => value ?? null;

const commandFields = (raw: RawHookPayload) => {
  const command = raw.command ?? raw.tool_input?.command ?? null;

  return {
    commandBin: command === null ? null : firstToken(command),
    commandHash: command === null ? null : sha256Hex(command),
  };
};

const editFields = (raw: RawHookPayload) => {
  const edits = raw.edits ?? null;

  return {
    editCount: edits === null ? null : edits.length,
    filePath: raw.file_path ?? raw.tool_input?.file_path ?? null,
    linesAdded:
      edits === null ? null : sumLines(edits, (edit) => edit.new_string),
    linesRemoved:
      edits === null ? null : sumLines(edits, (edit) => edit.old_string),
  };
};

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
    ...outcomeFields(raw),
    ...sizeFields(raw),
    presentKeys: Object.keys(source).toSorted(),
    rawUsage: extractRawUsage(source),
  };
};
