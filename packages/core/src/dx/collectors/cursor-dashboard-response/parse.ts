import { Crypto, Data, DateTime, Effect, Option, Schema } from "effect";

import { withCollectorBlocks } from "../../harness/collector-blocks.js";
import type { TokenCategory } from "../../model/ai.js";
import type { Origin } from "../../model/common.js";
import type { SourceCoverage, SourceGap } from "../../model/coverage.js";
import { EVENT_SCHEMA_VERSION } from "../../model/event.js";
import type {
  DxEventEnvelope,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";

export const CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID = "cursor-dashboard-response";

export const CURSOR_DASHBOARD_RESPONSE_ADAPTER_VERSION = "0.1.0";

const MAX_REJECTED_REPORTED = 50;

export class RefusedInput extends Data.TaggedError("RefusedInput")<{
  readonly reason: "credential-bearing" | "har-archive" | "unrecognized";
  readonly message: string;
}> {}

export type CostLedger = "charge" | "metered" | "not-charged" | "unallocated";

export interface ParseOptions {
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly sourceName: string;
}

export interface PageInfo {
  readonly declaredTotal: number | null;
  readonly page: number | null;
  readonly pageSize: number | null;
  readonly rows: number;
}

export interface Pagination {
  readonly complete: boolean;
  readonly declaredTotal: number | null;
  readonly duplicateRows: number;
  readonly missingPages: readonly number[];
  readonly pages: readonly PageInfo[];
  readonly uniqueRows: number;
}

export interface RejectedRow {
  readonly at: string;
  readonly reason: string;
}

export interface ParseResult {
  readonly batchId: string;
  readonly coverage: SourceCoverage;
  readonly events: readonly DxEventEnvelope[];
  readonly pagination: Pagination;
  readonly rejected: readonly RejectedRow[];
}

const NumberLike = Schema.Union([Schema.Finite, Schema.FiniteFromString]);

const TokenUsageSchema = Schema.Struct({
  cacheReadTokens: Schema.optionalKey(NumberLike),
  cacheWriteTokens: Schema.optionalKey(NumberLike),
  inputTokens: Schema.optionalKey(NumberLike),
  outputTokens: Schema.optionalKey(NumberLike),
  reasoningTokens: Schema.optionalKey(NumberLike),
  totalCents: Schema.optionalKey(NumberLike),
  totalTokens: Schema.optionalKey(NumberLike),
});

type TokenUsage = typeof TokenUsageSchema.Type;

const UsageRowSchema = Schema.Struct({
  bubbleId: Schema.optionalKey(Schema.String),
  clientRequestId: Schema.optionalKey(Schema.String),
  composerId: Schema.optionalKey(Schema.String),
  conversationId: Schema.optionalKey(Schema.String),
  generationId: Schema.optionalKey(Schema.String),
  isChargeable: Schema.optionalKey(Schema.Boolean),
  isTokenBasedCall: Schema.optionalKey(Schema.Boolean),
  kind: Schema.optionalKey(Schema.String),
  maxMode: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  requestsCosts: Schema.optionalKey(NumberLike),
  serverBubbleId: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
  tokenUsage: Schema.optionalKey(TokenUsageSchema),
  usageBasedCosts: Schema.optionalKey(
    Schema.Union([Schema.Finite, Schema.String])
  ),
});

type UsageRow = typeof UsageRowSchema.Type;

const ResponseSchema = Schema.Struct({
  totalUsageEventsCount: Schema.optionalKey(NumberLike),
  usageEvents: Schema.optionalKey(Schema.Array(UsageRowSchema)),
  usageEventsDisplay: Schema.optionalKey(Schema.Array(UsageRowSchema)),
});

type DashboardResponse = typeof ResponseSchema.Type;

const RequestSchema = Schema.Struct({
  page: Schema.optionalKey(NumberLike),
  pageSize: Schema.optionalKey(NumberLike),
});

const WrappedPageSchema = Schema.Struct({
  request: Schema.optionalKey(RequestSchema),
  response: ResponseSchema,
});

const EntrySchema = Schema.Union([WrappedPageSchema, ResponseSchema]);

type Entry = typeof EntrySchema.Type;

const PagesSchema = Schema.Struct({ pages: Schema.Array(EntrySchema) });

const EntryListSchema = Schema.Array(EntrySchema);

const HarSchema = Schema.Struct({
  log: Schema.Struct({ entries: Schema.Array(Schema.Unknown) }),
});

const InputSchema = Schema.Union([
  HarSchema,
  PagesSchema,
  EntryListSchema,
  EntrySchema,
]);

type Input = typeof InputSchema.Type;

const CREDENTIAL_KEY =
  /"(?:cookie|cookies|set-cookie|authorization|workoscursorsessiontoken|accesstoken|access_token|refreshtoken|refresh_token|sessiontoken|session_token|bearer)"\s*:/iu;

interface RawPage {
  readonly events: readonly UsageRow[];
  readonly info: Omit<PageInfo, "rows">;
}

const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim() ?? "";

  return text === "" ? null : text;
};

