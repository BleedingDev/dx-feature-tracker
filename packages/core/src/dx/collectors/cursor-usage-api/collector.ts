import type { Crypto } from "effect";
import { DateTime, Effect, FileSystem, Option, Schema } from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { DxCollector } from "../../contracts/services.js";
import type { DxEventEnvelope } from "../../model/event.js";
import { emptyFlightContext } from "../../model/event.js";
import { parseCursorDashboardResponse } from "../cursor-dashboard-response/parse.js";
import { fetchUsagePages, PAGE_SIZE, pagesDocument, redact } from "./client.js";
import type { FetchLike, FetchWindow, UsagePage } from "./client.js";
import { cursorUsageApiDescriptor } from "./descriptor.js";
import { cursorStateDbPath, readCursorSession } from "./session.js";
import type { CursorSession } from "./session.js";

export const CURSOR_USAGE_API_ADAPTER_ID = "cursor-usage-api";

export const CURSOR_USAGE_API_ADAPTER_VERSION = "0.1.0";

export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export const OVERLAP_MS = 60 * 60 * 1000;

export interface CursorUsageApiDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: FetchLike;
  readonly home: string;
  readonly pageSize?: number;
  readonly readSession: () => Effect.Effect<CursorSession | null>;
}

export const statePath = (home: string): string =>
  `${home.replace(/\/+$/u, "")}/.dft/cursor-usage-api/state.json`;

const unavailable = (message: string) =>
  new SourceUnavailable({ adapterId: CURSOR_USAGE_API_ADAPTER_ID, message });

const StateSchema = Schema.fromJsonString(
  Schema.Struct({ lastTimestampMs: Schema.Finite })
);

const decodeState = Schema.decodeUnknownOption(StateSchema);

const readLastTimestamp = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(
    Effect.map((text) =>
      Option.match(decodeState(text), {
        onNone: () => null,
        onSome: (state) => state.lastTimestampMs,
      })
    ),
    Effect.orElseSucceed(() => null)
  );

const isoOf = (value: number | string | undefined): string | null => {
  const ms = Number(value);

  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }

  return Option.match(DateTime.make(ms), {
    onNone: () => null,
    onSome: (at) => DateTime.formatIso(at),
  });
};

const chargedIndex = (
  pages: readonly UsagePage[]
): ReadonlyMap<string, number> => {
  const index = new Map<string, number>();

  for (const row of pages.flatMap((page) => page.rows)) {
    const at = isoOf(row.timestamp);

    if (at !== null && row.chargedCents !== undefined) {
      index.set(`${at}|${row.conversationId ?? ""}`, row.chargedCents);
    }
  }

  return index;
};

const maxTimestamp = (pages: readonly UsagePage[]): number | null => {
  const values = pages.flatMap((page) =>
    page.rows.flatMap((row) => {
      const value = Number(row.timestamp);

      return Number.isFinite(value) && value > 0 ? [value] : [];
    })
  );

  return values.length === 0 ? null : Math.max(...values);
};

export const toApiEvent = (
  event: DxEventEnvelope,
  charged: ReadonlyMap<string, number>
): DxEventEnvelope => {
  const key = `${event.occurredAt ?? ""}|${event.identity.sessionId ?? ""}`;
  const cents = charged.get(key);

  const chargedUsd =
    cents === undefined ? null : Math.round(cents * 10_000) / 1_000_000;

  return {
    ...event,
    acquisition: "api",
    adapterId: CURSOR_USAGE_API_ADAPTER_ID,
    adapterVersion: CURSOR_USAGE_API_ADAPTER_VERSION,
    evidence: {
      ...event.evidence,
      ref: `cursor-usage-api://get-filtered-usage-events#${event.upstreamKey ?? ""}`,
    },
    payload: {
      ...event.payload,
      charge: chargedUsd ?? event.payload.charge ?? null,
      chargedUsd,
      sourceKind: "dashboard-json",
    },
  };
};

export const makeCursorUsageApiCollector = (
  deps: CursorUsageApiDeps
): DxCollector<FileSystem.FileSystem | Crypto.Crypto> => ({
  collect: (input) =>
    Effect.gen(function* collectCursorUsageApi() {
      if ((deps.env.DFT_CURSOR_USAGE ?? "").toLowerCase() === "off") {
        return yield* unavailable("disabled by DFT_CURSOR_USAGE=off");
      }

      const session = yield* deps.readSession();

      if (session === null) {
        return yield* unavailable("unavailable: not logged in");
      }

      const fs = yield* FileSystem.FileSystem;
      const file = statePath(deps.home);
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);

      const fromCursor =
        input.cursor === null ? null : Number(input.cursor.value);

      const last =
        fromCursor !== null && Number.isFinite(fromCursor)
          ? fromCursor
          : yield* readLastTimestamp(fs, file);

      const startMs =
        last === null ? nowMs - DEFAULT_LOOKBACK_MS : last - OVERLAP_MS;

      const window: FetchWindow = {
        endMs: nowMs,
        pageSize: deps.pageSize ?? PAGE_SIZE,
        startMs,
      };

      const pages = yield* fetchUsagePages(
        deps.fetchImpl,
        session,
        window
      ).pipe(
        Effect.mapError((error) => unavailable(redact(error.message, session)))
      );

      if (!pages.some((page) => page.rows.length > 0)) {
        return {
          coverage: {
            adapterId: CURSOR_USAGE_API_ADAPTER_ID,
            expectedItems: 0,
            gaps: [],
            observedItems: 0,
            state: "none" as const,
            watermark: null,
            windowFrom: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
            windowTo: DateTime.formatIso(now),
          },
          cursor:
            last === null
              ? null
              : { adapterId: CURSOR_USAGE_API_ADAPTER_ID, value: String(last) },
          events: [],
        };
      }

      const result = yield* parseCursorDashboardResponse(pagesDocument(pages), {
        context: emptyFlightContext,
        observedAt: DateTime.formatIso(now),
        origin: "live",
        sourceName: "get-filtered-usage-events",
      }).pipe(
        Effect.mapError((error) => unavailable(redact(error.message, session)))
      );

      const charged = chargedIndex(pages);
      const events = result.events.map((event) => toApiEvent(event, charged));
      const newest = maxTimestamp(pages) ?? last;

      if (newest !== null) {
        yield* fs
          .makeDirectory(file.replace(/\/[^/]+$/u, ""), { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                file,
                `${JSON.stringify({ lastTimestampMs: newest })}\n`
              )
            ),
            Effect.ignore
          );
      }

      return {
        coverage: {
          ...result.coverage,
          adapterId: CURSOR_USAGE_API_ADAPTER_ID,
        },
        cursor:
          newest === null
            ? null
            : { adapterId: CURSOR_USAGE_API_ADAPTER_ID, value: String(newest) },
        events,
      };
    }),
  descriptor: cursorUsageApiDescriptor,
});

const homeDir = (): string => process.env.HOME ?? "";

export const cursorUsageApiCollector = makeCursorUsageApiCollector({
  env: process.env,
  // @effect-diagnostics-next-line asyncFunction:off globalFetch:off -- The usage API seam is the platform fetch; the client wraps it in Effect.tryPromise and pins the host allowlist.
  fetchImpl: async (url, init) => await fetch(url, init),
  home: homeDir(),
  readSession: () => readCursorSession(cursorStateDbPath(homeDir())),
});
