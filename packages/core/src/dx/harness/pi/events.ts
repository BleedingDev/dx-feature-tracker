// @effect-diagnostics nodeBuiltinImport:off -- Event ids need a synchronous deterministic sha256 inside the pure event builder; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { Predicate } from "effect";

import type {
  AiAttribution,
  AiTokens,
  AiUsage,
  ToolFigure,
} from "../../model/attribution.js";
import type { Origin } from "../../model/common.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import type {
  DxEventEnvelope,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import type { BranchSource } from "../ids.js";
import { harnessAdapterId } from "../pending.js";
import type { PiUsage } from "./entries.js";
import { attributeModel } from "./models.js";
import type { PiAgent, PiRequest, PiTurn } from "./requests.js";

export const PI_ADAPTER_ID = harnessAdapterId("pi");

export const PI_ADAPTER_VERSION = "0.2.0";

export const PI_SOURCE_KIND = "pi-session";

export interface PiPlace {
  readonly branchSource: BranchSource;
  readonly context: FlightContext;
}

export interface PiPlaceQuery {
  readonly cwd: string | null;
  readonly turnId: string | null;
}

export interface PiSessionFacts {
  readonly cwd: string | null;
  readonly fileAgent: PiAgent | null;
  readonly localProviders: ReadonlySet<string>;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly parentSessionId: string | null;
  readonly path: string;
  readonly placeOf: (query: PiPlaceQuery) => PiPlace;
  readonly sessionId: string;
  readonly version: string | null;
}

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const eventIdOf = (upstreamKey: string, kind: EventKind) =>
  EventIdSchema.make(
    sha256(`${PI_ADAPTER_ID}\u0000${upstreamKey}\u0000${kind}`)
  );

const count = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value) || value < 0
    ? null
    : value;

const sumOf = (parts: readonly (number | null)[]): number | null => {
  let total = 0;

  for (const part of parts) {
    if (part === null) {
      return null;
    }

    total += part;
  }

  return total;
};

const cacheSplit = (cacheWrite: number | null, oneHour: number | null) => {
  if (oneHour !== null) {
    return {
      cacheWrite1h: oneHour,
      cacheWrite5m:
        cacheWrite === null ? null : Math.max(cacheWrite - oneHour, 0),
    };
  }

  return cacheWrite === 0
    ? { cacheWrite1h: 0, cacheWrite5m: 0 }
    : { cacheWrite1h: null, cacheWrite5m: null };
};

export const piTokens = (usage: PiUsage): AiTokens => {
  const inputFresh = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const reasoning = count(usage.reasoning) ?? (output === 0 ? 0 : null);

  return {
    cacheRead,
    cacheWrite,
    ...cacheSplit(cacheWrite, count(usage.cacheWrite1h)),
    inputFresh,
    output,
    reasoning,
    total: sumOf([inputFresh, output, cacheRead, cacheWrite]),
  };
};

export const reportsTokens = (tokens: AiTokens): boolean =>
  [tokens.inputFresh, tokens.output, tokens.cacheRead, tokens.cacheWrite].some(
    (value) => value !== null && value > 0
  );

export const costOf = (usage: PiUsage): number | null => {
  const { cost } = usage;

  if (cost === null || cost === undefined) {
    return null;
  }

  return count(Predicate.isNumber(cost) ? cost : cost.total);
};

export const piToolFigure = (usage: PiUsage): ToolFigure | null => {
  const amount = costOf(usage);

  return amount === null || amount <= 0
    ? null
    : { amount, currency: "USD", kind: "api-equivalent" };
};

const USAGE_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "payload.tokens.input",
    method: "source-reported",
    note: "uncached input tokens of this request",
    rawName: "usage.input",
    unit: "tokens",
  },
  {
    field: "payload.tokens.cacheRead",
    method: "source-reported",
    note: null,
    rawName: "usage.cacheRead",
    unit: "tokens",
  },
  {
    field: "payload.tokens.cacheWrite",
    method: "source-reported",
    note: null,
    rawName: "usage.cacheWrite",
    unit: "tokens",
  },
  {
    field: "payload.tokens.output",
    method: "source-reported",
    note: "includes reasoning",
    rawName: "usage.output",
    unit: "tokens",
  },
  {
    field: "payload.tokens.reasoning",
    method: "source-reported",
    note: "already inside output",
    rawName: "usage.reasoning",
    unit: "tokens",
  },
  {
    field: "payload.tokens.total",
    method: "derived",
    note: "input + output + cacheRead + cacheWrite of this one request; Pi's totalTokens is never summed across requests",
    rawName: "usage.totalTokens",
    unit: "tokens",
  },
  {
    field: "payload.cost.value",
    method: "estimated",
    note: "Pi's API-equivalent figure from model list prices; 0 for local and custom providers means no figure",
    rawName: "usage.cost.total",
    unit: "USD",
  },
];

