// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs need a synchronous deterministic sha256 inside the pure parser; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem, Option, Schema } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FieldSemantics,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION } from "../../model/event.js";
import {
  DescriptorIdSchema,
  EventIdSchema,
  RequestKeySchema,
} from "../../model/ids.js";

export const CURSOR_CLI_ADAPTER_ID = "cursor-cli";

export const CURSOR_CLI_ADAPTER_VERSION = "0.1.0";

export const CURSOR_CLI_PROBED_VERSION = "2026.09.28-64d2043";

export const CURSOR_CLI_FIXTURE_IDS = [
  "b10-cursor-cli-stream-json",
  "b10-cursor-cli-json",
  "b10-cursor-cli-store-db",
] as const;

const SOURCE_KIND = "cursor-cli";

const SQLITE_MAGIC = "SQLite format 3\u0000";

const NullableCount = Schema.optional(Schema.NullOr(Schema.Finite));

const UsageSchema = Schema.Struct({
  cacheReadTokens: NullableCount,
  cacheWriteTokens: NullableCount,
  inputTokens: NullableCount,
  outputTokens: NullableCount,
});

const LineSchema = Schema.Struct({
  apiKeySource: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  duration_api_ms: Schema.optional(Schema.Finite),
  duration_ms: Schema.optional(Schema.Finite),
  is_error: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String),
  request_id: Schema.optional(Schema.NullOr(Schema.String)),
  session_id: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  timestamp_ms: Schema.optional(Schema.Finite),
  tool_call: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  type: Schema.String,
  usage: Schema.optional(UsageSchema),
});

type Line = typeof LineSchema.Type;

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(LineSchema)
);

const BASE_GAPS: readonly SourceGap[] = [
  {
    code: "no-cost-in-cli-output",
    message:
      "cursor-agent print output reports no charge or price; money stays unavailable from this source.",
  },
  {
    code: "no-reasoning-tokens",
    message:
      "cursor-agent usage reports input/output/cacheRead/cacheWrite only; reasoning tokens are unavailable.",
  },
  {
    code: "no-branch-in-cli-output",
    message:
      "CLI output carries cwd but no Git branch; branch comes from the collect context only.",
  },
  {
    code: "may-overlap-hooks-stop",
    message:
      "The same turn may also be reported by Cursor Stop hooks; correlation must collapse by session/request, never sum.",
  },
];

export const cursorCliDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...CURSOR_CLI_FIXTURE_IDS],
  gaps: [
    ...BASE_GAPS,
    {
      code: "no-live-capture",
      message:
        "Decoder follows the installed cursor-agent 2026.09.28 emitter; no live run was captured on this host (agent login required).",
    },
    {
      code: "cli-store-db-unsupported",
      message:
        "Lowercase CLI chat store.db (~/.cursor/chats) holds protobuf blobs; layout unsupported and reported as a visible gap.",
    },
  ],
  id: DescriptorIdSchema.make("collector/cursor-cli"),
  kind: "collector",
  owner: "B10",
  readiness: "degraded",
  requiredInputs: [
    "user-selected file with `cursor-agent -p --output-format stream-json|json` stdout",
  ],
  supportedFields: [
    "identity.sessionId",
    "identity.requestId",
    "context.worktreePath",
    "payload.model",
    "payload.tokens.input",
    "payload.tokens.cached-input",
    "payload.tokens.cache-write",
    "payload.tokens.output",
    "payload.durationMs",
    "payload.durationApiMs",
    "payload.toolCalls",
    "payload.toolNames",
    "payload.isError",
  ],
  version: CURSOR_CLI_ADAPTER_VERSION,
};

const TOKEN_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "tokens.input",
    method: "source-reported",
    note: "cursor-agent subtracts cacheRead and cacheWrite before printing",
    rawName: "usage.inputTokens",
    unit: "tokens",
  },
  {
    field: "tokens.cached-input",
    method: "source-reported",
    note: null,
    rawName: "usage.cacheReadTokens",
    unit: "tokens",
  },
  {
    field: "tokens.cache-write",
    method: "source-reported",
    note: null,
    rawName: "usage.cacheWriteTokens",
    unit: "tokens",
  },
  {
    field: "tokens.output",
    method: "source-reported",
    note: null,
    rawName: "usage.outputTokens",
    unit: "tokens",
  },
];

