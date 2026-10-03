// @effect-diagnostics-next-line nodeBuiltinImport:off -- Reviewed account metadata and replacement receipts use deterministic SHA-256 identities.
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Descriptor-bound credential and checkpoint reads enforce reviewed allowances without following symbolic links.
} from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { NodeCrypto, NodeHttpClient, NodePath } from "@effect/platform-node";
import { DateTime, Effect, Option, Path, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { runCollect } from "../cli/commands/collect.js";
import type { DxCommandEnv } from "../cli/commands/context.js";
import {
  parseCursorDashboardResponse,
  rowKeysOf,
} from "../collectors/cursor-dashboard-response/parse.js";
import {
  PAGE_SIZE,
  pagesDocument,
  redact,
  sessionCookie,
  USAGE_EVENTS_URL,
} from "../collectors/cursor-usage-api/client.js";
import type { UsagePage } from "../collectors/cursor-usage-api/client.js";
import {
  CURSOR_USAGE_API_ADAPTER_ID,
  DEFAULT_LOOKBACK_MS,
  MIGRATION_LOOKBACK_MS,
  OVERLAP_MS,
  STATE_VERSION,
  statePath,
  toApiEvent,
} from "../collectors/cursor-usage-api/collector.js";
import { cursorUsageApiDescriptor } from "../collectors/cursor-usage-api/descriptor.js";
import {
  cursorStateDbPath,
  sessionFromToken,
} from "../collectors/cursor-usage-api/session.js";
import type { CursorSession } from "../collectors/cursor-usage-api/session.js";
import type { AgentStoreFailure } from "../contracts/agent-store.js";
import { AgentError } from "../contracts/error-agent.js";
import type { DxCollector } from "../contracts/services.js";
import type {
  AgentRef,
  AgentScope,
  StoreIdentity,
} from "../model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
  OperationReceipt,
  OperationStep,
} from "../model/agent-operation.js";
import type { Origin } from "../model/common.js";
import type { EventBatch } from "../model/event.js";
import { emptyFlightContext, EVENT_SCHEMA_VERSION } from "../model/event.js";
import type { BoundedEventReplacement } from "../storage/agent-append-bounds.js";
import { operationScopeDigest, sameOperationRefs } from "./digest.js";
import { operationStep } from "./ports.js";
import type {
  OperationAdapter,
  OperationApplyInput,
  OperationEffectResult,
  OperationExecutionContext,
  OperationPlanInput,
  OperationPreparation,
  OperationProbe,
  OperationWorkContext,
} from "./ports.js";

export const ACCOUNT_OPERATION_SOURCE = "collector.cursor-usage-api";

export const ACCOUNT_OPERATION_VERSION = "cursor-usage-api:bounded.v1";

export const ACCOUNT_OPERATION_BOUNDS: OperationBounds = {
  maxBytes: 67_108_864,
  maxElapsedMs: 60_000,
  maxFiles: 32,
  maxRecords: 100_000,
  maxRequests: 10,
  maxRetries: 0,
};

export const accountOperationScope = (): AgentScope => ({
  branchSelection: { branches: [], kind: "all" },
  flightId: null,
  repoId: null,
  resolution: "Cursor account usage has no repository or branch assignment.",
  sources: [ACCOUNT_OPERATION_SOURCE],
  tools: ["cursor"],
  worktreeId: null,
});

export const accountOperationArguments = (
  identity: StoreIdentity
): Extract<OperationArguments, { kind: "collect" }> => ({
  allowSourceGrowth: false,
  cursor: null,
  inputRefs: [
    {
      basisId: null,
      id: USAGE_EVENTS_URL,
      kind: "evidence",
      storeGeneration: identity.storeGeneration,
      storeId: identity.storeId,
      version: ACCOUNT_OPERATION_VERSION,
    },
  ],
  kind: "collect",
  parserVersion: ACCOUNT_OPERATION_VERSION,
  selectedRoots: [USAGE_EVENTS_URL],
  source: ACCOUNT_OPERATION_SOURCE,
});

export interface AccountConfiguration {
  readonly cursorUsageImport: boolean;
  readonly digest: string;
}

export interface AccountEnrollmentRequest {
  readonly bounds: OperationBounds;
  readonly configuration: AccountConfiguration;
  readonly inputRefs: readonly AgentRef[];
  readonly receiptIds: readonly string[];
  readonly scope: AgentScope;
  readonly selectedRoots: readonly string[];
  readonly source: string;
}

export interface AccountPageRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "POST";
  readonly url: typeof USAGE_EVENTS_URL;
}

export interface AccountPageLimits {
  readonly maxBytes: number;
  readonly maxElapsedMs: number;
}

export interface AccountPageReply {
  readonly body: string;
  readonly bytesRead: number;
  readonly reason: string | null;
  readonly status: number;
}

export type AccountPageTransport = (
  request: AccountPageRequest,
  limits: AccountPageLimits
) => Effect.Effect<AccountPageReply, AgentStoreFailure>;

