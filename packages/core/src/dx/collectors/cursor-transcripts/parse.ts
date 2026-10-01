import { Crypto, Effect, Option, Schema } from "effect";

import { withCollectorBlocks } from "../../harness/collector-blocks.js";
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
import type { MappedUsage, UsageCounters, UsageState } from "./usage.js";
import { UNAVAILABLE_USAGE, mapUsage } from "./usage.js";

export const CURSOR_TRANSCRIPT_ADAPTER_ID = "cursor-transcripts";

export const CURSOR_TRANSCRIPT_ADAPTER_VERSION = "0.1.0";

const EVENT_KIND = "ai.usage";

const SOURCE_KIND = "transcript-estimate";

const MAX_TOOL_NAMES = 50;

const CHARS_PER_TOKEN = 4;

export type TranscriptLayout =
  | "cursor-transcript-jsonl"
  | "cursor-transcript-txt"
  | "unrecognized";

export interface TranscriptParseOptions {
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly parentSessionId: string | null;
  readonly sessionHint: string | null;
  readonly sourceName: string;
}

export interface TranscriptParseResult {
  readonly coverage: SourceCoverage;
  readonly events: readonly DxEventEnvelope[];
  readonly layout: TranscriptLayout;
  readonly lineCount: number;
}

const ContentBlockSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  toolName: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.String,
});

const ContentSchema = Schema.optional(
  Schema.NullOr(Schema.Union([Schema.String, Schema.Array(ContentBlockSchema)]))
);

const TranscriptLineSchema = Schema.fromJsonString(
  Schema.Struct({
    content: ContentSchema,
    message: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          content: ContentSchema,
          model: Schema.optional(Schema.NullOr(Schema.String)),
        })
      )
    ),
    model: Schema.optional(Schema.NullOr(Schema.String)),
    role: Schema.String,
  })
);

type TranscriptLine = typeof TranscriptLineSchema.Type;

type ContentBlock = typeof ContentBlockSchema.Type;

const CountersSchema = Schema.Record(Schema.String, Schema.Finite);

const UsageCarrierSchema = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.optional(
      Schema.NullOr(Schema.Struct({ usage: Schema.optional(CountersSchema) }))
    ),
    usage: Schema.optional(CountersSchema),
  })
);

const HasUsageSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ usage: Schema.Struct({}) }),
    Schema.Struct({ message: Schema.Struct({ usage: Schema.Struct({}) }) }),
  ])
);

const decodeTranscriptLine = Schema.decodeUnknownOption(TranscriptLineSchema);

const decodeUsageCarrier = Schema.decodeUnknownOption(UsageCarrierSchema);

const hasUsage = Schema.is(HasUsageSchema);

interface Turn {
  assistantMessages: number;
  readonly lineNos: number[];
  model: string | null;
  readonly raws: string[];
  readonly toolNames: string[];
  readonly turnIndex: number;
  usage: MappedUsage;
  visibleChars: number;
}

interface Tally {
  lineCount: number;
  malformed: number;
  partialTail: boolean;
  unknownRows: number;
  usageUnparsed: number;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digestSha256 = (value: string) =>
  Effect.gen(function* digestTranscriptEvidence() {
    const crypto = yield* Crypto.Crypto;

    const bytes = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );

    return `sha256:${toHex(bytes)}`;
  });

const newTurn = (turnIndex: number): Turn => ({
  assistantMessages: 0,
  lineNos: [],
  model: null,
  raws: [],
  toolNames: [],
  turnIndex,
  usage: UNAVAILABLE_USAGE,
  visibleChars: 0,
});

const nonEmpty = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === "" ? null : value;

const isPlainText = Schema.is(Schema.String);

const blocksOf = (line: TranscriptLine): readonly ContentBlock[] => {
  const content = line.message?.content ?? line.content ?? null;

  if (content === null) {
    return [];
  }

  return isPlainText(content) ? [{ text: content, type: "text" }] : content;
};

const visibleTextLength = (line: TranscriptLine): number => {
  let total = 0;

  for (const block of blocksOf(line)) {
    if (block.type === "text") {
      total += block.text?.length ?? 0;
    }
  }

  return total;
};

const toolNamesOf = (line: TranscriptLine): string[] =>
  blocksOf(line).flatMap((block) =>
    block.type === "tool_use" || block.type === "tool-call"
      ? [nonEmpty(block.name) ?? nonEmpty(block.toolName) ?? "unknown"]
      : []
  );

const usageOfRaw = (raw: string, tally: Tally): MappedUsage | null => {
  const carrier = decodeUsageCarrier(raw);

  if (Option.isNone(carrier)) {
    if (hasUsage(raw)) {
      tally.usageUnparsed += 1;
    }

    return null;
  }

  const top: UsageCounters | null = carrier.value.usage ?? null;
  const nested: UsageCounters | null = carrier.value.message?.usage ?? null;

  if (top !== null) {
    return mapUsage(top, "usage");
  }

  return nested === null ? null : mapUsage(nested, "message.usage");
};

