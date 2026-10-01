// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { Option, Schema } from "effect";

import { withCollectorBlocks } from "../../harness/collector-blocks.js";
import { canonicalRequestKey, canonicalTurnKey } from "../../model/ai.js";
import type { Origin } from "../../model/common.js";
import type { SourceGap } from "../../model/coverage.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";

export const ENTIRE_ADAPTER_ID = "entire";

export const ENTIRE_ADAPTER_VERSION = "0.1.0";

const MAX_TOOL_NAMES = 40;

const OptString = Schema.optional(Schema.NullOr(Schema.String));

const OptNumber = Schema.optional(Schema.NullOr(Schema.Finite));

const TokenUsageFields = {
  api_call_count: OptNumber,
  cache_creation_tokens: OptNumber,
  cache_read_tokens: OptNumber,
  input_tokens: OptNumber,
  output_tokens: OptNumber,
};

const TokenUsageSchema = Schema.Struct({
  ...TokenUsageFields,
  subagent_tokens: Schema.optional(
    Schema.NullOr(Schema.Struct(TokenUsageFields))
  ),
});

type TokenUsage = typeof TokenUsageSchema.Type;

const AttributionSchema = Schema.Struct({
  agent_lines: OptNumber,
  agent_percentage: OptNumber,
  human_added: OptNumber,
  human_modified: OptNumber,
  human_removed: OptNumber,
  total_committed: OptNumber,
});

const SessionMetadataSchema = Schema.fromJsonString(
  Schema.Struct({
    agent: OptString,
    branch: OptString,
    checkpoint_id: Schema.String,
    checkpoint_transcript_start: OptNumber,
    created_at: OptString,
    files_touched: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    initial_attribution: Schema.optional(Schema.NullOr(AttributionSchema)),
    model: OptString,
    session_id: Schema.String,
    strategy: OptString,
    token_usage: Schema.optional(Schema.NullOr(TokenUsageSchema)),
    turn_id: OptString,
  })
);

type SessionMetadata = typeof SessionMetadataSchema.Type;

const RootMetadataSchema = Schema.fromJsonString(
  Schema.Struct({
    branch: OptString,
    checkpoint_id: Schema.String,
    checkpoints_count: OptNumber,
    files_touched: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    sessions: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    strategy: OptString,
    token_usage: Schema.optional(Schema.NullOr(TokenUsageSchema)),
  })
);

type RootMetadata = typeof RootMetadataSchema.Type;

const TranscriptLineSchema = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          content: Schema.optional(Schema.Unknown),
        })
      )
    ),
    type: OptString,
  })
);

const ToolUseSchema = Schema.Struct({
  name: OptString,
  type: Schema.Literal("tool_use"),
});

const decodeSession = Schema.decodeUnknownOption(SessionMetadataSchema);

const decodeRoot = Schema.decodeUnknownOption(RootMetadataSchema);

const decodeTranscriptLine = Schema.decodeUnknownOption(TranscriptLineSchema);

const decodeToolUse = Schema.decodeUnknownOption(ToolUseSchema);

export interface EntireInputFile {
  readonly relPath: string;
  readonly text: string;
}

export interface EntireParseOptions {
  readonly context: FlightContext;
  readonly evidenceName: string;
  readonly observedAt: string;
  readonly origin: Origin;
}

export interface EntireParseResult {
  readonly batch: EventBatch;
  readonly duplicateSessionRecords: number;
  readonly malformedFiles: number;
  readonly recognizedFiles: number;
}

interface SessionRow {
  readonly dir: string;
  readonly meta: SessionMetadata;
  readonly relPath: string;
  readonly text: string;
}

interface UsageWindow {
  readonly endLine: number | null;
  readonly kind: "delta" | "single" | "cumulative-unverified-latest";
  readonly startLine: number | null;
  readonly supersededCheckpoints: readonly string[];
}

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const makeEventId = (upstreamKey: string, kind: EventKind) =>
  EventIdSchema.make(
    sha256(`${ENTIRE_ADAPTER_ID}\u0000${upstreamKey}\u0000${kind}`)
  );