const occurredPrecision = (at: string | null) =>
  at === null ? ("unknown" as const) : ("exact" as const);

const isSubagent = (agent: PiAgent | null, facts: PiSessionFacts) =>
  agent !== null || facts.fileAgent !== null;

const childSessionId = (facts: PiSessionFacts, agent: PiAgent | null) =>
  agent === null ? facts.sessionId : `${facts.sessionId}/${agent.id}`;

const parentOf = (facts: PiSessionFacts, agent: PiAgent | null) =>
  agent === null ? facts.parentSessionId : facts.sessionId;

interface BlockInput {
  readonly agent: PiAgent | null;
  readonly cwd: string | null;
  readonly effort: string | null;
  readonly modelRaw: string | null;
  readonly piProvider: string | null;
  readonly place: PiPlace;
}

const attributionOf = (
  facts: PiSessionFacts,
  input: BlockInput
): AiAttribution => {
  const model = attributeModel(
    input.modelRaw,
    input.piProvider,
    facts.localProviders
  );

  const agent = input.agent ?? facts.fileAgent;

  return {
    agentId: agent?.id ?? null,
    agentType: agent?.type ?? null,
    branchSource:
      input.place.context.branch === null
        ? "unassigned"
        : input.place.branchSource,
    channel: "session-file",
    cwd: input.cwd,
    effort: input.effort,
    effortSource: input.effort === null ? null : "harness-recorded",
    harness: "pi",
    harnessVersion: facts.version,
    model: model.model,
    modelRaw: model.modelRaw,
    parentSessionId: parentOf(facts, input.agent),
    provider: model.provider,
    sessionId: childSessionId(facts, input.agent),
    via: model.via,
  };
};

const baseEnvelope = (facts: PiSessionFacts) => ({
  acquisition: "file-import" as const,
  adapterId: PI_ADAPTER_ID,
  adapterVersion: PI_ADAPTER_VERSION,
  observedAt: facts.observedAt,
  origin: facts.origin,
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: facts.version,
});

const failedStop = (stopReason: string | null): boolean =>
  stopReason === "error" || stopReason === "aborted";

const tokenPayload = (tokens: AiTokens) => ({
  cacheRead: tokens.cacheRead,
  cacheWrite: tokens.cacheWrite,
  input: tokens.inputFresh,
  output: tokens.output,
  reasoning: tokens.reasoning,
  total: tokens.total,
});

const costPayload = (amount: number | null) =>
  amount === null || amount <= 0
    ? null
    : {
        currency: "USD",
        ledger: "list-price-estimate",
        method: "estimated",
        value: amount,
      };

interface Measured {
  readonly counted: boolean;
  readonly kind: EventKind;
  readonly tokens: AiTokens | null;
  readonly usage: AiUsage | null;
}

const measure = (request: PiRequest): Measured => {
  if (request.usage === null) {
    return { counted: false, kind: "ai.request", tokens: null, usage: null };
  }

  const tokens = piTokens(request.usage);
  const counted = reportsTokens(tokens);
  const figure = piToolFigure(request.usage);

  if (!counted && figure === null) {
    return { counted, kind: "ai.request", tokens, usage: null };
  }

  return {
    counted,
    kind: "ai.usage",
    tokens,
    usage: {
      premiumRequests: null,
      requestKey: request.key,
      serviceTier: null,
      speed: null,
      tokens,
      toolFigure: figure,
    },
  };
};

const requestPayload = (
  facts: PiSessionFacts,
  request: PiRequest,
  measured: Measured,
  cwd: string | null
) => {
  const agent = request.agent ?? facts.fileAgent;
  const usage = request.usage ?? null;

  return {
    agentId: agent?.id ?? null,
    agentType: agent?.type ?? null,
    cost: usage === null ? null : costPayload(costOf(usage)),
    cwd,
    failed: failedStop(request.stopReason),
    isSubagent: isSubagent(request.agent, facts),
    label: request.label,
    model: request.responseModel ?? request.modelRaw,
    modelRequested: request.modelRaw,
    parentSessionId: parentOf(facts, request.agent),
    provider: request.piProvider,
    requestKey: request.key,
    requestKind: request.kind,
    sourceKind: PI_SOURCE_KIND,
    sourceTotal: count(usage?.totalTokens),
    stopReason: request.stopReason,
    thinkingLevel: request.effort,
    tokens:
      measured.tokens === null || !measured.counted
        ? null
        : tokenPayload(measured.tokens),
    usageReported: measured.counted,
  };
};

