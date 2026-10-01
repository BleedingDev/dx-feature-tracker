import { Schema } from "effect";

import { titleText } from "../title.js";
import {
  decodeOmpLine,
  serviceTierFor,
  serviceTierOf,
  taskSpawnsOf,
  toolCallsOf,
} from "./format.js";
import type { OmpLine, OmpTaskResult, OmpUsage } from "./format.js";
import { resolveToolPath } from "./paths.js";

const NEWLINE = 0x0a;

const TITLE_SLOT = "title";

const TITLE_CHANGE = "title_change";

export const OmpHeaderSchema = Schema.Struct({
  cwd: Schema.NullOr(Schema.String),
  id: Schema.String,
  parentSession: Schema.NullOr(Schema.String),
  previousSessionFiles: Schema.Array(Schema.String),
  timestamp: Schema.NullOr(Schema.String),
});

export type OmpHeader = typeof OmpHeaderSchema.Type;

export const OmpTurnStartSchema = Schema.Struct({
  at: Schema.NullOr(Schema.String),
  id: Schema.NullOr(Schema.String),
  index: Schema.Int,
  initiator: Schema.NullOr(Schema.String),
});

export type OmpTurnStart = typeof OmpTurnStartSchema.Type;

export const OmpStateSchema = Schema.Struct({
  firstModel: Schema.NullOr(Schema.String),
  header: Schema.NullOr(OmpHeaderSchema),
  model: Schema.NullOr(Schema.String),
  modelRole: Schema.NullOr(Schema.String),
  serviceTier: Schema.NullOr(
    Schema.Union([
      Schema.String,
      Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
    ])
  ),
  thinkingConfigured: Schema.NullOr(Schema.String),
  thinkingLevel: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  turn: OmpTurnStartSchema,
});

export type OmpState = typeof OmpStateSchema.Type;

export const initialOmpState: OmpState = {
  firstModel: null,
  header: null,
  model: null,
  modelRole: null,
  serviceTier: null,
  thinkingConfigured: null,
  thinkingLevel: null,
  title: null,
  turn: { at: null, id: null, index: 0, initiator: null },
};

export interface OmpRequest {
  readonly api: string | null;
  readonly cwd: string | null;
  readonly durationMs: number | null;
  readonly effort: string | null;
  readonly effortConfigured: string | null;
  readonly entryId: string;
  readonly errorStatus: number | null;
  readonly lineStart: number;
  readonly model: string | null;
  readonly modelRole: string | null;
  readonly provider: string | null;
  readonly responseId: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: string | null;
  readonly sessionId: string | null;
  readonly stopReason: string | null;
  readonly timestamp: string | null;
  readonly toolNames: readonly string[];
  readonly toolPaths: readonly string[];
  readonly ttftMs: number | null;
  readonly turn: OmpTurnStart;
  readonly usage: OmpUsage | null;
}

export interface OmpTurn {
  readonly lineStart: number;
  readonly sessionId: string | null;
  readonly start: OmpTurnStart;
  readonly stateAtStart: OmpState;
}

export interface OmpSessionInit {
  readonly agent: string | null;
  readonly modelRole: string | null;
}

export interface ParsedOmpSession {
  readonly cursorOffset: number;
  readonly cursorState: OmpState;
  readonly duplicateEntries: number;
  readonly endOffset: number;
  readonly header: OmpHeader | null;
  readonly invalidLines: number;
  readonly requests: readonly OmpRequest[];
  readonly sessionInit: OmpSessionInit | null;
  readonly slotTitle: string | null;
  readonly spawns: readonly OmpTaskResult[];
  readonly startOffset: number;
  readonly state: OmpState;
  readonly turns: readonly OmpTurn[];
  readonly unrecognizedLines: number;
}

export interface OmpResume {
  readonly offset: number;
  readonly state: OmpState;
}

interface RawLine {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

const decoder = new TextDecoder();

export const completeLines = (
  bytes: Uint8Array,
  from: number
): readonly RawLine[] => {
  const lines: RawLine[] = [];
  let start = from;

  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);

    if (newline === -1) {
      break;
    }

    const text = decoder.decode(bytes.subarray(start, newline)).trim();

    if (text !== "") {
      lines.push({ end: newline + 1, start, text });
    }

    start = newline + 1;
  }

  return lines;
};

