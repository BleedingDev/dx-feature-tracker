// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { DateTime, Option, Schema } from "effect";

import { canonicalRequestKey, canonicalTurnKey } from "../../model/ai.js";
import type {
  AttributionState,
  Origin,
  TimePrecision,
} from "../../model/common.js";
import type { CoverageState, SourceGap } from "../../model/coverage.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
  EventIdentity,
  EventKind,
  EvidenceRef,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";

export const CODEX_ADAPTER_ID = "codex-session";

export const CODEX_ADAPTER_VERSION = "0.1.0";

const MAX_TOOL_NAMES = 40;

const NullableString = Schema.optional(Schema.NullOr(Schema.String));

const NullableNumber = Schema.optional(Schema.NullOr(Schema.Finite));

const UsageSchema = Schema.Struct({
  cache_write_input_tokens: NullableNumber,
  cached_input_tokens: NullableNumber,
  input_tokens: NullableNumber,
  output_tokens: NullableNumber,
  reasoning_output_tokens: NullableNumber,
  total_tokens: NullableNumber,
});

type Usage = typeof UsageSchema.Type;

const LineSchema = Schema.fromJsonString(
  Schema.Struct({
    payload: Schema.optional(Schema.Unknown),
    timestamp: NullableString,
    type: Schema.String,
  })
);

const SessionMetaSchema = Schema.Struct({
  cli_version: NullableString,
  cwd: NullableString,
  git: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ branch: NullableString, commit_hash: NullableString })
    )
  ),
  id: NullableString,
  model_provider: NullableString,
  originator: NullableString,
  session_id: NullableString,
  source: NullableString,
  timestamp: NullableString,
});

const TurnContextSchema = Schema.Struct({
  cwd: NullableString,
  effort: NullableString,
  model: NullableString,
  turn_id: Schema.String,
});

const UsageRecordSchema = Schema.Struct({
  response_id: NullableString,
  turn_id: NullableString,
  usage: UsageSchema,
});

const TaskEventSchema = Schema.Struct({
  completed_at: NullableNumber,
  duration_ms: NullableNumber,
  reason: NullableString,
  started_at: NullableNumber,
  turn_id: Schema.String,
  type: Schema.Literals(["task_started", "task_complete", "turn_aborted"]),
});

const TokenCountSchema = Schema.Struct({
  info: Schema.Struct({
    last_token_usage: UsageSchema,
    total_token_usage: Schema.Struct({ total_tokens: Schema.Finite }),
  }),
  type: Schema.Literal("token_count"),
});

const ToolCallSchema = Schema.Struct({
  name: NullableString,
  type: Schema.Literals([
    "function_call",
    "custom_tool_call",
    "local_shell_call",
    "web_search_call",
  ]),
});

const decodeLine = Schema.decodeUnknownOption(LineSchema);

const decodeSessionMeta = Schema.decodeUnknownOption(SessionMetaSchema);

const decodeTurnContext = Schema.decodeUnknownOption(TurnContextSchema);

const decodeUsageRecord = Schema.decodeUnknownOption(UsageRecordSchema);

const decodeTaskEvent = Schema.decodeUnknownOption(TaskEventSchema);

const decodeTokenCount = Schema.decodeUnknownOption(TokenCountSchema);

const decodeToolCall = Schema.decodeUnknownOption(ToolCallSchema);

export interface Allocation {
  readonly reason: string;
  readonly state: AttributionState;
}

interface TurnState {
  aborted: boolean;
  abortReason: string | null;
  completedAt: number | null;
  cwd: string | null;
  durationMs: number | null;
  effort: string | null;
  readonly firstLine: number;
  readonly firstTimestamp: string | null;
  model: string | null;
  startedAt: number | null;
  toolCalls: number;
  readonly toolNames: Map<string, number>;
  readonly turnId: string;
  usageRecords: number;
}

interface UsageRow {
  readonly legacy: boolean;
  readonly line: number;
  readonly lineText: string;
  readonly model: string | null;
  readonly requestId: string | null;
  readonly timestamp: string | null;
  readonly turnId: string | null;
  readonly upstreamKey: string;
  readonly usage: Usage;
}