const COST_UNAVAILABLE = {
  reason:
    "Entire checkpoints record tokens only; charge and list price are unavailable.",
  state: "unavailable",
  value: null,
} as const;

const ALLOCATION_PROVISIONAL = {
  reason:
    "Entire records the branch at checkpoint time; branch and line attribution are the source's heuristic.",
  state: "provisional",
} as const;

const segments = (path: string): readonly string[] =>
  path.split("/").filter((part) => part !== "" && part !== ".");

const isNumeric = (part: string | undefined): boolean =>
  part !== undefined && /^\d+$/u.test(part);

const num = (value: number | null | undefined): number | null =>
  value === undefined ? null : value;

const tokenFields = (usage: TokenUsage | null | undefined) => ({
  apiCallCount: num(usage?.api_call_count),
  cacheWrite: num(usage?.cache_creation_tokens),
  cachedInput: num(usage?.cache_read_tokens),
  input: num(usage?.input_tokens),
  output: num(usage?.output_tokens),
  total: null,
});

const subagentFields = (usage: TokenUsage | null | undefined) =>
  usage?.subagent_tokens === undefined || usage.subagent_tokens === null
    ? null
    : tokenFields(usage.subagent_tokens);

const tokenSemantics: readonly FieldSemantics[] = [
  {
    field: "tokens.input",
    method: "source-reported",
    note: null,
    rawName: "input_tokens",
    unit: "tokens",
  },
  {
    field: "tokens.cachedInput",
    method: "source-reported",
    note: null,
    rawName: "cache_read_tokens",
    unit: "tokens",
  },
  {
    field: "tokens.cacheWrite",
    method: "source-reported",
    note: null,
    rawName: "cache_creation_tokens",
    unit: "tokens",
  },
  {
    field: "tokens.output",
    method: "source-reported",
    note: null,
    rawName: "output_tokens",
    unit: "tokens",
  },
  {
    field: "tokens.total",
    method: "source-reported",
    note: "Entire reports no total; left unavailable rather than derived.",
    rawName: null,
    unit: "tokens",
  },
  {
    field: "subagentTokens",
    method: "source-reported",
    note: "Kept separate; never added to the parent counts.",
    rawName: "subagent_tokens",
    unit: "tokens",
  },
];

const orderKey = (row: SessionRow): string =>
  `${row.meta.created_at ?? ""}\u0000${row.meta.checkpoint_id}`;

const planWindows = (
  rows: readonly SessionRow[],
  transcriptLines: (row: SessionRow) => number | null
): Map<SessionRow, UsageWindow> => {
  const windows = new Map<SessionRow, UsageWindow>();

  const sorted = rows.toSorted((a, b) =>
    orderKey(a).localeCompare(orderKey(b))
  );

  if (sorted.length === 1) {
    const [row] = sorted;

    if (row !== undefined) {
      windows.set(row, {
        endLine: transcriptLines(row),
        kind: "single",
        startLine: num(row.meta.checkpoint_transcript_start),
        supersededCheckpoints: [],
      });
    }

    return windows;
  }

  const starts = sorted.map((row) => num(row.meta.checkpoint_transcript_start));

  const strictlyIncreasing = starts.every(
    (start, index) =>
      start !== null &&
      (index === 0 || start > (starts[index - 1] ?? Number.POSITIVE_INFINITY))
  );

  if (strictlyIncreasing) {
    for (const [index, row] of sorted.entries()) {
      windows.set(row, {
        endLine: starts[index + 1] ?? transcriptLines(row),
        kind: "delta",
        startLine: starts[index] ?? null,
        supersededCheckpoints: [],
      });
    }

    return windows;
  }

  const latest = sorted.at(-1);

  if (latest !== undefined) {
    windows.set(latest, {
      endLine: transcriptLines(latest),
      kind: "cumulative-unverified-latest",
      startLine: null,
      supersededCheckpoints: sorted
        .slice(0, -1)
        .map((row) => row.meta.checkpoint_id),
    });
  }

  return windows;
};

