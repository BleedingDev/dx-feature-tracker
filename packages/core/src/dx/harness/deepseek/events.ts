// @effect-diagnostics nodeBuiltinImport:off -- Event ids are content hashes computed synchronously while a session log is folded.
import { createHash } from "node:crypto";

import type { AiAttribution, AiUsage } from "../../model/attribution.js";
import type { Origin } from "../../model/common.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import { harnessAdapterId } from "../pending.js";
import { normalizeModel } from "../provider.js";
import { isZeroUsage, isoOf, makerOf, tokensOf, viaOf } from "./attribution.js";
import type {
  FoldRecord,
  RequestRecord,
  RouteState,
  TitleRecord,
  ToolRecord,
  TurnRecord,
} from "./fold.js";
import type { Header } from "./format.js";

export const DEEPSEEK_ADAPTER_ID = harnessAdapterId("deepseek");

export const DEEPSEEK_ADAPTER_VERSION = "0.2.0" as const;

export const DEEPSEEK_SOURCE_KIND = "deepseek-session" as const;

export interface SessionFacts {
  readonly agentType: string | null;
  readonly context: FlightContext;
  readonly formatVersion: number;
  readonly harnessVersion: string | null;
  readonly header: Header;
  readonly origin: Origin;
}

type Payload = DxEventEnvelope["payload"];

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const isSubagent = (header: Header): boolean =>
  header.origin === "subagent" || header.parentSession !== undefined;

const turnIdOf = (sessionId: string, turn: number | null): string | null =>
  turn === null ? null : `${sessionId}:turn:${String(turn)}`;

const TOKEN_SEMANTICS: readonly FieldSemantics[] = [
  ["tokens.input", "usage.inputTokens", "uncached input tokens"],
  ["tokens.cached-input", "usage.cacheReadTokens", "cache reads"],
  ["tokens.cache-write", "usage.cacheWriteTokens", "cache writes"],
  ["tokens.output", "usage.outputTokens", "includes reasoning"],
  ["tokens.reasoning", "usage.reasoningTokens", "subset of output"],
  ["tokens.total", "usage.totalTokens", "full-call total"],
].map(([field = "", rawName = "", note = ""]) => ({
  field,
  method: "source-reported" as const,
  note,
  rawName,
  unit: "tokens",
}));

interface Built {
  readonly ai: AiAttribution | null;
  readonly identity: Partial<DxEventEnvelope["identity"]>;
  readonly kind: EventKind;
  readonly payload: Payload;
  readonly seq: number | null;
  readonly time: number | null;
  readonly upstreamKey: string;
  readonly usage: AiUsage | null;
}

const envelope = (facts: SessionFacts, built: Built): DxEventEnvelope => {
  const occurredAt = isoOf(built.time);
  const sessionId = facts.header.id;
  const seq = built.seq === null ? "header" : `seq:${String(built.seq)}`;

  return {
    acquisition: "file-import",
    adapterId: DEEPSEEK_ADAPTER_ID,
    adapterVersion: DEEPSEEK_ADAPTER_VERSION,
    ai: built.ai,
    context: facts.context,
    eventId: EventIdSchema.make(
      `sha256:${sha256Hex(
        [
          DEEPSEEK_ADAPTER_ID,
          built.kind,
          built.upstreamKey,
          JSON.stringify(built.payload),
        ].join("\n")
      )}`
    ),
    evidence: {
      bounded: true,
      hash: null,
      ref: `${DEEPSEEK_ADAPTER_ID}:${sessionId}#${seq}`,
    },
    fieldSemantics: built.usage === null ? [] : TOKEN_SEMANTICS,
    identity: { ...emptyEventIdentity, sessionId, ...built.identity },
    kind: built.kind,
    observedAt: occurredAt ?? isoOf(facts.header.createdAt) ?? "",
    occurredAt,
    occurredAtPrecision: occurredAt === null ? "unknown" : "exact",
    origin: facts.origin,
    payload: built.payload,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: `session.v${String(facts.formatVersion)}`,
    upstreamKey: built.upstreamKey,
    usage: built.usage,
  };
};

const attributionFor = (
  facts: SessionFacts,
  route: RouteState | null,
  modelReported: string | null
): AiAttribution => {
  const { header } = facts;
  const subagent = isSubagent(header);
  const configured = route?.provider ?? null;
  const modelRaw = modelReported ?? route?.model ?? null;

  return {
    agentId: subagent ? header.id : null,
    agentType: subagent ? (facts.agentType ?? "subagent") : null,
    branchSource: facts.context.branch === null ? "unassigned" : "cwd-inferred",
    channel: "session-file",
    cwd: header.cwd ?? null,
    effort: route?.effort ?? null,
    effortSource: route?.effortSource ?? null,
    harness: "deepseek",
    harnessVersion: facts.harnessVersion,
    model: normalizeModel(modelRaw),
    modelRaw,
    parentSessionId: header.parentSession ?? null,
    provider: makerOf(modelRaw, configured),
    sessionId: header.id,
    via: viaOf(modelRaw, configured),
  };
};

