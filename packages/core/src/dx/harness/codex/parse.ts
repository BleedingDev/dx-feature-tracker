import { DateTime, Effect, Option, Schema } from "effect";

import { promptDigest } from "../title.js";
import {
  CodexHeadSchema,
  headOfMeta,
  replaysParentHistory,
  startsOwnHistory,
} from "./head.js";
import type { CodexHead } from "./head.js";
import {
  SNIFF_CHARS,
  TOOL_CALL_TYPES,
  decodeMetaLine,
  decodeResponseMessageLine,
  decodeTaskCompleteLine,
  decodeTaskStartedLine,
  decodeThreadSettingsLine,
  decodeTokenCountLine,
  decodeTurnAbortedLine,
  decodeTurnContextLine,
  decodeUsageRecordLine,
  decodeUserMessageLine,
  errorKindOf,
  isContentText,
  lineKindOf,
  sniffLine,
} from "./records.js";
import type { CodexUsage, LineKind } from "./records.js";
import { ToolTouchSchema, toolCallFacts } from "./tools.js";
import type { ToolTouch } from "./tools.js";

const Text = Schema.NullOr(Schema.String);

export const TurnFactsSchema = Schema.Struct({
  cwd: Text,
  effort: Text,
  model: Text,
  providerId: Text,
  serviceTier: Text,
});

export type TurnFacts = typeof TurnFactsSchema.Type;

export const OpenTurnSchema = Schema.Struct({
  facts: TurnFactsSchema,
  requests: Schema.Int,
  startedAt: Text,
  toolCalls: Schema.Int,
  turnId: Schema.String,
});

export type OpenTurn = typeof OpenTurnSchema.Type;