const DURATION_SEMANTICS: FieldSemantics = {
  field: "durationMs",
  method: "source-reported",
  note: "wall time of the cursor-agent print run",
  rawName: "duration_ms",
  unit: "ms",
};

const TOOL_SEMANTICS: FieldSemantics = {
  field: "toolCalls",
  method: "observed",
  note: "count of tool_call completed lines in the same session",
  rawName: "tool_call",
  unit: "calls",
};

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

interface SessionState {
  cwd: string | null;
  lastTimestampMs: number | null;
  model: string | null;
  toolNames: string[];
}

const newSession = (): SessionState => ({
  cwd: null,
  lastTimestampMs: null,
  model: null,
  toolNames: [],
});

const toolNameOf = (line: Line): string => {
  const keys = Object.keys(line.tool_call ?? {});

  return keys[0] ?? "unknown";
};

const tally = (names: readonly string[]) => {
  const counts = new Map<string, number>();

  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return Object.fromEntries(counts);
};

const tokensOf = (line: Line) => {
  const { usage } = line;

  if (usage === undefined) {
    return null;
  }

  return {
    "cache-write": usage.cacheWriteTokens ?? null,
    "cached-input": usage.cacheReadTokens ?? null,
    input: usage.inputTokens ?? null,
    output: usage.outputTokens ?? null,
    reasoning: null,
    total: null,
  };
};