const jsonlTurns = (text: string, tally: Tally): Turn[] => {
  const rows = text.split(/\r?\n/u);
  const lastIndex = rows.findLastIndex((raw) => raw.trim() !== "");
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const [index, raw] of rows.entries()) {
    if (raw.trim() === "") {
      continue;
    }

    tally.lineCount += 1;
    const decoded = decodeTranscriptLine(raw);

    if (Option.isNone(decoded)) {
      if (index === lastIndex && !text.endsWith("\n")) {
        tally.partialTail = true;
      } else {
        tally.malformed += 1;
      }

      continue;
    }

    const line = decoded.value;

    if (line.role === "user") {
      current = newTurn(turns.length);
      turns.push(current);
    } else if (line.role === "assistant") {
      current ??= newTurn(turns.length);

      if (!turns.includes(current)) {
        turns.push(current);
      }

      current.assistantMessages += 1;
      current.visibleChars += visibleTextLength(line);
      current.toolNames.push(...toolNamesOf(line));
      current.model =
        nonEmpty(line.model) ?? nonEmpty(line.message?.model) ?? current.model;
      current.usage = usageOfRaw(raw, tally) ?? current.usage;
    } else {
      tally.unknownRows += 1;
    }

    current?.lineNos.push(index + 1);
    current?.raws.push(raw);
  }

  return turns.filter((turn) => turn.assistantMessages > 0);
};

const TOOL_CALL_PREFIX = "[Tool call] ";

const TOOL_RESULT_PREFIX = "[Tool result]";

const txtTurns = (text: string, tally: Tally): Turn[] => {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let role: "assistant" | "user" | null = null;
  let inToolBlock = false;

  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    tally.lineCount += 1;
    const trimmed = raw.trim();

    if (trimmed === "user:") {
      role = "user";
      current = newTurn(turns.length);
      turns.push(current);
    } else if (trimmed === "assistant:") {
      role = "assistant";
      current ??= newTurn(turns.length);

      if (!turns.includes(current)) {
        turns.push(current);
      }

      current.assistantMessages += 1;
    } else if (current !== null && role === "assistant") {
      const indented = raw !== trimmed && /^\s/u.test(raw);

      if (trimmed.startsWith(TOOL_CALL_PREFIX)) {
        inToolBlock = true;
        current.toolNames.push(
          nonEmpty(trimmed.slice(TOOL_CALL_PREFIX.length).trim()) ?? "unknown"
        );
      } else if (trimmed.startsWith(TOOL_RESULT_PREFIX)) {
        inToolBlock = true;
      } else if (!(inToolBlock && indented)) {
        inToolBlock = false;
        current.visibleChars += trimmed.length;
      }
    }

    current?.lineNos.push(index + 1);
    current?.raws.push(raw);
  }

  return turns.filter((turn) => turn.assistantMessages > 0);
};

const detectLayout = (text: string, sourceName: string): TranscriptLayout => {
  if (sourceName.endsWith(".txt")) {
    return /^(?:user|assistant):\s*$/mu.test(text)
      ? "cursor-transcript-txt"
      : "unrecognized";
  }

  const hasRole = text
    .split(/\r?\n/u)
    .some((raw) => Option.isSome(decodeTranscriptLine(raw)));

  return hasRole ? "cursor-transcript-jsonl" : "unrecognized";
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

const BASE_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "charge",
    method: "source-reported",
    note: "Cursor transcripts carry no billed charge: unavailable, not zero",
    rawName: null,
    unit: "USD",
  },
  {
    field: "toolCalls",
    method: "observed",
    note: "count of tool call blocks; names only, never inputs or outputs",
    rawName: "content[].type=tool_use | [Tool call]",
    unit: "calls",
  },
  {
    field: "estimates.visibleTextTokens",
    method: "estimated",
    note: "chars/4 of assistant visible text only; excludes context resend, cache, hidden reasoning and discarded generations; never a billed count",
    rawName: null,
    unit: "tokens",
  },
];

const upstreamKeyOf = (turn: Turn, options: TranscriptParseOptions): string =>
  `session:${options.sessionHint ?? options.sourceName}:turn:${String(turn.turnIndex)}`;

