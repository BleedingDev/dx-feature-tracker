import { Option, Schema } from "effect";

import type { CollectCursor } from "../../model/coverage.js";
import type { EventBatch, FlightContext } from "../../model/event.js";
import type { ReadInput, SessionRef } from "../contract.js";
import { isoOf } from "./attribution.js";
import {
  DEEPSEEK_ADAPTER_ID,
  recordEvent,
  sessionStartEvent,
} from "./events.js";
import { FoldStateSchema, foldRows, initialFoldState } from "./fold.js";
import type { FoldRecord } from "./fold.js";
import {
  HeaderSchema,
  decodeHeaderLine,
  decodeRowLine,
  generationOf,
} from "./format.js";
import type { Header, Row } from "./format.js";
import { decodeRawLog, decodeZstdLog } from "./frames.js";
import type { DecodedLog } from "./frames.js";

export const DeepseekCursorSchema = Schema.Struct({
  fold: FoldStateSchema,
  header: HeaderSchema,
  mtimeMs: Schema.NullOr(Schema.Finite),
  offset: Schema.Int,
  path: Schema.String,
  size: Schema.NullOr(Schema.Int),
});

export type DeepseekCursor = typeof DeepseekCursorSchema.Type;

const cursorJson = Schema.fromJsonString(DeepseekCursorSchema);

const decodeCursor = Schema.decodeUnknownOption(cursorJson);

const encodeCursor = Schema.encodeSync(cursorJson);

export const readDeepseekCursor = (
  cursor: CollectCursor | null,
  ref: SessionRef
): DeepseekCursor | null => {
  if (cursor === null || cursor.adapterId !== DEEPSEEK_ADAPTER_ID) {
    return null;
  }

  return Option.match(decodeCursor(cursor.value), {
    onNone: () => null,
    onSome: (decoded) => (decoded.path === ref.path ? decoded : null),
  });
};

const trimmedDir = (dir: string): string => dir.replace(/\/+$/u, "");

export const isInside = (child: string | null, parent: string | null) =>
  child !== null &&
  parent !== null &&
  (trimmedDir(child) === trimmedDir(parent) ||
    trimmedDir(child).startsWith(`${trimmedDir(parent)}/`));

export const sessionContext = (
  given: FlightContext,
  header: Header,
  ref: SessionRef
): FlightContext => {
  const cwd = header.cwd ?? null;

  if (isInside(cwd, given.worktreePath)) {
    return given;
  }

  return {
    branch: null,
    flightId: null,
    headSha: null,
    repoCommonDir: null,
    worktreePath: ref.worktree ?? cwd,
  };
};

export interface ReadOptions {
  readonly bytes: Uint8Array;
  readonly harnessVersion: string | null;
  readonly input: ReadInput;
  readonly ref: SessionRef;
}

