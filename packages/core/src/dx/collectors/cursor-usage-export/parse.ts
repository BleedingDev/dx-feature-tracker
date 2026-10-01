import { Crypto, Data, DateTime, Effect, Option } from "effect";

import { withCollectorBlocks } from "../../harness/collector-blocks.js";
import type { TokenCategory } from "../../model/ai.js";
import type { Origin, TimePrecision } from "../../model/common.js";
import type { SourceCoverage, SourceGap } from "../../model/coverage.js";
import { EVENT_SCHEMA_VERSION } from "../../model/event.js";
import type {
  DxEventEnvelope,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";

export const CURSOR_USAGE_EXPORT_ADAPTER_ID = "cursor-usage-export";

export const CURSOR_USAGE_EXPORT_ADAPTER_VERSION = "0.1.0";

const MAX_REJECTED_REPORTED = 50;

interface TokenColumn {
  readonly category: TokenCategory;
  readonly raw: string;
}

type ColumnRole =
  | { readonly role: "date" }
  | { readonly role: "kind" }
  | { readonly role: "model" }
  | { readonly role: "max-mode" }
  | { readonly role: "cost" }
  | { readonly role: "requests" }
  | { readonly role: "identity-dropped" }
  | ({ readonly role: "token" } & TokenColumn);

const TOKEN_HEADERS = new Map<string, TokenCategory>([
  ["cache read", "cached-input"],
  ["cache write", "cache-write"],
  ["input", "input"],
  ["input (w/ cache write)", "cache-write"],
  ["input (w/o cache write)", "input"],
  ["output", "output"],
  ["output tokens", "output"],
  ["reasoning", "reasoning"],
  ["reasoning tokens", "reasoning"],
  ["tokens", "total"],
  ["total tokens", "total"],
]);

const tokenCategoryOf = (header: string): TokenCategory | undefined =>
  TOKEN_HEADERS.get(header);

const roleOf = (header: string): ColumnRole | null => {
  const tokenCategory = tokenCategoryOf(header);

  if (tokenCategory !== undefined) {
    return { category: tokenCategory, raw: header, role: "token" };
  }

  if (header === "date" || header === "timestamp" || header === "time") {
    return { role: "date" };
  }

  if (header === "kind" || header === "type") {
    return { role: "kind" };
  }

  if (header === "model") {
    return { role: "model" };
  }

  if (header === "max mode") {
    return { role: "max-mode" };
  }

  if (header === "requests" || header === "request units") {
    return { role: "requests" };
  }

  if (
    header === "user" ||
    header === "email" ||
    header === "user email" ||
    header === "name"
  ) {
    return { role: "identity-dropped" };
  }

  if (header === "cost" || header.startsWith("cost ")) {
    return { role: "cost" };
  }

  return null;
};

export const splitCsvLine = (line: string): readonly string[] => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);

  return cells.map((cell) => cell.trim());
};

const normalizeHeader = (value: string): string =>
  value.replace(/^﻿/u, "").trim().toLowerCase().replaceAll(/\s+/gu, " ");

export type CostLedger = "charge" | "metered" | "unallocated" | "not-charged";

export interface CostReading {
  readonly amountUsd: number | null;
  readonly cell: "amount" | "included" | "empty" | "unparsed";
  readonly ledger: CostLedger;
}

const parseAmount = (cell: string): number | null => {
  const cleaned = cell.replaceAll(/[$,\s]/gu, "").replace(/^usd/iu, "");

  if (cleaned === "" || !/^-?\d+(?:\.\d+)?$/u.test(cleaned)) {
    return null;
  }

  return Number(cleaned);
};

export const readCost = (
  cell: string | null,
  kind: string | null
): CostReading => {
  const lowerKind = kind?.toLowerCase() ?? "";
  const notCharged = lowerKind.includes("not charged");

  const billed =
    lowerKind.includes("usage-based") ||
    lowerKind.includes("usage based") ||
    lowerKind.includes("on-demand") ||
    lowerKind.includes("on demand");

  const included = lowerKind.includes("included") || lowerKind.includes("free");

  if (cell === null || cell === "" || cell === "-") {
    return {
      amountUsd: notCharged ? 0 : null,
      cell: "empty",
      ledger: notCharged ? "not-charged" : "unallocated",
    };
  }

  if (cell.toLowerCase() === "included") {
    return { amountUsd: null, cell: "included", ledger: "metered" };
  }

  const amount = parseAmount(cell);

  if (amount === null) {
    return { amountUsd: null, cell: "unparsed", ledger: "unallocated" };
  }

  if (notCharged) {
    return { amountUsd: amount, cell: "amount", ledger: "not-charged" };
  }

  if (billed) {
    return { amountUsd: amount, cell: "amount", ledger: "charge" };
  }

  if (included) {
    return { amountUsd: amount, cell: "amount", ledger: "metered" };
  }

  return { amountUsd: amount, cell: "amount", ledger: "unallocated" };
};