interface SessionState {
  branch: string | null;
  cliVersion: string | null;
  commit: string | null;
  cwd: string | null;
  metaLine: number;
  metaLineText: string;
  modelProvider: string | null;
  originator: string | null;
  sessionId: string | null;
  source: string | null;
  startedAt: string | null;
}

interface ParseState {
  currentTurn: TurnState | null;
  duplicateUsageRecords: number;
  lastLegacyTotal: number | null;
  readonly legacyRows: UsageRow[];
  malformedLines: number;
  recognizedLines: number;
  readonly seenResponses: Set<string>;
  readonly session: SessionState;
  readonly timestamps: string[];
  readonly turns: Map<string, TurnState>;
  readonly usageRows: UsageRow[];
}

interface LineRef {
  readonly line: number;
  readonly lineText: string;
  readonly payload: unknown;
  readonly timestamp: string | null;
}

export interface CodexParseOptions {
  readonly context: FlightContext;
  readonly evidenceName: string;
  readonly observedAt: string;
  readonly origin: Origin;
}

export interface CodexParseResult {
  readonly batch: EventBatch;
  readonly duplicateUsageRecords: number;
  readonly malformedLines: number;
  readonly recognizedLines: number;
}

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const secondsToIso = (seconds: number | null): string | null =>
  seconds === null
    ? null
    : DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

const isWithin = (cwd: string, root: string): boolean =>
  cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);

export const allocate = (
  context: FlightContext,
  cwd: string | null,
  sessionBranch: string | null
): Allocation => {
  if (context.worktreePath === null) {
    return {
      reason:
        "No branch worktree selected; a Codex session is not assigned to any branch without one.",
      state: "unassigned",
    };
  }

  if (cwd === null) {
    return {
      reason: "Codex session recorded no working directory.",
      state: "unassigned",
    };
  }

  if (!isWithin(cwd, context.worktreePath)) {
    return {
      reason:
        "Codex working directory is outside the selected branch worktree.",
      state: "unassigned",
    };
  }

  if (
    sessionBranch !== null &&
    context.branch !== null &&
    sessionBranch !== context.branch
  ) {
    return {
      reason: `Codex session started on branch ${sessionBranch}, not the selected branch ${context.branch}.`,
      state: "unassigned",
    };
  }

  return {
    reason:
      "Codex working directory is inside the selected branch worktree, but Codex does not record the branch per turn, so a mid-session branch switch cannot be excluded.",
    state: "provisional",
  };
};

const tokenField = (
  name: string,
  rawName: string,
  note: string | null
): FieldSemantics => ({
  field: `tokens.${name}`,
  method: "source-reported",
  note,
  rawName,
  unit: "tokens",
});

const tokenSemantics = (legacy: boolean): FieldSemantics[] => {
  const origin = legacy
    ? "Per-emission delta from event_msg token_count last_token_usage; repeated emissions with an unchanged cumulative total are dropped."
    : "Per-response usage from token_usage_record.usage.";

  return [
    tokenField(
      "input",
      "input_tokens",
      `${origin} Includes cached input (OpenAI convention); never add tokens.cachedInput to it.`
    ),
    tokenField("cachedInput", "cached_input_tokens", "Subset of tokens.input."),
    tokenField("cacheWrite", "cache_write_input_tokens", null),
    tokenField("output", "output_tokens", "Includes reasoning output."),
    tokenField(
      "reasoning",
      "reasoning_output_tokens",
      "Subset of tokens.output."
    ),
    tokenField("total", "total_tokens", null),
  ];
};

const COST_UNAVAILABLE = {
  reason:
    "Codex session rollouts carry no billed charge or price; no list-price estimate is made.",
  state: "unavailable",
  value: null,
} as const;

const usageFields = (usage: Usage) => ({
  cacheWrite: usage.cache_write_input_tokens ?? null,
  cachedInput: usage.cached_input_tokens ?? null,
  input: usage.input_tokens ?? null,
  output: usage.output_tokens ?? null,
  reasoning: usage.reasoning_output_tokens ?? null,
  total: usage.total_tokens ?? null,
});

