// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event ids are the contract's synchronous sha256 over adapter, upstream key and kind.
import { createHash } from "node:crypto";

import { touchedPaths } from "../../correlation/attribution/touched-paths.js";
import { canonicalRequestKey, canonicalTurnKey } from "../../model/ai.js";
import type {
  AiAttribution,
  AiTokens,
  AiUsage,
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
import { harnessAdapterId } from "../pending.js";
import { normalizeModel, providerFor, viaFor } from "../provider.js";
import type { CodexHead } from "./head.js";
import { isSubagent } from "./head.js";
import type { CodexRequest, EndedTurn, TurnFacts } from "./parse.js";
import { placeTurn } from "./place.js";
import type { CodexUsage } from "./records.js";

export const CODEX_ADAPTER_ID = harnessAdapterId("codex");

export const CODEX_ADAPTER_VERSION = "0.2.0" as const;

export const CODEX_SOURCE_KIND = "codex-session" as const;

const DIRECT_PROVIDERS: ReadonlySet<string> = new Set(["openai"]);

export interface EventInput {
  readonly evidenceName: string;
  readonly head: CodexHead;
  readonly home: string | null;
  readonly observedAt: string;
  readonly origin: Origin;
  readonly parent: CodexHead | null;
  readonly selected: FlightContext;
  readonly title: string | null;
}

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const eventIdOf = (upstreamKey: string, kind: EventKind, extra = "") =>
  EventIdSchema.make(
    sha256(`${CODEX_ADAPTER_ID}\u0000${upstreamKey}\u0000${kind}${extra}`)
  );

export const viaOf = (
  modelRaw: string | null,
  providerId: string | null
): string | null => {
  const hint = providerId?.trim().toLowerCase() ?? null;

  if (hint === null || hint === "" || DIRECT_PROVIDERS.has(hint)) {
    return viaFor(modelRaw, null);
  }

  return viaFor(modelRaw, hint) ?? hint;
};

export const attributionOf = (
  head: CodexHead,
  facts: TurnFacts,
  branchSource: AiAttribution["branchSource"]
): AiAttribution => {
  const subagent = isSubagent(head);

  return {
    agentId: subagent ? head.threadId : null,
    agentType: subagent
      ? (head.agentRole ?? head.subagentKind ?? "subagent")
      : null,
    branchSource,
    channel: "session-file",
    cwd: facts.cwd ?? head.cwd,
    effort: facts.effort,
    effortSource: facts.effort === null ? null : "harness-recorded",
    harness: "codex",
    harnessVersion: head.cliVersion,
    model: normalizeModel(facts.model),
    modelRaw: facts.model,
    parentSessionId: head.parentId,
    provider: providerFor(facts.model, facts.providerId),
    sessionId: head.threadId,
    via: viaOf(facts.model, facts.providerId),
  };
};

const difference = (whole: number | null, ...parts: (number | null)[]) =>
  whole === null
    ? null
    : Math.max(
        0,
        parts.reduce<number>((left, part) => left - (part ?? 0), whole)
      );

export const tokensOf = (usage: CodexUsage): AiTokens => {
  const input = usage.input_tokens ?? null;
  const output = usage.output_tokens ?? null;
  const cacheRead = usage.cached_input_tokens ?? null;
  const cacheWrite = usage.cache_write_input_tokens ?? null;

  return {
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    cacheWrite5m: null,
    inputFresh: difference(input, cacheRead, cacheWrite),
    output,
    reasoning: usage.reasoning_output_tokens ?? null,
    total:
      input !== null && output !== null
        ? input + output
        : (usage.total_tokens ?? null),
  };
};

const tokenField = (
  name: string,
  rawName: string,
  note: string | null
): FieldSemantics => ({
  field: `tokens.${name}`,
  method: "source-reported",
  note,
  rawName,
  unit: "tokens",
});

const USAGE_SEMANTICS: readonly FieldSemantics[] = [
  tokenField(
    "input",
    "input_tokens",
    "Includes cached input and cache writes (OpenAI convention)."
  ),
  tokenField("cachedInput", "cached_input_tokens", "Subset of tokens.input."),
  tokenField(
    "cacheWrite",
    "cache_write_input_tokens",
    "Subset of tokens.input."
  ),
  tokenField("output", "output_tokens", "Includes reasoning output."),
  tokenField(
    "reasoning",
    "reasoning_output_tokens",
    "Subset of tokens.output."
  ),
  tokenField("total", "input_tokens + output_tokens", null),
];

interface EnvelopeParts {
  readonly ai: AiAttribution;
  readonly context: FlightContext;
  readonly eventId: DxEventEnvelope["eventId"];
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly identity: Partial<EventIdentity>;
  readonly kind: EventKind;
  readonly occurredAt: string | null;
  readonly ordinal: number | null;
  readonly payload: DxEventEnvelope["payload"];
  readonly upstreamKey: string;
  readonly usage: AiUsage | null;
}

const envelope = (
  input: EventInput,
  parts: EnvelopeParts
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: CODEX_ADAPTER_ID,
  adapterVersion: CODEX_ADAPTER_VERSION,
  ai: parts.ai,
  context: parts.context,
  eventId: parts.eventId,
  evidence: {
    bounded: true,
    hash: null,
    ref: `${CODEX_ADAPTER_ID}:${input.evidenceName}${parts.ordinal === null ? "" : `#${String(parts.ordinal)}`}`,
  },
  fieldSemantics: parts.fieldSemantics,
  identity: { ...emptyEventIdentity, ...parts.identity },
  kind: parts.kind,
  observedAt: input.observedAt,
  occurredAt: parts.occurredAt,
  occurredAtPrecision: parts.occurredAt === null ? "unknown" : "exact",
  origin: input.origin,
  payload: parts.payload,
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: input.head.cliVersion,
  upstreamKey: parts.upstreamKey,
  usage: parts.usage,
});