const parseTokenCell = (cell: string): number | null | "invalid" => {
  const cleaned = cell.replaceAll(/[,\s_]/gu, "");

  if (cleaned === "" || cleaned === "-") {
    return null;
  }

  if (!/^\d+$/u.test(cleaned)) {
    return "invalid";
  }

  return Number(cleaned);
};

const ZONE_PATTERN = /(?:z|[+-]\d{2}:?\d{2})$/iu;

export const readTime = (
  cell: string
): { readonly at: string; readonly precision: TimePrecision } | null => {
  const trimmed = cell.trim();

  if (trimmed === "") {
    return null;
  }

  const epoch = /^\d{10,13}$/u.test(trimmed)
    ? Number(trimmed.length === 10 ? `${trimmed}000` : trimmed)
    : Date.parse(trimmed);

  const parsed = Number.isNaN(epoch) ? Option.none() : DateTime.make(epoch);

  if (Option.isNone(parsed)) {
    return null;
  }

  const at = DateTime.formatIso(parsed.value);

  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return { at, precision: "day" };
  }

  const zoned = /^\d{10,13}$/u.test(trimmed) || ZONE_PATTERN.test(trimmed);

  if (!zoned) {
    return { at, precision: "unknown" };
  }

  return { at, precision: /\.\d+/u.test(trimmed) ? "exact" : "second" };
};

export interface RejectedRow {
  readonly line: number;
  readonly reason: string;
}

export interface ParseOptions {
  readonly context: FlightContext;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly sourceName: string;
}

export interface ParseResult {
  readonly batchId: string;
  readonly coverage: SourceCoverage;
  readonly dataRows: number;
  readonly droppedIdentityColumns: number;
  readonly events: readonly DxEventEnvelope[];
  readonly layout: string;
  readonly rejected: readonly RejectedRow[];
  readonly unknownColumns: readonly string[];
}

export class UnrecognizedLayout extends Data.TaggedError("UnrecognizedLayout")<{
  readonly message: string;
}> {}

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

interface AcceptedRow {
  readonly canonical: string;
  readonly cost: CostReading;
  readonly costCell: string | null;
  readonly kind: string | null;
  readonly line: number;
  readonly maxMode: string | null;
  readonly model: string | null;
  readonly rawTokens: Readonly<Record<string, number | null>>;
  readonly requestUnits: number | null;
  readonly time: { readonly at: string; readonly precision: TimePrecision };
  readonly tokens: Partial<Record<TokenCategory, number>>;
}

const cellAt = (
  cells: readonly string[],
  index: number | undefined
): string | null => (index === undefined ? null : (cells[index] ?? null));

const tokenSemantics = (rawNames: readonly string[]): FieldSemantics[] =>
  rawNames.map((raw) => ({
    field: `payload.tokens.${tokenCategoryOf(raw) ?? "other"}`,
    method: "source-reported",
    note: "Cursor usage export column; normalized category is a best-effort mapping of the raw column name, not verified against Cursor documentation",
    rawName: raw,
    unit: "tokens",
  }));

const COST_SEMANTICS: FieldSemantics = {
  field: "payload.costUsd",
  method: "source-reported",
  note: "Raw cost cell. payload.costLedger discriminates charge (usage-based/on-demand kind) from metered (included in plan) and unallocated (kind unknown); only charge rows populate payload.charge",
  rawName: "cost",
  unit: "USD",
};

const layoutName = (roles: readonly (ColumnRole | null)[]): string => {
  const hasKind = roles.some((role) => role?.role === "kind");

  const hasCacheSplit = roles.some(
    (role) => role?.role === "token" && role.raw.includes("cache write")
  );

  const hasUser = roles.some((role) => role?.role === "identity-dropped");

  return [
    "cursor-usage-csv",
    hasKind ? "kind" : "no-kind",
    hasCacheSplit ? "cache-split" : "flat-tokens",
    ...(hasUser ? ["team-user-dropped"] : []),
  ].join("/");
};

interface Layout {
  readonly costIndex: number | undefined;
  readonly dateIndex: number;
  readonly droppedIdentityColumns: number;
  readonly headerIndex: number;
  readonly headers: readonly string[];
  readonly kindIndex: number | undefined;
  readonly maxModeIndex: number | undefined;
  readonly modelIndex: number | undefined;
  readonly name: string;
  readonly requestsIndex: number | undefined;
  readonly tokenIndexes: readonly {
    readonly index: number;
    readonly role: TokenColumn;
  }[];
  readonly unknownColumns: readonly string[];
}