export const completeEnd = (bytes: Uint8Array): number =>
  bytes.lastIndexOf(NEWLINE) + 1;

const nonEmpty = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

const headerOf = (line: OmpLine): OmpHeader | null => {
  const id = nonEmpty(line.id);

  return id === null
    ? null
    : {
        cwd: nonEmpty(line.cwd),
        id,
        parentSession: nonEmpty(line.parentSession),
        previousSessionFiles: line.previousSessionFiles ?? [],
        timestamp: nonEmpty(line.timestamp),
      };
};

export const slotTitleOf = (bytes: Uint8Array): string | null => {
  const [first] = completeLines(
    bytes.subarray(0, Math.min(bytes.length, 4096)),
    0
  );

  if (first === undefined) {
    return null;
  }

  const decoded = decodeOmpLine(first.text);

  return decoded.state === "ok" && decoded.line.type === TITLE_SLOT
    ? titleText(decoded.line.title)
    : null;
};

const usageTotal = (usage: OmpUsage | null): number =>
  usage === null
    ? 0
    : (usage.totalTokens ??
      (usage.input ?? 0) +
        (usage.output ?? 0) +
        (usage.cacheRead ?? 0) +
        (usage.cacheWrite ?? 0));

const mergeSpawns = (
  results: readonly OmpTaskResult[],
  progress: readonly OmpTaskResult[]
): readonly OmpTaskResult[] => {
  const byId = new Map<string, OmpTaskResult>();

  for (const spawn of progress) {
    byId.set(spawn.id, spawn);
  }

  for (const spawn of results) {
    byId.set(spawn.id, { ...byId.get(spawn.id), ...spawn });
  }

  return [...byId.values()];
};

interface Fold {
  duplicates: number;
  invalid: number;
  readonly keys: Map<string, number>;
  readonly requests: OmpRequest[];
  sessionInit: OmpSessionInit | null;
  readonly spawnProgress: OmpTaskResult[];
  readonly spawnResults: OmpTaskResult[];
  state: OmpState;
  readonly turns: OmpTurn[];
  unrecognized: number;
}

const currentTurn = (fold: Fold): OmpTurn | undefined => fold.turns.at(-1);

const recordRequest = (fold: Fold, line: OmpLine, raw: RawLine): void => {
  const { message } = line;
  const entryId = nonEmpty(line.id);

  if (message === undefined || entryId === null) {
    return;
  }

  const { state } = fold;
  const sessionId = state.header?.id ?? null;
  const tools = toolCallsOf(message);
  const provider = nonEmpty(message.provider);
  const model = nonEmpty(message.model);

  const request: OmpRequest = {
    api: nonEmpty(message.api),
    cwd: state.header?.cwd ?? null,
    durationMs: message.duration ?? null,
    effort: state.thinkingLevel,
    effortConfigured: state.thinkingConfigured,
    entryId,
    errorStatus: message.errorStatus ?? null,
    lineStart: raw.start,
    model,
    modelRole: state.modelRole,
    provider,
    responseId: nonEmpty(message.responseId),
    selectedModel: state.model,
    serviceTier: serviceTierFor(state.serviceTier, nonEmpty(message.api)),
    sessionId,
    stopReason: nonEmpty(message.stopReason),
    timestamp: nonEmpty(line.timestamp),
    toolNames: tools.names,
    toolPaths: tools.paths.flatMap((target) => {
      const resolved = resolveToolPath(state.header?.cwd ?? null, target);

      return resolved === null ? [] : [resolved];
    }),
    ttftMs: message.ttft ?? null,
    turn: state.turn,
    usage: message.usage ?? null,
  };

  const key = `${sessionId ?? "-"}:${entryId}`;
  const existing = fold.keys.get(key);

  if (existing === undefined) {
    fold.keys.set(key, fold.requests.length);
    fold.requests.push(request);
  } else {
    fold.duplicates += 1;
    const previous = fold.requests[existing];

    if (
      previous !== undefined &&
      usageTotal(request.usage) >= usageTotal(previous.usage)
    ) {
      fold.requests[existing] = request;
    }
  }

  if (fold.state.firstModel === null && model !== null) {
    fold.state = {
      ...fold.state,
      firstModel: provider === null ? model : `${provider}/${model}`,
    };
  }
};