export interface AccountStreamChunk {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

export interface AccountStreamReader {
  readonly cancel: () => Promise<void>;
  readonly read: () => Promise<AccountStreamChunk>;
  readonly releaseLock: () => void;
}

export type AccountStreamFetch = (
  request: AccountPageRequest,
  signal: AbortSignal
) => Promise<{
  readonly reader: AccountStreamReader | null;
  readonly status: number;
}>;

export interface BoundedAccountOperationOptions {
  readonly appendReplacement?: (
    batch: EventBatch,
    context: OperationExecutionContext
  ) => Effect.Effect<AccountReplacementResult, AgentStoreFailure>;
  readonly dftHome: string;
  readonly enrollment: (
    request: AccountEnrollmentRequest,
    context: OperationWorkContext
  ) => Effect.Effect<
    Pick<OperationPlan["consent"], "state" | "reason" | "receiptIds">,
    AgentStoreFailure
  >;
  readonly env: DxCommandEnv;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly origin?: Origin;
  readonly readConfiguration?: (
    context: OperationWorkContext
  ) => Effect.Effect<AccountConfiguration, AgentStoreFailure>;
  readonly readSession?: (
    context: OperationWorkContext
  ) => Effect.Effect<CursorSession | null, AgentStoreFailure>;
  readonly transport?: AccountPageTransport;
}

export interface AccountReplacementResult {
  readonly duplicates: number;
  readonly inserted: number;
  readonly removedCount: number;
  readonly removedDigest?: string | null;
  readonly removedIdsOmitted?: number;
  readonly removedRefs: readonly AgentRef[];
  readonly spooledTo: string | null;
}

const accountError = (code: AgentError["code"], message: string): AgentError =>
  new AgentError({
    code,
    currentRevision: null,
    expectedRevision: null,
    message,
    recovery: { action: "replan", ref: null },
    ref: null,
    retryable: false,
  });

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const StateSchema = Schema.Struct({
  lastTimestampMs: Schema.optionalKey(Schema.Finite),
  version: Schema.optionalKey(Schema.Finite),
});

const ConfigSchema = Schema.Struct({
  cursorUsageImport: Schema.optionalKey(Schema.Boolean),
  repos: Schema.optionalKey(Schema.Array(Schema.String)),
});

const TokenRowSchema = Schema.Struct({ value: Schema.String });

const PageRowSchema = Schema.Struct({
  chargedCents: Schema.optionalKey(Schema.Finite),
  composerId: Schema.optionalKey(Schema.String),
  conversationId: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});

const PageSchema = Schema.Struct({
  totalUsageEventsCount: Schema.optionalKey(
    Schema.Union([Schema.Finite, Schema.FiniteFromString])
  ),
  usageEvents: Schema.optionalKey(Schema.Array(PageRowSchema)),
  usageEventsDisplay: Schema.optionalKey(Schema.Array(PageRowSchema)),
});

const WindowSchema = Schema.Struct({
  endMs: Schema.Finite,
  lastTimestampMs: Schema.NullOr(Schema.Finite),
  migrate: Schema.Boolean,
  startMs: Schema.Finite,
  stateDigest: Schema.String,
});

type AccountWindow = typeof WindowSchema.Type;

const zeroUsage = {
  bytesRead: 0,
  filesRead: 0,
  recordsDecoded: 0,
  requests: 0,
  retries: 0,
};

export const makeBoundedAccountReplacement = (
  appendBounded: BoundedEventReplacement["Service"]["appendBounded"]
): NonNullable<BoundedAccountOperationOptions["appendReplacement"]> =>
  Effect.fn("appendBoundedAccountReplacement")(function* appendReplacement(
    batch: EventBatch,
    context: OperationExecutionContext
  ): Effect.fn.Return<AccountReplacementResult, AgentStoreFailure> {
    const remaining = yield* context.budget.remaining;

    if (remaining.maxBytes < 1 || remaining.maxRecords < 1) {
      return yield* accountError(
        "budget-exhausted",
        "The cumulative reviewed work has no allowance for inspecting account rows before replacement."
      );
    }

    const reservation = yield* context.budget.reserve({
      ...zeroUsage,
      bytesRead: remaining.maxBytes,
      recordsDecoded: remaining.maxRecords,
    });

    const result = yield* appendBounded(batch, {
      maxElapsedMs: remaining.maxElapsedMs,
      maxRemovedBytes: remaining.maxBytes,
      maxRemovedRecords: remaining.maxRecords,
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* rejectedReplacement() {
          yield* reservation.complete({
            ...zeroUsage,
            byteUnits: remaining.maxBytes,
            bytesRead: null,
            recordUnits: remaining.maxRecords,
            recordsDecoded: null,
          });

          return yield* error;
        })
      )
    );

    yield* reservation.complete({
      ...zeroUsage,
      bytesRead: result.decodedBytes,
      recordsDecoded: result.factsExamined,
    });

    return {
      duplicates: result.duplicates,
      inserted: result.inserted,
      removedCount: result.removedCount,
      removedDigest: result.removedDigest,
      removedIdsOmitted: result.removedIdsOmitted,
      removedRefs: result.removedEventIds.map((id): AgentRef => ({
        basisId: null,
        id,
        kind: "event",
        storeGeneration: context.operation.storeGeneration,
        storeId: context.operation.storeId,
        version: EVENT_SCHEMA_VERSION,
      })),
      spooledTo: null,
    };
  });

const readBoundedFile = Effect.fn("readBoundedAccountFile")(function* readFile(
  file: string,
  context: OperationWorkContext
): Effect.fn.Return<string | null, AgentStoreFailure> {
  const stat = yield* Effect.try({
    catch: () =>
      accountError(
        "source-unavailable",
        "The selected account metadata could not be inspected."
      ),
    try: () => lstatSync(file, { throwIfNoEntry: false }),
  });

  if (stat === undefined) {
    return null;
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    return yield* accountError(
      "source-unavailable",
      "The selected account metadata must be a regular file."
    );
  }

  const remaining = yield* context.budget.remaining;
  const length = Math.min(16_384, remaining.maxBytes);

  if (
    stat.size > length ||
    remaining.maxFiles < 1 ||
    remaining.maxRecords < 1
  ) {
    return yield* accountError(
      "budget-exhausted",
      "The account metadata exceeds the reviewed file, byte or record limit."
    );
  }

  const reservation = yield* context.budget.reserve({
    ...zeroUsage,
    bytesRead: stat.size,
    filesRead: 1,
    recordsDecoded: 1,
  });

  const text = yield* Effect.try({
    catch: () =>
      accountError(
        "source-unavailable",
        "The selected account metadata could not be read."
      ),
    try: () => {
      const fd = openSync(file, constants.O_RDONLY + constants.O_NOFOLLOW);

      try {
        const opened = fstatSync(fd);

        if (
          !opened.isFile() ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          opened.size !== stat.size
        ) {
          throw new Error("changed metadata");
        }

        const bytes = Buffer.alloc(stat.size);
        let offset = 0;

        while (offset < bytes.length) {
          const read = readSync(
            fd,
            bytes,
            offset,
            bytes.length - offset,
            offset
          );

          if (read === 0) {
            throw new Error("truncated metadata");
          }

          offset += read;
        }

        return bytes.toString("utf-8");
      } finally {
        closeSync(fd);
      }
    },
  });

  yield* reservation.complete({
    ...zeroUsage,
    bytesRead: stat.size,
    filesRead: 1,
    recordsDecoded: 1,
  });

  return text;
});

