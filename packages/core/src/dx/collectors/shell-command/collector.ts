import {
  Clock,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Schema,
} from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { TimePrecision } from "../../model/common.js";
import type { SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventBatch,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import { parseShellHistory, tokenize } from "./history.js";
import {
  CommandLifecycleRecordSchema,
  isTestCommand,
  programOf,
  redactArgv,
} from "./record.js";
import type { CommandLifecycleRecord } from "./record.js";

export const SHELL_COMMAND_ADAPTER_ID = "command-capture";

export const SHELL_HISTORY_PREFIX = "history:";

const ADAPTER_VERSION = "1.0.0";

export const shellCommandDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: ["b20-lifecycle", "b20-history-zsh", "b20-history-bash"],
  gaps: [
    {
      code: "history-reconstructed",
      message:
        "Shell history import has no exit code, cwd or branch; events are reconstructed with provisional context.",
    },
    {
      code: "test-counts-unavailable",
      message:
        "Test runs are classified from argv; pass/fail comes from exit status, individual test counts are unavailable.",
    },
  ],
  id: DescriptorIdSchema.make("collector/shell-command"),
  kind: "collector",
  owner: "B20",
  readiness: "ready",
  requiredInputs: [
    "command lifecycle JSONL written by captureCommand (path)",
    "optional explicitly selected shell history file (history:<path>)",
  ],
  supportedFields: [
    "command.run.argv(redacted)",
    "command.run.exitCode",
    "command.run.signal",
    "command.run.startedAt",
    "command.run.completedAt",
    "command.run.durationMs",
    "command.run.testCommand",
    "test.result.outcome",
  ],
  version: ADAPTER_VERSION,
};

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(CommandLifecycleRecordSchema)
);

interface Draft {
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly kind: EventKind;
  readonly occurredAt: string | null;
  readonly precision: TimePrecision;
  readonly payload: DxEventEnvelope["payload"];
  readonly rawLine: string;
  readonly context: FlightContext;
  readonly sessionId: string | null;
  readonly upstreamKey: string;
}

const parseMs = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }

  const parsed = DateTime.make(iso);

  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
};