const newState = (): ParseState => ({
  currentTurn: null,
  duplicateUsageRecords: 0,
  lastLegacyTotal: null,
  legacyRows: [],
  malformedLines: 0,
  recognizedLines: 0,
  seenResponses: new Set(),
  session: {
    branch: null,
    cliVersion: null,
    commit: null,
    cwd: null,
    metaLine: 0,
    metaLineText: "",
    modelProvider: null,
    originator: null,
    sessionId: null,
    source: null,
    startedAt: null,
  },
  timestamps: [],
  turns: new Map(),
  usageRows: [],
});

const turnFor = (state: ParseState, turnId: string, ref: LineRef) => {
  const existing = state.turns.get(turnId);

  if (existing !== undefined) {
    return existing;
  }

  const created: TurnState = {
    abortReason: null,
    aborted: false,
    completedAt: null,
    cwd: null,
    durationMs: null,
    effort: null,
    firstLine: ref.line,
    firstTimestamp: ref.timestamp,
    model: null,
    startedAt: null,
    toolCalls: 0,
    toolNames: new Map(),
    turnId,
    usageRecords: 0,
  };

  state.turns.set(turnId, created);

  return created;
};

const onSessionMeta = (state: ParseState, ref: LineRef) => {
  const decoded = decodeSessionMeta(ref.payload);

  if (Option.isNone(decoded) || state.session.sessionId !== null) {
    return;
  }

  const meta = decoded.value;
  const { session } = state;

  state.recognizedLines += 1;
  session.sessionId = meta.id ?? meta.session_id ?? null;
  session.cliVersion = meta.cli_version ?? null;
  session.cwd = meta.cwd ?? null;
  session.branch = meta.git?.branch ?? null;
  session.commit = meta.git?.commit_hash ?? null;
  session.modelProvider = meta.model_provider ?? null;
  session.originator = meta.originator ?? null;
  session.source = meta.source ?? null;
  session.startedAt = meta.timestamp ?? ref.timestamp;
  session.metaLine = ref.line;
  session.metaLineText = ref.lineText;
};

const onTurnContext = (state: ParseState, ref: LineRef) => {
  const decoded = decodeTurnContext(ref.payload);

  if (Option.isNone(decoded)) {
    return;
  }

  const turn = turnFor(state, decoded.value.turn_id, ref);

  state.recognizedLines += 1;
  turn.model = decoded.value.model ?? turn.model;
  turn.effort = decoded.value.effort ?? turn.effort;
  turn.cwd = decoded.value.cwd ?? turn.cwd;
  state.currentTurn = turn;
};

const onUsageRecord = (state: ParseState, ref: LineRef) => {
  const decoded = decodeUsageRecord(ref.payload);

  if (Option.isNone(decoded)) {
    return;
  }

  const responseId = decoded.value.response_id ?? null;

  state.recognizedLines += 1;

  if (responseId !== null && state.seenResponses.has(responseId)) {
    state.duplicateUsageRecords += 1;

    return;
  }

  if (responseId !== null) {
    state.seenResponses.add(responseId);
  }

  const turnId = decoded.value.turn_id ?? state.currentTurn?.turnId ?? null;
  const turn = turnId === null ? null : turnFor(state, turnId, ref);

  if (turn !== null) {
    turn.usageRecords += 1;
  }

  state.usageRows.push({
    legacy: false,
    line: ref.line,
    lineText: ref.lineText,
    model: turn?.model ?? null,
    requestId: responseId,
    timestamp: ref.timestamp,
    turnId,
    upstreamKey:
      responseId === null
        ? `session:${state.session.sessionId ?? "unknown"}:line:${String(ref.line)}`
        : `response:${responseId}`,
    usage: decoded.value.usage,
  });
};

const onTaskEvent = (state: ParseState, ref: LineRef): boolean => {
  const decoded = decodeTaskEvent(ref.payload);

  if (Option.isNone(decoded)) {
    return false;
  }

  const event = decoded.value;
  const turn = turnFor(state, event.turn_id, ref);

  state.recognizedLines += 1;
  turn.startedAt = event.started_at ?? turn.startedAt;

  if (event.type === "task_started") {
    state.currentTurn = turn;

    return true;
  }

  turn.completedAt = event.completed_at ?? turn.completedAt;
  turn.durationMs = event.duration_ms ?? turn.durationMs;
  turn.aborted = event.type === "turn_aborted";
  turn.abortReason = event.reason ?? null;

  return true;
};