const readDefaultConfiguration = Effect.fn("readAccountConfiguration")(
  function* configuration(
    options: BoundedAccountOperationOptions,
    context: OperationWorkContext
  ): Effect.fn.Return<AccountConfiguration, AgentStoreFailure, Path.Path> {
    const path = yield* Path.Path;

    const text = yield* readBoundedFile(
      path.join(options.dftHome, "config.json"),
      context
    );

    const parsed =
      text === null
        ? { cursorUsageImport: true }
        : yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ConfigSchema)
          )(text).pipe(
            Effect.mapError(() =>
              accountError(
                "source-unavailable",
                "The live configuration is invalid."
              )
            )
          );

    return {
      cursorUsageImport: parsed.cursorUsageImport ?? true,
      digest: digest(text ?? "missing-default"),
    };
  },
  Effect.provide(NodePath.layer)
);

const readDefaultSession = Effect.fn("readBoundedCursorSession")(
  function* session(
    options: BoundedAccountOperationOptions,
    context: OperationWorkContext
  ): Effect.fn.Return<CursorSession | null, AgentStoreFailure> {
    const file = cursorStateDbPath(options.home);

    const files = yield* Effect.try({
      catch: () =>
        accountError(
          "source-unavailable",
          "Cursor credentials could not be inspected."
        ),
      try: () =>
        [file, `${file}-wal`].flatMap((candidate) => {
          const stat = lstatSync(candidate, { throwIfNoEntry: false });

          if (stat === undefined) {
            return [];
          }

          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error("credential path is not a regular file");
          }

          return [{ file: candidate, stat }];
        }),
    });

    if (!files.some((entry) => entry.file === file)) {
      return null;
    }

    const bytes = 16_384;
    const remaining = yield* context.budget.remaining;

    if (
      bytes > remaining.maxBytes ||
      files.length > remaining.maxFiles ||
      remaining.maxRecords < 1
    ) {
      return yield* accountError(
        "budget-exhausted",
        "The reviewed allowance cannot admit the bounded Cursor credential field read."
      );
    }

    const reservation = yield* context.budget.reserve({
      ...zeroUsage,
      bytesRead: bytes,
      filesRead: files.length,
      recordsDecoded: 1,
    });

    const raw = yield* Effect.try({
      catch: () =>
        accountError(
          "source-unavailable",
          "Cursor credentials could not be read."
        ),
      try: () => {
        for (const entry of files) {
          const current = lstatSync(entry.file);

          if (
            current.ino !== entry.stat.ino ||
            current.dev !== entry.stat.dev
          ) {
            throw new Error("credential database changed");
          }
        }

        const db = new DatabaseSync(file, { readOnly: true });

        try {
          const value = db
            .prepare(
              "SELECT value FROM ItemTable INDEXED BY sqlite_autoindex_ItemTable_1 WHERE key = 'cursorAuth/accessToken' AND length(CAST(value AS BLOB)) <= 16384 LIMIT 1"
            )
            .get();

          return (
            Option.getOrNull(Schema.decodeUnknownOption(TokenRowSchema)(value))
              ?.value ?? null
          );
        } finally {
          db.close();
        }
      },
    });

    yield* reservation.complete({
      ...zeroUsage,
      bytesRead: raw === null ? 0 : Buffer.byteLength(raw, "utf-8"),
      filesRead: files.length,
      recordsDecoded: raw === null ? 0 : 1,
    });

    return sessionFromToken(raw);
  }
);

const StreamChunkSchema = Schema.Struct({
  done: Schema.Boolean,
  value: Schema.optionalKey(Schema.Uint8Array),
});

const accountRequestFailure = (): AgentError =>
  accountError(
    "source-unavailable",
    "The bounded Cursor usage request failed."
  );

const accountRequestTimeout = (): AgentError =>
  accountError(
    "budget-exhausted",
    "The reviewed Cursor request time limit expired."
  );

const makeCapturedAccountResponse = (maxBytes: number) => {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  let overflowReason =
    "The usage response reached the reviewed captured-body byte cap before a complete response was available; physical network I/O is unavailable.";

  return {
    admit: (bytes: Uint8Array): boolean => {
      const remaining = maxBytes - bytesRead;
      bytesRead += Math.min(bytes.byteLength, remaining);

      if (bytes.byteLength > remaining) {
        overflowReason = `The delivered response chunk contained ${String(bytes.byteLength - remaining)} extra bytes beyond the reviewed captured-body byte cap; physical network I/O is unavailable.`;

        return false;
      }

      parts.push(decoder.decode(bytes, { stream: true }));

      return bytesRead < maxBytes;
    },
    hasAllowance: (): boolean => bytesRead < maxBytes,
    reply: (status: number, complete: boolean): AccountPageReply => ({
      body: complete ? `${parts.join("")}${decoder.decode()}` : "",
      bytesRead,
      reason: complete ? null : overflowReason,
      status,
    }),
  };
};

