import { Option, Schema } from "effect";

import type { CollectCursor } from "../../model/coverage.js";
import type { SessionRef } from "../contract.js";
import { OMP_ADAPTER_ID } from "./events.js";
import { decodeOmpLine } from "./format.js";
import { OmpStateSchema, completeLines, headerFromHead } from "./parse.js";
import type { OmpResume, ParsedOmpSession } from "./parse.js";

export const OmpCursorSchema = Schema.Struct({
  agentType: Schema.NullOr(Schema.String),
  anchor: Schema.NullOr(Schema.String),
  mtimeMs: Schema.NullOr(Schema.Finite),
  offset: Schema.Int,
  path: Schema.String,
  size: Schema.NullOr(Schema.Int),
  state: OmpStateSchema,
  worktree: Schema.NullOr(Schema.String),
});

export type OmpCursor = typeof OmpCursorSchema.Type;

const decodeCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(OmpCursorSchema)
);

export const readOmpCursor = (
  cursor: CollectCursor | null,
  ref: SessionRef
): OmpCursor | null => {
  if (cursor === null || cursor.adapterId !== OMP_ADAPTER_ID) {
    return null;
  }

  return Option.match(decodeCursor(cursor.value), {
    onNone: () => null,
    onSome: (decoded) =>
      decoded.path === ref.path && decoded.worktree === ref.worktree
        ? decoded
        : null,
  });
};

export const ompCursorUnchanged = (
  cursor: OmpCursor | null,
  ref: SessionRef
): boolean =>
  cursor !== null &&
  cursor.mtimeMs !== null &&
  cursor.size !== null &&
  cursor.mtimeMs === ref.mtimeMs &&
  cursor.size === ref.size;

const anchorAt = (bytes: Uint8Array, offset: number): string | null => {
  const [line] = completeLines(bytes, offset);

  if (line?.start !== offset) {
    return null;
  }

  const decoded = decodeOmpLine(line.text);

  return decoded.state === "ok" && decoded.line.message?.role === "user"
    ? (decoded.line.id ?? null)
    : null;
};

export const resumeFrom = (
  cursor: OmpCursor | null,
  bytes: Uint8Array
): OmpResume | null => {
  if (
    cursor === null ||
    cursor.offset <= 0 ||
    cursor.offset > bytes.length ||
    cursor.anchor === null ||
    cursor.state.header === null
  ) {
    return null;
  }

  const header = headerFromHead(
    bytes.subarray(0, Math.min(bytes.length, 65_536))
  );

  return header?.id === cursor.state.header.id &&
    anchorAt(bytes, cursor.offset) === cursor.anchor
    ? { offset: cursor.offset, state: cursor.state }
    : null;
};

export const ompCursorOf = (
  ref: SessionRef,
  parsed: ParsedOmpSession,
  agentType: string | null
): CollectCursor => {
  const anchor =
    parsed.cursorOffset > 0
      ? (parsed.turns.find((turn) => turn.lineStart === parsed.cursorOffset)
          ?.start.id ?? null)
      : null;

  const cursor: OmpCursor = {
    agentType,
    anchor,
    mtimeMs: ref.mtimeMs,
    offset: anchor === null ? 0 : parsed.cursorOffset,
    path: ref.path,
    size: ref.size,
    state: anchor === null ? parsed.state : parsed.cursorState,
    worktree: ref.worktree,
  };

  return { adapterId: OMP_ADAPTER_ID, value: JSON.stringify(cursor) };
};
