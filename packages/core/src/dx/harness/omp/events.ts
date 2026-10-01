// @effect-diagnostics nodeBuiltinImport:off -- Event IDs need a synchronous deterministic sha256 inside the pure mapper; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { Schema } from "effect";

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
  EventIdentity,
  EventKind,
  FieldSemantics,
  FlightContext,
} from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import type { BranchSource, EffortSource } from "../ids.js";
import { harnessAdapterId } from "../pending.js";
import { normalizeModel, providerFor, viaFor } from "../provider.js";
import type { OmpTaskResult, OmpUsage } from "./format.js";
import type { OmpRequest, OmpTurn } from "./parse.js";

export const OMP_ADAPTER_ID = harnessAdapterId("omp");

export const OMP_ADAPTER_VERSION = "1.0.0";

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export const ompEventId = (upstreamKey: string, kind: EventKind): string =>
  `sha256:${sha256Hex(`${OMP_ADAPTER_ID}\u0000${upstreamKey}\u0000${kind}`)}`;

export const ompRequestKey = (owner: string, entryId: string): string =>
  `omp:${owner}:${entryId}`;

export interface OmpPlacement {
  readonly branchSource: BranchSource;
  readonly context: FlightContext;
}

export interface OmpSessionFacts {
  readonly agentId: string | null;
  readonly agentType: string | null;
  readonly cwd: string | null;
  readonly harnessVersion: string | null;
  readonly parentSessionId: string | null;
  readonly path: string;
  readonly sessionId: string | null;
}

export interface OmpEventInput {
  readonly observedAt: string;
  readonly origin: Origin;
}

export const ompModelRaw = (
  provider: string | null,
  model: string | null
): string | null => {
  if (model === null) {
    return null;
  }

  return provider === null || model.startsWith(`${provider}/`)
    ? model
    : `${provider}/${model}`;
};

const providerHintOf = (modelRaw: string | null): string | null => {
  if (modelRaw === null) {
    return null;
  }

  const slash = modelRaw.indexOf("/");

  return slash === -1 ? null : modelRaw.slice(0, slash);
};

export interface ModelChoice {
  readonly effort: string | null;
  readonly modelRaw: string | null;
}

const EFFORT_SUFFIX =
  /:(?<effort>off|minimal|low|medium|high|xhigh|max|auto)$/u;

const splitEffortSuffix = (modelRaw: string | null): ModelChoice => {
  if (modelRaw === null) {
    return { effort: null, modelRaw };
  }

  const match = EFFORT_SUFFIX.exec(modelRaw);
  const effort = match?.groups?.effort ?? null;

  return effort === null
    ? { effort: null, modelRaw }
    : { effort, modelRaw: modelRaw.slice(0, -(effort.length + 1)) };
};

const effortSourceOf = (
  recorded: string | null,
  suffix: string | null
): EffortSource | null => {
  if (recorded !== null) {
    return "harness-recorded";
  }

  return suffix === null ? null : "model-suffix";
};

export const ompAttribution = (
  facts: OmpSessionFacts,
  placement: OmpPlacement,
  choice: ModelChoice
): AiAttribution => {
  const suffixed = splitEffortSuffix(choice.modelRaw);
  const hint = providerHintOf(suffixed.modelRaw);
  const recorded = choice.effort;

  return {
    agentId: facts.agentId,
    agentType: facts.agentType,
    branchSource: placement.branchSource,
    channel: "session-file",
    cwd: facts.cwd,
    effort: recorded ?? suffixed.effort,
    effortSource: effortSourceOf(recorded, suffixed.effort),
    harness: "omp",
    harnessVersion: facts.harnessVersion,
    model: normalizeModel(suffixed.modelRaw),
    modelRaw: suffixed.modelRaw,
    parentSessionId: facts.parentSessionId,
    provider: providerFor(suffixed.modelRaw, hint),
    sessionId: facts.sessionId,
    via: viaFor(suffixed.modelRaw, hint),
  };
};

const count = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : value;

export const ompTokens = (usage: OmpUsage): AiTokens => {
  const inputFresh = count(usage.input);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const output = count(usage.output);

  const parts = [inputFresh, cacheRead, cacheWrite, output].flatMap((part) =>
    part === null ? [] : [part]
  );

  return {
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    cacheWrite5m: null,
    inputFresh,
    output,
    reasoning: count(usage.reasoningTokens),
    total:
      count(usage.totalTokens) ??
      (parts.length === 0 ? null : parts.reduce((sum, part) => sum + part, 0)),
  };
};

export const hasTokens = (usage: OmpUsage | null): boolean =>
  usage !== null &&
  [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
  ].some((value) => (count(value) ?? 0) > 0);

export const ompToolFigure = (usage: OmpUsage): ToolFigure | null => {
  const amount = count(usage.cost?.total);

  return amount === null || amount <= 0
    ? null
    : { amount, currency: "USD", kind: "api-equivalent" };
};