export const makeBoundedAccountPageTransport =
  (fetchPage: AccountStreamFetch): AccountPageTransport =>
  (request, limits) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        catch: accountRequestFailure,
        // oxlint-disable-next-line typescript/promise-function-async -- The transport already returns a promise and receives Effect's interruption signal.
        try: (signal) => fetchPage(request, signal),
      }).pipe(Effect.interruptible),
      Effect.fnUntraced(function* readBoundedAccountStream(
        response: Awaited<ReturnType<AccountStreamFetch>>
      ) {
        const { reader } = response;

        if (reader === null) {
          return {
            body: "",
            bytesRead: 0,
            reason: "The usage endpoint returned no response body.",
            status: response.status,
          };
        }

        const captured = makeCapturedAccountResponse(limits.maxBytes);

        while (captured.hasAllowance()) {
          const rawChunk: unknown = yield* Effect.tryPromise({
            catch: accountRequestFailure,
            // oxlint-disable-next-line typescript/promise-function-async -- The injected reader is a promise boundary whose schema failure stays in the Effect channel.
            try: () => reader.read(),
          });

          const chunk = yield* Schema.decodeUnknownEffect(StreamChunkSchema)(
            rawChunk
          ).pipe(Effect.mapError(accountRequestFailure));

          if (chunk.done) {
            return captured.reply(response.status, true);
          }

          if (!captured.admit(chunk.value ?? new Uint8Array())) {
            break;
          }
        }

        return captured.reply(response.status, false);
      }),
      (response) =>
        response.reader === null
          ? Effect.void
          : Effect.tryPromise({
              catch: accountRequestFailure,
              // oxlint-disable-next-line typescript/promise-function-async -- Resource finalization forwards the reader's cancellation promise.
              try: () => response.reader?.cancel() ?? Promise.resolve(),
            }).pipe(
              Effect.ensuring(Effect.sync(() => response.reader?.releaseLock()))
            )
    ).pipe(
      Effect.timeoutOrElse({
        duration: limits.maxElapsedMs,
        orElse: () => Effect.fail(accountRequestTimeout()),
      })
    );

export const boundedAccountPageTransport: AccountPageTransport = (
  request,
  limits
) =>
  Effect.scoped(
    Effect.gen(function* readEffectAccountResponse() {
      const client = yield* HttpClient.HttpClient;

      const response = yield* HttpClient.withScope(client).execute(
        HttpClientRequest.post(USAGE_EVENTS_URL).pipe(
          HttpClientRequest.bodyText(request.body, "application/json"),
          HttpClientRequest.setHeaders(request.headers)
        )
      );

      if (response.status >= 300 && response.status < 400) {
        return {
          body: "",
          bytesRead: 0,
          reason: "The fixed account endpoint returned a disallowed redirect.",
          status: response.status,
        };
      }

      const captured = makeCapturedAccountResponse(limits.maxBytes);

      if (captured.hasAllowance()) {
        yield* Stream.runForEachWhile(response.stream, (bytes) =>
          Effect.sync(() => captured.admit(bytes))
        );
      }

      return captured.reply(response.status, captured.hasAllowance());
    })
  ).pipe(
    Effect.provide(NodeHttpClient.layerNodeHttp),
    Effect.mapError(accountRequestFailure),
    Effect.timeoutOrElse({
      duration: limits.maxElapsedMs,
      orElse: () => Effect.fail(accountRequestTimeout()),
    })
  );

const configured = (
  options: BoundedAccountOperationOptions,
  context: OperationWorkContext
) =>
  options.readConfiguration === undefined
    ? readDefaultConfiguration(options, context)
    : options.readConfiguration(context);

const enabled = (
  options: BoundedAccountOperationOptions,
  configuration: AccountConfiguration
): boolean =>
  configuration.cursorUsageImport &&
  (options.environment?.DFT_CURSOR_USAGE ?? "").toLowerCase() !== "off";

const validAccountScope = (scope: AgentScope): boolean =>
  scope.repoId === null &&
  scope.worktreeId === null &&
  scope.flightId === null &&
  scope.branchSelection.kind === "all" &&
  scope.branchSelection.branches.length === 0 &&
  sameOperationRefs(scope.sources, [ACCOUNT_OPERATION_SOURCE]) &&
  sameOperationRefs(scope.tools, ["cursor"]);

const validSelection = (
  input: Pick<OperationPlanInput, "arguments" | "scope">
): boolean => {
  const args = input.arguments;

  return (
    args.kind === "collect" &&
    args.source === ACCOUNT_OPERATION_SOURCE &&
    args.parserVersion === ACCOUNT_OPERATION_VERSION &&
    args.cursor === null &&
    !args.allowSourceGrowth &&
    sameOperationRefs(args.selectedRoots, [USAGE_EVENTS_URL]) &&
    args.inputRefs.length === 1 &&
    args.inputRefs[0]?.id === USAGE_EVENTS_URL &&
    args.inputRefs[0]?.kind === "evidence" &&
    args.inputRefs[0]?.basisId === null &&
    args.inputRefs[0]?.version === ACCOUNT_OPERATION_VERSION &&
    validAccountScope(input.scope)
  );
};

const enrollmentRequest = (
  input: Pick<OperationPlanInput, "arguments" | "scope" | "bounds">,
  configuration: AccountConfiguration,
  receiptIds: readonly string[]
): AccountEnrollmentRequest => ({
  bounds: input.bounds,
  configuration,
  inputRefs:
    input.arguments.kind === "collect" ? input.arguments.inputRefs : [],
  receiptIds,
  scope: input.scope,
  selectedRoots: [USAGE_EVENTS_URL],
  source: ACCOUNT_OPERATION_SOURCE,
});

const retainedWindow = (
  plan: OperationPlan
): Effect.Effect<AccountWindow, AgentStoreFailure> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(WindowSchema))(
    plan.preconditions.find(
      (entry) =>
        entry.kind === "selected-content" &&
        entry.target === "cursor-account-window"
    )?.expected ?? ""
  ).pipe(
    Effect.mapError(() =>
      accountError(
        "invalid-selector",
        "The reviewed Cursor account window is unavailable."
      )
    )
  );

