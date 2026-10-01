import { Option, Schema } from "effect";

import type { EffortSource } from "../ids.js";
import {
  AssistantAttemptSchema,
  AssistantMessageSchema,
  CompactionSummarySchema,
  DescriptorSchema,
  EndSeedSchema,
  RequestHeaderSchema,
  RetryStartedSchema,
  RouteSchema,
  SearchRequestSchema,
  TitleRequestSchema,
  TitleSchema,
  ToolCallSchema,
  TurnEndSchema,
  TurnStartSchema,
  decodeData,
  decodeStreamRecord,
  decodeToolArguments,
} from "./format.js";
import type { Header, Row, StreamRecord, Usage } from "./format.js";

const Nullable = Schema.NullOr(Schema.String);

export const RouteStateSchema = Schema.Struct({
  effort: Nullable,
  effortSource: Schema.NullOr(
    Schema.Literals(["harness-recorded", "model-suffix", "config"])
  ),
  model: Nullable,
  provider: Nullable,
});

export type RouteState = typeof RouteStateSchema.Type;

const SlotSchema = Schema.Struct({
  attempt: Schema.Int,
  buckets: Schema.Array(Schema.Finite),
  key: Schema.String,
  step: Schema.Int,
  turn: Schema.Int,
});

const OpenTurnSchema = Schema.Struct({
  modelReported: Nullable,
  requests: Schema.Int,
  route: Schema.NullOr(RouteStateSchema),
  startedAt: Schema.NullOr(Schema.Finite),
  turn: Schema.Int,
});

export const FoldStateSchema = Schema.Struct({
  agentType: Nullable,
  attempts: Schema.NullOr(
    Schema.Struct({
      attempt: Schema.Int,
      step: Schema.Int,
      turn: Schema.Int,
    })
  ),
  cut: Schema.Literals(["pending", "live"]),
  delegate: Schema.NullOr(RouteStateSchema),
  route: Schema.NullOr(RouteStateSchema),
  selection: Schema.NullOr(RouteStateSchema),
  slot: Schema.NullOr(SlotSchema),
  turn: Schema.NullOr(OpenTurnSchema),
});

export type FoldState = typeof FoldStateSchema.Type;

export const initialFoldState = (header: Header): FoldState => ({
  agentType: null,
  attempts: null,
  cut: header.isSeeded === true ? "pending" : "live",
  delegate: null,
  route: null,
  selection: null,
  slot: null,
  turn: null,
});

export type RequestSource =
  | "message"
  | "attempt"
  | "compaction"
  | "title"
  | "web-search";

export interface RequestRecord {
  readonly attempt: number;
  readonly errorCode: string | null;
  readonly kind: "request";
  readonly messageId: string | null;
  readonly modelReported: string | null;
  readonly outcome: string | null;
  readonly replaces: string | null;
  readonly requestKey: string;
  readonly responseId: string | null;
  readonly route: RouteState;
  readonly seq: number;
  readonly serviceTier: string | null;
  readonly source: RequestSource;
  readonly step: number | null;
  readonly time: number | null;
  readonly turn: number | null;
  readonly usage: Usage | null;
}

export interface TurnRecord {
  readonly endedAt: number | null;
  readonly errorCode: string | null;
  readonly kind: "turn";
  readonly modelReported: string | null;
  readonly outcome: string | null;
  readonly requests: number;
  readonly route: RouteState | null;
  readonly seq: number;
  readonly startedAt: number | null;
  readonly turn: number;
}

export interface TitleRecord {
  readonly kind: "title";
  readonly seq: number;
  readonly source: string;
  readonly time: number | null;
  readonly title: string;
}

export interface ToolRecord {
  readonly callId: string;
  readonly filePath: string | null;
  readonly kind: "tool";
  readonly name: string;
  readonly seq: number;
  readonly time: number | null;
  readonly turn: number;
  readonly workdir: string | null;
}

export type FoldRecord = RequestRecord | TurnRecord | TitleRecord | ToolRecord;

export interface FoldResult {
  readonly gaps: readonly string[];
  readonly records: readonly FoldRecord[];
  readonly skippedInherited: number;
  readonly state: FoldState;
  readonly unknownTypes: number;
}

const emptyRoute: RouteState = {
  effort: null,
  effortSource: null,
  model: null,
  provider: null,
};

const decodeMessage = decodeData(AssistantMessageSchema);

const decodeAttempt = decodeData(AssistantAttemptSchema);