export const ScanStateSchema = Schema.Struct({
  calls: Schema.Array(ToolTouchSchema),
  current: Text,
  facts: TurnFactsSchema,
  head: Schema.NullOr(CodexHeadSchema),
  lastTotal: Schema.NullOr(Schema.Finite),
  openTurns: Schema.Array(OpenTurnSchema),
  prompts: Schema.NullOr(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  replaying: Schema.Boolean,
  sawRecord: Schema.Boolean,
  settings: TurnFactsSchema,
  toolCalls: Schema.Int,
  webSearches: Schema.Int,
});

export type ScanState = typeof ScanStateSchema.Type;

export type TurnStatus = "completed" | "failed" | "aborted" | "unfinished";

export interface EndedTurn extends OpenTurn {
  readonly abortReason: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly errorKind: string | null;
  readonly status: TurnStatus;
}

export type UsageSource = "token_usage_record" | "token_count";

export interface CodexRequest {
  readonly calls: readonly ToolTouch[];
  readonly facts: TurnFacts;
  readonly key: string;
  readonly occurredAt: string | null;
  readonly ordinal: number | null;
  readonly responseId: string | null;
  readonly source: UsageSource;
  readonly toolCalls: number;
  readonly turnId: string | null;
  readonly usage: CodexUsage;
  readonly webSearches: number;
}

export interface ScanCounts {
  readonly duplicateRecords: number;
  readonly emptyRecords: number;
  readonly foreignRecords: number;
  readonly malformedLines: number;
  readonly repeatedEmissions: number;
  readonly replayedEmissions: number;
}

export interface ScanResult {
  readonly consumed: number;
  readonly counts: ScanCounts;
  readonly endedTurns: readonly EndedTurn[];
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
  readonly requests: readonly CodexRequest[];
  readonly state: ScanState;
}

const noFacts: TurnFacts = {
  cwd: null,
  effort: null,
  model: null,
  providerId: null,
  serviceTier: null,
};

export const initialScanState: ScanState = {
  calls: [],
  current: null,
  facts: noFacts,
  head: null,
  lastTotal: null,
  openTurns: [],
  prompts: [],
  replaying: false,
  sawRecord: false,
  settings: noFacts,
  toolCalls: 0,
  webSearches: 0,
};

interface MutableTurn {
  facts: TurnFacts;
  requests: number;
  readonly startedAt: string | null;
  toolCalls: number;
  readonly turnId: string;
}

interface Scan {
  calls: ToolTouch[];
  current: string | null;
  duplicateRecords: number;
  emptyRecords: number;
  readonly ended: EndedTurn[];
  readonly endedIds: Set<string>;
  facts: TurnFacts;
  firstTimestamp: string | null;
  foreignRecords: number;
  head: CodexHead | null;
  lastTimestamp: string | null;
  lastTotal: number | null;
  malformedLines: number;
  readonly open: Map<string, MutableTurn>;
  readonly prompts: string[] | null;
  repeatedEmissions: number;
  replayedEmissions: number;
  replaying: boolean;
  readonly requests: CodexRequest[];
  sawRecord: boolean;
  readonly seenEmissions: Set<string>;
  readonly seenResponses: Set<string>;
  settings: TurnFacts;
  toolCalls: number;
  webSearches: number;
}

interface LineRef {
  readonly ordinal: number | null;
  readonly text: string;
  readonly timestamp: string | null;
}

const present = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === "" ? null : value;

const secondsToIso = (seconds: number | null | undefined): string | null =>
  seconds === null || seconds === undefined
    ? null
    : DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

const seen = (scan: Scan, timestamp: string | null) => {
  if (timestamp === null) {
    return;
  }

  if (scan.firstTimestamp === null || timestamp < scan.firstTimestamp) {
    scan.firstTimestamp = timestamp;
  }

  if (scan.lastTimestamp === null || timestamp > scan.lastTimestamp) {
    scan.lastTimestamp = timestamp;
  }
};

const endTurn = (
  scan: Scan,
  turn: MutableTurn,
  end: Omit<EndedTurn, keyof OpenTurn>
) => {
  scan.open.delete(turn.turnId);
  scan.endedIds.add(turn.turnId);
  scan.ended.push({
    ...end,
    facts: turn.facts,
    requests: turn.requests,
    startedAt: turn.startedAt,
    toolCalls: turn.toolCalls,
    turnId: turn.turnId,
  });
};

const supersede = (scan: Scan, keep: string) => {
  for (const turn of scan.open.values()) {
    if (turn.turnId !== keep) {
      endTurn(scan, turn, {
        abortReason: null,
        completedAt: null,
        durationMs: null,
        errorKind: null,
        status: "unfinished",
      });
    }
  }
};

const openTurn = (
  scan: Scan,
  turnId: string,
  startedAt: string | null
): MutableTurn | null => {
  if (scan.endedIds.has(turnId)) {
    return null;
  }

  const existing = scan.open.get(turnId);

  if (existing !== undefined) {
    return existing;
  }

  const created: MutableTurn = {
    facts: {
      cwd: scan.facts.cwd ?? scan.head?.cwd ?? null,
      effort: scan.settings.effort ?? scan.facts.effort,
      model: scan.settings.model ?? scan.facts.model,
      providerId: scan.settings.providerId,
      serviceTier: scan.settings.serviceTier,
    },
    requests: 0,
    startedAt,
    toolCalls: 0,
    turnId,
  };

  scan.open.set(turnId, created);

  return created;
};

const enterTurn = (scan: Scan, turnId: string) => {
  scan.current = turnId;

  if (
    scan.replaying &&
    scan.head !== null &&
    startsOwnHistory(scan.head, turnId)
  ) {
    scan.replaying = false;
  }
};

const onSessionMeta = (scan: Scan, line: LineRef) => {
  if (scan.head !== null) {
    return;
  }

  const decoded = decodeMetaLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const head = headOfMeta(decoded.value.payload, line.timestamp);

  scan.head = head;
  scan.replaying = replaysParentHistory(head);
  scan.settings = { ...scan.settings, providerId: head.providerId };
  scan.facts = { ...scan.facts, cwd: head.cwd, providerId: head.providerId };
};

const onThreadSettings = (scan: Scan, line: LineRef) => {
  const decoded = decodeThreadSettingsLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const { thread_id: threadId, thread_settings: settings } =
    decoded.value.payload;

  if (
    present(threadId) !== null &&
    scan.head !== null &&
    threadId !== scan.head.threadId
  ) {
    return;
  }

  scan.settings = {
    cwd: present(settings.cwd) ?? scan.settings.cwd,
    effort: present(settings.reasoning_effort) ?? scan.settings.effort,
    model: present(settings.model) ?? scan.settings.model,
    providerId: present(settings.model_provider_id) ?? scan.settings.providerId,
    serviceTier: present(settings.service_tier) ?? scan.settings.serviceTier,
  };
};

const onTurnContext = (scan: Scan, line: LineRef) => {
  const decoded = decodeTurnContextLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const context = decoded.value.payload;
  const turnId = present(context.turn_id) ?? scan.current;

  if (turnId === null) {
    return;
  }

  enterTurn(scan, turnId);

  if (scan.replaying) {
    return;
  }

  const facts: TurnFacts = {
    cwd: present(context.cwd) ?? scan.facts.cwd,
    effort:
      present(context.effort) ??
      present(context.collaboration_mode?.settings?.reasoning_effort) ??
      scan.settings.effort ??
      scan.facts.effort,
    model: present(context.model) ?? scan.settings.model ?? scan.facts.model,
    providerId: scan.settings.providerId,
    serviceTier: scan.settings.serviceTier,
  };

  scan.facts = facts;

  const turn = openTurn(scan, turnId, line.timestamp);

  if (turn !== null) {
    turn.facts = facts;
  }
};

const onTaskStarted = (scan: Scan, line: LineRef) => {
  const decoded = decodeTaskStartedLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const { payload } = decoded.value;
  const turnId = present(payload.turn_id);

  if (turnId === null) {
    return;
  }

  enterTurn(scan, turnId);

  if (scan.replaying) {
    return;
  }

  supersede(scan, turnId);
  scan.calls = [];
  scan.toolCalls = 0;
  scan.webSearches = 0;
  openTurn(scan, turnId, secondsToIso(payload.started_at) ?? line.timestamp);
};

const onTaskEnd = (
  scan: Scan,
  turnId: string | null,
  end: Omit<EndedTurn, keyof OpenTurn>
) => {
  if (turnId === null || scan.replaying) {
    return;
  }

  const turn = scan.open.get(turnId);

  if (turn !== undefined) {
    endTurn(scan, turn, end);
  }
};

const onTaskComplete = (scan: Scan, line: LineRef) => {
  const decoded = decodeTaskCompleteLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const { payload } = decoded.value;
  const errorKind = errorKindOf(payload.error?.codex_error_info);
  const failed = payload.error !== null && payload.error !== undefined;

  onTaskEnd(scan, present(payload.turn_id), {
    abortReason: null,
    completedAt: secondsToIso(payload.completed_at) ?? line.timestamp,
    durationMs: payload.duration_ms ?? null,
    errorKind: failed ? (errorKind ?? "error") : null,
    status: failed ? "failed" : "completed",
  });
};

const onTurnAborted = (scan: Scan, line: LineRef) => {
  const decoded = decodeTurnAbortedLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const { payload } = decoded.value;

  onTaskEnd(scan, present(payload.turn_id) ?? scan.current, {
    abortReason: present(payload.reason),
    completedAt: line.timestamp,
    durationMs: null,
    errorKind: null,
    status: "aborted",
  });
};

const factsFor = (scan: Scan, turnId: string | null): TurnFacts => {
  const turn = turnId === null ? undefined : scan.open.get(turnId);

  return turn?.facts ?? scan.facts;
};

type RequestFields = Omit<
  CodexRequest,
  "calls" | "facts" | "toolCalls" | "webSearches"
>;

const pushRequest = (scan: Scan, request: RequestFields) => {
  const turn =
    request.turnId === null ? undefined : scan.open.get(request.turnId);

  if (turn !== undefined) {
    turn.requests += 1;
  }

  scan.requests.push({
    ...request,
    calls: scan.calls,
    facts: factsFor(scan, request.turnId),
    toolCalls: scan.toolCalls,
    webSearches: scan.webSearches,
  });
  scan.calls = [];
  scan.toolCalls = 0;
  scan.webSearches = 0;
};

const spent = (usage: CodexUsage): number =>
  (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

const onUsageRecord = (scan: Scan, line: LineRef) => {
  const decoded = decodeUsageRecordLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const record = decoded.value.payload;

  if (scan.head === null || present(record.thread_id) !== scan.head.threadId) {
    scan.foreignRecords += 1;

    return;
  }

  const responseId = present(record.response_id);
  const key = responseId ?? `ord-${String(line.ordinal ?? -1)}`;

  if (scan.seenResponses.has(key)) {
    scan.duplicateRecords += 1;

    return;
  }

  scan.seenResponses.add(key);
  scan.sawRecord = true;
  scan.replaying = false;

  if (spent(record.usage) === 0) {
    scan.emptyRecords += 1;

    return;
  }

  pushRequest(scan, {
    key,
    occurredAt: line.timestamp,
    ordinal: line.ordinal,
    responseId,
    source: "token_usage_record",
    turnId: present(record.turn_id) ?? scan.current,
    usage: record.usage,
  });
};

const onTokenCount = (scan: Scan, line: LineRef) => {
  const decoded = decodeTokenCountLine(line.text);

  if (Option.isNone(decoded)) {
    scan.malformedLines += 1;

    return;
  }

  const info = decoded.value.payload.info ?? null;
  const last = info?.last_token_usage ?? null;

  if (last === null) {
    return;
  }

  const total = info?.total_token_usage?.total_tokens ?? null;

  const signature =
    total === null
      ? `ord-${String(line.ordinal ?? -1)}`
      : `${String(total)}-${String(last.input_tokens ?? 0)}-${String(last.output_tokens ?? 0)}`;

  const repeated =
    (total !== null && total === scan.lastTotal) ||
    scan.seenEmissions.has(signature);

  scan.lastTotal = total ?? scan.lastTotal;
  scan.seenEmissions.add(signature);

  if (scan.replaying) {
    scan.replayedEmissions += 1;

    return;
  }

  if (scan.sawRecord) {
    return;
  }

  if (repeated) {
    scan.repeatedEmissions += 1;

    return;
  }

  if (spent(last) === 0) {
    scan.emptyRecords += 1;

    return;
  }

  pushRequest(scan, {
    key: `tc-${signature}`,
    occurredAt: line.timestamp,
    ordinal: line.ordinal,
    responseId: null,
    source: "token_count",
    turnId: scan.current,
    usage: last,
  });
};

const MAX_PROMPTS = 16;

const USER_ROLE = '"role":"user"';

const notePrompt = (scan: Scan, text: string | null | undefined) => {
  const prompt = text?.trim() ?? "";

  if (scan.prompts === null || prompt === "") {
    return;
  }

  const digest = promptDigest(prompt);

  if (scan.prompts.length < MAX_PROMPTS && !scan.prompts.includes(digest)) {
    scan.prompts.push(digest);
  }
};

const wantsPrompts = (scan: Scan): boolean =>
  scan.prompts !== null && scan.prompts.length < MAX_PROMPTS;

const onUserMessage = (scan: Scan, lineOf: () => LineRef) => {
  if (!wantsPrompts(scan)) {
    return;
  }

  Option.map(decodeUserMessageLine(lineOf().text), (decoded) => {
    notePrompt(scan, decoded.payload.message);

    return null;
  });
};

const onResponseMessage = (scan: Scan, lineOf: () => LineRef) => {
  if (!wantsPrompts(scan)) {
    return;
  }

  const { text } = lineOf();

  if (!text.includes(USER_ROLE)) {
    return;
  }

  Option.map(decodeResponseMessageLine(text), (decoded) => {
    if (decoded.payload.role === "user") {
      for (const item of decoded.payload.content ?? []) {
        notePrompt(scan, isContentText(item) ? item.text : null);
      }
    }

    return null;
  });
};

const onToolCall = (scan: Scan, lineOf: () => LineRef) => {
  if (scan.replaying || scan.current === null) {
    return;
  }

  const turn = scan.open.get(scan.current);

  if (turn !== undefined) {
    turn.toolCalls += 1;
  }

  const facts = toolCallFacts(lineOf().text);

  scan.calls.push(...facts.touches);
  scan.toolCalls += 1;
  scan.webSearches += facts.webSearch ? 1 : 0;
};

const EVENT_HANDLERS: ReadonlyMap<string, (scan: Scan, line: LineRef) => void> =
  new Map([
    ["task_started", onTaskStarted],
    ["task_complete", onTaskComplete],
    ["turn_aborted", onTurnAborted],
    ["token_count", onTokenCount],
    ["thread_settings_applied", onThreadSettings],
  ]);

const TOP_HANDLERS: ReadonlyMap<string, (scan: Scan, line: LineRef) => void> =
  new Map([
    ["session_meta", onSessionMeta],
    ["turn_context", onTurnContext],
    ["token_usage_record", onUsageRecord],
  ]);

const LineHeaderSchema = Schema.fromJsonString(
  Schema.Struct({
    ordinal: Schema.optional(Schema.NullOr(Schema.Finite)),
    timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  })
);

const decodeHeader = Schema.decodeUnknownOption(LineHeaderSchema);

const ORDINAL = /"ordinal":(?<ordinal>\d+)/u;

const TIMESTAMP = /"timestamp":"(?<timestamp>[^"]+)"/u;