const accountWindowStart = (
  now: number,
  migrate: boolean,
  lastTimestampMs: number | null
): number => {
  if (migrate) {
    return now - MIGRATION_LOOKBACK_MS;
  }

  if (lastTimestampMs === null) {
    return now - DEFAULT_LOOKBACK_MS;
  }

  return lastTimestampMs - OVERLAP_MS;
};

const readWindow = Effect.fn("readAccountWindow")(function* window(
  options: BoundedAccountOperationOptions,
  context: OperationWorkContext
): Effect.fn.Return<AccountWindow, AgentStoreFailure> {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const text = yield* readBoundedFile(statePath(options.dftHome), context);

  const stored =
    text === null
      ? null
      : Option.getOrNull(
          Schema.decodeUnknownOption(Schema.fromJsonString(StateSchema))(text)
        );

  const migrate =
    text !== null && (stored === null || stored.version !== STATE_VERSION);

  const lastTimestampMs = migrate ? null : (stored?.lastTimestampMs ?? null);

  return {
    endMs: now,
    lastTimestampMs,
    migrate,
    startMs: accountWindowStart(now, migrate, lastTimestampMs),
    stateDigest: digest(text ?? "missing"),
  };
});

const pageCharges = (
  pages: readonly UsagePage[]
): ReadonlyMap<string, number> => {
  const charges = new Map<string, number>();

  for (const row of pages.flatMap((page) => page.rows)) {
    const ms = Number(row.timestamp);

    const at =
      Number.isFinite(ms) && ms > 0
        ? Option.map(DateTime.make(ms), DateTime.formatIso)
        : Option.none();

    if (row.chargedCents === undefined || Option.isNone(at)) {
      continue;
    }

    const keys = rowKeysOf(row);
    charges.set(
      `${at.value}|${keys.conversationId ?? keys.composerId ?? ""}`,
      row.chargedCents
    );

    if (keys.requestId !== null) {
      charges.set(`request:${keys.requestId}`, row.chargedCents);
    }
  }

  return charges;
};

interface PageRun {
  readonly complete: boolean;
  readonly failureState: "rejected" | "unavailable";
  readonly gaps: readonly string[];
  readonly pages: readonly UsagePage[];
  readonly rows: number;
}

interface PageAttempt {
  readonly page: UsagePage | null;
  readonly reason: string | null;
  readonly state: "rejected" | "unavailable";
}

const requestPage = Effect.fn("requestBoundedAccountPage")(function* requestOne(
  options: BoundedAccountOperationOptions,
  session: CursorSession,
  window: AccountWindow,
  page: number,
  pageSize: number,
  maxBytes: number,
  maxElapsedMs: number,
  context: OperationWorkContext
): Effect.fn.Return<PageAttempt, AgentStoreFailure> {
  const reservation = yield* context.budget.reserve({
    ...zeroUsage,
    bytesRead: maxBytes,
    recordsDecoded: maxBytes,
    requests: 1,
  });

  const request: AccountPageRequest = {
    body: JSON.stringify({
      endDate: String(window.endMs),
      page,
      pageSize,
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
    url: USAGE_EVENTS_URL,
  };

  return yield* (options.transport ?? boundedAccountPageTransport)(request, {
    maxBytes,
    maxElapsedMs,
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        reservation
          .complete({
            ...zeroUsage,
            byteUnits: maxBytes,
            bytesRead: null,
            recordsDecoded: 0,
            requests: 1,
          })
          .pipe(
            Effect.as<PageAttempt>({
              page: null,
              reason: redact(error.message, session),
              state: "unavailable",
            })
          ),
      onSuccess: (reply) =>
        Effect.gen(function* settleAccountPage(): Effect.fn.Return<
          PageAttempt,
          AgentStoreFailure
        > {
          if (reply.reason !== null || reply.bytesRead > maxBytes) {
            yield* reservation.complete({
              ...zeroUsage,
              bytesRead: reply.bytesRead,
              recordsDecoded: 0,
              requests: 1,
            });

            return {
              page: null,
              reason:
                reply.reason ??
                "The account response exceeded its reserved byte allowance.",
              state: "rejected",
            };
          }

          if (reply.status < 200 || reply.status >= 300) {
            yield* reservation.complete({
              ...zeroUsage,
              bytesRead: reply.bytesRead,
              recordsDecoded: 0,
              requests: 1,
            });

            return {
              page: null,
              reason:
                reply.status === 401 || reply.status === 403
                  ? "Cursor account usage is unavailable because the client is not logged in."
                  : `Cursor usage returned HTTP ${String(reply.status)}.`,
              state: "unavailable",
            };
          }

          const decoded = Option.getOrNull(
            Schema.decodeUnknownOption(Schema.fromJsonString(PageSchema))(
              reply.body
            )
          );

          const rows =
            decoded?.usageEventsDisplay ?? decoded?.usageEvents ?? [];

          yield* reservation.complete({
            ...zeroUsage,
            bytesRead: reply.bytesRead,
            recordsDecoded: rows.length,
            requests: 1,
          });

          if (decoded === null) {
            return {
              page: null,
              reason: "The Cursor usage response is not recognized.",
              state: "unavailable",
            };
          }

          return {
            page: {
              body: reply.body,
              request: { page, pageSize },
              rows,
              total: decoded.totalUsageEventsCount ?? null,
            },
            reason: null,
            state: "unavailable",
          };
        }),
    })
  );
});

const fetchPages = Effect.fn("fetchBoundedAccountPages")(function* pages(
  options: BoundedAccountOperationOptions,
  session: CursorSession,
  window: AccountWindow,
  context: OperationWorkContext
): Effect.fn.Return<PageRun, AgentStoreFailure> {
  const fetched: UsagePage[] = [];
  const gaps: string[] = [];
  let rows = 0;
  let complete = false;
  let failureState: PageRun["failureState"] = "rejected";

  for (let page = 1; page <= 100; page += 1) {
    const remaining = yield* context.budget.remaining;
    const maxBytes = Math.min(remaining.maxBytes, remaining.maxRecords);

    if (
      remaining.maxRequests < 1 ||
      maxBytes < 1 ||
      remaining.maxRecords < PAGE_SIZE
    ) {
      gaps.push(
        "The reviewed request, byte or record limit ended before the account window was complete."
      );
      break;
    }

    const pageSize = PAGE_SIZE;

    const attempted = yield* requestPage(
      options,
      session,
      window,
      page,
      pageSize,
      maxBytes,
      remaining.maxElapsedMs,
      context
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed<PageAttempt>({
          page: null,
          reason: redact(error.message, session),
          state: "rejected",
        })
      )
    );

    if (attempted.page === null) {
      failureState = attempted.state;
      gaps.push(
        attempted.reason ??
          "The account request did not produce a complete page."
      );
      break;
    }

    fetched.push(attempted.page);
    rows += attempted.page.rows.length;

    if (
      attempted.page.rows.length < pageSize ||
      (attempted.page.total !== null && rows >= attempted.page.total)
    ) {
      complete = true;
      break;
    }
  }

  return { complete, failureState, gaps, pages: fetched, rows };
});