const responseOf = (entry: Entry): DashboardResponse =>
  "response" in entry ? entry.response : entry;

const toPage = (entry: Entry): RawPage | null => {
  const wrapped = Schema.is(WrappedPageSchema)(entry) ? entry : null;
  const response = responseOf(entry);
  const events = response.usageEventsDisplay ?? response.usageEvents;

  if (events === undefined) {
    return null;
  }

  return {
    events,
    info: {
      declaredTotal: response.totalUsageEventsCount ?? null,
      page: wrapped?.request?.page ?? null,
      pageSize: wrapped?.request?.pageSize ?? null,
    },
  };
};

const entriesOf = (
  document: Exclude<Input, typeof HarSchema.Type>
): readonly Entry[] => {
  if (Schema.is(EntryListSchema)(document)) {
    return document;
  }

  return "pages" in document ? document.pages : [document];
};

const refuseUnrecognized = () =>
  new RefusedInput({
    message:
      "expected a Cursor dashboard usage response with a usageEventsDisplay array (or an array/pages list of them)",
    reason: "unrecognized",
  });

const readPages = (
  text: string,
  document: Input
): readonly RawPage[] | RefusedInput => {
  if ("log" in document) {
    return new RefusedInput({
      message:
        "HAR browser captures are refused; export the dashboard response body JSON only",
      reason: "har-archive",
    });
  }

  if (CREDENTIAL_KEY.test(text)) {
    return new RefusedInput({
      message:
        "input contains a cookie/authorization/token key; remove credentials and export only the response body",
      reason: "credential-bearing",
    });
  }

  const pages: RawPage[] = [];

  for (const entry of entriesOf(document)) {
    const page = toPage(entry);

    if (page === null) {
      return refuseUnrecognized();
    }

    pages.push(page);
  }

  return pages.length === 0 ? refuseUnrecognized() : pages;
};

const ZONED = /(?:z|[+-]\d{2}:?\d{2})$/iu;

const readTimestamp = (value: number | string | undefined): string | null => {
  if (value === undefined) {
    return null;
  }

  const text = String(value).trim();
  const epoch = /^\d+$/u.test(text) ? Number(text) : null;

  if (epoch === null && !ZONED.test(text)) {
    return null;
  }

  const millis = epoch !== null && epoch < 1e11 ? epoch * 1000 : epoch;

  return Option.match(DateTime.make(millis ?? text), {
    onNone: () => null,
    onSome: (at) => DateTime.formatIso(at),
  });
};

type TokenField = Exclude<keyof TokenUsage, "totalCents">;

const TOKEN_FIELDS: readonly (readonly [TokenField, TokenCategory])[] = [
  ["inputTokens", "input"],
  ["outputTokens", "output"],
  ["cacheReadTokens", "cached-input"],
  ["cacheWriteTokens", "cache-write"],
  ["reasoningTokens", "reasoning"],
  ["totalTokens", "total"],
];

interface TokenRead {
  readonly raw: Partial<Record<TokenField, number>>;
  readonly tokens: Partial<Record<TokenCategory, number>>;
}

const readTokens = (usage: TokenUsage | undefined): TokenRead => {
  const raw: Partial<Record<TokenField, number>> = {};
  const tokens: Partial<Record<TokenCategory, number>> = {};

  for (const [rawName, category] of TOKEN_FIELDS) {
    const value = usage?.[rawName];

    if (value !== undefined && value >= 0) {
      raw[rawName] = value;
      tokens[category] = value;
    }
  }

  return { raw, tokens };
};

const parseDollars = (value: number | string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const match = /^\$?\s*(?<amount>-?\d+(?:\.\d+)?)$/u.exec(
    String(value).trim()
  );

  return match?.groups?.amount === undefined
    ? null
    : Number(match.groups.amount);
};

export interface CostReading {
  readonly amountUsd: number | null;
  readonly ledger: CostLedger;
  readonly rawField: string | null;
}