const readLayout = (lines: readonly string[]): Layout | UnrecognizedLayout => {
  const headerIndex = lines.findIndex((line) => line.trim() !== "");

  if (headerIndex === -1) {
    return new UnrecognizedLayout({ message: "file is empty" });
  }

  const headers = splitCsvLine(lines[headerIndex] ?? "").map(normalizeHeader);
  const roles = headers.map(roleOf);

  const indexOf = (role: ColumnRole["role"]) => {
    const found = roles.findIndex((entry) => entry?.role === role);

    return found === -1 ? undefined : found;
  };

  const dateIndex = indexOf("date");
  const costIndex = indexOf("cost");

  const tokenIndexes = roles.flatMap((role, index) =>
    role?.role === "token" ? [{ index, role }] : []
  );

  if (dateIndex === undefined) {
    return new UnrecognizedLayout({
      message: "no Date/Timestamp column in header",
    });
  }

  if (tokenIndexes.length === 0 && costIndex === undefined) {
    return new UnrecognizedLayout({
      message: "no token or cost columns in header",
    });
  }

  return {
    costIndex,
    dateIndex,
    droppedIdentityColumns: roles.filter(
      (role) => role?.role === "identity-dropped"
    ).length,
    headerIndex,
    headers,
    kindIndex: indexOf("kind"),
    maxModeIndex: indexOf("max-mode"),
    modelIndex: indexOf("model"),
    name: layoutName(roles),
    requestsIndex: indexOf("requests"),
    tokenIndexes,
    unknownColumns: headers.filter((_, index) => roles[index] === null),
  };
};

const readTokens = (cells: readonly string[], layout: Layout) => {
  const tokens: Partial<Record<TokenCategory, number>> = {};
  const rawTokens: Record<string, number | null> = {};

  for (const { index, role } of layout.tokenIndexes) {
    const parsed = parseTokenCell(cells[index] ?? "");

    if (parsed === "invalid") {
      return null;
    }

    rawTokens[role.raw] = parsed;

    if (parsed !== null) {
      tokens[role.category] = (tokens[role.category] ?? 0) + parsed;
    }
  }

  return { rawTokens, tokens };
};

const emptyToNull = (value: string | null): string | null =>
  value === "" ? null : value;

const parseRow = (
  raw: string,
  line: number,
  layout: Layout
): AcceptedRow | RejectedRow => {
  const cells = splitCsvLine(raw);

  if (cells.length !== layout.headers.length) {
    return { line, reason: "column-count-mismatch" };
  }

  const time = readTime(cellAt(cells, layout.dateIndex) ?? "");

  if (time === null) {
    return { line, reason: "unparseable-date" };
  }

  const tokenRead = readTokens(cells, layout);

  if (tokenRead === null) {
    return { line, reason: "non-numeric-token-cell" };
  }

  const kind = emptyToNull(cellAt(cells, layout.kindIndex));
  const costCell = cellAt(cells, layout.costIndex);
  const cost = readCost(costCell, kind);

  if (cost.cell === "unparsed") {
    return { line, reason: "unparseable-cost" };
  }

  const requestsCell = cellAt(cells, layout.requestsIndex);
  const model = emptyToNull(cellAt(cells, layout.modelIndex));
  const maxMode = emptyToNull(cellAt(cells, layout.maxModeIndex));

  return {
    canonical: JSON.stringify([
      time.at,
      kind,
      model,
      maxMode,
      tokenRead.rawTokens,
      costCell,
      requestsCell,
    ]),
    cost,
    costCell,
    kind,
    line,
    maxMode,
    model,
    rawTokens: tokenRead.rawTokens,
    requestUnits: requestsCell === null ? null : parseAmount(requestsCell),
    time,
    tokens: tokenRead.tokens,
  };
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
    adapterId: CURSOR_USAGE_EXPORT_ADAPTER_ID,
    adapterVersion: CURSOR_USAGE_EXPORT_ADAPTER_VERSION,
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
      ref: `cursor-usage-csv://${options.sourceName}#line:${String(row.line)}`,
    },
    fieldSemantics,
    identity: {
      commitSha: null,
      generationId: null,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: null,
      sessionId: null,
      turnId: null,
    },
    kind: "ai.usage",
    observedAt: options.observedAt,
    occurredAt: row.time.at,
    occurredAtPrecision: row.time.precision,
    origin: options.origin,
    payload: {
      attribution: "unassigned",
      attributionReason:
        "usage export rows carry no branch, request or session id; branch assignment needs time-window correlation",
      batchId: hashes.batchId,
      charge: row.cost.ledger === "charge" ? row.cost.amountUsd : null,
      costCell: row.cost.cell,
      costLedger: row.cost.ledger,
      costUsd: row.cost.amountUsd,
      currency: row.cost.amountUsd === null ? null : "USD",
      maxMode: row.maxMode,
      model: row.model,
      rawCategory: row.kind,
      rawTokens: row.rawTokens,
      requestKey: null,
      requestUnits: row.requestUnits,
      sourceKind: "usage-csv",
      tokens: row.tokens,
      toolCalls: null,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: null,
    upstreamKey: hashes.upstreamKey,
  });