const onTokenCount = (state: ParseState, ref: LineRef) => {
  const decoded = decodeTokenCount(ref.payload);

  if (Option.isNone(decoded)) {
    return;
  }

  const { info } = decoded.value;
  const total = info.total_token_usage.total_tokens;

  state.recognizedLines += 1;

  if (total === state.lastLegacyTotal) {
    return;
  }

  const ordinal = state.legacyRows.length + 1;

  state.lastLegacyTotal = total;
  state.legacyRows.push({
    legacy: true,
    line: ref.line,
    lineText: ref.lineText,
    model: state.currentTurn?.model ?? null,
    requestId: null,
    timestamp: ref.timestamp,
    turnId: state.currentTurn?.turnId ?? null,
    upstreamKey: `session:${state.session.sessionId ?? "unknown"}:token_count:${String(ordinal)}`,
    usage: info.last_token_usage,
  });
};

const onEventMsg = (state: ParseState, ref: LineRef) => {
  if (!onTaskEvent(state, ref)) {
    onTokenCount(state, ref);
  }
};

const onResponseItem = (state: ParseState, ref: LineRef) => {
  const decoded = decodeToolCall(ref.payload);
  const turn = state.currentTurn;

  if (Option.isNone(decoded)) {
    return;
  }

  state.recognizedLines += 1;

  if (turn === null) {
    return;
  }

  const name = decoded.value.name ?? decoded.value.type;

  turn.toolCalls += 1;

  if (turn.toolNames.has(name) || turn.toolNames.size < MAX_TOOL_NAMES) {
    turn.toolNames.set(name, (turn.toolNames.get(name) ?? 0) + 1);
  }
};

const handlers: ReadonlyMap<string, (state: ParseState, ref: LineRef) => void> =
  new Map([
    ["session_meta", onSessionMeta],
    ["turn_context", onTurnContext],
    ["token_usage_record", onUsageRecord],
    ["event_msg", onEventMsg],
    ["response_item", onResponseItem],
  ]);

const scanLine = (state: ParseState, line: number, lineText: string) => {
  const decoded = decodeLine(lineText);

  if (Option.isNone(decoded)) {
    state.malformedLines += 1;

    return;
  }

  const timestamp = decoded.value.timestamp ?? null;

  if (timestamp !== null) {
    state.timestamps.push(timestamp);
  }

  handlers.get(decoded.value.type)?.(state, {
    line,
    lineText,
    payload: decoded.value.payload,
    timestamp,
  });
};

const scan = (lines: readonly string[]): ParseState => {
  const state = newState();

  for (const [index, raw] of lines.entries()) {
    const lineText = raw.trim();

    if (lineText !== "") {
      scanLine(state, index + 1, lineText);
    }
  }

  return state;
};

interface EnvelopeParts {
  readonly allocation: Allocation;
  readonly cwd: string | null;
  readonly evidence: EvidenceRef;
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly identity: Partial<EventIdentity>;
  readonly kind: EventKind;
  readonly occurredAt: string | null;
  readonly payload: DxEventEnvelope["payload"];
  readonly precision: TimePrecision;
  readonly upstreamKey: string;
}