export const ledgerOfKind = (
  kind: string | null,
  isChargeable: boolean | undefined
): CostLedger => {
  const upper = kind?.toUpperCase() ?? "";

  if (upper.includes("NOT_CHARGED") || upper.includes("ERRORED")) {
    return "not-charged";
  }

  if (upper.includes("USAGE_BASED") || upper.includes("ON_DEMAND")) {
    return "charge";
  }

  if (upper.includes("INCLUDED") || upper.includes("FREE")) {
    return "metered";
  }

  if (isChargeable === undefined) {
    return "unallocated";
  }

  return isChargeable ? "charge" : "metered";
};

const readCost = (row: UsageRow): CostReading => {
  const ledger = ledgerOfKind(trimmed(row.kind), row.isChargeable);
  const cents = row.tokenUsage?.totalCents;

  if (cents !== undefined) {
    return {
      amountUsd: Math.round(cents * 10_000) / 1_000_000,
      ledger,
      rawField: "tokenUsage.totalCents",
    };
  }

  const dollars = parseDollars(row.usageBasedCosts);

  if (dollars !== null) {
    return { amountUsd: dollars, ledger, rawField: "usageBasedCosts" };
  }

  return { amountUsd: null, ledger, rawField: null };
};

export interface RowKeys {
  readonly clientRequestId: string | null;
  readonly composerId: string | null;
  readonly conversationId: string | null;
  readonly generationId: string | null;
  readonly requestId: string | null;
}

export const rowKeysOf = (row: {
  readonly bubbleId?: string;
  readonly clientRequestId?: string;
  readonly composerId?: string;
  readonly conversationId?: string;
  readonly generationId?: string;
  readonly requestId?: string;
  readonly serverBubbleId?: string;
}): RowKeys => ({
  clientRequestId: trimmed(row.clientRequestId),
  composerId: trimmed(row.composerId),
  conversationId: trimmed(row.conversationId),
  generationId:
    trimmed(row.generationId) ??
    trimmed(row.serverBubbleId) ??
    trimmed(row.bubbleId),
  requestId: trimmed(row.requestId),
});

const unique = (values: readonly (string | null)[]): readonly string[] => [
  ...new Set(values.filter((value): value is string => value !== null)),
];

export const correlationKeysOfRow = (keys: RowKeys): readonly string[] => [
  ...unique([keys.requestId, keys.clientRequestId]).map(
    (id) => `request:${id}`
  ),
  ...unique([keys.generationId]).map((id) => `generation:${id}`),
  ...unique([keys.composerId, keys.conversationId]).map(
    (id) => `session:${id}`
  ),
];

interface AcceptedRow {
  readonly canonical: string;
  readonly conversationId: string | null;
  readonly cost: CostReading;
  readonly keys: RowKeys;
  readonly kind: string | null;
  readonly maxMode: boolean | null;
  readonly model: string | null;
  readonly occurredAt: string;
  readonly rawTokens: Partial<Record<TokenField, number>>;
  readonly requestId: string | null;
  readonly requestUnits: number | null;
  readonly tokenBased: boolean | null;
  readonly tokens: Partial<Record<TokenCategory, number>>;
}

const parseRow = (row: UsageRow, at: string): AcceptedRow | RejectedRow => {
  const occurredAt = readTimestamp(row.timestamp);

  if (occurredAt === null) {
    return { at, reason: "timestamp-missing-or-unzoned" };
  }

  const tokenRead = readTokens(row.tokenUsage);
  const cost = readCost(row);
  const model = trimmed(row.model);
  const kind = trimmed(row.kind);
  const keys = rowKeysOf(row);
  const { requestId } = keys;
  const conversationId = keys.conversationId ?? keys.composerId;
  const requestUnits = row.requestsCosts ?? null;
  const maxMode = row.maxMode ?? null;

  return {
    canonical: JSON.stringify([
      occurredAt,
      requestId,
      conversationId,
      kind,
      model,
      maxMode,
      tokenRead.raw,
      cost.amountUsd,
      requestUnits,
    ]),
    conversationId,
    cost,
    keys,
    kind,
    maxMode,
    model,
    occurredAt,
    rawTokens: tokenRead.raw,
    requestId,
    requestUnits,
    tokenBased: row.isTokenBasedCall ?? null,
    tokens: tokenRead.tokens,
  };
};

const isRejected = (row: AcceptedRow | RejectedRow): row is RejectedRow =>
  "reason" in row;

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

const TOKEN_SEMANTICS: readonly FieldSemantics[] = TOKEN_FIELDS.map(
  ([rawName, category]) => ({
    field: `payload.tokens.${category}`,
    method: "source-reported",
    note: "Cursor dashboard response tokenUsage field; present only when the row reports it",
    rawName: `tokenUsage.${rawName}`,
    unit: "tokens",
  })
);