const buildGaps = (
  layout: Layout,
  rejected: readonly RejectedRow[],
  ambiguousTime: number
): SourceGap[] => {
  const shown = rejected
    .slice(0, MAX_REJECTED_REPORTED)
    .map((row) => `${String(row.line)}:${row.reason}`)
    .join(", ");

  const candidates: readonly (SourceGap | null)[] = [
    {
      code: "branch-unassigned",
      message:
        "Cursor usage export rows have no branch/request/session identity; all rows are unassigned until time-window correlation",
    },
    rejected.length > 0
      ? {
          code: "rejected-rows",
          message: `${String(rejected.length)} row(s) rejected: ${shown}`,
        }
      : null,
    ambiguousTime > 0
      ? {
          code: "timezone-unspecified",
          message: `${String(ambiguousTime)} row(s) had timestamps without a zone; interpreted in host local time with precision unknown`,
        }
      : null,
    layout.unknownColumns.length > 0
      ? {
          code: "unknown-columns",
          message: `ignored unrecognized columns: ${layout.unknownColumns.join(", ")}`,
        }
      : null,
    layout.droppedIdentityColumns > 0
      ? {
          code: "identity-columns-dropped",
          message:
            "user/email columns are not stored; team exports are not scoped to one developer",
        }
      : null,
    layout.tokenIndexes.length === 0
      ? { code: "tokens-unavailable", message: "export has no token columns" }
      : null,
    layout.costIndex === undefined
      ? { code: "cost-unavailable", message: "export has no cost column" }
      : null,
  ];

  return candidates.filter((gap): gap is SourceGap => gap !== null);
};

const coverageState = (
  events: number,
  rejected: number,
  ambiguousTime: number
): SourceCoverage["state"] => {
  if (events === 0) {
    return "none";
  }

  return rejected === 0 && ambiguousTime === 0 ? "complete" : "partial";
};

const isRejected = (row: AcceptedRow | RejectedRow): row is RejectedRow =>
  "reason" in row;

export const parseCursorUsageCsv = (text: string, options: ParseOptions) =>
  Effect.gen(function* parseCursorUsageCsvGen() {
    const lines = text.split(/\r?\n/u);
    const layout = readLayout(lines);

    if (layout instanceof UnrecognizedLayout) {
      return yield* layout;
    }

    const parsed = lines
      .slice(layout.headerIndex + 1)
      .flatMap((raw, offset) =>
        raw.trim() === ""
          ? []
          : [parseRow(raw, layout.headerIndex + offset + 2, layout)]
      );

    const rejected = parsed.filter(isRejected);
    const accepted = parsed.flatMap((row) => (isRejected(row) ? [] : [row]));
    const batchId = yield* digestSha256(text);
    const seen = new Map<string, number>();

    const tokenFieldSemantics = tokenSemantics(
      layout.tokenIndexes.map(({ role }) => role.raw)
    );

    const fieldSemantics =
      layout.costIndex === undefined
        ? tokenFieldSemantics
        : [...tokenFieldSemantics, COST_SEMANTICS];

    const events: DxEventEnvelope[] = [];

    for (const row of accepted) {
      const occurrence = seen.get(row.canonical) ?? 0;
      seen.set(row.canonical, occurrence + 1);
      const rowHash = yield* digestSha256(row.canonical);
      const upstreamKey = `row:${rowHash}#${String(occurrence)}`;

      const eventId = yield* digestSha256(
        `${CURSOR_USAGE_EXPORT_ADAPTER_ID}\n${upstreamKey}\nai.usage`
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

    const ambiguousTime = accepted.filter(
      (row) => row.time.precision === "unknown"
    ).length;

    const times = accepted
      .map((row) => row.time.at)
      .toSorted((left, right) => left.localeCompare(right));

    const coverage: SourceCoverage = {
      adapterId: CURSOR_USAGE_EXPORT_ADAPTER_ID,
      expectedItems: parsed.length,
      gaps: buildGaps(layout, rejected, ambiguousTime),
      observedItems: events.length,
      state: coverageState(events.length, rejected.length, ambiguousTime),
      watermark: batchId,
      windowFrom: times[0] ?? null,
      windowTo: times.at(-1) ?? null,
    };

    return {
      batchId,
      coverage,
      dataRows: parsed.length,
      droppedIdentityColumns: layout.droppedIdentityColumns,
      events,
      layout: layout.name,
      rejected,
      unknownColumns: layout.unknownColumns,
    } satisfies ParseResult;
  });
