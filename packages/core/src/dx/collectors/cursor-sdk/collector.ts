// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import type { SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  EventKind,
  FieldSemantics,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";
import type { FlightRecord, SdkAgentUsage, SdkTokenUsage } from "./parse.js";
import {
  FLIGHT_RECORD_SCHEMA,
  centsToUsd,
  parseFlightLine,
  tokenMapOf,
} from "./parse.js";

export const CURSOR_SDK_ADAPTER_ID = "cursor-sdk";

export const CURSOR_SDK_ADAPTER_VERSION = "0.1.0";

export const CURSOR_SDK_FIXTURE_ID = "b44-cursor-sdk-flight-record";

export const CURSOR_SDK_PROBED_VERSION = "@cursor/sdk@1.0.34";

const SOURCE_GAPS: readonly SourceGap[] = [
  {
    code: "instrumented-traffic-only",
    message: `Only Cursor SDK runs whose caller appended ${FLIGHT_RECORD_SCHEMA} lines (stream usage/tool_call messages, Run.wait() results, agent.getUsage() settlements) with an explicit flight.branch tag are seen. IDE, CLI and uninstrumented SDK traffic are invisible to this adapter.`,
  },
  {
    code: "content-omitted",
    message:
      "Assistant, user, thinking and task text plus tool args/results are never read or stored; only counters, tool names, statuses and ids.",
  },
  {
    code: "reasoning-subset-of-output",
    message:
      "SDK reasoningTokens are a subset of outputTokens and totalTokens excludes reasoning; totals must not add reasoning on top of output.",
  },
  {
    code: "settlement-first-import-wins",
    message:
      "Settlement cost is eventually consistent. Within one import the latest getUsage() snapshot per agent is used; a later re-import of the same run keeps the first stored event.",
  },
];

export const cursorSdkDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [CURSOR_SDK_FIXTURE_ID],
  gaps: SOURCE_GAPS,
  id: DescriptorIdSchema.make("collector/cursor-sdk"),
  kind: "collector",
  owner: "B44",
  readiness: "disabled",
  requiredInputs: [
    `user-selected JSONL run record (${FLIGHT_RECORD_SCHEMA}) written by the caller's own @cursor/sdk instrumentation, one tagged record per line`,
  ],
  supportedFields: [
    "context.branch",
    "identity.sessionId",
    "identity.turnId",
    "identity.requestId",
    "payload.tokens.input",
    "payload.tokens.output",
    "payload.tokens.cacheRead",
    "payload.tokens.cacheWrite",
    "payload.tokens.reasoning",
    "payload.charge",
    "payload.rawCostUsd",
    "payload.agentDurationMs",
    "payload.runStatus",
    "payload.toolCall",
    "payload.toolName",
    "payload.status",
  ],
  version: CURSOR_SDK_ADAPTER_VERSION,
};

const TOKEN_SEMANTICS: readonly FieldSemantics[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
].map((key) => ({
  field: `payload.tokens.${key}`,
  method: "source-reported" as const,
  note:
    key === "reasoning" ? "subset of output tokens per SDK TokenUsage" : null,
  rawName: `${key}Tokens`,
  unit: "tokens",
}));

const SETTLEMENT_SEMANTICS: readonly FieldSemantics[] = [
  ...TOKEN_SEMANTICS,
  {
    field: "payload.charge",
    method: "source-reported",
    note: "UsageCost.chargedCents / 100; 0 for plan-included, BYOK and credit-grant usage",
    rawName: "chargedCents",
    unit: "USD",
  },
  {
    field: "payload.rawCostUsd",
    method: "source-reported",
    note: "UsageCost.rawCostCents / 100: undiscounted model token cost, not a charge",
    rawName: "rawCostCents",
    unit: "USD",
  },
];

const RESULT_SEMANTICS: readonly FieldSemantics[] = [
  ...TOKEN_SEMANTICS,
  {
    field: "payload.agentDurationMs",
    method: "source-reported",
    note: "RunResult.durationMs: agent wall time for the run, not human waiting",
    rawName: "durationMs",
    unit: "ms",
  },
];

const hashOf = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

interface Sink {
  readonly events: Map<string, DxEventEnvelope>;
  readonly gaps: SourceGap[];
}

interface EventSeed {
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly kind: EventKind;
  readonly payload: DxEventEnvelope["payload"];
  readonly record: FlightRecord;
  readonly requestId: string | null;
  readonly turnId: string | null;
  readonly upstreamKey: string;
}