const startTurn = (fold: Fold, line: OmpLine, raw: RawLine): void => {
  const before = fold.state;

  const start: OmpTurnStart = {
    at: nonEmpty(line.timestamp),
    id: nonEmpty(line.id),
    index: fold.state.turn.index + 1,
    initiator: nonEmpty(line.message?.attribution),
  };

  fold.state = { ...fold.state, turn: start };
  fold.turns.push({
    lineStart: raw.start,
    sessionId: fold.state.header?.id ?? null,
    start,
    stateAtStart: before,
  });
};

const applyMessage = (fold: Fold, line: OmpLine, raw: RawLine): void => {
  const { message } = line;

  if (message === undefined) {
    return;
  }

  if (message.role === "user") {
    startTurn(fold, line, raw);

    return;
  }

  if (message.role === "assistant") {
    recordRequest(fold, line, raw);

    return;
  }

  if (message.role === "toolResult" && message.toolName === "task") {
    const spawns = taskSpawnsOf(message);

    fold.spawnResults.push(...spawns.results);
    fold.spawnProgress.push(...spawns.progress);
  }
};

const nextState = (state: OmpState, line: OmpLine): OmpState => {
  switch (line.type) {
    case "session": {
      const header = headerOf(line);

      return header === null || state.header?.id === header.id
        ? state
        : { ...state, header, title: titleText(line.title) ?? state.title };
    }

    case "model_change": {
      return {
        ...state,
        model: nonEmpty(line.model),
        modelRole: nonEmpty(line.role),
      };
    }

    case "thinking_level_change": {
      return {
        ...state,
        thinkingConfigured: nonEmpty(line.configured),
        thinkingLevel: nonEmpty(line.thinkingLevel),
      };
    }

    case "service_tier_change": {
      return { ...state, serviceTier: serviceTierOf(line) };
    }

    case TITLE_CHANGE: {
      return { ...state, title: titleText(line.title) };
    }

    default: {
      return state;
    }
  }
};

const applyLine = (fold: Fold, line: OmpLine, raw: RawLine): void => {
  fold.state = nextState(fold.state, line);

  if (line.type === "session_init") {
    fold.sessionInit = {
      agent: nonEmpty(line.agent),
      modelRole: nonEmpty(line.modelRole),
    };
  }

  if (line.type === "message") {
    applyMessage(fold, line, raw);
  }
};

export const parseOmpSession = (
  bytes: Uint8Array,
  resume: OmpResume | null = null
): ParsedOmpSession => {
  const startOffset = resume?.offset ?? 0;

  const fold: Fold = {
    duplicates: 0,
    invalid: 0,
    keys: new Map(),
    requests: [],
    sessionInit: null,
    spawnProgress: [],
    spawnResults: [],
    state: resume?.state ?? initialOmpState,
    turns: [],
    unrecognized: 0,
  };

  const initial = fold.state;

  for (const raw of completeLines(bytes, startOffset)) {
    const decoded = decodeOmpLine(raw.text);

    if (decoded.state === "invalid") {
      fold.invalid += 1;
    } else if (decoded.state === "unrecognized") {
      fold.unrecognized += 1;
    } else {
      applyLine(fold, decoded.line, raw);
    }
  }

  const lastTurn = currentTurn(fold);
  const endOffset = Math.max(startOffset, completeEnd(bytes));

  return {
    cursorOffset: lastTurn?.lineStart ?? startOffset,
    cursorState: lastTurn?.stateAtStart ?? initial,
    duplicateEntries: fold.duplicates,
    endOffset,
    header: fold.state.header,
    invalidLines: fold.invalid,
    requests: fold.requests,
    sessionInit: fold.sessionInit,
    slotTitle: slotTitleOf(bytes),
    spawns: mergeSpawns(fold.spawnResults, fold.spawnProgress),
    startOffset,
    state: fold.state,
    turns: fold.turns,
    unrecognizedLines: fold.unrecognized,
  };
};

export const headerFromHead = (bytes: Uint8Array): OmpHeader | null => {
  for (const raw of completeLines(bytes, 0)) {
    const decoded = decodeOmpLine(raw.text);

    if (decoded.state === "ok" && decoded.line.type === "session") {
      return headerOf(decoded.line);
    }

    if (decoded.state === "ok" && decoded.line.type !== TITLE_SLOT) {
      return null;
    }
  }

  return null;
};

export const requestTokenTotal = (request: OmpRequest): number =>
  usageTotal(request.usage);