const buildEvent = (
  turn: Turn,
  layout: TranscriptLayout,
  options: TranscriptParseOptions,
  hashes: { readonly eventId: string; readonly evidence: string }
): DxEventEnvelope => {
  const sessionId = options.sessionHint;
  const usageState: UsageState = turn.usage.state;

  return withCollectorBlocks({
    acquisition: "file-import",
    adapterId: CURSOR_TRANSCRIPT_ADAPTER_ID,
    adapterVersion: CURSOR_TRANSCRIPT_ADAPTER_VERSION,
    context: options.context,
    eventId: EventIdSchema.make(hashes.eventId),
    evidence: {
      bounded: true,
      hash: hashes.evidence,
      ref: `cursor-transcript://${options.sourceName}#lines:${String(Math.min(...turn.lineNos))}-${String(Math.max(...turn.lineNos))}`,
    },
    fieldSemantics: [...BASE_SEMANTICS, ...turn.usage.semantics],
    identity: {
      commitSha: null,
      generationId: null,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: null,
      sessionId,
      turnId:
        sessionId === null ? null : `${sessionId}:${String(turn.turnIndex)}`,
    },
    kind: EVENT_KIND,
    observedAt: options.observedAt,
    occurredAt: null,
    occurredAtPrecision: "unknown",
    origin: options.origin,
    payload: {
      assistantMessages: turn.assistantMessages,
      branchSource: options.context.branch === null ? null : "collect-context",
      charge: null,
      estimates: {
        method: "estimated",
        visibleTextTokens: Math.ceil(turn.visibleChars / CHARS_PER_TOKEN),
      },
      listPriceEstimateUsd: null,
      model: turn.model,
      parentSessionId: options.parentSessionId,
      requestKey: canonicalRequestKey({
        generationId: null,
        requestId: null,
        sessionId,
        sourceKind: SOURCE_KIND,
        turnIndex: turn.turnIndex,
      }),
      sourceKind: SOURCE_KIND,
      tokens: turn.usage.tokens,
      toolCalls: turn.toolNames.length,
      toolNames: tallyTools(turn.toolNames),
      transcriptLayout: layout,
      turnIndex: turn.turnIndex,
      unmappedUsage: turn.usage.unmapped,
      usageState,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: null,
    upstreamKey: upstreamKeyOf(turn, options),
  });
};

const gapsOf = (
  tally: Tally,
  layout: TranscriptLayout,
  events: readonly DxEventEnvelope[]
): SourceGap[] => {
  const gaps: SourceGap[] = [
    {
      code: "charge-unavailable",
      message:
        "Cursor transcripts carry no billed charge; money stays unavailable unless a billing source is imported",
    },
  ];

  const count = (states: readonly UsageState[]) =>
    events.filter((event) =>
      states.some((state) => event.payload.usageState === state)
    ).length;

  const optional: readonly [number, string, string][] = [
    [
      tally.malformed,
      "malformed-lines",
      "line(s) were not transcript JSON and were skipped",
    ],
    [
      tally.partialTail ? 1 : 0,
      "partial-tail",
      "incomplete trailing line ignored (transcript still being written)",
    ],
    [tally.unknownRows, "unknown-rows", "row(s) had an unrecognized role"],
    [
      tally.usageUnparsed,
      "usage-unparsed",
      "usage block(s) had non-numeric counters and were not mapped",
    ],
    [
      count(["unavailable"]),
      "usage-unavailable",
      "turn(s) had no usage fields; tokens unavailable (visible-text estimate only)",
    ],
    [
      count(["unmapped", "partial"]),
      "usage-unmapped",
      "turn(s) carried usage keys that are kept raw in unmappedUsage, not normalized",
    ],
    [
      events.length,
      "timestamps-absent",
      "turn(s) have no per-turn timestamp in the transcript; occurredAt unknown",
    ],
    [
      layout === "unrecognized" ? 1 : 0,
      "layout-unrecognized",
      "file matched neither Cursor transcript JSONL nor TXT layout",
    ],
  ];

  for (const [amount, code, message] of optional) {
    if (amount > 0) {
      gaps.push({ code, message: `${String(amount)} ${message}` });
    }
  }

  return gaps;
};

const coverageState = (
  layout: TranscriptLayout,
  events: readonly DxEventEnvelope[]
) => {
  if (layout === "unrecognized") {
    return "unsupported" as const;
  }

  return events.length === 0 ? ("none" as const) : ("partial" as const);
};

const turnsOf = (text: string, layout: TranscriptLayout, tally: Tally) => {
  if (layout === "cursor-transcript-jsonl") {
    return jsonlTurns(text, tally);
  }

  return layout === "cursor-transcript-txt" ? txtTurns(text, tally) : [];
};

export const parseCursorTranscript = Effect.fn("parseCursorTranscript")(
  function* parseTranscriptText(text: string, options: TranscriptParseOptions) {
    const tally: Tally = {
      lineCount: 0,
      malformed: 0,
      partialTail: false,
      unknownRows: 0,
      usageUnparsed: 0,
    };

    const layout = detectLayout(text, options.sourceName);
    const turns = turnsOf(text, layout, tally);
    const events: DxEventEnvelope[] = [];

    for (const turn of turns) {
      const eventId = yield* digestSha256(
        `${CURSOR_TRANSCRIPT_ADAPTER_ID}\n${upstreamKeyOf(turn, options)}\n${EVENT_KIND}`
      );

      const evidence = yield* digestSha256(turn.raws.join("\n"));

      events.push(buildEvent(turn, layout, options, { eventId, evidence }));
    }

    const result: TranscriptParseResult = {
      coverage: {
        adapterId: CURSOR_TRANSCRIPT_ADAPTER_ID,
        expectedItems: null,
        gaps: gapsOf(tally, layout, events),
        observedItems: events.length,
        state: coverageState(layout, events),
        watermark: null,
        windowFrom: null,
        windowTo: null,
      },
      events,
      layout,
      lineCount: tally.lineCount,
    };

    return result;
  }
);
