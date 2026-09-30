import { Crypto, DateTime, Effect, Option, Predicate, Schema } from "effect";

import { canonicalRequestKey } from "../../model/ai.js";
import type { Origin } from "../../model/common.js";
import type { SourceCoverage, SourceGap } from "../../model/coverage.js";
import { EVENT_SCHEMA_VERSION } from "../../model/event.js";
import type {
  DxEventEnvelope,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";

export const CLAUDE_JSONL_ADAPTER_ID = "claude-jsonl";

export const CLAUDE_JSONL_ADAPTER_VERSION = "0.1.0";

const MAX_TOOL_NAMES = 50;

const EVENT_KIND = "ai.usage";

const SYNTHETIC_MODEL = "<synthetic>";

const LineTypeSchema = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String })
);

const TokenFieldSchema = Schema.optional(Schema.NullOr(Schema.Int));

const UsageSchema = Schema.Struct({
  cache_creation_input_tokens: TokenFieldSchema,
  cache_read_input_tokens: TokenFieldSchema,
  input_tokens: TokenFieldSchema,
  output_tokens: TokenFieldSchema,
});

const ContentBlockSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  type: Schema.String,
});

const AssistantLineSchema = Schema.fromJsonString(
  Schema.Struct({
    costUSD: Schema.optional(Schema.NullOr(Schema.Finite)),
    cwd: Schema.optional(Schema.NullOr(Schema.String)),
    gitBranch: Schema.optional(Schema.NullOr(Schema.String)),
    message: Schema.Struct({
      content: Schema.optional(
        Schema.Union([Schema.String, Schema.Array(ContentBlockSchema)])
      ),
      id: Schema.optional(Schema.NullOr(Schema.String)),
      model: Schema.optional(Schema.NullOr(Schema.String)),
      usage: Schema.optional(Schema.NullOr(UsageSchema)),
    }),
    requestId: Schema.optional(Schema.NullOr(Schema.String)),
    sessionId: Schema.optional(Schema.NullOr(Schema.String)),
    timestamp: Schema.optional(Schema.NullOr(Schema.String)),
    type: Schema.Literal("assistant"),
    version: Schema.optional(Schema.NullOr(Schema.String)),
  })
);

type AssistantLine = typeof AssistantLineSchema.Type;

type ContentBlocks = AssistantLine["message"]["content"];

interface TokenCounts {
  readonly "cache-write": number | null;
  readonly "cached-input": number | null;
  readonly input: number | null;
  readonly output: number | null;
}

const EMPTY_TOKENS: TokenCounts = {
  "cache-write": null,
  "cached-input": null,
  input: null,
  output: null,
};

interface AssistantRow {
  readonly costUsd: number | null;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly lineNo: number;
  readonly messageId: string | null;
  readonly model: string | null;
  readonly raw: string;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly timestamp: string | null;
  readonly tokens: TokenCounts | null;
  readonly toolNames: readonly string[];
  readonly version: string | null;
}

export interface ParseOptions {
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly sourceName: string;
}

export interface ParseResult {
  readonly coverage: SourceCoverage;
  readonly events: readonly DxEventEnvelope[];
  readonly lineCount: number;
  readonly sourceVersion: string | null;
}

interface Tally {
  lineCount: number;
  malformed: number;
  missingIdentity: number;
  missingUsage: number;
  synthetic: number;
  unparsedAssistant: number;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digestSha256 = (value: string) =>
  Effect.gen(function* digestSha256Gen() {
    const crypto = yield* Crypto.Crypto;

    const bytes = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );

    return `sha256:${toHex(bytes)}`;
  });

const nonEmpty = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === "" ? null : value;

const readToolNames = (content: ContentBlocks): readonly string[] => {
  if (content === undefined || Predicate.isString(content)) {
    return [];
  }

  return content.flatMap((block) =>
    block.type === "tool_use" ? [block.name ?? "unknown"] : []
  );
};

const toRow = (line: AssistantLine, raw: string, lineNo: number) => {
  const { message } = line;
  const { usage } = message;

  const tokens: TokenCounts | null =
    usage === undefined || usage === null
      ? null
      : {
          "cache-write": usage.cache_creation_input_tokens ?? null,
          "cached-input": usage.cache_read_input_tokens ?? null,
          input: usage.input_tokens ?? null,
          output: usage.output_tokens ?? null,
        };

  return {
    costUsd: line.costUSD ?? null,
    cwd: nonEmpty(line.cwd),
    gitBranch: nonEmpty(line.gitBranch),
    lineNo,
    messageId: nonEmpty(message.id),
    model: nonEmpty(message.model),
    raw,
    requestId: nonEmpty(line.requestId),
    sessionId: nonEmpty(line.sessionId),
    timestamp: nonEmpty(line.timestamp),
    tokens,
    toolNames: readToolNames(message.content),
    version: nonEmpty(line.version),
  } satisfies AssistantRow;
};