const emptyBatch = (
  cursor: CollectCursor | null,
  gaps: readonly string[],
  state: EventBatch["coverage"]["state"]
): EventBatch => ({
  coverage: {
    adapterId: DEEPSEEK_ADAPTER_ID,
    expectedItems: null,
    gaps: gaps.map((message) => ({ code: "deepseek-session", message })),
    observedItems: 0,
    state,
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor,
  events: [],
});

const unchanged = (cursor: DeepseekCursor, ref: SessionRef): boolean =>
  cursor.mtimeMs !== null &&
  cursor.mtimeMs === ref.mtimeMs &&
  cursor.size === ref.size;

const linesOf = (text: string): readonly string[] =>
  text.split("\n").filter((line) => line.trim() !== "");

const rowsOf = (lines: readonly string[]) => {
  const rows: Row[] = [];
  let failures = 0;

  for (const line of lines) {
    const row = Option.getOrNull(decodeRowLine(line));

    if (row === null) {
      failures += 1;
    } else {
      rows.push(row);
    }
  }

  return { failures, rows };
};

const logGaps = (log: DecodedLog, failures: number): readonly string[] => [
  ...(log.torn
    ? [
        "the last Zstandard frame or line is incomplete; it is read once the tool repairs or finishes it",
      ]
    : []),
  ...(log.corrupt
    ? ["a committed Zstandard frame failed to decompress; later frames skipped"]
    : []),
  ...(failures > 0
    ? [`${String(failures)} line(s) were not valid session events`]
    : []),
];

const timeRange = (records: readonly FoldRecord[]) => {
  const times = records.flatMap((record) => {
    const time = record.kind === "turn" ? record.startedAt : record.time;

    return time === null ? [] : [time];
  });

  return times.length === 0
    ? { from: null, to: null }
    : {
        from: isoOf(Math.min(...times)),
        to: isoOf(Math.max(...times)),
      };
};

interface Decoded {
  readonly formatVersion: number | null;
  readonly header: Header | null;
  readonly lines: readonly string[];
  readonly log: DecodedLog;
}

const decodeFrom = (
  bytes: Uint8Array,
  ref: SessionRef,
  resume: DeepseekCursor | null
): Decoded => {
  const generation = generationOf(`p/s/${ref.path.split("/").at(-1) ?? ""}`);
  const compressed = generation?.compressed ?? ref.path.endsWith(".zstd");
  const from = resume?.offset ?? 0;

  const log = compressed
    ? decodeZstdLog(bytes, from)
    : decodeRawLog(bytes, from);

  const lines = linesOf(log.text);
  const [first] = lines;

  const decodedHeader =
    first === undefined ? null : Option.getOrNull(decodeHeaderLine(first));

  return {
    formatVersion: generation?.version ?? null,
    header: resume?.header ?? decodedHeader,
    lines: resume === null ? lines.slice(1) : lines,
    log,
  };
};

const resumable = (
  input: ReadInput,
  ref: SessionRef,
  bytes: Uint8Array
): DeepseekCursor | null => {
  const previous = readDeepseekCursor(input.cursor, ref);

  return previous !== null && previous.offset <= bytes.length ? previous : null;
};

export const readDeepseekSession = (options: ReadOptions): EventBatch => {
  const { bytes, input, ref } = options;
  const previous = readDeepseekCursor(input.cursor, ref);

  if (previous !== null && unchanged(previous, ref)) {
    return emptyBatch(input.cursor, [], "complete");
  }

  const resume = resumable(input, ref, bytes);
  const { formatVersion, header, lines, log } = decodeFrom(bytes, ref, resume);

  if (header === null) {
    return emptyBatch(
      null,
      [...logGaps(log, 0), "the session header did not decode"],
      lines.length === 0 ? "none" : "error"
    );
  }

  const { failures, rows } = rowsOf(lines);
  const start = resume?.fold ?? initialFoldState(header);
  const fold = foldRows(header.id, rows, start);

  const facts = {
    agentType: fold.state.agentType,
    context: sessionContext(input.context, header, ref),
    formatVersion: formatVersion ?? header.version ?? 0,
    harnessVersion: options.harnessVersion,
    header,
    origin: input.origin,
  };

  const events = [
    ...(resume === null ? [sessionStartEvent(facts)] : []),
    ...fold.records.map((record) => recordEvent(facts, record)),
  ];

  const gaps = [...logGaps(log, failures), ...fold.gaps];
  const range = timeRange(fold.records);

  return {
    coverage: {
      adapterId: DEEPSEEK_ADAPTER_ID,
      expectedItems: null,
      gaps: gaps.map((message) => ({ code: "deepseek-session", message })),
      observedItems: events.length,
      state: gaps.length === 0 ? "complete" : "partial",
      watermark: range.to,
      windowFrom: range.from,
      windowTo: range.to,
    },
    cursor: {
      adapterId: DEEPSEEK_ADAPTER_ID,
      value: encodeCursor({
        fold: fold.state,
        header,
        mtimeMs: ref.mtimeMs,
        offset: log.end,
        path: ref.path,
        size: ref.size ?? bytes.length,
      }),
    },
    events,
  };
};