const decodeRetry = decodeData(RetryStartedSchema);

const decodeHeader = decodeData(RequestHeaderSchema);

const decodeRoute = decodeData(RouteSchema);

const decodeTurnStart = decodeData(TurnStartSchema);

const decodeTurnEnd = decodeData(TurnEndSchema);

const decodeEndSeed = decodeData(EndSeedSchema);

const decodeTitle = decodeData(TitleSchema);

const decodeDescriptor = decodeData(DescriptorSchema);

const decodeCompaction = decodeData(CompactionSummarySchema);

const decodeTitleRequest = decodeData(TitleRequestSchema);

const decodeSearchRequest = decodeData(SearchRequestSchema);

const decodeToolCall = decodeData(ToolCallSchema);

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/attempt",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "developer/message",
  "feedback/message-delete",
  "feedback/message-put",
  "feedback/record",
  "goal/change",
  "image/offload",
  "llm/retry",
  "llm/retry-started",
  "model/selection",
  "permission/preset",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/catalog",
  "subagent/descriptor",
  "system/message",
  "todo/write",
  "tool/call",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
]);

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "apply_patch",
  "create",
  "edit",
  "multi_edit",
  "notebook_edit",
  "str_replace_editor",
  "write",
]);

const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "bash_persistent",
  "pwsh",
  "pwsh_persistent",
]);

const streamRecords = (stream: readonly unknown[] | undefined) =>
  (stream ?? []).flatMap((entry) => Option.toArray(decodeStreamRecord(entry)));

const lastChunk = (
  records: readonly StreamRecord[],
  type: string
): StreamRecord["chunk"] | null =>
  records.findLast((record) => record.chunk?.type === type)?.chunk ?? null;

export const bucketsOf = (usage: Usage): readonly number[] => [
  usage.inputTokens,
  usage.outputTokens,
  usage.cacheReadTokens ?? 0,
  usage.cacheWriteTokens ?? 0,
];

const sameBuckets = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const effortOf = (
  route: RouteState | null,
  fallbacks: readonly (RouteState | null)[]
): Pick<RouteState, "effort" | "effortSource"> => {
  for (const candidate of [route, ...fallbacks]) {
    if (candidate !== null && candidate.effort !== null) {
      return { effort: candidate.effort, effortSource: candidate.effortSource };
    }
  }

  return { effort: null, effortSource: null };
};

interface Fold {
  readonly gaps: string[];
  readonly records: FoldRecord[];
  skippedInherited: number;
  state: FoldState;
  unknownTypes: number;
}

const routeFor = (
  fold: Fold,
  provider: string | null,
  model: string | null
) => {
  const { delegate, route, selection } = fold.state;

  return {
    ...effortOf(route, [selection, delegate]),
    model: model ?? route?.model ?? selection?.model ?? delegate?.model ?? null,
    provider:
      provider ??
      route?.provider ??
      selection?.provider ??
      delegate?.provider ??
      null,
  };
};

const countInTurn = (fold: Fold, record: RequestRecord) => {
  const open = fold.state.turn;

  if (open !== null && record.turn === open.turn) {
    fold.state = {
      ...fold.state,
      turn: {
        ...open,
        modelReported: record.modelReported ?? open.modelReported,
        requests: open.requests + 1,
        route: record.route,
      },
    };
  }
};

const uncountInTurn = (fold: Fold, turn: number) => {
  const open = fold.state.turn;

  if (open !== null && open.turn === turn) {
    fold.state = {
      ...fold.state,
      turn: { ...open, requests: Math.max(open.requests - 1, 0) },
    };
  }
};

const slotKey = (
  sessionId: string,
  turn: number,
  step: number,
  attempt: number
): string =>
  `deepseek:${sessionId}:turn:${String(turn)}:step:${String(step)}:attempt:${String(attempt)}`;

interface Sample {
  readonly finish: StreamRecord["chunk"] | null;
  readonly messageId: string | null;
  readonly modelReported: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly responseId: string | null;
  readonly serviceTier: string | null;
  readonly source: "message" | "attempt";
  readonly step: number;
  readonly turn: number;
  readonly usage: Usage | null;
  readonly interrupted: boolean;
}