const legacyTokens = (tokens: AiTokens) => ({
  cacheRead: tokens.cacheRead,
  cacheWrite: tokens.cacheWrite,
  input: tokens.inputFresh,
  output: tokens.output,
  reasoning: tokens.reasoning,
  total: tokens.total,
});

const USAGE_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "usage.tokens.inputFresh",
    method: "source-reported",
    note: "OMP buckets are disjoint: input excludes cache reads and writes",
    rawName: "message.usage.input",
    unit: "tokens",
  },
  {
    field: "usage.tokens.reasoning",
    method: "source-reported",
    note: "inside output",
    rawName: "message.usage.reasoningTokens",
    unit: "tokens",
  },
  {
    field: "usage.toolFigure",
    method: "estimated",
    note: "OMP's API-equivalent dollar figure from its own price table; not a bill",
    rawName: "message.usage.cost.total",
    unit: "USD",
  },
  {
    field: "occurredAt",
    method: "source-reported",
    note: "when OMP wrote the finished assistant message",
    rawName: "timestamp",
    unit: null,
  },
];

const precisionOf = (iso: string | null) =>
  iso === null ? ("unknown" as const) : ("exact" as const);

interface EnvelopeParts {
  readonly ai: AiAttribution;
  readonly identity: Partial<EventIdentity>;
  readonly kind: EventKind;
  readonly occurredAt: string | null;
  readonly payload: DxEventEnvelope["payload"];
  readonly semantics: readonly FieldSemantics[];
  readonly upstreamKey: string;
  readonly usage: AiUsage | null;
}

const envelope = (
  input: OmpEventInput,
  facts: OmpSessionFacts,
  placement: OmpPlacement,
  parts: EnvelopeParts
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: OMP_ADAPTER_ID,
  adapterVersion: OMP_ADAPTER_VERSION,
  ai: parts.ai,
  context: placement.context,
  eventId: EventIdSchema.make(ompEventId(parts.upstreamKey, parts.kind)),
  evidence: {
    bounded: true,
    hash: null,
    ref: `${facts.path}#${parts.upstreamKey}`,
  },
  fieldSemantics: parts.semantics,
  identity: { ...emptyEventIdentity, ...parts.identity },
  kind: parts.kind,
  observedAt: input.observedAt,
  occurredAt: parts.occurredAt,
  occurredAtPrecision: precisionOf(parts.occurredAt),
  origin: input.origin,
  payload: { cwd: facts.cwd, ...parts.payload },
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: facts.harnessVersion,
  upstreamKey: parts.upstreamKey,
  usage: parts.usage,
});

export interface OmpRequestEventInput {
  readonly facts: OmpSessionFacts;
  readonly input: OmpEventInput;
  readonly owner: string;
  readonly placement: OmpPlacement;
  readonly request: OmpRequest;
}

export const ompRequestEvent = (
  event: OmpRequestEventInput
): DxEventEnvelope => {
  const { facts, input, owner, placement, request } = event;
  const requestKey = ompRequestKey(owner, request.entryId);

  const ai = ompAttribution(facts, placement, {
    effort: request.effort,
    modelRaw: ompModelRaw(request.provider, request.model),
  });

  const counted = hasTokens(request.usage) ? request.usage : null;
  const tokens = counted === null ? null : ompTokens(counted);
  const toolFigure = counted === null ? null : ompToolFigure(counted);
  const premiumRequests = count(request.usage?.premiumRequests);
  const costValue = count(request.usage?.cost?.total);

  const usage: AiUsage | null =
    tokens === null
      ? null
      : {
          premiumRequests,
          requestKey,
          serviceTier: request.serviceTier,
          speed: null,
          tokens,
          toolFigure,
        };

  return envelope(input, facts, placement, {
    ai,
    identity: {
      generationId: request.entryId,
      requestId: request.responseId,
      sessionId: facts.sessionId,
      turnId: request.turn.id,
    },
    kind: usage === null ? "ai.request" : "ai.usage",
    occurredAt: request.timestamp,
    payload: {
      api: request.api,
      cost: {
        currency: costValue === null ? null : "USD",
        ledger: "list-price-estimate",
        method: "estimated",
        value: costValue,
      },
      durationMs: request.durationMs,
      effortConfigured: request.effortConfigured,
      entryId: request.entryId,
      errorStatus: request.errorStatus,
      failed: usage === null,
      inheritedFrom: owner === facts.sessionId ? null : owner,
      modelId: request.model,
      modelRole: request.modelRole,
      premiumRequests,
      providerId: request.provider,
      requestKey,
      selectedModel: request.selectedModel,
      stopReason: request.stopReason,
      tokens: tokens === null ? null : legacyTokens(tokens),
      toolCalls: request.toolNames.length,
      ttftMs: request.ttftMs,
      turnIndex: request.turn.index,
    },
    semantics: usage === null ? [] : USAGE_SEMANTICS,
    upstreamKey: requestKey,
    usage,
  });
};