const epochIso = (seconds: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

const relativeCwd = (
  cwd: string | null,
  worktree: string | null
): string | null => {
  if (cwd === null || worktree === null) {
    return null;
  }

  if (cwd === worktree) {
    return ".";
  }

  return cwd.startsWith(`${worktree}/`) ? cwd.slice(worktree.length + 1) : null;
};

const statusOf = (record: CommandLifecycleRecord): string => {
  if (record.phase === "start") {
    return "incomplete";
  }

  if (record.spawnError !== null) {
    return "spawn-error";
  }

  if (record.signal !== null) {
    return "signaled";
  }

  return record.exitCode === 0 ? "succeeded" : "failed";
};

const lifecycleDrafts = (
  record: CommandLifecycleRecord,
  rawLine: string,
  input: CollectInput
): readonly Draft[] => {
  const redacted = redactArgv(record.argv);
  const startMs = parseMs(record.startedAt);
  const endMs = parseMs(record.endedAt);

  const durationMs =
    startMs !== null && endMs !== null && endMs >= startMs
      ? endMs - startMs
      : null;

  const context: FlightContext = {
    ...input.context,
    branch: record.branch ?? input.context.branch,
    headSha: record.headSha ?? input.context.headSha,
  };

  const status = statusOf(record);
  const testCommand = isTestCommand(record.argv);

  const common = {
    completedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    status,
  };

  const semantics: FieldSemantics[] = [
    {
      field: "exitCode",
      method: "observed",
      note: null,
      rawName: "exitCode",
      unit: null,
    },
    {
      field: "durationMs",
      method: "derived",
      note:
        durationMs === null
          ? "unavailable: missing or inconsistent end time"
          : null,
      rawName: null,
      unit: "ms",
    },
  ];

  const run: Draft = {
    context,
    fieldSemantics: semantics,
    kind: "command.run",
    occurredAt: record.startedAt,
    payload: {
      ...common,
      argv: redacted.args,
      argvTruncated: redacted.truncated,
      contextSource: record.branch === null ? "collect-input" : "recorded",
      cwdRelative: relativeCwd(record.cwd, input.context.worktreePath),
      durationMs,
      program: programOf(record.argv),
      redactedCount: redacted.redactedCount,
      source: "lifecycle",
      spawnError: record.spawnError,
      testCommand,
    },
    precision: "exact",
    rawLine,
    sessionId: record.runId,
    upstreamKey: `run:${record.runId}`,
  };

  if (!testCommand || record.phase === "start") {
    return [run];
  }

  const outcome = record.exitCode === 0 ? "passed" : "failed";

  const test: Draft = {
    ...run,
    fieldSemantics: [
      {
        field: "outcome",
        method: "derived",
        note: "from process exit status; test counts unavailable",
        rawName: null,
        unit: null,
      },
    ],
    kind: "test.result",
    occurredAt: record.endedAt ?? record.startedAt,
    payload: {
      ...common,
      durationMs,
      failedTests: null,
      outcome,
      passedTests: null,
      program: programOf(record.argv),
      runUpstreamKey: `run:${record.runId}`,
    },
    upstreamKey: `test:${record.runId}`,
  };

  return [run, test];
};

const collectLifecycle = (lines: readonly string[], input: CollectInput) => {
  const latest = new Map<
    string,
    { record: CommandLifecycleRecord; raw: string; index: number }
  >();

  let invalid = 0;

  for (const [index, raw] of lines.entries()) {
    if (raw.trim().length === 0) {
      continue;
    }

    const decoded = decodeRecord(raw);

    if (Option.isNone(decoded)) {
      invalid += 1;
      continue;
    }

    const existing = latest.get(decoded.value.runId);

    if (existing === undefined || existing.record.phase === "start") {
      latest.set(decoded.value.runId, {
        index: existing?.index ?? index,
        raw,
        record: decoded.value,
      });
    }
  }

  const runs = [...latest.values()];

  const drafts = runs
    .filter(({ record }) => record.phase === "end")
    .flatMap(({ raw, record }) => lifecycleDrafts(record, raw, input));

  const pending = runs.filter(({ record }) => record.phase === "start");
  const incomplete = pending.length;

  const holdFrom =
    pending.length === 0
      ? null
      : Math.min(...pending.map(({ index }) => index));

  const gaps: SourceGap[] = [];

  if (invalid > 0) {
    gaps.push({
      code: "invalid-records",
      message: `${invalid} line(s) did not decode`,
    });
  }

  if (incomplete > 0) {
    gaps.push({
      code: "incomplete-runs",
      message: `${incomplete} run(s) have a start record but no end record yet; not emitted, cursor held before them`,
    });
  }

  return { drafts, expected: latest.size, gaps, holdFrom };
};

const collectHistory = (text: string, input: CollectInput) => {
  const entries = parseShellHistory(text);

  const drafts = entries.map((entry): Draft => {
    const argv = tokenize(entry.command);
    const redacted = redactArgv(argv);

    const occurredAt =
      entry.epochSeconds === null ? null : epochIso(entry.epochSeconds);

    return {
      context: input.context,
      fieldSemantics: [
        {
          field: "exitCode",
          method: "observed",
          note: "unavailable: shell history does not record exit status",
          rawName: null,
          unit: null,
        },
        {
          field: "durationMs",
          method: "source-reported",
          note:
            entry.durationSeconds === null
              ? "unavailable: history format has no duration"
              : "zsh EXTENDED_HISTORY elapsed seconds",
          rawName: "elapsed",
          unit: "ms",
        },
      ],
      kind: "command.run",
      occurredAt,
      payload: {
        argv: redacted.args,
        argvTruncated: redacted.truncated,
        completedAt: null,
        contextSource: "collect-input-provisional",
        cwdRelative: null,
        durationMs:
          entry.durationSeconds === null ? null : entry.durationSeconds * 1000,
        exitCode: null,
        program: programOf(argv),
        reconstructed: true,
        redactedCount: redacted.redactedCount,
        signal: null,
        source: "shell-history",
        startedAt: occurredAt,
        status: "unknown",
        testCommand: isTestCommand(argv),
      },
      precision: occurredAt === null ? "unknown" : "second",
      rawLine: `${entry.line}\u0000${entry.command}`,
      sessionId: null,
      upstreamKey: `history:${entry.line}`,
    };
  });

  const untimed = entries.filter((entry) => entry.epochSeconds === null).length;

  const gaps: SourceGap[] = [
    {
      code: "history-reconstructed",
      message:
        "History entries lack exit status, cwd and branch; context is provisional.",
    },
  ];

  if (untimed > 0) {
    gaps.push({
      code: "history-untimed",
      message: `${untimed} entrie(s) have no timestamp`,
    });
  }

  return { drafts, expected: entries.length, gaps, holdFrom: null };
};

const sha256 = Effect.fn("sha256")(function* sha256(value: string) {
  const crypto = yield* Crypto.Crypto;

  const bytes = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(
      Effect.mapError(
        (error) =>
          new SourceUnavailable({
            adapterId: SHELL_COMMAND_ADAPTER_ID,
            message: `sha256 digest failed: ${error._tag}`,
          })
      )
    );

  return `sha256:${toHex(bytes)}`;
});

const toEnvelope = Effect.fn("toEnvelope")(function* toEnvelope(
  draft: Draft,
  input: CollectInput,
  isHistory: boolean,
  observedAt: string,
  selectedRef: string
) {
  const eventId = yield* sha256(
    `${SHELL_COMMAND_ADAPTER_ID}\u0000${draft.upstreamKey}\u0000${draft.kind}`
  );

  const hash = yield* sha256(draft.rawLine);

  const envelope: DxEventEnvelope = {
    acquisition: isHistory ? "file-import" : "command-capture",
    adapterId: SHELL_COMMAND_ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    context: draft.context,
    eventId: EventIdSchema.make(eventId),
    evidence: {
      bounded: true,
      hash,
      ref: `${selectedRef}#${draft.upstreamKey}`,
    },
    fieldSemantics: draft.fieldSemantics,
    identity: { ...emptyEventIdentity, sessionId: draft.sessionId },
    kind: draft.kind,
    observedAt,
    occurredAt: draft.occurredAt,
    occurredAtPrecision: draft.precision,
    origin: input.origin,
    payload: draft.payload,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: isHistory ? "shell-history" : "dx.shell-command.v1",
    upstreamKey: draft.upstreamKey,
  };

  return envelope;
});

const parseCursor = (input: CollectInput): number => {
  if (
    input.cursor === null ||
    input.cursor.adapterId !== SHELL_COMMAND_ADAPTER_ID
  ) {
    return 0;
  }

  const value = Number(input.cursor.value);

  return Number.isInteger(value) && value >= 0 ? value : 0;
};

export const collectShellCommands = Effect.fn("collectShellCommands")(
  function* collectShellCommands(input: CollectInput) {
    const selected = input.selectedInput;

    if (selected === null || selected.length === 0) {
      return yield* new InvalidInput({
        field: "input",
        message:
          "shell-command needs an explicit lifecycle log path or history:<path>; nothing is scanned implicitly",
      });
    }

    const isHistory = selected.startsWith(SHELL_HISTORY_PREFIX);

    const path = isHistory
      ? selected.slice(SHELL_HISTORY_PREFIX.length)
      : selected;

    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new SourceUnavailable({
            adapterId: SHELL_COMMAND_ADAPTER_ID,
            message: `cannot read selected input: ${error._tag}`,
          })
      )
    );

    const allLines = text.split("\n");

    const consumed = isHistory
      ? 0
      : Math.min(parseCursor(input), allLines.length);

    const complete = text.endsWith("\n")
      ? allLines.length - 1
      : allLines.length;

    const fresh = isHistory ? [] : allLines.slice(consumed, complete);

    const result = isHistory
      ? collectHistory(text, input)
      : collectLifecycle(fresh, input);

    const observedAt = DateTime.formatIso(
      DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
    );

    const selectedRef = isHistory ? "shell-history" : "command-lifecycle-log";

    const events: DxEventEnvelope[] = [];

    for (const draft of result.drafts) {
      events.push(
        yield* toEnvelope(draft, input, isHistory, observedAt, selectedRef)
      );
    }

    const nextCursor =
      result.holdFrom === null
        ? Math.max(consumed, complete)
        : consumed + result.holdFrom;

    const times = events
      .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
      .toSorted();

    const batch: EventBatch = {
      coverage: {
        adapterId: SHELL_COMMAND_ADAPTER_ID,
        expectedItems: result.expected,
        gaps: result.gaps,
        observedItems: events.length,
        state: result.gaps.length === 0 ? "complete" : "partial",
        watermark: isHistory ? null : String(nextCursor),
        windowFrom: times.at(0) ?? null,
        windowTo: times.at(-1) ?? null,
      },
      cursor: isHistory
        ? null
        : { adapterId: SHELL_COMMAND_ADAPTER_ID, value: String(nextCursor) },
      events,
    };

    return batch;
  }
);

export const shellCommandCollector: DxCollector<
  Crypto.Crypto | FileSystem.FileSystem
> = {
  collect: (input) => collectShellCommands(input),
  descriptor: shellCommandDescriptor,
};