const outcomeOf = (sample: Sample) => {
  if (sample.interrupted) {
    return { errorCode: null, outcome: "interrupted" };
  }

  const reason = sample.finish?.reason ?? null;

  if (reason === null) {
    return {
      errorCode: null,
      outcome: sample.source === "message" ? "completed" : "failed",
    };
  }

  const { kind } = reason;

  return {
    errorCode: reason.failure?.code ?? null,
    outcome: kind === "stop" || kind === "tool-calls" ? "completed" : kind,
  };
};

const settle = (fold: Fold, sessionId: string, sample: Sample, row: Row) => {
  const { attempts, slot } = fold.state;

  const attempt =
    attempts !== null &&
    attempts.turn === sample.turn &&
    attempts.step === sample.step
      ? attempts.attempt
      : 0;

  const slotId = slotKey(sessionId, sample.turn, sample.step, attempt);
  const buckets = sample.usage === null ? null : bucketsOf(sample.usage);

  const previous =
    slot !== null &&
    slot.turn === sample.turn &&
    slot.step === sample.step &&
    slot.attempt === attempt
      ? slot
      : null;

  if (
    previous !== null &&
    buckets !== null &&
    sameBuckets(previous.buckets, buckets)
  ) {
    return;
  }

  let replaces: string | null = null;

  if (previous !== null && buckets !== null) {
    const index = fold.records.findLastIndex(
      (record) =>
        record.kind === "request" && record.requestKey === previous.key
    );

    if (index === -1) {
      replaces = previous.key;
    } else {
      fold.records.splice(index, 1);
      uncountInTurn(fold, sample.turn);
    }
  }

  const key =
    sample.responseId === null
      ? slotId
      : `deepseek:response:${sample.responseId}`;

  const record: RequestRecord = {
    attempt,
    ...outcomeOf(sample),
    kind: "request",
    messageId: sample.messageId,
    modelReported: sample.modelReported,
    replaces,
    requestKey: key,
    responseId: sample.responseId,
    route: routeFor(fold, sample.provider, sample.model),
    seq: row.seq,
    serviceTier: sample.serviceTier,
    source: sample.source,
    step: sample.step,
    time: row.time ?? null,
    turn: sample.turn,
    usage: sample.usage,
  };

  fold.records.push(record);
  countInTurn(fold, record);

  if (buckets !== null) {
    fold.state = {
      ...fold.state,
      slot: {
        attempt,
        buckets,
        key,
        step: sample.step,
        turn: sample.turn,
      },
    };
  }
};

type Response = NonNullable<
  NonNullable<NonNullable<StreamRecord["chunk"]>["replayState"]>["response"]
>;

interface Reported {
  readonly modelReported: string | null;
  readonly responseId: string | null;
  readonly serviceTier: string | null;
}

const reportedBy = (response: Response | null): Reported => ({
  modelReported: response?.responseModel ?? null,
  responseId: response?.responseId ?? null,
  serviceTier: response?.serviceTier ?? null,
});

const undecoded = (fold: Fold, row: Row) => {
  fold.gaps.push(`${row.type} at seq ${String(row.seq)} did not decode`);
};

const assistantMessage = (fold: Fold, sessionId: string, row: Row) => {
  const data = decodeMessage(row);

  if (data === null) {
    undecoded(fold, row);

    return;
  }

  const records = streamRecords(data.stream);
  const finish = lastChunk(records, "finish");
  const { source } = data.message;

  const response =
    source?.replayState?.response ?? finish?.replayState?.response ?? null;

  const streamed = lastChunk(records, "usage")?.usage ?? null;

  settle(
    fold,
    sessionId,
    {
      ...reportedBy(response),
      finish,
      interrupted: data.interrupted === true,
      messageId: data.message.id ?? null,
      model: source?.model ?? response?.model ?? null,
      provider: source?.provider ?? response?.provider ?? null,
      source: "message",
      step: data.step,
      turn: data.turn,
      usage: data.usage ?? streamed,
    },
    row
  );
};

const assistantAttempt = (fold: Fold, sessionId: string, row: Row) => {
  const data = decodeAttempt(row);

  if (data === null) {
    undecoded(fold, row);

    return;
  }

  const records = streamRecords(data.stream);
  const finish = lastChunk(records, "finish");
  const response = finish?.replayState?.response ?? null;

  settle(
    fold,
    sessionId,
    {
      ...reportedBy(response),
      finish,
      interrupted: false,
      messageId: null,
      model: response?.model ?? null,
      provider: response?.provider ?? null,
      source: "attempt",
      step: data.step,
      turn: data.turn,
      usage: lastChunk(records, "usage")?.usage ?? null,
    },
    row
  );
};