const COST_SEMANTICS: FieldSemantics = {
  field: "payload.costUsd",
  method: "source-reported",
  note: "tokenUsage.totalCents / 100 when present, else usageBasedCosts dollars. payload.costLedger discriminates charge (usage-based kind) from metered (included in plan), not-charged and unallocated; only charge rows populate payload.charge",
  rawName: "tokenUsage.totalCents|usageBasedCosts",
  unit: "USD",
};

export const analyzePagination = (
  pages: readonly PageInfo[],
  uniqueRows: number,
  duplicateRows: number
): Pagination => {
  const totals = pages.flatMap((page) =>
    page.declaredTotal === null ? [] : [page.declaredTotal]
  );

  const declaredTotal = totals.length === 0 ? null : Math.max(...totals);

  const numbered = pages.flatMap((page) =>
    page.page === null ? [] : [page.page]
  );

  const pageSize = pages.find((page) => page.pageSize !== null)?.pageSize;
  const missingPages: number[] = [];

  if (
    declaredTotal !== null &&
    pageSize !== undefined &&
    pageSize !== null &&
    pageSize > 0 &&
    numbered.length === pages.length
  ) {
    const expectedPages = Math.ceil(declaredTotal / pageSize);
    const have = new Set(numbered);

    for (let page = 1; page <= expectedPages; page += 1) {
      if (!have.has(page)) {
        missingPages.push(page);
      }
    }
  }

  const complete =
    declaredTotal !== null &&
    uniqueRows + duplicateRows >= declaredTotal &&
    uniqueRows <= declaredTotal &&
    missingPages.length === 0;

  return {
    complete,
    declaredTotal,
    duplicateRows,
    missingPages,
    pages,
    uniqueRows,
  };
};

const buildGaps = (
  pagination: Pagination,
  rejected: readonly RejectedRow[],
  events: readonly AcceptedRow[]
): SourceGap[] => {
  const shown = rejected
    .slice(0, MAX_REJECTED_REPORTED)
    .map((row) => `${row.at}:${row.reason}`)
    .join(", ");

  const missingKeys = events.filter(
    (row) => correlationKeysOfRow(row.keys).length === 0
  ).length;

  const candidates: readonly (SourceGap | null)[] = [
    {
      code: "branch-unassigned",
      message:
        "Dashboard usage rows carry no branch; rows stay unassigned until a correlator joins them by request/conversation key or time window",
    },
    pagination.declaredTotal === null
      ? {
          code: "pagination-unknown",
          message:
            "response has no totalUsageEventsCount; completeness of the export cannot be verified",
        }
      : null,
    pagination.declaredTotal !== null && !pagination.complete
      ? {
          code: "pagination-incomplete",
          message: `export holds ${String(pagination.uniqueRows)} unique row(s) but the dashboard declared ${String(pagination.declaredTotal)}${pagination.missingPages.length > 0 ? `; missing page(s) ${pagination.missingPages.join(", ")}` : ""}`,
        }
      : null,
    pagination.duplicateRows > 0
      ? {
          code: "duplicate-rows",
          message: `${String(pagination.duplicateRows)} row(s) repeated across pages were deduplicated`,
        }
      : null,
    rejected.length > 0
      ? {
          code: "rejected-rows",
          message: `${String(rejected.length)} row(s) rejected: ${shown}`,
        }
      : null,
    missingKeys > 0
      ? {
          code: "request-key-unavailable",
          message: `${String(missingKeys)} row(s) have neither request nor conversation id; they can only be correlated by time`,
        }
      : null,
  ];

  return candidates.filter((gap): gap is SourceGap => gap !== null);
};

const turnIdOf = (keys: RowKeys): string | null => {
  const session = keys.composerId ?? keys.conversationId;

  return session === null || keys.generationId === null
    ? null
    : `${session}:${keys.generationId}`;
};