const handlerFor = (
  type: string | null,
  payloadType: string | null
): ((scan: Scan, line: LineRef) => void) | null => {
  if (type === "event_msg") {
    return payloadType === null
      ? null
      : (EVENT_HANDLERS.get(payloadType) ?? null);
  }

  return type === null ? null : (TOP_HANDLERS.get(type) ?? null);
};

const decoder = new TextDecoder();

const NEWLINE = 10;

const dispatch = (scan: Scan, kind: LineKind, lineOf: () => LineRef) => {
  if (kind.type === "response_item") {
    if (kind.payloadType !== null && TOOL_CALL_TYPES.has(kind.payloadType)) {
      onToolCall(scan, lineOf);
    }

    if (kind.payloadType === "message") {
      onResponseMessage(scan, lineOf);
    }

    return;
  }

  if (kind.type === "event_msg" && kind.payloadType === "user_message") {
    onUserMessage(scan, lineOf);

    return;
  }

  const handler = handlerFor(kind.type, kind.payloadType);

  if (handler === null) {
    return;
  }

  const line = lineOf();

  seen(scan, line.timestamp);
  handler(scan, line);
};

const decodedLine = (text: string): LineRef =>
  Option.match(decodeHeader(text), {
    onNone: () => ({ ordinal: null, text, timestamp: null }),
    onSome: (header) => ({
      ordinal: header.ordinal ?? null,
      text,
      timestamp: header.timestamp ?? null,
    }),
  });