const sameSlot = (
  slot: { readonly step: number; readonly turn: number } | null,
  turn: number,
  step: number
): boolean => slot !== null && slot.turn === turn && slot.step === step;

const retryStarted = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeRetry(row);

  if (data === null) {
    return;
  }

  const { attempts, slot } = fold.state;

  const attempt =
    attempts !== null && sameSlot(attempts, data.turn, data.step)
      ? attempts.attempt + 1
      : 1;

  fold.state = {
    ...fold.state,
    attempts: { attempt, step: data.step, turn: data.turn },
    slot: sameSlot(slot, data.turn, data.step) ? null : slot,
  };
};

interface SideRequest {
  readonly key: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly source: RequestSource;
  readonly usage: Usage | null;
}

const sideRequest = (fold: Fold, row: Row, side: SideRequest) => {
  const route =
    side.model === null && side.provider === null
      ? routeFor(fold, null, null)
      : { ...emptyRoute, model: side.model, provider: side.provider };

  fold.records.push({
    attempt: 0,
    errorCode: null,
    kind: "request",
    messageId: null,
    modelReported: null,
    outcome: null,
    replaces: null,
    requestKey: side.key,
    responseId: null,
    route,
    seq: row.seq,
    serviceTier: null,
    source: side.source,
    step: null,
    time: row.time ?? null,
    turn: fold.state.turn?.turn ?? null,
    usage: side.usage,
  });
};

const headerEffortSource = (
  effort: string | null,
  defaulted: boolean
): EffortSource | null => {
  if (effort === null) {
    return null;
  }

  return defaulted ? "config" : "harness-recorded";
};

const requestHeader = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeHeader(row);

  if (data === null) {
    return;
  }

  const { adapterDefaults, config } = data.header;
  const effort = config.reasoningEffort ?? null;

  fold.state = {
    ...fold.state,
    route: {
      effort,
      effortSource: headerEffortSource(
        effort,
        adapterDefaults?.reasoningEffort === true
      ),
      model: config.model,
      provider: config.provider,
    },
  };
};

const requestContext = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeRoute(row);
  const current = fold.state.route;

  if (data === null) {
    return;
  }

  const same =
    current !== null &&
    current.provider === data.provider &&
    current.model === data.model;

  fold.state = {
    ...fold.state,
    route: same
      ? current
      : {
          effort: null,
          effortSource: null,
          model: data.model,
          provider: data.provider,
        },
  };
};

const effortSourceOf = (effort: string | null): EffortSource | null =>
  effort === null ? null : "harness-recorded";

const modelSelection = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeRoute(row);

  if (data === null) {
    return;
  }

  const effort = data.reasoningEffort ?? null;

  fold.state = {
    ...fold.state,
    selection: {
      effort,
      effortSource: effortSourceOf(effort),
      model: data.model,
      provider: data.provider,
    },
  };
};

const subagentDescriptor = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeDescriptor(row);

  if (data === null) {
    return;
  }

  const effort = data.agentReasoningEffort ?? null;

  fold.state = {
    ...fold.state,
    agentType: data.persona ?? data.provider ?? data.mode ?? null,
    delegate: {
      effort,
      effortSource: effortSourceOf(effort),
      model: data.agentModel ?? null,
      provider: data.agentProvider ?? null,
    },
  };
};

const turnStart = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeTurnStart(row);

  if (data === null) {
    return;
  }

  fold.state = {
    ...fold.state,
    turn: {
      modelReported: null,
      requests: 0,
      route: null,
      startedAt: row.time ?? null,
      turn: data.turn,
    },
  };
};

interface ToolTarget {
  readonly filePath: string | null;
  readonly workdir: string | null;
}

const toolTarget = (name: string, raw: string): ToolTarget | null => {
  const shell = SHELL_TOOLS.has(name);

  if (!shell && !EDIT_TOOLS.has(name)) {
    return null;
  }

  const args = Option.getOrNull(decodeToolArguments(raw));

  const target: ToolTarget = shell
    ? { filePath: null, workdir: args?.workdir ?? null }
    : { filePath: args?.file_path ?? args?.path ?? null, workdir: null };

  return target.filePath === null && target.workdir === null ? null : target;
};

const toolCall = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeToolCall(row);
  const target = data === null ? null : toolTarget(data.name, data.arguments);

  if (data === null || target === null) {
    return;
  }

  fold.records.push({
    ...target,
    callId: data.callId,
    kind: "tool",
    name: data.name,
    seq: row.seq,
    time: row.time ?? null,
    turn: data.turn,
  });
};