const normalizeTime = (value: string | null) =>
  Option.match(value === null ? Option.none() : DateTime.make(value), {
    onNone: () => ({ at: null, precision: "unknown" as const }),
    onSome: (at) => ({
      at: DateTime.formatIso(at),
      precision: "exact" as const,
    }),
  });

const TOKEN_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "tokens.input",
    method: "source-reported",
    note: null,
    rawName: "message.usage.input_tokens",
    unit: "tokens",
  },
  {
    field: "tokens.cached-input",
    method: "source-reported",
    note: null,
    rawName: "message.usage.cache_read_input_tokens",
    unit: "tokens",
  },
  {
    field: "tokens.cache-write",
    method: "source-reported",
    note: null,
    rawName: "message.usage.cache_creation_input_tokens",
    unit: "tokens",
  },
  {
    field: "tokens.output",
    method: "source-reported",
    note: "last streamed row of the request wins; repeated rows are not summed",
    rawName: "message.usage.output_tokens",
    unit: "tokens",
  },
  {
    field: "charge",
    method: "source-reported",
    note: "Claude JSONL carries no billed charge: unavailable, not zero",
    rawName: null,
    unit: "USD",
  },
  {
    field: "toolCalls",
    method: "observed",
    note: "count of tool_use content blocks; names only, no inputs",
    rawName: "message.content[].type=tool_use",
    unit: "calls",
  },
];

const COST_SEMANTICS: FieldSemantics = {
  field: "listPriceEstimateUsd",
  method: "estimated",
  note: "Claude Code costUSD is a client-side list-price estimate, never a charge",
  rawName: "costUSD",
  unit: "USD",
};

const tallyTools = (names: readonly string[]) => {
  const tally = new Map<string, number>();

  for (const name of names) {
    if (tally.has(name) || tally.size < MAX_TOOL_NAMES) {
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
  }

  return Object.fromEntries(tally);
};

const groupKeyOf = (row: AssistantRow): string => {
  if (row.requestId !== null) {
    return `request:${row.requestId}`;
  }

  const session = `session:${row.sessionId ?? "unknown"}`;

  if (row.messageId !== null) {
    return `${session}:message:${row.messageId}`;
  }

  return `${session}:line:${String(row.lineNo)}`;
};

const branchSourceOf = (
  row: AssistantRow,
  context: FlightContext
): string | null => {
  if (row.gitBranch !== null) {
    return "claude-jsonl";
  }

  return context.branch === null ? null : "collect-context";
};

const buildEvent = (
  rows: readonly [AssistantRow, ...AssistantRow[]],
  upstreamKey: string,
  options: ParseOptions,
  hashes: { readonly eventId: string; readonly evidence: string }
): DxEventEnvelope => {
  const [first] = rows;
  const final = rows.findLast((row) => row.tokens !== null) ?? null;
  const toolNames = rows.flatMap((row) => row.toolNames);

  const costs = rows.flatMap((row) =>
    row.costUsd === null ? [] : [row.costUsd]
  );

  const time = normalizeTime(first.timestamp);
  const lines = rows.map((row) => row.lineNo);

  const requestKey = canonicalRequestKey({
    generationId: first.messageId,
    requestId: first.requestId,
    sessionId: first.sessionId,
    sourceKind: "claude-jsonl",
    turnIndex: null,
  });

  return {
    acquisition: "file-import",
    adapterId: CLAUDE_JSONL_ADAPTER_ID,
    adapterVersion: CLAUDE_JSONL_ADAPTER_VERSION,
    context: {
      ...options.context,
      branch: first.gitBranch ?? options.context.branch,
      worktreePath: options.context.worktreePath ?? first.cwd,
    },
    eventId: EventIdSchema.make(hashes.eventId),
    evidence: {
      bounded: true,
      hash: hashes.evidence,
      ref: `claude-jsonl://${options.sourceName}#lines:${String(Math.min(...lines))}-${String(Math.max(...lines))}`,
    },
    fieldSemantics:
      costs.length > 0 ? [...TOKEN_SEMANTICS, COST_SEMANTICS] : TOKEN_SEMANTICS,
    identity: {
      commitSha: null,
      generationId: first.messageId,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: first.requestId,
      sessionId: first.sessionId,
      turnId: null,
    },
    kind: EVENT_KIND,
    observedAt: options.observedAt,
    occurredAt: time.at,
    occurredAtPrecision: time.precision,
    origin: options.origin,
    payload: {
      branchSource: branchSourceOf(first, options.context),
      charge: null,
      listPriceEstimateUsd: costs.at(-1) ?? null,
      model: final?.model ?? first.model,
      requestKey,
      rowCount: rows.length,
      sourceKind: "claude-jsonl",
      tokens: final?.tokens ?? EMPTY_TOKENS,
      toolCalls: toolNames.length,
      toolNames: tallyTools(toolNames),
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: first.version,
    upstreamKey,
  };
};

const collectRows = (text: string, tally: Tally) => {
  const groups = new Map<string, [AssistantRow, ...AssistantRow[]]>();

  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    if (raw.trim() === "") {
      continue;
    }

    tally.lineCount += 1;
    const head = Schema.decodeOption(LineTypeSchema)(raw);

    if (Option.isNone(head)) {
      tally.malformed += 1;
      continue;
    }

    if (head.value.type !== "assistant") {
      continue;
    }

    const line = Schema.decodeOption(AssistantLineSchema)(raw);

    if (Option.isNone(line)) {
      tally.unparsedAssistant += 1;
      continue;
    }

    const row = toRow(line.value, raw, index + 1);

    if (row.model === SYNTHETIC_MODEL) {
      tally.synthetic += 1;
      continue;
    }

    const key = groupKeyOf(row);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, [row]);
    } else {
      existing.push(row);
    }
  }

  return groups;
};