const summarizeTranscript = (
  text: string,
  startLine: number | null,
  endLine: number | null
) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const from = Math.max(0, startLine ?? 0);
  const to = Math.min(lines.length, endLine ?? lines.length);
  const toolNames = new Map<string, number>();
  let assistantMessages = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let malformed = 0;

  for (const line of lines.slice(from, Math.max(from, to))) {
    const decoded = decodeTranscriptLine(line);

    if (Option.isNone(decoded)) {
      malformed += 1;
      continue;
    }

    const record = decoded.value;

    if (record.type === "assistant") {
      assistantMessages += 1;
    } else if (record.type === "user") {
      userMessages += 1;
    }

    const content = record.message?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        const tool = decodeToolUse(block);

        if (Option.isSome(tool)) {
          toolCalls += 1;
          const name = tool.value.name ?? "unknown";

          if (toolNames.has(name) || toolNames.size < MAX_TOOL_NAMES) {
            toolNames.set(name, (toolNames.get(name) ?? 0) + 1);
          }
        }
      }
    }
  }

  return {
    assistantMessages,
    malformedLines: malformed,
    toolCalls,
    toolNames: Object.fromEntries(toolNames),
    totalLines: lines.length,
    userMessages,
    windowEndLine: to,
    windowLines: Math.max(0, to - from),
    windowStartLine: from,
  };
};

const lineCount = (text: string): number =>
  text.split("\n").filter((line) => line.trim() !== "").length;

const minMax = (values: readonly string[]) => {
  const sorted = values.toSorted();

  return { max: sorted.at(-1) ?? null, min: sorted[0] ?? null };
};

interface RootRow {
  readonly meta: RootMetadata;
  readonly relPath: string;
  readonly text: string;
}

interface Classified {
  readonly duplicateSessionRecords: number;
  readonly malformedFiles: number;
  readonly recognizedFiles: number;
  readonly roots: ReadonlyMap<string, RootRow>;
  readonly sessionRows: readonly SessionRow[];
  readonly transcripts: ReadonlyMap<string, string>;
}

const classifyFiles = (files: readonly EntireInputFile[]): Classified => {
  const roots = new Map<string, RootRow>();
  const sessionRows: SessionRow[] = [];
  const transcripts = new Map<string, string>();
  const seenPairs = new Set<string>();
  let malformedFiles = 0;
  let recognizedFiles = 0;
  let duplicateSessionRecords = 0;

  for (const file of files.toSorted((a, b) =>
    a.relPath.localeCompare(b.relPath)
  )) {
    const parts = segments(file.relPath);
    const name = parts.at(-1);
    const dir = parts.slice(0, -1).join("/");
    const inSessionDir = isNumeric(parts.at(-2));

    if (name === "full.jsonl" && inSessionDir) {
      transcripts.set(dir, file.text);
      recognizedFiles += 1;
      continue;
    }

    if (name !== "metadata.json") {
      continue;
    }

    if (inSessionDir) {
      const decoded = decodeSession(file.text);

      if (Option.isNone(decoded)) {
        malformedFiles += 1;
        continue;
      }

      recognizedFiles += 1;
      const pair = `${decoded.value.checkpoint_id}\u0000${decoded.value.session_id}`;

      if (seenPairs.has(pair)) {
        duplicateSessionRecords += 1;
        continue;
      }

      seenPairs.add(pair);
      sessionRows.push({
        dir,
        meta: decoded.value,
        relPath: file.relPath,
        text: file.text,
      });
      continue;
    }

    const decoded = decodeRoot(file.text);

    if (Option.isNone(decoded)) {
      malformedFiles += 1;
      continue;
    }

    recognizedFiles += 1;

    if (!roots.has(decoded.value.checkpoint_id)) {
      roots.set(decoded.value.checkpoint_id, {
        meta: decoded.value,
        relPath: file.relPath,
        text: file.text,
      });
    }
  }

  return {
    duplicateSessionRecords,
    malformedFiles,
    recognizedFiles,
    roots,
    sessionRows,
    transcripts,
  };
};