const checkpoint = Effect.fn("writeAccountCheckpoint")(
  function* writeCheckpoint(
    options: BoundedAccountOperationOptions,
    expected: string,
    newest: number,
    context: OperationWorkContext
  ): Effect.fn.Return<boolean, AgentStoreFailure, Path.Path> {
    const path = yield* Path.Path;

    const file = statePath(options.dftHome);
    const text = yield* readBoundedFile(file, context);

    if (digest(text ?? "missing") !== expected) {
      return false;
    }

    yield* context.budget.remaining;

    return yield* Effect.try({
      catch: () =>
        accountError(
          "source-unavailable",
          "The committed account checkpoint could not be saved."
        ),
      try: () => {
        mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(
          temporary,
          `${JSON.stringify({ lastTimestampMs: newest, version: STATE_VERSION })}\n`,
          { flag: "wx", mode: 0o600 }
        );
        renameSync(temporary, file);

        return true;
      },
    });
  },
  Effect.provide(NodePath.layer)
);

const accountRemovalReason = (
  batch: EventBatch,
  result: AccountReplacementResult
): string | null => {
  if (batch.replace === undefined) {
    return null;
  }

  const omitted =
    result.removedIdsOmitted ??
    Math.max(0, result.removedCount - result.removedRefs.length);

  return `Replaced stored ${batch.replace.adapterId} rows at or after ${batch.replace.fromOccurredAt}, with no upper deletion bound; ${String(result.removedCount)} rows removed, ${String(omitted)} exact event references omitted from this bounded receipt, content digest ${result.removedDigest ?? "unavailable"}.`;
};

const appendAccountBatch = Effect.fn("appendBoundedAccountBatch")(
  function* appendBatch(
    options: BoundedAccountOperationOptions,
    batch: EventBatch,
    context: OperationExecutionContext
  ): Effect.fn.Return<AccountReplacementResult, AgentStoreFailure> {
    yield* context.budget.remaining;

    if (batch.replace !== undefined) {
      if (options.appendReplacement === undefined) {
        return yield* accountError(
          "source-unavailable",
          "Atomic bounded account replacement is unavailable."
        );
      }

      return yield* options.appendReplacement(batch, context);
    }

    const collector: DxCollector = {
      collect: () => Effect.succeed(batch),
      descriptor: cursorUsageApiDescriptor,
    };

    const appended = yield* runCollect(options.env, [collector], {
      context: emptyFlightContext,
      input: USAGE_EVENTS_URL,
      source: ACCOUNT_OPERATION_SOURCE,
    }).pipe(
      Effect.mapError((error) =>
        accountError("source-unavailable", error.message)
      )
    );

    return {
      duplicates: appended.duplicates,
      inserted: appended.inserted,
      removedCount: 0,
      removedRefs: [],
      spooledTo: appended.spooledTo,
    };
  }
);

const persistAccountWindowCheckpoint = Effect.fn(
  "persistBoundedAccountWindowCheckpoint"
)(function* persistWindow(
  options: BoundedAccountOperationOptions,
  window: AccountWindow,
  result: PageRun,
  spooledTo: string | null,
  context: OperationWorkContext
): Effect.fn.Return<
  { readonly errors: readonly string[]; readonly saved: boolean },
  AgentStoreFailure
> {
  if (!result.complete || spooledTo !== null) {
    return { errors: [], saved: false };
  }

  const times = result.pages
    .flatMap((page) => page.rows)
    .map((row) => Number(row.timestamp))
    .filter((value) => Number.isFinite(value) && value > 0);

  const newest =
    times.length === 0 ? window.lastTimestampMs : Math.max(...times);

  if (newest === null) {
    return { errors: [], saved: false };
  }

  return yield* checkpoint(options, window.stateDigest, newest, context).pipe(
    Effect.map((saved) => ({
      errors: saved
        ? []
        : [
            "The committed account checkpoint changed concurrently and was retained.",
          ],
      saved,
    })),
    Effect.catch((error) =>
      Effect.succeed({ errors: [error.message], saved: false })
    )
  );
});

const accountStepState = (
  spooledTo: string | null,
  complete: boolean,
  inserted: number,
  duplicates: number
): OperationStep["state"] => {
  if (spooledTo !== null) {
    return "spooled";
  }

  if (!complete) {
    return "partial";
  }

  if (inserted > 0) {
    return "committed";
  }

  return duplicates > 0 ? "already-applied" : "unchanged";
};