export interface OmpTurnEventInput {
  readonly facts: OmpSessionFacts;
  readonly first: OmpRequest | null;
  readonly input: OmpEventInput;
  readonly owner: string;
  readonly placement: OmpPlacement;
  readonly turn: OmpTurn;
}

export const ompTurnEvent = (
  event: OmpTurnEventInput
): DxEventEnvelope | null => {
  const { facts, first, input, owner, placement, turn } = event;
  const turnId = turn.start.id;

  if (turnId === null) {
    return null;
  }

  const modelRaw =
    first === null
      ? turn.stateAtStart.model
      : ompModelRaw(first.provider, first.model);

  const effort =
    first === null ? turn.stateAtStart.thinkingLevel : first.effort;

  const upstreamKey = `omp:${owner}:turn:${turnId}`;

  return envelope(input, facts, placement, {
    ai: ompAttribution(facts, placement, { effort, modelRaw }),
    identity: { sessionId: facts.sessionId, turnId },
    kind: "ai.turn",
    occurredAt: turn.start.at,
    payload: {
      effortConfigured:
        first === null
          ? turn.stateAtStart.thinkingConfigured
          : first.effortConfigured,
      initiator: turn.start.initiator,
      parentSessionId: facts.parentSessionId,
      role: "user",
      turnIndex: turn.start.index,
    },
    semantics: [],
    upstreamKey,
    usage: null,
  });
};

export interface OmpSessionEventInput {
  readonly facts: OmpSessionFacts;
  readonly forkedFrom: string | null;
  readonly input: OmpEventInput;
  readonly modelRaw: string | null;
  readonly placement: OmpPlacement;
  readonly startedAt: string | null;
  readonly thinkingLevel: string | null;
  readonly title: string | null;
}

export const ompSessionEvent = (
  event: OmpSessionEventInput
): DxEventEnvelope | null => {
  const { facts, input, placement } = event;

  if (facts.sessionId === null) {
    return null;
  }

  const version = sha256Hex(
    JSON.stringify([event.title, event.modelRaw])
  ).slice(0, 16);

  const upstreamKey = `omp:${facts.sessionId}:session:${version}`;

  return envelope(input, facts, placement, {
    ai: ompAttribution(facts, placement, {
      effort: event.thinkingLevel,
      modelRaw: event.modelRaw,
    }),
    identity: { sessionId: facts.sessionId },
    kind: "ai.session",
    occurredAt: event.startedAt,
    payload: {
      agentId: facts.agentId,
      agentType: facts.agentType,
      forkedFrom: event.forkedFrom,
      isSubagent: facts.agentId !== null,
      parentSessionId: facts.parentSessionId,
      title: event.title,
    },
    semantics: [],
    upstreamKey,
    usage: null,
  });
};

export interface OmpSpawnEventInput {
  readonly facts: OmpSessionFacts;
  readonly input: OmpEventInput;
  readonly occurredAt: string | null;
  readonly placement: OmpPlacement;
  readonly spawn: OmpTaskResult;
}

const isText = Schema.is(Schema.String);

const spawnModel = (spawn: OmpTaskResult): string | null => {
  const override = spawn.modelOverride ?? null;

  if (override === null) {
    return null;
  }

  return isText(override) ? override : (override[0] ?? null);
};

export const ompSpawnFallbackEvent = (
  event: OmpSpawnEventInput
): DxEventEnvelope | null => {
  const { facts, input, placement, spawn } = event;
  const usage = spawn.usage ?? null;

  if (facts.sessionId === null || usage === null || !hasTokens(usage)) {
    return null;
  }

  const requestKey = `omp:${facts.sessionId}:task:${spawn.id}`;
  const tokens = ompTokens(usage);

  const subagent: OmpSessionFacts = {
    ...facts,
    agentId: spawn.id,
    agentType: spawn.agent ?? null,
    parentSessionId: facts.sessionId,
    sessionId: null,
  };

  return envelope(input, subagent, placement, {
    ai: ompAttribution(subagent, placement, {
      effort: null,
      modelRaw: spawnModel(spawn),
    }),
    identity: { sessionId: facts.sessionId },
    kind: "ai.usage",
    occurredAt: event.occurredAt,
    payload: {
      aggregate: true,
      reason:
        "the subagent's own session file is missing; its tokens come from the parent's task result, summed over all its requests",
      requestKey,
      tokens: legacyTokens(tokens),
    },
    semantics: [],
    upstreamKey: requestKey,
    usage: {
      premiumRequests: count(usage.premiumRequests),
      requestKey,
      serviceTier: null,
      speed: null,
      tokens,
      toolFigure: ompToolFigure(usage),
    },
  });
};