interface EnvelopeParts {
  readonly branch: string | null | undefined;
  readonly evidence: DxEventEnvelope["evidence"];
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly identity: Partial<DxEventEnvelope["identity"]>;
  readonly occurredAt: string | null;
  readonly payload: DxEventEnvelope["payload"];
}

type Emit = (
  kind: EventKind,
  upstreamKey: string,
  parts: EnvelopeParts
) => void;

const makeEmitter = (
  options: EntireParseOptions,
  events: DxEventEnvelope[],
  timestamps: string[]
): Emit => {
  const contextFor = (branch: string | null | undefined): FlightContext =>
    branch === null || branch === undefined || branch === ""
      ? options.context
      : { ...options.context, branch };

  return (kind, upstreamKey, parts) => {
    if (parts.occurredAt !== null) {
      timestamps.push(parts.occurredAt);
    }

    events.push(
      withCollectorBlocks({
        acquisition: "file-import",
        adapterId: ENTIRE_ADAPTER_ID,
        adapterVersion: ENTIRE_ADAPTER_VERSION,
        context: contextFor(parts.branch),
        eventId: makeEventId(upstreamKey, kind),
        evidence: parts.evidence,
        fieldSemantics: parts.fieldSemantics,
        identity: { ...emptyEventIdentity, ...parts.identity },
        kind,
        observedAt: options.observedAt,
        occurredAt: parts.occurredAt,
        occurredAtPrecision: parts.occurredAt === null ? "unknown" : "exact",
        origin: options.origin,
        payload: {
          ...parts.payload,
          allocation: ALLOCATION_PROVISIONAL,
          sourceKind: ENTIRE_ADAPTER_ID,
        },
        schemaVersion: EVENT_SCHEMA_VERSION,
        sourceVersion: null,
        upstreamKey,
      })
    );
  };
};

const evidenceFor =
  (evidenceName: string) => (relPath: string, text: string | null) => ({
    bounded: true,
    hash: text === null ? null : sha256(text),
    ref: `${ENTIRE_ADAPTER_ID}:${evidenceName}/${relPath}`,
  });

const earliestCheckpointTimes = (
  rows: readonly SessionRow[]
): ReadonlyMap<string, string> => {
  const times = new Map<string, string>();

  for (const row of rows) {
    const created = row.meta.created_at ?? null;
    const known = times.get(row.meta.checkpoint_id);

    if (created !== null && (known === undefined || created < known)) {
      times.set(row.meta.checkpoint_id, created);
    }
  }

  return times;
};

const emitRoots = (
  classified: Classified,
  emit: Emit,
  evidence: ReturnType<typeof evidenceFor>
) => {
  const times = earliestCheckpointTimes(classified.sessionRows);

  for (const [checkpointId, root] of classified.roots) {
    emit("provenance.attestation", `checkpoint:${checkpointId}`, {
      branch: root.meta.branch,
      evidence: evidence(root.relPath, root.text),
      fieldSemantics: [
        {
          field: "rootTokenUsage",
          method: "source-reported",
          note: "Aggregate over the checkpoint's sessions; an alternative ledger, never summed with per-session usage.",
          rawName: "token_usage",
          unit: "tokens",
        },
      ],
      identity: {},
      occurredAt: times.get(checkpointId) ?? null,
      payload: {
        checkpointId,
        checkpointsCount: num(root.meta.checkpoints_count),
        commitLink:
          "Entire links commits through an Entire-Checkpoint trailer; this import does not read Git history.",
        filesTouchedCount: root.meta.files_touched?.length ?? null,
        rootTokenUsage: {
          ledgerRole: "aggregate-alternative",
          summedIntoTotals: false,
          tokens: tokenFields(root.meta.token_usage),
        },
        sessionCount: root.meta.sessions?.length ?? null,
        strategy: root.meta.strategy ?? null,
      },
    });
  }
};

