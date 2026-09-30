import { Data, Effect, Option, Schema } from "effect";

import type { CursorSession } from "./session.js";

export const USAGE_EVENTS_URL =
  "https://cursor.com/api/dashboard/get-filtered-usage-events";

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "cursor.com",
  "www.cursor.com",
  "api2.cursor.sh",
]);

export const PAGE_SIZE = 100;

export const MAX_PAGES = 200;

export class UsageFetchFailed extends Data.TaggedError("UsageFetchFailed")<{
  readonly message: string;
}> {}

export type FetchLike = (
  url: string,
  init: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: "POST";
  }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

const LiteRowSchema = Schema.Struct({
  chargedCents: Schema.optionalKey(Schema.Finite),
  composerId: Schema.optionalKey(Schema.String),
  conversationId: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});

export type LiteRow = typeof LiteRowSchema.Type;

const LiteResponseSchema = Schema.Struct({
  totalUsageEventsCount: Schema.optionalKey(
    Schema.Union([Schema.Finite, Schema.FiniteFromString])
  ),
  usageEvents: Schema.optionalKey(Schema.Array(LiteRowSchema)),
  usageEventsDisplay: Schema.optionalKey(Schema.Array(LiteRowSchema)),
});

const decodeLite = Schema.decodeUnknownOption(
  Schema.fromJsonString(LiteResponseSchema)
);

export interface UsagePage {
  readonly body: string;
  readonly request: { readonly page: number; readonly pageSize: number };
  readonly rows: readonly LiteRow[];
  readonly total: number | null;
}

export const redact = (text: string, session: CursorSession): string => {
  let out = text;

  for (const secret of [
    session.accessToken,
    encodeURIComponent(session.accessToken),
  ]) {
    if (secret.length > 0) {
      out = out.split(secret).join("<redacted>");
    }
  }

  return out;
};

export const sessionCookie = (session: CursorSession): string =>
  `WorkosCursorSessionToken=${session.userId}%3A%3A${session.accessToken}`;

const assertAllowed = (url: string): void => {
  const parsed = new URL(url);

  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`refusing to send Cursor session to ${parsed.hostname}`);
  }
};

export interface FetchWindow {
  readonly endMs: number;
  readonly pageSize?: number;
  readonly startMs: number;
}

const httpFailure = (status: number): string =>
  status === 401 || status === 403
    ? `unavailable: not logged in (HTTP ${String(status)})`
    : `usage endpoint returned HTTP ${String(status)}`;

const fetchPage = (
  fetchImpl: FetchLike,
  session: CursorSession,
  window: FetchWindow,
  request: UsagePage["request"]
): Effect.Effect<UsagePage, UsageFetchFailed> =>
  Effect.tryPromise({
    catch: (error) =>
      new UsageFetchFailed({
        message: redact(
          error instanceof Error ? error.message : String(error),
          session
        ),
      }),
    // @effect-diagnostics-next-line asyncFunction:off -- fetch is promise-only and Effect.tryPromise is its boundary.
    try: async () => {
      assertAllowed(USAGE_EVENTS_URL);

      const res = await fetchImpl(USAGE_EVENTS_URL, {
        body: JSON.stringify({
          endDate: String(window.endMs),
          page: request.page,
          pageSize: request.pageSize,
          startDate: String(window.startMs),
          teamId: 0,
        }),
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie(session),
          origin: "https://cursor.com",
          referer: "https://cursor.com/dashboard",
        },
        method: "POST",
      });

      const body = await res.text();

      if (!res.ok) {
        throw new Error(httpFailure(res.status));
      }

      const lite = decodeLite(body);

      if (Option.isNone(lite)) {
        throw new Error("usage endpoint returned an unrecognized body");
      }

      return {
        body,
        request,
        rows: lite.value.usageEventsDisplay ?? lite.value.usageEvents ?? [],
        total: lite.value.totalUsageEventsCount ?? null,
      };
    },
  });

export const fetchUsagePages = (
  fetchImpl: FetchLike,
  session: CursorSession,
  window: FetchWindow
): Effect.Effect<readonly UsagePage[], UsageFetchFailed> =>
  Effect.gen(function* fetchAllPages() {
    const pages: UsagePage[] = [];
    const pageSize = window.pageSize ?? PAGE_SIZE;
    let seen = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const fetched = yield* fetchPage(fetchImpl, session, window, {
        page,
        pageSize,
      });

      pages.push(fetched);
      seen += fetched.rows.length;

      if (
        fetched.rows.length < pageSize ||
        (fetched.total !== null && seen >= fetched.total)
      ) {
        break;
      }
    }

    return pages;
  });

export const pagesDocument = (pages: readonly UsagePage[]): string =>
  `{"pages":[${pages
    .map(
      (page) =>
        `{"request":${JSON.stringify(page.request)},"response":${page.body}}`
    )
    .join(",")}]}`;