const turnEnd = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeTurnEnd(row);
  const open = fold.state.turn;

  if (data === null || open === null || open.turn !== data.turn) {
    return;
  }

  fold.records.push({
    endedAt: row.time ?? null,
    errorCode: data.reason?.error?.code ?? null,
    kind: "turn",
    modelReported: open.modelReported,
    outcome: data.reason?.kind ?? null,
    requests: open.requests,
    route: open.route,
    seq: row.seq,
    startedAt: open.startedAt,
    turn: open.turn,
  });

  fold.state = { ...fold.state, turn: null };
};

const sessionTitle = (fold: Fold, _sessionId: string, row: Row) => {
  const data = decodeTitle(row);

  if (data === null || data.source.kind === "fallback") {
    return;
  }

  fold.records.push({
    kind: "title",
    seq: row.seq,
    source: data.source.kind,
    time: row.time ?? null,
    title: data.title,
  });
};

const compactionSummary = (fold: Fold, sessionId: string, row: Row) => {
  const data = decodeCompaction(row);

  if (data === null) {
    return;
  }

  sideRequest(fold, row, {
    key: `deepseek:${sessionId}:compaction:${data.compactionId}`,
    model: data.model ?? null,
    provider: data.provider ?? null,
    source: "compaction",
    usage: data.usage ?? null,
  });
};

const titleRequest = (fold: Fold, sessionId: string, row: Row) => {
  const route = decodeTitleRequest(row)?.route ?? null;

  sideRequest(fold, row, {
    key: `deepseek:${sessionId}:title:${String(row.seq)}`,
    model: route?.model ?? null,
    provider: route?.provider ?? null,
    source: "title",
    usage: null,
  });
};

const searchRequest = (fold: Fold, sessionId: string, row: Row) => {
  const model = decodeSearchRequest(row)?.body?.model ?? null;

  sideRequest(fold, row, {
    key: `deepseek:${sessionId}:web-search:${String(row.seq)}`,
    model,
    provider: model === null ? null : "deepseek",
    source: "web-search",
    usage: null,
  });
};

type RowHandler = (fold: Fold, sessionId: string, row: Row) => void;

const ROW_HANDLERS: ReadonlyMap<string, RowHandler> = new Map([
  ["assistant/attempt", assistantAttempt],
  ["assistant/message", assistantMessage],
  ["compaction/summary", compactionSummary],
  ["llm/retry-started", retryStarted],
  ["model/selection", modelSelection],
  ["request/context", requestContext],
  ["request/header", requestHeader],
  ["session/title", sessionTitle],
  ["session/title-llm-request", titleRequest],
  ["subagent/descriptor", subagentDescriptor],
  ["tool/call", toolCall],
  ["turn/end", turnEnd],
  ["turn/start", turnStart],
  ["web/deepseek-search-llm-request", searchRequest],
]);

const applyLive = (fold: Fold, sessionId: string, row: Row) => {
  const handler = ROW_HANDLERS.get(row.type);

  if (handler === undefined) {
    fold.unknownTypes += KNOWN_TYPES.has(row.type) ? 0 : 1;
  } else {
    handler(fold, sessionId, row);
  }
};

const isInheritedMarker = (row: Row): boolean =>
  row.type === "session/end-seed" && decodeEndSeed(row)?.inherited === true;

export const foldRows = (
  sessionId: string,
  rows: readonly Row[],
  start: FoldState
): FoldResult => {
  const fold: Fold = {
    gaps: [],
    records: [],
    skippedInherited: 0,
    state: start,
    unknownTypes: 0,
  };

  let firstLive = 0;

  if (start.cut === "pending" && rows.length > 0) {
    const marker = rows.findLastIndex(isInheritedMarker);

    if (marker === -1) {
      fold.gaps.push(
        "seeded session has no inherited end-seed marker; every event is counted as its own"
      );
    }

    firstLive = marker + 1;
    fold.skippedInherited = firstLive;
    fold.state = { ...fold.state, cut: "live" };
  }

  for (const row of rows.slice(firstLive)) {
    applyLive(fold, sessionId, row);
  }

  return {
    gaps: fold.gaps,
    records: fold.records,
    skippedInherited: fold.skippedInherited,
    state: fold.state,
    unknownTypes: fold.unknownTypes,
  };
};