const attributionOf = (meta: SessionMetadata) => {
  const source = meta.initial_attribution;

  if (source === undefined || source === null) {
    return null;
  }

  return {
    agentLines: num(source.agent_lines),
    agentPercentage: num(source.agent_percentage),
    humanAdded: num(source.human_added),
    humanModified: num(source.human_modified),
    humanRemoved: num(source.human_removed),
    state: "provisional",
    totalCommitted: num(source.total_committed),
  };
};

const usageSemantics: readonly FieldSemantics[] = [
  ...tokenSemantics,
  {
    field: "attribution",
    method: "source-reported",
    note: "Entire's line-level heuristic; provisional, not proof of AI ownership.",
    rawName: "initial_attribution",
    unit: "lines",
  },
];

const windowSemantics: readonly FieldSemantics[] = [
  {
    field: "toolCalls",
    method: "observed",
    note: "tool_use blocks inside this checkpoint's transcript window only.",
    rawName: "tool_use",
    unit: "calls",
  },
];

const emitRow = (
  row: SessionRow,
  window: UsageWindow | undefined,
  transcript: string | undefined,
  emit: Emit,
  evidence: ReturnType<typeof evidenceFor>
): boolean => {
  const sessionId = row.meta.session_id;
  const checkpointId = row.meta.checkpoint_id;
  const occurredAt = row.meta.created_at ?? null;
  const turnKey = canonicalTurnKey(sessionId, checkpointId);

  const identity = {
    generationId: checkpointId,
    sessionId,
    turnId: row.meta.turn_id ?? null,
  };

  if (transcript !== undefined) {
    emit("ai.turn", `checkpoint:${checkpointId}:session:${sessionId}:window`, {
      branch: row.meta.branch,
      evidence: evidence(`${row.dir}/full.jsonl`, transcript),
      fieldSemantics: windowSemantics,
      identity,
      occurredAt,
      payload: {
        checkpointId,
        model: row.meta.model ?? null,
        tokensFromTranscript: null,
        tokensNote:
          "Transcript usage is not re-read; checkpoint metadata is the only token source to avoid double counting.",
        transcriptWindow: summarizeTranscript(
          transcript,
          window?.startLine ?? num(row.meta.checkpoint_transcript_start),
          window?.endLine ?? null
        ),
        turnKey,
        windowKind: window?.kind ?? "superseded",
      },
    });
  }

  if (window === undefined) {
    return false;
  }

  emit("ai.usage", `checkpoint:${checkpointId}:session:${sessionId}:usage`, {
    branch: row.meta.branch,
    evidence: evidence(row.relPath, row.text),
    fieldSemantics: usageSemantics,
    identity,
    occurredAt,
    payload: {
      attribution: attributionOf(row.meta),
      checkpointId,
      cost: COST_UNAVAILABLE,
      cumulativeVerified: false,
      filesTouchedCount: row.meta.files_touched?.length ?? null,
      ledger: "tokens",
      model: row.meta.model ?? null,
      requestKey: canonicalRequestKey({
        generationId: checkpointId,
        requestId: null,
        sessionId,
        sourceKind: "entire",
        turnIndex: null,
      }),
      subagentTokens: subagentFields(row.meta.token_usage),
      supersededCheckpoints: window.supersededCheckpoints,
      tokens: tokenFields(row.meta.token_usage),
      turnKey,
      windowKind: window.kind,
    },
  });

  return true;
};