const scanLine = (scan: Scan, bytes: Uint8Array) => {
  const head = decoder.decode(bytes.subarray(0, SNIFF_CHARS));
  const sniffed = sniffLine(head);

  if (sniffed.type !== null) {
    dispatch(scan, sniffed, () => {
      const prefix = head.split('"payload":')[0] ?? head;
      const ordinal = ORDINAL.exec(prefix)?.groups?.ordinal;

      return {
        ordinal: ordinal === undefined ? null : Number(ordinal),
        text: decoder.decode(bytes),
        timestamp: TIMESTAMP.exec(prefix)?.groups?.timestamp ?? null,
      };
    });

    return;
  }

  const text = decoder.decode(bytes);
  const kind = lineKindOf(text);

  if (kind.type === null) {
    scan.malformedLines += 1;

    return;
  }

  dispatch(scan, kind, () => decodedLine(text));
};

const isCompleteJson = (bytes: Uint8Array): boolean =>
  Option.isSome(decodeHeader(decoder.decode(bytes)));

const startScan = (state: ScanState): Scan => ({
  calls: [...state.calls],
  current: state.current,
  duplicateRecords: 0,
  emptyRecords: 0,
  ended: [],
  endedIds: new Set(),
  facts: state.facts,
  firstTimestamp: null,
  foreignRecords: 0,
  head: state.head,
  lastTimestamp: null,
  lastTotal: state.lastTotal,
  malformedLines: 0,
  open: new Map(
    state.openTurns.map((turn) => [turn.turnId, { ...turn }] as const)
  ),
  prompts: state.prompts === null ? null : [...state.prompts],
  repeatedEmissions: 0,
  replayedEmissions: 0,
  replaying: state.replaying,
  requests: [],
  sawRecord: state.sawRecord,
  seenEmissions: new Set(),
  seenResponses: new Set(),
  settings: state.settings,
  toolCalls: state.toolCalls,
  webSearches: state.webSearches,
});