const sessionPayload = (facts: SessionFacts): Payload => ({
  cwd: facts.header.cwd ?? null,
  delegationDepth: facts.header.delegationDepth ?? 0,
  isSeeded: facts.header.isSeeded === true,
  isSubagent: isSubagent(facts.header),
  parentSessionId: facts.header.parentSession ?? null,
  sourceKind: DEEPSEEK_SOURCE_KIND,
});

const routePayload = (
  route: RouteState | null,
  modelReported: string | null
): Payload => ({
  effort: route?.effort ?? null,
  model: modelReported ?? route?.model ?? null,
  modelRequested: route?.model ?? null,
  providerId: route?.provider ?? null,
});

const usageReportedOf = (
  record: RequestRecord,
  counted: RequestRecord["usage"]
): string => {
  if (record.usage === null) {
    return "none";
  }

  return counted === null ? "zero" : "tokens";
};

const requestEvent = (
  facts: SessionFacts,
  record: RequestRecord
): DxEventEnvelope => {
  const counted =
    record.usage === null || isZeroUsage(record.usage) ? null : record.usage;

  const tokens = counted === null ? null : tokensOf(counted);

  const usage: AiUsage | null =
    tokens === null
      ? null
      : {
          premiumRequests: null,
          requestKey: record.requestKey,
          serviceTier: record.serviceTier,
          speed: null,
          tokens,
          toolFigure: null,
        };

  return envelope(facts, {
    ai: attributionFor(facts, record.route, record.modelReported),
    identity: {
      generationId: record.messageId,
      requestId: record.responseId,
      turnId: turnIdOf(facts.header.id, record.turn),
    },
    kind: usage === null ? "ai.request" : "ai.usage",
    payload: {
      ...sessionPayload(facts),
      ...routePayload(record.route, record.modelReported),
      attempt: record.attempt,
      errorCode: record.errorCode,
      outcome: record.outcome,
      replacesRequestKey: record.replaces,
      requestKey: record.requestKey,
      requestSource: record.source,
      step: record.step,
      tokens:
        tokens === null
          ? null
          : {
              "cache-write": tokens.cacheWrite,
              "cached-input": tokens.cacheRead,
              input: tokens.inputFresh,
              output: tokens.output,
              reasoning: tokens.reasoning,
              total: tokens.total,
            },
      turn: record.turn,
      usageReported: usageReportedOf(record, counted),
    },
    seq: record.seq,
    time: record.time,
    upstreamKey: record.requestKey,
    usage,
  });
};

const turnEvent = (
  facts: SessionFacts,
  record: TurnRecord
): DxEventEnvelope => {
  const turnId = turnIdOf(facts.header.id, record.turn) ?? "";

  return envelope(facts, {
    ai: attributionFor(facts, record.route, record.modelReported),
    identity: { turnId },
    kind: "ai.turn",
    payload: {
      ...sessionPayload(facts),
      ...routePayload(record.route, record.modelReported),
      durationMs:
        record.startedAt === null || record.endedAt === null
          ? null
          : record.endedAt - record.startedAt,
      endedAt: isoOf(record.endedAt),
      errorCode: record.errorCode,
      outcome: record.outcome,
      requests: record.requests,
      turn: record.turn,
    },
    seq: record.seq,
    time: record.startedAt ?? record.endedAt,
    upstreamKey: turnId,
    usage: null,
  });
};

const titleEvent = (
  facts: SessionFacts,
  record: TitleRecord
): DxEventEnvelope =>
  envelope(facts, {
    ai: attributionFor(facts, null, null),
    identity: {},
    kind: "ai.session",
    payload: {
      ...sessionPayload(facts),
      title: record.title,
      titleSource: record.source,
    },
    seq: record.seq,
    time: record.time,
    upstreamKey: `${facts.header.id}:title:${String(record.seq)}`,
    usage: null,
  });

const toolEvent = (facts: SessionFacts, record: ToolRecord): DxEventEnvelope =>
  envelope(facts, {
    ai: attributionFor(facts, null, null),
    identity: { turnId: turnIdOf(facts.header.id, record.turn) },
    kind: "ai.tool-edit",
    payload: {
      cwd: record.workdir,
      filePath: record.filePath,
      isSubagent: isSubagent(facts.header),
      parentSessionId: facts.header.parentSession ?? null,
      sourceKind: DEEPSEEK_SOURCE_KIND,
      toolCallId: record.callId,
      toolName: record.name,
      turn: record.turn,
    },
    seq: record.seq,
    time: record.time,
    upstreamKey: `${facts.header.id}:tool:${record.callId}`,
    usage: null,
  });

export const sessionStartEvent = (facts: SessionFacts): DxEventEnvelope =>
  envelope(facts, {
    ai: attributionFor(facts, null, null),
    identity: {},
    kind: "ai.session",
    payload: {
      ...sessionPayload(facts),
      createdAt: isoOf(facts.header.createdAt),
    },
    seq: null,
    time: facts.header.createdAt,
    upstreamKey: `${facts.header.id}:session`,
    usage: null,
  });

export const recordEvent = (
  facts: SessionFacts,
  record: FoldRecord
): DxEventEnvelope => {
  if (record.kind === "request") {
    return requestEvent(facts, record);
  }

  if (record.kind === "turn") {
    return turnEvent(facts, record);
  }

  return record.kind === "title"
    ? titleEvent(facts, record)
    : toolEvent(facts, record);
};