const emitSessions = (
  classified: Classified,
  emit: Emit,
  evidence: ReturnType<typeof evidenceFor>
): number => {
  const bySession = new Map<string, SessionRow[]>();

  for (const row of classified.sessionRows) {
    const group = bySession.get(row.meta.session_id) ?? [];
    group.push(row);
    bySession.set(row.meta.session_id, group);
  }

  let collapsed = 0;

  for (const [sessionId, rows] of bySession) {
    const [first] = rows;

    const windows = planWindows(rows, (row) => {
      const transcript = classified.transcripts.get(row.dir);

      return transcript === undefined ? null : lineCount(transcript);
    });

    const created = rows
      .map((row) => row.meta.created_at ?? null)
      .filter((value): value is string => value !== null)
      .toSorted();

    emit("ai.session", `session:${sessionId}`, {
      branch: first?.meta.branch,
      evidence: evidence(first?.relPath ?? "", first?.text ?? null),
      fieldSemantics: [],
      identity: { sessionId },
      occurredAt: created[0] ?? null,
      payload: {
        agent: first?.meta.agent ?? null,
        checkpointIds: rows.map((row) => row.meta.checkpoint_id).toSorted(),
        cost: COST_UNAVAILABLE,
        model: first?.meta.model ?? null,
        sessionId,
      },
    });

    for (const row of rows) {
      const counted = emitRow(
        row,
        windows.get(row),
        classified.transcripts.get(row.dir),
        emit,
        evidence
      );

      if (!counted) {
        collapsed += 1;
      }
    }
  }

  return collapsed;
};

const buildGaps = (
  classified: Classified,
  collapsedCumulative: number
): SourceGap[] => {
  const gaps: SourceGap[] = [
    {
      code: "cost-unavailable",
      message:
        "Entire checkpoints report tokens only; charge and list price stay unavailable.",
    },
    {
      code: "attribution-source-heuristic",
      message:
        "Branch and line attribution come from Entire's own heuristic; allocation is provisional, never strong AI ownership.",
    },
  ];

  if (collapsedCumulative > 0) {
    gaps.push({
      code: "cumulative-unverified-collapsed",
      message: `${String(collapsedCumulative)} checkpoint usage record(s) lacked strictly increasing transcript offsets; only each session's latest checkpoint is counted, so usage may be understated.`,
    });
  }

  if (classified.duplicateSessionRecords > 0) {
    gaps.push({
      code: "duplicate-session-records",
      message: `${String(classified.duplicateSessionRecords)} repeated checkpoint/session record(s) were skipped.`,
    });
  }

  if (classified.malformedFiles > 0) {
    gaps.push({
      code: "malformed-files",
      message: `${String(classified.malformedFiles)} metadata file(s) did not match the Entire checkpoint layout and were skipped.`,
    });
  }

  return gaps;
};

const coverageState = (
  eventCount: number,
  classified: Classified,
  collapsedCumulative: number
) => {
  if (eventCount === 0) {
    return "none" as const;
  }

  return classified.malformedFiles > 0 || collapsedCumulative > 0
    ? ("partial" as const)
    : ("complete" as const);
};

export const parseEntireCheckpoints = (
  files: readonly EntireInputFile[],
  options: EntireParseOptions
): EntireParseResult => {
  const classified = classifyFiles(files);
  const events: DxEventEnvelope[] = [];
  const timestamps: string[] = [];
  const emit = makeEmitter(options, events, timestamps);
  const evidence = evidenceFor(options.evidenceName);

  emitRoots(classified, emit, evidence);
  const collapsedCumulative = emitSessions(classified, emit, evidence);
  const window = minMax(timestamps);

  return {
    batch: {
      coverage: {
        adapterId: ENTIRE_ADAPTER_ID,
        expectedItems: null,
        gaps: buildGaps(classified, collapsedCumulative),
        observedItems: events.length,
        state: coverageState(events.length, classified, collapsedCumulative),
        watermark: window.max,
        windowFrom: window.min,
        windowTo: window.max,
      },
      cursor: {
        adapterId: ENTIRE_ADAPTER_ID,
        value: `files:${String(classified.recognizedFiles)}`,
      },
      events,
    },
    duplicateSessionRecords: classified.duplicateSessionRecords,
    malformedFiles: classified.malformedFiles,
    recognizedFiles: classified.recognizedFiles,
  };
};
