import { Option, Schema } from "effect";

import type { CollectCursor } from "../../model/coverage.js";
import { FileCursorSchema } from "../contract.js";
import { CLAUDE_CODE_ADAPTER_ID } from "./events.js";
import type { FileState } from "./scan.js";

const FileStateSchema = Schema.Struct({
  ...FileCursorSchema.fields,
  pending: Schema.Boolean,
  turnId: Schema.NullOr(Schema.String),
});

const SessionCursorSchema = Schema.Struct({
  files: Schema.Array(FileStateSchema),
  ref: Schema.String,
});

const decodeSessionCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionCursorSchema)
);

export const sessionCursorOf = (
  ref: string,
  files: readonly FileState[]
): CollectCursor => ({
  adapterId: CLAUDE_CODE_ADAPTER_ID,
  value: JSON.stringify({
    files: files.map((file) => ({
      mtimeMs: file.mtimeMs,
      offset: file.offset,
      path: file.path,
      pending: file.pending,
      size: file.size,
      turnId: file.turnId,
    })),
    ref,
  }),
});

export const readSessionCursor = (
  cursor: CollectCursor | null,
  ref: string
): ReadonlyMap<string, FileState> => {
  if (cursor === null) {
    return new Map();
  }

  return Option.match(decodeSessionCursor(cursor.value), {
    onNone: () => new Map(),
    onSome: (decoded) =>
      decoded.ref === ref
        ? new Map(decoded.files.map((file) => [file.path, file]))
        : new Map(),
  });
};

export const isUnchanged = (
  state: FileState | undefined,
  mtimeMs: number | null,
  size: number | null
): boolean =>
  state !== undefined &&
  !state.pending &&
  state.mtimeMs !== null &&
  state.mtimeMs === mtimeMs &&
  state.size === size;