export const requestKeyOf = (
  head: CodexHead,
  request: CodexRequest
): string | null =>
  canonicalRequestKey({
    generationId: request.responseId === null ? request.key : null,
    requestId: request.responseId,
    sessionId: head.threadId,
    sourceKind: CODEX_SOURCE_KIND,
    turnIndex: null,
  });

const webSearchesOf = (count: number) =>
  count === 0 ? {} : { webSearchRequests: count };

export const usageEvent = (
  input: EventInput,
  request: CodexRequest
): DxEventEnvelope => {
  const { head } = input;

  const placement = placeTurn(
    head,
    input.parent,
    request.facts.cwd,
    input.selected
  );

  const requestKey = requestKeyOf(head, request);
  const tokens = tokensOf(request.usage);
  const upstreamKey = `codex:${head.threadId}:request:${request.key}`;
  const ai = attributionOf(head, request.facts, placement.branchSource);

  const touched = touchedPaths({
    calls: request.calls,
    cwd: ai.cwd,
    home: input.home,
  });

  return envelope(input, {
    ai: touched.length === 0 ? ai : { ...ai, touchedPaths: touched },
    context: placement.context,
    eventId: eventIdOf(upstreamKey, "ai.usage"),
    fieldSemantics: USAGE_SEMANTICS,
    identity: {
      requestId: request.responseId,
      sessionId: head.threadId,
      turnId: request.turnId,
    },
    kind: "ai.usage",
    occurredAt: request.occurredAt,
    ordinal: request.ordinal,
    payload: {
      effort: request.facts.effort,
      ledger: "tokens",
      model: request.facts.model,
      requestKey,
      serviceTier: request.facts.serviceTier,
      sourceKind: CODEX_SOURCE_KIND,
      tokens: {
        cacheWrite: tokens.cacheWrite,
        cachedInput: tokens.cacheRead,
        input: request.usage.input_tokens ?? null,
        output: tokens.output,
        reasoning: tokens.reasoning,
        total: tokens.total,
      },
      toolCalls: request.toolCalls,
      turnId: request.turnId,
      usageSource: request.source,
      webSearchRequests: request.webSearches,
    },
    upstreamKey,
    usage: {
      premiumRequests: null,
      requestKey,
      serviceTier: request.facts.serviceTier,
      speed: null,
      tokens,
      toolFigure: null,
      ...webSearchesOf(request.webSearches),
    },
  });
};

export const turnEvent = (
  input: EventInput,
  turn: EndedTurn
): DxEventEnvelope => {
  const { head } = input;

  const placement = placeTurn(
    head,
    input.parent,
    turn.facts.cwd,
    input.selected
  );

  const upstreamKey = `codex:${head.threadId}:turn:${turn.turnId}`;

  return envelope(input, {
    ai: attributionOf(head, turn.facts, placement.branchSource),
    context: placement.context,
    eventId: eventIdOf(upstreamKey, "ai.turn"),
    fieldSemantics: [],
    identity: { sessionId: head.threadId, turnId: turn.turnId },
    kind: "ai.turn",
    occurredAt: turn.startedAt,
    ordinal: null,
    payload: {
      abortReason: turn.abortReason,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      effort: turn.facts.effort,
      errorKind: turn.errorKind,
      model: turn.facts.model,
      parentSessionId: head.parentId,
      requests: turn.requests,
      serviceTier: turn.facts.serviceTier,
      startedAt: turn.startedAt,
      status: turn.status,
      toolCalls: turn.toolCalls,
      turnKey: canonicalTurnKey(head.threadId, turn.turnId),
    },
    upstreamKey,
    usage: null,
  });
};

export const sessionEvent = (
  input: EventInput,
  facts: TurnFacts
): DxEventEnvelope => {
  const { head } = input;

  const placement = placeTurn(head, input.parent, head.cwd, input.selected);
  const upstreamKey = `codex:${head.threadId}:session`;

  return envelope(input, {
    ai: attributionOf(head, facts, placement.branchSource),
    context: placement.context,
    eventId: eventIdOf(upstreamKey, "ai.session", `\u0000${input.title ?? ""}`),
    fieldSemantics: [],
    identity: { sessionId: head.threadId },
    kind: "ai.session",
    occurredAt: head.startedAt,
    ordinal: 0,
    payload: {
      agentNickname: head.agentNickname,
      agentPath: head.agentPath,
      agentRole: head.agentRole,
      branchAtStart: head.branch,
      cliVersion: head.cliVersion,
      depth: head.depth,
      forkedFromId: head.forkedFromId,
      isSubagent: isSubagent(head),
      modelProvider: head.providerId,
      originator: head.originator,
      parentSessionId: head.parentId,
      rootSessionId: head.rootId,
      sessionId: head.threadId,
      source: head.source,
      startedAt: head.startedAt,
      subagentKind: head.subagentKind,
      title: input.title,
    },
    upstreamKey,
    usage: null,
  });
};