const settledFacts = (scan: Scan): readonly CodexRequest[] => {
  const known = new Map<string, TurnFacts>([
    ...scan.ended.map((turn) => [turn.turnId, turn.facts] as const),
    ...[...scan.open.values()].map(
      (turn) => [turn.turnId, turn.facts] as const
    ),
  ]);

  return scan.requests.map((request) => {
    const later =
      request.turnId === null ? undefined : known.get(request.turnId);

    return request.facts.model === null && later !== undefined
      ? { ...request, facts: later }
      : request;
  });
};

const finish = (scan: Scan, consumed: number): ScanResult => ({
  consumed,
  counts: {
    duplicateRecords: scan.duplicateRecords,
    emptyRecords: scan.emptyRecords,
    foreignRecords: scan.foreignRecords,
    malformedLines: scan.malformedLines,
    repeatedEmissions: scan.repeatedEmissions,
    replayedEmissions: scan.replayedEmissions,
  },
  endedTurns: scan.ended,
  firstTimestamp: scan.firstTimestamp,
  lastTimestamp: scan.lastTimestamp,
  requests: settledFacts(scan),
  state: {
    calls: scan.calls,
    current: scan.current,
    facts: scan.facts,
    head: scan.head,
    lastTotal: scan.lastTotal,
    openTurns: [...scan.open.values()].map((turn) => ({ ...turn })),
    prompts: scan.prompts,
    replaying: scan.replaying,
    sawRecord: scan.sawRecord,
    settings: scan.settings,
    toolCalls: scan.toolCalls,
    webSearches: scan.webSearches,
  },
});

export const scanSession = (
  bytes: Uint8Array,
  state: ScanState = initialScanState
): ScanResult => {
  const scan = startScan(state);
  let start = 0;

  while (start < bytes.byteLength) {
    const end = bytes.indexOf(NEWLINE, start);

    if (end === -1) {
      const rest = bytes.subarray(start);

      if (rest.some((byte) => byte > 32) && isCompleteJson(rest)) {
        scanLine(scan, rest);
        start = bytes.byteLength;
      }

      break;
    }

    const line = bytes.subarray(start, end);

    if (line.some((byte) => byte > 32)) {
      scanLine(scan, line);
    }

    start = end + 1;
  }

  return finish(scan, start);
};