const toEvent = (
  row: AcceptedRow,
  hashes: {
    readonly batchId: string;
    readonly eventId: string;
    readonly rowHash: string;
    readonly upstreamKey: string;
  },
  fieldSemantics: readonly FieldSemantics[],
  options: ParseOptions
): DxEventEnvelope =>
  withCollectorBlocks({
    acquisition: "file-import",
    adapterId: CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID,
    adapterVersion: CURSOR_DASHBOARD_RESPONSE_ADAPTER_VERSION,
    context: {
      ...options.context,
      branch: null,
      flightId: null,
      headSha: null,
    },
    eventId: EventIdSchema.make(hashes.eventId),
    evidence: {
      bounded: true,
      hash: hashes.rowHash,
      ref: `cursor-dashboard-response://${options.sourceName}#${hashes.upstreamKey}`,
    },
    fieldSemantics,
    identity: {
      commitSha: null,
      generationId: row.keys.generationId,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: row.keys.requestId ?? row.keys.clientRequestId,
      sessionId: row.keys.composerId ?? row.conversationId,
      turnId: turnIdOf(row.keys),
    },
    kind: "ai.usage",
    observedAt: options.observedAt,
    occurredAt: row.occurredAt,
    occurredAtPrecision: "exact",
    origin: options.origin,
    payload: {
      attribution: "unassigned",
      attributionReason:
        "dashboard usage rows carry no branch; assignment needs request/conversation key or time-window correlation",
      batchId: hashes.batchId,
      charge: row.cost.ledger === "charge" ? row.cost.amountUsd : null,
      conversationId: row.conversationId,
      correlationKeys: correlationKeysOfRow(row.keys),
      costLedger: row.cost.ledger,
      costRawField: row.cost.rawField,
      costUsd: row.cost.amountUsd,
      currency: row.cost.amountUsd === null ? null : "USD",
      maxMode: row.maxMode,
      model: row.model,
      rawCategory: row.kind,
      rawTokens: row.rawTokens,
      requestKey:
        row.requestId ??
        (row.conversationId === null
          ? null
          : `${row.conversationId}@${row.occurredAt}`),
      requestUnits: row.requestUnits,
      sourceKind: "dashboard-response",
      tokenBased: row.tokenBased,
      tokens: row.tokens,
      toolCalls: null,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: null,
    upstreamKey: hashes.upstreamKey,
  });

const coverageState = (
  events: number,
  complete: boolean
): SourceCoverage["state"] => {
  if (events === 0) {
    return "none";
  }

  return complete ? "complete" : "partial";
};

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(InputSchema)
);

export const parseCursorDashboardResponse = (
  text: string,
  options: ParseOptions
) =>
  Effect.gen(function* parseCursorDashboardResponseGen() {
    const document = yield* decodeJson(text).pipe(
      Effect.mapError(
        () =>
          new RefusedInput({
            message:
              "selected file is not valid JSON or not a recognized dashboard usage response",
            reason: "unrecognized",
          })
      )
    );

    const pages = readPages(text, document);

    if (pages instanceof RefusedInput) {
      return yield* pages;
    }

    const rejected: RejectedRow[] = [];
    const accepted: AcceptedRow[] = [];
    const seen = new Set<string>();
    let duplicateRows = 0;

    for (const [pageIndex, page] of pages.entries()) {
      for (const [rowIndex, raw] of page.events.entries()) {
        const row = parseRow(
          raw,
          `page${String(pageIndex)}/row${String(rowIndex)}`
        );

        if (isRejected(row)) {
          rejected.push(row);
        } else if (seen.has(row.canonical)) {
          duplicateRows += 1;
        } else {
          seen.add(row.canonical);
          accepted.push(row);
        }
      }
    }

    const pagination = analyzePagination(
      pages.map((page) => ({ ...page.info, rows: page.events.length })),
      accepted.length,
      duplicateRows
    );

    const batchId = yield* digestSha256(text);
    const hasCost = accepted.some((row) => row.cost.amountUsd !== null);

    const fieldSemantics = hasCost
      ? [...TOKEN_SEMANTICS, COST_SEMANTICS]
      : [...TOKEN_SEMANTICS];

    const events: DxEventEnvelope[] = [];

    for (const row of accepted) {
      const rowHash = yield* digestSha256(row.canonical);

      const upstreamKey =
        row.requestId === null
          ? `row:${rowHash}`
          : `request:${row.requestId}#${rowHash}`;

      const eventId = yield* digestSha256(
        `${CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID}\n${upstreamKey}\nai.usage`
      );

      events.push(
        toEvent(
          row,
          { batchId, eventId, rowHash, upstreamKey },
          fieldSemantics,
          options
        )
      );
    }

    const times = accepted
      .map((row) => row.occurredAt)
      .toSorted((left, right) => left.localeCompare(right));

    const state = coverageState(
      events.length,
      pagination.complete && rejected.length === 0
    );

    const coverage: SourceCoverage = {
      adapterId: CURSOR_DASHBOARD_RESPONSE_ADAPTER_ID,
      expectedItems: pagination.declaredTotal,
      gaps: buildGaps(pagination, rejected, accepted),
      observedItems: events.length,
      state,
      watermark: batchId,
      windowFrom: times[0] ?? null,
      windowTo: times.at(-1) ?? null,
    };

    return {
      batchId,
      coverage,
      events,
      pagination,
      rejected,
    } satisfies ParseResult;
  });