const emit = (
  sink: Sink,
  seed: EventSeed,
  input: CollectInput,
  source: { readonly ref: string; readonly hash: string },
  observedAt: string
) => {
  const eventId = EventIdSchema.make(
    hashOf(
      `${CURSOR_SDK_ADAPTER_ID}\u0000${seed.upstreamKey}\u0000${seed.kind}`
    )
  );

  sink.events.set(eventId, {
    acquisition: "file-import",
    adapterId: CURSOR_SDK_ADAPTER_ID,
    adapterVersion: CURSOR_SDK_ADAPTER_VERSION,
    context: { ...input.context, branch: seed.record.flight.branch },
    eventId,
    evidence: {
      bounded: true,
      hash: source.hash,
      ref: `${source.ref}#L${seed.record.line}`,
    },
    fieldSemantics: seed.fieldSemantics,
    identity: {
      ...emptyEventIdentity,
      requestId: seed.requestId,
      sessionId: seed.record.agentId,
      turnId: seed.turnId,
    },
    kind: seed.kind,
    observedAt,
    occurredAt: seed.record.recordedAt,
    occurredAtPrecision: "exact",
    origin: input.origin,
    payload: {
      ...seed.payload,
      flightTag: seed.record.flight.flightId ?? null,
      sourceKind: "sdk",
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: CURSOR_SDK_PROBED_VERSION,
    upstreamKey: seed.upstreamKey,
  });
};

const subtract = (total: SdkTokenUsage, runs: SdkAgentUsage["runs"]) => {
  const sum = (pick: (usage: SdkTokenUsage) => number) =>
    pick(total) - runs.reduce((acc, run) => acc + pick(run.usage), 0);

  return {
    cacheReadTokens: sum((usage) => usage.cacheReadTokens),
    cacheWriteTokens: sum((usage) => usage.cacheWriteTokens),
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
  };
};

const TOOL_STATUS = {
  completed: "ok",
  error: "failed",
  running: "running",
} as const;

const emptyUsage: SdkTokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

type Emitter = (seed: EventSeed) => void;

const emitSettlement = (
  record: Extract<FlightRecord, { type: "settlement" }>,
  push: Emitter,
  gaps: SourceGap[]
) => {
  const { agentId, usage } = record;

  for (const run of usage.runs) {
    push({
      fieldSemantics: SETTLEMENT_SEMANTICS,
      kind: "ai.usage",
      payload: {
        charge:
          run.cost === undefined ? null : centsToUsd(run.cost.chargedCents),
        chargeReason:
          run.cost === undefined ? "backend has not reported cost yet" : null,
        currency: run.cost === undefined ? null : "USD",
        rawCostUsd:
          run.cost === undefined ? null : centsToUsd(run.cost.rawCostCents),
        rawTotalTokens: run.usage.totalTokens ?? null,
        record: "settlement",
        requestKey: `cursor-sdk:${agentId}:${run.runId}`,
        tokens: tokenMapOf(run.usage),
      },
      record,
      requestId: null,
      turnId: run.runId,
      upstreamKey: `settlement:${agentId}:${run.runId}`,
    });

    if (run.cost === undefined) {
      gaps.push({
        code: "cost-unsettled",
        message: `agent ${agentId} run ${run.runId}: getUsage() reported no cost yet`,
      });
    }
  }

  const remainder = subtract(usage.usage, usage.runs);
  const hasRemainder = Object.values(remainder).some((value) => value > 0);

  if (hasRemainder) {
    gaps.push({
      code: "settlement-unkeyed-remainder",
      message: `agent ${agentId}: agent totals exceed the per-run entries (local events without a usage UUID); remainder kept as an aggregate bucket, not attributed to a run`,
    });
    push({
      fieldSemantics: TOKEN_SEMANTICS,
      kind: "ai.usage",
      payload: {
        charge: null,
        chargeReason:
          "agent-level cost is not split between keyed runs and the remainder",
        record: "settlement-remainder",
        scope: "provider-bucket",
        tokens: {
          cacheRead: remainder.cacheReadTokens,
          cacheWrite: remainder.cacheWriteTokens,
          input: remainder.inputTokens,
          output: remainder.outputTokens,
        },
      },
      record,
      requestId: null,
      turnId: null,
      upstreamKey: `settlement-remainder:${agentId}`,
    });
  }
};

const emitResult = (
  record: Extract<FlightRecord, { type: "run-result" }>,
  settled: boolean,
  push: Emitter,
  gaps: SourceGap[]
) => {
  const { agentId, result } = record;
  const counts = !settled && result.usage !== undefined;

  if (!settled) {
    gaps.push({
      code: "cost-unsettled",
      message: `agent ${agentId} run ${result.id}: no getUsage() settlement recorded; charge unavailable`,
    });
  }

  push({
    fieldSemantics: RESULT_SEMANTICS,
    kind: counts ? "ai.usage" : "ai.request",
    payload: {
      agentDurationMs: result.durationMs ?? null,
      charge: null,
      chargeReason: settled
        ? "charged on the agent settlement events"
        : "no settlement recorded",
      model: result.model?.id ?? null,
      record: "run-result",
      requestKey: `cursor-sdk:${agentId}:${result.id}`,
      runStatus: result.status,
      ...(counts
        ? { tokens: tokenMapOf(result.usage ?? emptyUsage) }
        : {
            runTokens:
              result.usage === undefined ? null : tokenMapOf(result.usage),
          }),
      tokensReason: result.usage === undefined ? "run reported no usage" : null,
    },
    record,
    requestId: result.requestId ?? null,
    turnId: result.id,
    upstreamKey: `result:${agentId}:${result.id}`,
  });
};

const latestSettlements = (records: readonly FlightRecord[]) => {
  const latest = new Map<
    string,
    Extract<FlightRecord, { type: "settlement" }>
  >();

  for (const record of records) {
    if (record.type === "settlement") {
      const previous = latest.get(record.agentId);

      if (previous === undefined || previous.recordedAt <= record.recordedAt) {
        latest.set(record.agentId, record);
      }
    }
  }

  return latest;
};

const latestToolCalls = (records: readonly FlightRecord[]) => {
  const calls = new Map<string, Extract<FlightRecord, { type: "tool-call" }>>();

  for (const record of records) {
    if (record.type === "tool-call") {
      const key = `${record.agentId}:${record.callId}`;
      const previous = calls.get(key);

      if (previous === undefined || previous.status === "running") {
        calls.set(key, record);
      }
    }
  }

  return calls;
};

export const parseCursorSdkFlightRecord = (
  text: string,
  source: { readonly ref: string },
  input: CollectInput,
  observedAt: string
): EventBatch => {
  const sink: Sink = { events: new Map(), gaps: [...SOURCE_GAPS] };
  const records: FlightRecord[] = [];
  const lines = text.split("\n");
  const hashed = { hash: hashOf(text), ref: source.ref };
  let considered = 0;

  for (const [index, line] of lines.entries()) {
    const outcome = parseFlightLine(line, index + 1);

    if (outcome.kind === "rejected") {
      considered += 1;
      sink.gaps.push({ code: outcome.code, message: outcome.message });
    } else if (outcome.kind === "record") {
      considered += 1;
      const wanted = input.context.branch;

      if (wanted !== null && wanted !== outcome.record.flight.branch) {
        sink.gaps.push({
          code: "flight-tag-other-branch",
          message: `line ${outcome.record.line}: tagged ${outcome.record.flight.branch}, selected branch is ${wanted}; skipped`,
        });
      } else {
        records.push(outcome.record);
      }
    }
  }

  const push: Emitter = (seed) => {
    emit(sink, seed, input, hashed, observedAt);
  };

  const settlements = latestSettlements(records);

  for (const record of settlements.values()) {
    emitSettlement(record, push, sink.gaps);
  }

  const turnOrdinal = new Map<string, number>();

  for (const record of records) {
    if (record.type === "run-result") {
      emitResult(record, settlements.has(record.agentId), push, sink.gaps);
    } else if (record.type === "turn-usage") {
      const runKey = `${record.agentId}:${record.runId}`;
      const ordinal = (turnOrdinal.get(runKey) ?? 0) + 1;

      turnOrdinal.set(runKey, ordinal);
      push({
        fieldSemantics: [],
        kind: "ai.turn",
        payload: {
          liveTurnTokens: tokenMapOf(record.usage),
          note: "live per-turn usage; informational, totals come from run results or settlements",
          record: "turn-usage",
        },
        record,
        requestId: null,
        turnId: record.runId,
        upstreamKey: `turn-usage:${runKey}:${ordinal}`,
      });
    }
  }

  for (const call of latestToolCalls(records).values()) {
    push({
      fieldSemantics: [],
      kind: "ai.turn",
      payload: {
        record: "tool-call",
        status: TOOL_STATUS[call.status],
        toolCall: true,
        toolName: call.name,
      },
      record: call,
      requestId: null,
      turnId: call.runId,
      upstreamKey: `tool-call:${call.agentId}:${call.callId}`,
    });
  }

  const accepted = [...sink.events.values()];

  return {
    coverage: {
      adapterId: CURSOR_SDK_ADAPTER_ID,
      expectedItems: considered,
      gaps: sink.gaps,
      observedItems: accepted.length,
      state: accepted.length === 0 ? "none" : "partial",
      watermark: null,
      windowFrom: null,
      windowTo: null,
    },
    cursor: null,
    events: accepted,
  };
};

export const cursorSdkCollector: DxCollector<FileSystem.FileSystem> = {
  collect: (input) =>
    Effect.gen(function* collectCursorSdk() {
      const selected = input.selectedInput;

      if (selected === null || selected.length === 0) {
        return yield* new InvalidInput({
          field: "input",
          message:
            "cursor-sdk reads only an explicitly selected run record JSONL file (--input); it never runs the SDK or calls Cursor APIs",
        });
      }

      const fileSystem = yield* FileSystem.FileSystem;

      const text = yield* fileSystem.readFileString(selected).pipe(
        Effect.mapError(
          () =>
            new SourceUnavailable({
              adapterId: CURSOR_SDK_ADAPTER_ID,
              message: "selected cursor-sdk run record is not readable",
            })
        )
      );

      const now = yield* DateTime.now;

      return parseCursorSdkFlightRecord(
        text,
        { ref: selected },
        input,
        DateTime.formatIso(now)
      );
    }),
  descriptor: cursorSdkDescriptor,
};