const makeEnvelope = (
  state: ParseState,
  options: CodexParseOptions,
  parts: EnvelopeParts
): DxEventEnvelope => {
  const { session } = state;

  const context: FlightContext =
    parts.allocation.state === "provisional"
      ? options.context
      : {
          branch: session.branch,
          flightId: null,
          headSha: session.commit,
          repoCommonDir: null,
          worktreePath: parts.cwd,
        };

  return {
    acquisition: "file-import",
    adapterId: CODEX_ADAPTER_ID,
    adapterVersion: CODEX_ADAPTER_VERSION,
    context,
    eventId: EventIdSchema.make(
      sha256(`${CODEX_ADAPTER_ID}\u0000${parts.upstreamKey}\u0000${parts.kind}`)
    ),
    evidence: parts.evidence,
    fieldSemantics: parts.fieldSemantics,
    identity: { ...emptyEventIdentity, ...parts.identity },
    kind: parts.kind,
    observedAt: options.observedAt,
    occurredAt: parts.occurredAt,
    occurredAtPrecision:
      parts.occurredAt === null ? "unknown" : parts.precision,
    origin: options.origin,
    payload: {
      ...parts.payload,
      allocation: {
        reason: parts.allocation.reason,
        state: parts.allocation.state,
      },
      sourceKind: CODEX_ADAPTER_ID,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: session.cliVersion,
    upstreamKey: parts.upstreamKey,
  };
};

const evidenceRef = (
  options: CodexParseOptions,
  line: number,
  lineText: string | null
): EvidenceRef => ({
  bounded: true,
  hash: lineText === null ? null : sha256(lineText),
  ref: `${CODEX_ADAPTER_ID}:${options.evidenceName}#L${String(line)}`,
});

const turnStatus = (turn: TurnState): string => {
  if (turn.aborted) {
    return "aborted";
  }

  return turn.completedAt === null ? "open" : "completed";
};

const sessionEvent = (
  state: ParseState,
  options: CodexParseOptions,
  usageRows: readonly UsageRow[],
  legacy: boolean
): DxEventEnvelope | null => {
  const { session } = state;
  const { sessionId } = session;

  if (sessionId === null) {
    return null;
  }

  const toolCalls = [...state.turns.values()].reduce(
    (sum, turn) => sum + turn.toolCalls,
    0
  );

  return makeEnvelope(state, options, {
    allocation: allocate(options.context, session.cwd, session.branch),
    cwd: session.cwd,
    evidence: evidenceRef(options, session.metaLine, session.metaLineText),
    fieldSemantics: [
      {
        field: "toolCalls",
        method: "observed",
        note: "Count of tool-call response items attributed to a turn.",
        rawName: null,
        unit: "calls",
      },
    ],
    identity: { sessionId },
    kind: "ai.session",
    occurredAt: session.startedAt,
    payload: {
      branchAtStart: session.branch,
      cliVersion: session.cliVersion,
      commitAtStart: session.commit,
      cost: COST_UNAVAILABLE,
      modelProvider: session.modelProvider,
      originator: session.originator,
      sessionId,
      source: session.source,
      toolCalls,
      turnCount: state.turns.size,
      usageRecords: usageRows.length,
      usageSource: legacy ? "event_msg.token_count" : "token_usage_record",
    },
    precision: "exact",
    upstreamKey: `session:${sessionId}`,
  });
};

const turnEvent = (
  state: ParseState,
  options: CodexParseOptions,
  turn: TurnState
): DxEventEnvelope => {
  const { session } = state;
  const { sessionId } = session;
  const cwd = turn.cwd ?? session.cwd;

  return makeEnvelope(state, options, {
    allocation: allocate(options.context, cwd, session.branch),
    cwd,
    evidence: evidenceRef(options, turn.firstLine, null),
    fieldSemantics: [
      {
        field: "durationMs",
        method: "source-reported",
        note: "Agent run time for the turn; not human waiting time.",
        rawName: "duration_ms",
        unit: "ms",
      },
      {
        field: "toolCalls",
        method: "observed",
        note: "Tool-call response items seen after this turn started.",
        rawName: null,
        unit: "calls",
      },
    ],
    identity: { sessionId, turnId: turn.turnId },
    kind: "ai.turn",
    occurredAt: secondsToIso(turn.startedAt) ?? turn.firstTimestamp,
    payload: {
      abortReason: turn.abortReason,
      completedAt: secondsToIso(turn.completedAt),
      durationMs: turn.durationMs,
      effort: turn.effort,
      model: turn.model,
      startedAt: secondsToIso(turn.startedAt),
      status: turnStatus(turn),
      toolCalls: turn.toolCalls,
      toolNames: Object.fromEntries(turn.toolNames),
      turnKey:
        sessionId === null ? null : canonicalTurnKey(sessionId, turn.turnId),
      usageRecords: turn.usageRecords,
    },
    precision: turn.startedAt === null ? "exact" : "second",
    upstreamKey: `session:${sessionId ?? "unknown"}:turn:${turn.turnId}`,
  });
};

const usageEvent = (
  state: ParseState,
  options: CodexParseOptions,
  row: UsageRow
): DxEventEnvelope => {
  const { session } = state;
  const { sessionId } = session;
  const turn = row.turnId === null ? undefined : state.turns.get(row.turnId);
  const cwd = turn?.cwd ?? session.cwd;

  const requestKey = canonicalRequestKey({
    generationId: null,
    requestId: row.requestId,
    sessionId,
    sourceKind: "codex-session",
    turnIndex: null,
  });

  return makeEnvelope(state, options, {
    allocation: allocate(options.context, cwd, session.branch),
    cwd,
    evidence: evidenceRef(options, row.line, row.lineText),
    fieldSemantics: tokenSemantics(row.legacy),
    identity: { requestId: row.requestId, sessionId, turnId: row.turnId },
    kind: "ai.usage",
    occurredAt: row.timestamp,
    payload: {
      cost: COST_UNAVAILABLE,
      cumulativeVerified: false,
      ledger: "tokens",
      model: row.model,
      requestKey,
      requestKeyReason:
        requestKey === null
          ? "Legacy token_count emissions carry no response ID; the row stays unassigned for overlap."
          : null,
      tokens: usageFields(row.usage),
      usageSource: row.legacy ? "event_msg.token_count" : "token_usage_record",
    },
    precision: "exact",
    upstreamKey: row.upstreamKey,
  });
};

const coverageGaps = (state: ParseState, legacy: boolean): SourceGap[] => {
  const gaps: SourceGap[] = [
    {
      code: "cost-unavailable",
      message:
        "Codex rollouts report tokens only; charge and price stay unavailable.",
    },
    {
      code: "branch-allocation-provisional",
      message:
        "Codex does not record the Git branch per turn; allocation is by working directory and is at most provisional.",
    },
  ];

  if (legacy) {
    gaps.push({
      code: "legacy-token-count",
      message:
        "No token_usage_record lines; usage comes from token_count deltas without response IDs.",
    });
  }

  if (state.malformedLines > 0) {
    gaps.push({
      code: "malformed-lines",
      message: `${String(state.malformedLines)} line(s) were not valid JSON records and were skipped.`,
    });
  }

  if (state.session.sessionId === null) {
    gaps.push({
      code: "missing-session-meta",
      message: "No session_meta line; session identity is unavailable.",
    });
  }

  return gaps;
};

const coverageState = (
  state: ParseState,
  legacy: boolean,
  eventCount: number
): CoverageState => {
  if (eventCount === 0) {
    return "none";
  }

  const partial =
    state.malformedLines > 0 || legacy || state.session.sessionId === null;

  return partial ? "partial" : "complete";
};

export const parseCodexSession = (
  text: string,
  options: CodexParseOptions
): CodexParseResult => {
  const lines = text.split("\n");
  const state = scan(lines);
  const legacy = state.usageRows.length === 0 && state.legacyRows.length > 0;
  const usageRows = legacy ? state.legacyRows : state.usageRows;
  const session = sessionEvent(state, options, usageRows, legacy);

  const events: DxEventEnvelope[] = [
    ...(session === null ? [] : [session]),
    ...[...state.turns.values()].map((turn) => turnEvent(state, options, turn)),
    ...usageRows.map((row) => usageEvent(state, options, row)),
  ];

  const sorted = state.timestamps.toSorted();
  const windowTo = sorted.at(-1) ?? null;

  return {
    batch: {
      coverage: {
        adapterId: CODEX_ADAPTER_ID,
        expectedItems: null,
        gaps: coverageGaps(state, legacy),
        observedItems: events.length,
        state: coverageState(state, legacy, events.length),
        watermark: windowTo,
        windowFrom: sorted.at(0) ?? null,
        windowTo,
      },
      cursor: {
        adapterId: CODEX_ADAPTER_ID,
        value: `line:${String(lines.length)}`,
      },
      events,
    },
    duplicateUsageRecords: state.duplicateUsageRecords,
    malformedLines: state.malformedLines,
    recognizedLines: state.recognizedLines,
  };
};
