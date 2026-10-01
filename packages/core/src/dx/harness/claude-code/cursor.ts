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
  pointsIn: Schema.optional(Schema.Boolean),
  ref: Schema.String,
});

const decodeSessionCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionCursorSchema)
);

export interface SessionCursor {
  readonly files: ReadonlyMap<string, FileState>;
  readonly pointsIn: boolean | null;
}

const NO_CURSOR: SessionCursor = { files: new Map(), pointsIn: null };

export const sessionCursorOf = (
  ref: string,
  files: readonly FileState[],
  pointsIn: boolean
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
    pointsIn,
    ref,
  }),
});

export const readSessionCursor = (
  cursor: CollectCursor | null,
  ref: string
): SessionCursor => {
  if (cursor === null) {
    return NO_CURSOR;
  }

  return Option.match(decodeSessionCursor(cursor.value), {
    onNone: () => NO_CURSOR,
    onSome: (decoded) =>
      decoded.ref === ref
        ? {
            files: new Map(decoded.files.map((file) => [file.path, file])),
            pointsIn: decoded.pointsIn ?? null,
          }
        : NO_CURSOR,
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