export const requestEvent = (
  facts: PiSessionFacts,
  request: PiRequest
): DxEventEnvelope => {
  const cwd = request.agent?.cwd ?? facts.cwd;
  const place = facts.placeOf({ cwd, turnId: request.turnId });
  const measured = measure(request);

  return {
    ...baseEnvelope(facts),
    ai: attributionOf(facts, {
      agent: request.agent,
      cwd,
      effort: request.effort,
      modelRaw: request.responseModel ?? request.modelRaw,
      piProvider: request.piProvider,
      place,
    }),
    context: place.context,
    eventId: eventIdOf(request.key, measured.kind),
    evidence: {
      bounded: true,
      hash: null,
      ref: `${facts.path}#${String(request.offset)}`,
    },
    fieldSemantics: measured.kind === "ai.usage" ? USAGE_SEMANTICS : [],
    identity: {
      ...emptyEventIdentity,
      generationId: request.key,
      requestId: request.responseId,
      sessionId: childSessionId(facts, request.agent),
      turnId: request.turnId,
    },
    kind: measured.kind,
    occurredAt: request.at,
    occurredAtPrecision: occurredPrecision(request.at),
    payload: requestPayload(facts, request, measured, cwd),
    upstreamKey: request.key,
    usage: measured.usage,
  };
};

export const turnEvent = (
  facts: PiSessionFacts,
  turn: PiTurn
): DxEventEnvelope => {
  const place = facts.placeOf({ cwd: facts.cwd, turnId: turn.entryId });

  return {
    ...baseEnvelope(facts),
    ai: attributionOf(facts, {
      agent: null,
      cwd: facts.cwd,
      effort: turn.effort,
      modelRaw: turn.modelRaw,
      piProvider: turn.piProvider,
      place,
    }),
    context: place.context,
    eventId: eventIdOf(turn.key, "ai.turn"),
    evidence: {
      bounded: true,
      hash: null,
      ref: `${facts.path}#${String(turn.offset)}`,
    },
    fieldSemantics: [],
    identity: {
      ...emptyEventIdentity,
      sessionId: facts.sessionId,
      turnId: turn.entryId,
    },
    kind: "ai.turn",
    occurredAt: turn.at,
    occurredAtPrecision: occurredPrecision(turn.at),
    payload: {
      cwd: facts.cwd,
      isSubagent: facts.fileAgent !== null,
      model: turn.modelRaw,
      parentSessionId: facts.parentSessionId,
      provider: turn.piProvider,
      role: "user",
      sourceKind: PI_SOURCE_KIND,
      thinkingLevel: turn.effort,
      turnIndex: turn.index,
    },
    upstreamKey: turn.key,
    usage: null,
  };
};

export interface PiSessionSummary {
  readonly agent: PiAgent | null;
  readonly at: string | null;
  readonly effort: string | null;
  readonly modelRaw: string | null;
  readonly piProvider: string | null;
  readonly requests: number;
  readonly title: string | null;
  readonly turns: number;
}

export const sessionEvent = (
  facts: PiSessionFacts,
  summary: PiSessionSummary
): DxEventEnvelope => {
  const sessionId = childSessionId(facts, summary.agent);
  const upstreamKey = `pi:session:${sessionId}:${summary.title ?? "-"}`;
  const cwd = summary.agent?.cwd ?? facts.cwd;
  const place = facts.placeOf({ cwd, turnId: null });

  return {
    ...baseEnvelope(facts),
    ai: attributionOf(facts, {
      agent: summary.agent,
      cwd,
      effort: summary.effort,
      modelRaw: summary.modelRaw,
      piProvider: summary.piProvider,
      place,
    }),
    context: place.context,
    eventId: eventIdOf(upstreamKey, "ai.session"),
    evidence: { bounded: true, hash: null, ref: `${facts.path}#0` },
    fieldSemantics: [],
    identity: { ...emptyEventIdentity, sessionId },
    kind: "ai.session",
    occurredAt: summary.at,
    occurredAtPrecision: occurredPrecision(summary.at),
    payload: {
      agentId: summary.agent?.id ?? facts.fileAgent?.id ?? null,
      agentType: summary.agent?.type ?? facts.fileAgent?.type ?? null,
      cwd,
      isSubagent: isSubagent(summary.agent, facts),
      model: summary.modelRaw,
      parentSessionId: parentOf(facts, summary.agent),
      provider: summary.piProvider,
      requestCount: summary.requests,
      sourceKind: PI_SOURCE_KIND,
      thinkingLevel: summary.effort,
      title: summary.title,
      turnCount: summary.turns,
    },
    upstreamKey,
    usage: null,
  };
};