const toEnvelope = (
  line: Line,
  sessionId: string,
  session: SessionState,
  lineNo: number,
  input: CollectInput,
  observedAt: string
): DxEventEnvelope => {
  const requestId = line.request_id ?? null;

  const upstreamKey =
    requestId === null
      ? `${sessionId}:line:${lineNo}`
      : `${sessionId}:${requestId}`;

  const tokens = tokensOf(line);

  const occurredAt =
    session.lastTimestampMs === null
      ? null
      : Option.match(DateTime.make(session.lastTimestampMs), {
          onNone: () => null,
          onSome: DateTime.formatIso,
        });

  return {
    acquisition: "file-import",
    adapterId: CURSOR_CLI_ADAPTER_ID,
    adapterVersion: CURSOR_CLI_ADAPTER_VERSION,
    context: {
      ...input.context,
      worktreePath: input.context.worktreePath ?? session.cwd,
    },
    eventId: EventIdSchema.make(
      sha256(`${CURSOR_CLI_ADAPTER_ID}\u0000${upstreamKey}\u0000ai.usage`)
    ),
    evidence: {
      bounded: true,
      hash: null,
      ref: `cursor-cli://${input.selectedInput ?? "unknown"}#L${lineNo}`,
    },
    fieldSemantics: [
      ...(tokens === null ? [] : TOKEN_SEMANTICS),
      DURATION_SEMANTICS,
      TOOL_SEMANTICS,
    ],
    identity: {
      commitSha: null,
      generationId: null,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId,
      sessionId,
      turnId: null,
    },
    kind: "ai.usage",
    observedAt,
    occurredAt,
    occurredAtPrecision: occurredAt === null ? "unknown" : "exact",
    origin: input.origin,
    payload: {
      branchSource: input.context.branch === null ? null : "collect-context",
      charge: null,
      durationApiMs: line.duration_api_ms ?? null,
      durationMs: line.duration_ms ?? null,
      isError: line.is_error ?? null,
      listPriceEstimateUsd: null,
      model: session.model,
      requestKey:
        requestId === null
          ? null
          : RequestKeySchema.make(`source:${SOURCE_KIND}:request:${requestId}`),
      sourceKind: SOURCE_KIND,
      subtype: line.subtype ?? null,
      tokens,
      tokensUnavailableReason:
        tokens === null ? "result line carried no usage object" : null,
      toolCalls: session.toolNames.length,
      toolNames: tally(session.toolNames),
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: null,
    upstreamKey,
  };
};

const unsupportedStoreBatch = (): EventBatch => ({
  coverage: {
    adapterId: CURSOR_CLI_ADAPTER_ID,
    expectedItems: null,
    gaps: [
      {
        code: "cli-store-db-unsupported",
        message:
          "Selected input is a SQLite CLI chat store; its protobuf blob layout is not decoded. No events emitted.",
      },
    ],
    observedItems: 0,
    state: "unsupported",
    watermark: null,
    windowFrom: null,
    windowTo: null,
  },
  cursor: null,
  events: [],
});

const applyLine = (
  line: Line,
  sessions: Map<string, SessionState>,
  at: {
    readonly input: CollectInput;
    readonly lineNo: number;
    readonly observedAt: string;
  }
): DxEventEnvelope | null => {
  const sessionId = line.session_id ?? "unknown-session";
  const session = sessions.get(sessionId) ?? newSession();

  sessions.set(sessionId, session);

  if (line.timestamp_ms !== undefined) {
    session.lastTimestampMs = line.timestamp_ms;
  }

  if (line.type === "system" && line.subtype === "init") {
    session.model = line.model ?? session.model;
    session.cwd = line.cwd ?? session.cwd;

    return null;
  }

  if (line.type === "tool_call" && line.subtype === "completed") {
    session.toolNames.push(toolNameOf(line));

    return null;
  }

  if (line.type !== "result") {
    return null;
  }

  sessions.set(sessionId, newSession());

  return toEnvelope(
    line,
    sessionId,
    session,
    at.lineNo,
    at.input,
    at.observedAt
  );
};

export const parseCursorCliOutput = (
  text: string,
  input: CollectInput,
  observedAt: string
): EventBatch => {
  if (text.startsWith(SQLITE_MAGIC)) {
    return unsupportedStoreBatch();
  }

  const sessions = new Map<string, SessionState>();
  const events = new Map<string, DxEventEnvelope>();
  const counts = { considered: 0, rejected: 0, resultsWithoutUsage: 0 };

  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const trimmed = raw.trim();

    if (trimmed.length > 0) {
      counts.considered += 1;
      const decoded = decodeLine(trimmed);

      if (Option.isNone(decoded)) {
        counts.rejected += 1;
      } else {
        const envelope = applyLine(decoded.value, sessions, {
          input,
          lineNo: index + 1,
          observedAt,
        });

        if (envelope !== null) {
          counts.resultsWithoutUsage +=
            decoded.value.usage === undefined ? 1 : 0;
          events.set(envelope.eventId, envelope);
        }
      }
    }
  }

  const { considered, rejected, resultsWithoutUsage } = counts;

  const ordered = [...events.values()];

  const times = ordered
    .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
    .toSorted();

  const gaps: SourceGap[] = [...BASE_GAPS];

  if (rejected > 0) {
    gaps.push({
      code: "rejected-lines",
      message: `${rejected} line(s) were not cursor-agent JSON output and were skipped`,
    });
  }

  if (resultsWithoutUsage > 0) {
    gaps.push({
      code: "result-without-usage",
      message: `${resultsWithoutUsage} result line(s) had no usage object; tokens unavailable for them`,
    });
  }

  const unfinished = [...sessions.values()].filter(
    (session) => session.toolNames.length > 0 || session.model !== null
  ).length;

  if (unfinished > 0) {
    gaps.push({
      code: "run-without-result",
      message: `${unfinished} session run(s) ended without a result line (aborted or truncated output)`,
    });
  }

  return {
    coverage: {
      adapterId: CURSOR_CLI_ADAPTER_ID,
      expectedItems: considered,
      gaps,
      observedItems: ordered.length,
      state: ordered.length === 0 ? "none" : "partial",
      watermark: times.at(-1) ?? null,
      windowFrom: times.at(0) ?? null,
      windowTo: times.at(-1) ?? null,
    },
    cursor: null,
    events: ordered,
  };
};

export const cursorCliCollector: DxCollector<FileSystem.FileSystem> = {
  collect: (input) =>
    Effect.gen(function* collectCursorCli() {
      const path = input.selectedInput;

      if (path === null || path.length === 0) {
        return yield* new InvalidInput({
          field: "input",
          message:
            "cursor-cli reads only an explicitly selected cursor-agent output file (--input)",
        });
      }

      const fileSystem = yield* FileSystem.FileSystem;

      const text = yield* fileSystem.readFileString(path).pipe(
        Effect.mapError(
          () =>
            new SourceUnavailable({
              adapterId: CURSOR_CLI_ADAPTER_ID,
              message: "selected cursor-agent output file is not readable",
            })
        )
      );

      const now = yield* DateTime.now;

      return parseCursorCliOutput(text, input, DateTime.formatIso(now));
    }),
  descriptor: cursorCliDescriptor,
};