const probeBoundedAccountOperation = (
  plan: OperationPlan,
  step: OperationStep,
  receipt: OperationReceipt,
  _context: OperationWorkContext
): Effect.Effect<OperationProbe, AgentStoreFailure> => {
  if (plan.effects.destructive) {
    return Effect.succeed({
      reason:
        "The legacy account replacement may already have committed; its durable result must be verified before another replacement.",
      state: "indeterminate",
    });
  }

  return Effect.succeed(
    receipt.steps.some(
      (stored) => stored.id === step.id && stored.state === "spooled"
    )
      ? {
          reason:
            "The account batch is spooled; bounded explicit spool recovery must establish its append before another account request.",
          state: "indeterminate",
        }
      : { state: "absent" }
  );
};

export const makeBoundedAccountOperationAdapter = (
  options: BoundedAccountOperationOptions
): OperationAdapter => {
  const prepare = Effect.fn("prepareBoundedAccountOperation")(
    function* prepareAccount(
      input: OperationPlanInput,
      context: OperationWorkContext
    ): Effect.fn.Return<OperationPreparation, AgentStoreFailure, Path.Path> {
      const path = yield* Path.Path;

      if (!validSelection(input)) {
        return yield* accountError(
          "scope-denied",
          "Cursor usage requires its exact account-wide source, destination and parser selection."
        );
      }

      if (input.arguments.kind !== "collect") {
        return yield* accountError(
          "invalid-selector",
          "Cursor usage requires collect arguments."
        );
      }

      if (
        input.arguments.inputRefs.some(
          (ref) =>
            ref.storeId !== input.target.storeId ||
            ref.storeGeneration !== input.target.storeGeneration
        )
      ) {
        return yield* accountError(
          "stale-generation",
          "The selected account input belongs to a different store generation."
        );
      }

      const configuration = yield* configured(options, context);

      const consent = enabled(options, configuration)
        ? yield* options.enrollment(
            enrollmentRequest(input, configuration, []),
            context
          )
        : {
            reason:
              "Cursor account usage is disabled by the live configuration or environment.",
            receiptIds: [],
            state: "denied" as const,
          };

      const window = yield* readWindow(options, context);

      return {
        arguments: input.arguments,
        consent: { ...consent, scopeDigest: "pending" },
        effects: {
          destructive: window.migrate,
          networkDestinations: [USAGE_EVENTS_URL],
          reads: [
            USAGE_EVENTS_URL,
            path.join(options.dftHome, "config.json"),
            cursorStateDbPath(options.home),
            statePath(options.dftHome),
          ],
          writes: [options.env.storePath, statePath(options.dftHome)],
        },
        expectedEvidenceImprovement: window.migrate
          ? `Import account usage and replace all previously stored ${CURSOR_USAGE_API_ADAPTER_ID} rows at or after ${DateTime.formatIso(DateTime.makeUnsafe(window.startMs))}, with no upper deletion bound; missing charges and branch assignments remain unavailable.`
          : "Import account usage rows and reported charges; missing charges and branch assignments remain unavailable.",
        forecast: { bytes: null, cost: null, elapsedMs: null, requests: null },
        preconditions: [
          {
            allowAppend: false,
            expected: configuration.digest,
            kind: "config-digest",
            target: path.join(options.dftHome, "config.json"),
          },
          {
            allowAppend: false,
            expected: ACCOUNT_OPERATION_VERSION,
            kind: "parser-version",
            target: ACCOUNT_OPERATION_SOURCE,
          },
          {
            allowAppend: false,
            expected: USAGE_EVENTS_URL,
            kind: "source-identity",
            target: ACCOUNT_OPERATION_SOURCE,
          },
          {
            allowAppend: false,
            expected: JSON.stringify(window),
            kind: "selected-content",
            target: "cursor-account-window",
          },
        ],
        resumeBoundary: "atomic-step",
        stopCondition:
          "Limit captured response-body bytes, the admitted indexed credential field, bounded validation, decoded rows, requests and elapsed work; physical network and SQLite internal I/O are unavailable. Advance the checkpoint only after a complete committed window.",
      };
    },
    Effect.provide(NodePath.layer)
  );

  const validate = Effect.fn("validateBoundedAccountOperation")(
    function* validateAccount(
      plan: OperationPlan,
      context: OperationWorkContext
    ): Effect.fn.Return<readonly string[], AgentStoreFailure> {
      if (!validSelection(plan)) {
        return ["The reviewed Cursor account selection is invalid."];
      }

      const configuration = yield* configured(options, context);

      if (
        !enabled(options, configuration) ||
        configuration.digest !==
          plan.preconditions.find((entry) => entry.kind === "config-digest")
            ?.expected
      ) {
        return [
          "The Cursor account configuration changed or acquisition was disabled.",
        ];
      }

      const window = yield* retainedWindow(plan);

      const text = yield* readBoundedFile(statePath(options.dftHome), context);

      return digest(text ?? "missing") === window.stateDigest
        ? []
        : [
            "The Cursor account checkpoint changed; review a new account window.",
          ];
    }
  );

  const authorize = Effect.fn("authorizeBoundedAccountOperation")(
    function* authorizeAccount(
      plan: OperationPlan,
      input: OperationApplyInput,
      context: OperationWorkContext
    ): Effect.fn.Return<boolean, AgentStoreFailure> {
      if (
        !validSelection(plan) ||
        plan.consent.scopeDigest !== operationScopeDigest(plan)
      ) {
        return false;
      }

      const configuration = yield* configured(options, context);

      if (!enabled(options, configuration)) {
        return false;
      }

      const consent = yield* options.enrollment(
        enrollmentRequest(plan, configuration, input.consentReceiptIds),
        context
      );

      return (
        consent.state === "authorized" &&
        sameOperationRefs(consent.receiptIds, plan.consent.receiptIds)
      );
    }
  );

  const execute = Effect.fn("executeBoundedAccountOperation")(
    function* executeAccount(
      plan: OperationPlan,
      step: OperationStep,
      context: OperationExecutionContext
    ): Effect.fn.Return<OperationEffectResult, AgentStoreFailure> {
      const window = yield* retainedWindow(plan);

      if (window.migrate && options.appendReplacement === undefined) {
        return {
          step: {
            ...step,
            gaps: [
              "The legacy account checkpoint requires an atomic bounded replacement port before acquisition can resume.",
            ],
            rejected: null,
            state: "unavailable",
          },
        };
      }

      const session = yield* options.readSession === undefined
        ? readDefaultSession(options, context)
        : options.readSession(context);

      if (session === null) {
        return {
          step: {
            ...step,
            gaps: [
              "Cursor account usage is unavailable because the client is not logged in.",
            ],
            rejected: null,
            state: "unavailable",
          },
        };
      }

      const result = yield* fetchPages(options, session, window, context);

      if (result.pages.length === 0) {
        return {
          step: {
            ...step,
            gaps: result.gaps,
            rejected: null,
            remainingWork:
              "Review a plan with sufficient account acquisition bounds.",
            state: result.failureState,
          },
        };
      }

      yield* context.budget.charge({
        ...zeroUsage,
        recordsDecoded: result.rows,
      });

      const parsed = yield* parseCursorDashboardResponse(
        pagesDocument(result.pages),
        {
          context: emptyFlightContext,
          observedAt: DateTime.formatIso(DateTime.makeUnsafe(window.endMs)),
          origin: options.origin ?? "live",
          sourceName: "get-filtered-usage-events",
        }
      ).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.mapError((error) =>
          accountError("source-unavailable", redact(error.message, session))
        )
      );

      const charged = pageCharges(result.pages);
      const events = parsed.events.map((event) => toApiEvent(event, charged));

      const baseBatch: EventBatch = {
        coverage: {
          ...parsed.coverage,
          adapterId: CURSOR_USAGE_API_ADAPTER_ID,
          gaps: [
            ...parsed.coverage.gaps,
            ...result.gaps.map((message) => ({
              code: "account.bounded-window",
              message,
            })),
          ],
          state: result.complete ? parsed.coverage.state : "partial",
          windowFrom: DateTime.formatIso(DateTime.makeUnsafe(window.startMs)),
          windowTo: DateTime.formatIso(DateTime.makeUnsafe(window.endMs)),
        },
        cursor: null,
        events,
      };

      const batch: EventBatch =
        window.migrate && result.complete
          ? {
              ...baseBatch,
              replace: {
                adapterId: CURSOR_USAGE_API_ADAPTER_ID,
                fromOccurredAt: DateTime.formatIso(
                  DateTime.makeUnsafe(window.startMs)
                ),
              },
            }
          : baseBatch;

      const appended = yield* appendAccountBatch(options, batch, context);

      const checkpointResult = yield* persistAccountWindowCheckpoint(
        options,
        window,
        result,
        appended.spooledTo,
        context
      );

      const gaps = [
        ...batch.coverage.gaps.map((gap) => gap.message),
        ...checkpointResult.errors,
      ];

      if (options.readSession === undefined) {
        gaps.push(
          "Credential bytes measure the bounded returned field; physical SQLite internal I/O is unavailable."
        );
      }

      const { saved } = checkpointResult;

      const refs: AgentRef[] = events.slice(0, 200).map((event) => ({
        basisId: null,
        id: event.eventId,
        kind: "event",
        storeGeneration: plan.storeGeneration,
        storeId: plan.storeId,
        version: event.schemaVersion,
      }));

      return {
        effects: {
          backupArtifacts: [],
          backupIds: [],
          configDigest: null,
          evidenceIds: refs.map((ref) => ref.id),
          exportArtifacts: [],
          exports: [],
          filesChanged: saved ? [statePath(options.dftHome)] : [],
          remainingStoreGeneration: plan.storeGeneration,
          removalReason: accountRemovalReason(batch, appended),
          removedCount:
            batch.replace === undefined ? null : appended.removedCount,
          removedRefs: appended.removedRefs,
        },
        step: {
          ...step,
          committedThrough: events.at(-1)?.eventId ?? null,
          duplicates: appended.duplicates,
          gaps: gaps.slice(0, 64),
          inserted: appended.inserted,
          rejected: parsed.rejected.length,
          remainingWork:
            !result.complete || appended.spooledTo !== null
              ? "The account window or durable append remains incomplete; its checkpoint was retained."
              : null,
          safeCursor: saved ? "checkpoint-committed" : null,
          spooledRefs: appended.spooledTo === null ? [] : [appended.spooledTo],
          state: accountStepState(
            appended.spooledTo,
            result.complete,
            appended.inserted,
            appended.duplicates
          ),
        },
        verificationRefs: refs,
      };
    }
  );

  return {
    authorize,
    descriptor: {
      authorization: "existing-enrollment",
      cancellation: "between-steps",
      effects: {
        destructive: true,
        networkDestinations: [USAGE_EVENTS_URL],
        reads: [USAGE_EVENTS_URL, "logged-in Cursor client credentials"],
        writes: [options.env.storePath, statePath(options.dftHome)],
      },
      enabled: true,
      idempotency: "durable-key",
      kind: "collect",
      reason: null,
      requiredInputs: [
        "physical network and SQLite internal I/O are unavailable; byte limits cover admitted content",
        "exact Cursor account enrollment",
        "logged-in Cursor client",
        "reviewed bounded account window",
      ],
      version: ACCOUNT_OPERATION_VERSION,
    },
    execute,
    meteredWork: true,
    prepare,
    probe: probeBoundedAccountOperation,
    replay: "safe",
    steps: () => [
      operationStep("cursor-account-window", ACCOUNT_OPERATION_SOURCE),
    ],
    validate,
  };
};