const gapsOf = (tally: Tally): SourceGap[] => {
  const gaps: SourceGap[] = [
    {
      code: "charge-unavailable",
      message:
        "Claude JSONL has no billed charge; money stays unavailable unless a billing source is imported",
    },
  ];

  const optional: readonly [number, string, string][] = [
    [
      tally.malformed,
      "malformed-lines",
      "line(s) were not JSON and were skipped",
    ],
    [
      tally.unparsedAssistant,
      "unparsed-assistant-rows",
      "assistant row(s) had an unexpected shape and were skipped",
    ],
    [
      tally.synthetic,
      "synthetic-rows",
      "client-generated <synthetic> row(s) excluded from usage",
    ],
    [
      tally.missingUsage,
      "usage-missing",
      "request(s) had no usage block; tokens unavailable",
    ],
    [
      tally.missingIdentity,
      "request-id-missing",
      "request(s) lacked requestId; no canonical cross-source key",
    ],
  ];

  for (const [amount, code, message] of optional) {
    if (amount > 0) {
      gaps.push({ code, message: `${String(amount)} ${message}` });
    }
  }

  return gaps;
};

const coverageState = (events: number, tally: Tally) => {
  if (events === 0) {
    return "none" as const;
  }

  const degraded =
    tally.malformed +
    tally.unparsedAssistant +
    tally.synthetic +
    tally.missingUsage;

  return degraded > 0 ? ("partial" as const) : ("complete" as const);
};

export const parseClaudeJsonl = Effect.fn("parseClaudeJsonl")(
  function* parseClaudeJsonl(text: string, options: ParseOptions) {
    const tally: Tally = {
      lineCount: 0,
      malformed: 0,
      missingIdentity: 0,
      missingUsage: 0,
      synthetic: 0,
      unparsedAssistant: 0,
    };

    const groups = collectRows(text, tally);
    const events: DxEventEnvelope[] = [];

    for (const [key, rows] of groups) {
      tally.missingUsage += rows.every((row) => row.tokens === null) ? 1 : 0;
      tally.missingIdentity += rows[0].requestId === null ? 1 : 0;

      const eventId = yield* digestSha256(
        `${CLAUDE_JSONL_ADAPTER_ID}\n${key}\n${EVENT_KIND}`
      );

      const evidence = yield* digestSha256(
        rows.map((row) => row.raw).join("\n")
      );

      events.push(buildEvent(rows, key, options, { eventId, evidence }));
    }

    const times = events
      .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
      .toSorted();

    const result: ParseResult = {
      coverage: {
        adapterId: CLAUDE_JSONL_ADAPTER_ID,
        expectedItems: null,
        gaps: gapsOf(tally),
        observedItems: events.length,
        state: coverageState(events.length, tally),
        watermark: times.at(-1) ?? null,
        windowFrom: times[0] ?? null,
        windowTo: times.at(-1) ?? null,
      },
      events,
      lineCount: tally.lineCount,
      sourceVersion:
        events.find((event) => event.sourceVersion !== null)?.sourceVersion ??
        null,
    };

    return result;
  }
);
