import { accountAiUsage } from "../metrics/ai-usage/ledger.js";
import type { LedgerTotal } from "../metrics/ai-usage/ledger.js";
import type { DxEventEnvelope } from "../model/event.js";
import type {
  ChatLedgerLine,
  ChatNode,
  ChatSourceId,
  ChatValue,
  ChatsReport,
  ModelTurn,
} from "./contract.js";
import { parseModelEffort } from "./effort.js";
import {
  booleanField,
  effortField,
  maxModeField,
  numberField,
  textField,
} from "./payload.js";

export interface ChatTreeScope {
  readonly branch: string | null;
  readonly repoCommonDir: string | null;
  readonly since: string | null;
}

const sourceKindOf = (event: DxEventEnvelope): string | null =>
  textField(event.payload, "sourceKind");

const isHooks = (event: DxEventEnvelope) =>
  event.adapterId.includes("cursor-hooks");

const isLocalDb = (event: DxEventEnvelope) =>
  event.adapterId.includes("cursor-local-db");

const isCli = (event: DxEventEnvelope) => sourceKindOf(event) === "cursor-cli";

const isTranscript = (event: DxEventEnvelope) =>
  sourceKindOf(event) === "transcript-estimate";

const unavailable = (reason: string): ChatValue => ({
  method: null,
  reason,
  source: null,
  value: null,
});

const available = (
  value: number,
  source: string,
  method: string
): ChatValue => ({ method, reason: null, source, value });

const sourceIdKind = (event: DxEventEnvelope): ChatSourceId["kind"] => {
  if (isLocalDb(event)) {
    return "composerId";
  }

  return isHooks(event) ? "conversationId" : "sessionId";
};

const inScope = (event: DxEventEnvelope, scope: ChatTreeScope) => {
  const { branch } = event.context;

  if (scope.branch !== null && branch !== null && branch !== scope.branch) {
    return false;
  }

  const at = event.occurredAt ?? event.observedAt;

  return scope.since === null || at >= scope.since;
};

const sumOf = (
  events: readonly DxEventEnvelope[],
  pick: (event: DxEventEnvelope) => number | null
) => {
  let total = 0;
  let seen = 0;

  for (const event of events) {
    const value = pick(event);

    if (value !== null) {
      total += value;
      seen += 1;
    }
  }

  return seen === 0 ? null : total;
};

const agentTimeOf = (events: readonly DxEventEnvelope[]): ChatValue => {
  const cli = sumOf(events.filter(isCli), (e) =>
    numberField(e.payload, "durationMs")
  );

  if (cli !== null) {
    return available(cli, "cursor-cli result duration_ms", "source-reported");
  }

  const hooks = sumOf(
    events.filter((e) => isHooks(e) && e.payload.hookEvent === "stop"),
    (e) => numberField(e.payload, "durationMs")
  );

  if (hooks !== null) {
    return available(hooks, "cursor-hooks stop duration", "source-reported");
  }

  return unavailable(
    "no source reported agent duration for this chat (needs cursor-cli stream or a stop hook with duration)"
  );
};

const distinctCount = (
  events: readonly DxEventEnvelope[],
  keyOf: (event: DxEventEnvelope) => string
) => new Set(events.map(keyOf)).size;

const requestsOf = (
  events: readonly DxEventEnvelope[],
  ledgerRequests: number
): ChatValue => {
  const submits = events.filter((e) => isHooks(e) && e.kind === "ai.request");

  if (submits.length > 0) {
    return available(
      distinctCount(submits, (e) => e.identity.generationId ?? e.eventId),
      "cursor-hooks beforeSubmitPrompt",
      "observed"
    );
  }

  if (ledgerRequests > 0) {
    return available(
      ledgerRequests,
      "ai-usage ledger (deduplicated request keys)",
      "derived"
    );
  }

  const userTurns = events.filter(
    (e) => isLocalDb(e) && e.kind === "ai.turn" && e.payload.role === "user"
  );

  if (userTurns.length > 0) {
    return available(
      userTurns.length,
      "cursor-local-db user bubbles",
      "observed"
    );
  }

  return unavailable("no prompt-submit hook, usage request or user bubble");
};

const toolCallsOf = (events: readonly DxEventEnvelope[]): ChatValue => {
  const hooks = events.filter((e) => isHooks(e) && e.payload.toolCall === true);

  if (hooks.length > 0) {
    return available(hooks.length, "cursor-hooks postToolUse", "observed");
  }

  const cli = sumOf(events.filter(isCli), (e) =>
    numberField(e.payload, "toolCalls")
  );

  if (cli !== null) {
    return available(cli, "cursor-cli stream tool calls", "source-reported");
  }

  const transcript = sumOf(events.filter(isTranscript), (e) =>
    numberField(e.payload, "toolCalls")
  );

  if (transcript !== null) {
    return available(transcript, "cursor-transcripts tool calls", "observed");
  }

  const bubbles = events.filter(
    (e) =>
      isLocalDb(e) &&
      e.kind === "ai.turn" &&
      textField(e.payload, "toolName") !== null
  );

  if (bubbles.length > 0) {
    return available(
      bubbles.length,
      "cursor-local-db tool bubbles",
      "observed"
    );
  }

  return unavailable("no source reported tool calls for this chat");
};

const ledgerLine = (total: LedgerTotal): ChatLedgerLine => ({
  category: total.category,
  currency: total.currency,
  estimate:
    total.ledger === "list-price-estimate" ||
    total.methods.includes("estimated"),
  ledger: total.ledger,
  methods: [...total.methods],
  sources: [...total.sources],
  value: total.value,
});

const scopeOf = (event: DxEventEnvelope): ModelTurn["scope"] => {
  if (event.kind === "ai.session") {
    return "session-setting";
  }

  if (event.kind === "ai.usage" && isLocalDb(event)) {
    return "aggregate";
  }

  return event.kind === "ai.request" ? "request" : "turn";
};

const modelTurnOf = (event: DxEventEnvelope): ModelTurn | null => {
  const rawModel = textField(event.payload, "model");

  if (rawModel === null) {
    return null;
  }

  const parsed = parseModelEffort(rawModel, effortField(event.payload));

  return {
    adapterId: event.adapterId,
    at: event.occurredAt,
    effort: parsed.effort,
    effortReason: parsed.effortReason,
    effortSource: parsed.effortSource,
    generationId: event.identity.generationId,
    maxMode: maxModeField(event.payload),
    model: parsed.model,
    rawModel,
    requestId: event.identity.requestId,
    scope: scopeOf(event),
    sourceKind: sourceKindOf(event),
    turnId: event.identity.turnId,
  };
};

const byTime = (a: ModelTurn, b: ModelTurn) => {
  if (a.at === b.at) {
    return 0;
  }

  if (a.at === null) {
    return 1;
  }

  if (b.at === null) {
    return -1;
  }

  return a.at < b.at ? -1 : 1;
};

const modelTimelineOf = (events: readonly DxEventEnvelope[]) => {
  const seen = new Map<string, ModelTurn>();

  for (const event of events) {
    const turn = modelTurnOf(event);

    if (turn !== null) {
      const key = `${turn.turnId ?? turn.requestId ?? turn.generationId ?? event.eventId}|${turn.rawModel}`;

      if (!seen.has(key)) {
        seen.set(key, turn);
      }
    }
  }

  return [...seen.values()].toSorted(byTime);
};

const spanOf = (events: readonly DxEventEnvelope[]): ChatNode["span"] => {
  const times = events
    .flatMap((e) => (e.occurredAt === null ? [] : [e.occurredAt]))
    .toSorted();

  return times.length === 0
    ? {
        end: null,
        reason: "no event in this chat has a timestamp",
        start: null,
      }
    : { end: times.at(-1) ?? null, reason: null, start: times[0] ?? null };
};

const sourceIdsOf = (events: readonly DxEventEnvelope[], sessionId: string) => {
  const ids = new Map<string, ChatSourceId>();

  for (const event of events) {
    const kind = sourceIdKind(event);
    ids.set(`${event.adapterId}|${kind}`, {
      adapterId: event.adapterId,
      kind,
      value: sessionId,
    });
  }

  return [...ids.values()];
};

const titleOf = (events: readonly DxEventEnvelope[]) => {
  for (const event of events) {
    const title = textField(event.payload, "title");

    if (title !== null) {
      return {
        exportable: false as const,
        source: event.adapterId,
        value: title,
      };
    }
  }

  return null;
};

const parentOf = (events: readonly DxEventEnvelope[]) => {
  for (const event of events) {
    const parent = textField(event.payload, "parentSessionId");

    if (parent !== null) {
      return parent;
    }
  }

  return null;
};

const isSubagentOf = (
  events: readonly DxEventEnvelope[],
  parent: string | null
) => {
  if (parent !== null) {
    return true;
  }

  const flags = events.flatMap((e) => {
    const flag = booleanField(e.payload, "isSubagent");

    return flag === null ? [] : [flag];
  });

  return flags.length === 0 ? null : flags.includes(true);
};

const buildNode = (
  sessionId: string,
  events: readonly DxEventEnvelope[]
): Omit<ChatNode, "childSessionIds"> => {
  const account = accountAiUsage(events);

  const tokens = account.totals.flatMap((t) =>
    t.ledger === "tokens" ? [ledgerLine(t)] : []
  );

  const money = account.totals.flatMap((t) =>
    t.ledger === "tokens" ? [] : [ledgerLine(t)]
  );

  const timeline = modelTimelineOf(events);

  const title = titleOf(events);

  const parentSessionId = parentOf(events);

  const isSubagent = isSubagentOf(events, parentSessionId);

  return {
    adapters: [...new Set(events.map((e) => e.adapterId))].toSorted(),
    agentTimeMs: agentTimeOf(events),
    eventCount: events.length,
    isSubagent,
    modelTimeline: timeline,
    modelTimelineReason:
      timeline.length === 0 ? "no event in this chat names a model" : null,
    models: [...new Set(timeline.map((t) => t.rawModel))],
    money,
    moneyUnavailableReason:
      money.length === 0
        ? "no local source reported money for this chat; import a usage CSV or dashboard export for billed figures"
        : null,
    parentSessionId,
    parentUnavailableReason:
      isSubagent === true && parentSessionId === null
        ? "source marks this chat as a subagent but does not name its parent"
        : null,
    requests: requestsOf(events, account.requestCount),
    sessionId,
    sourceIds: sourceIdsOf(events, sessionId),
    span: spanOf(events),
    title,
    titleUnavailableReason:
      title === null
        ? "no imported source carries a chat title; cursor-local-db deliberately drops composer names because they can echo prompt text"
        : null,
    tokens,
    tokensUnavailableReason:
      tokens.length === 0 ? "no source reported tokens for this chat" : null,
    toolCalls: toolCallsOf(events),
  };
};

const isAiEvent = (event: DxEventEnvelope) =>
  event.kind.startsWith("ai.") || (isHooks(event) && event.kind === "other");

export const buildChatTree = (
  events: readonly DxEventEnvelope[],
  scope: ChatTreeScope
): ChatsReport => {
  const bySession = new Map<string, DxEventEnvelope[]>();
  const unattributed: DxEventEnvelope[] = [];

  for (const event of events) {
    if (isAiEvent(event) && inScope(event, scope)) {
      const { sessionId } = event.identity;

      if (sessionId === null) {
        unattributed.push(event);
      } else {
        bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), event]);
      }
    }
  }

  const nodes = [...bySession.entries()].map(([sessionId, members]) =>
    buildNode(sessionId, members)
  );

  const children = new Map<string, string[]>();

  for (const node of nodes) {
    if (node.parentSessionId !== null) {
      children.set(node.parentSessionId, [
        ...(children.get(node.parentSessionId) ?? []),
        node.sessionId,
      ]);
    }
  }

  const known = new Set(nodes.map((n) => n.sessionId));

  const chats = nodes
    .map((node) => ({
      ...node,
      childSessionIds: (children.get(node.sessionId) ?? []).toSorted(),
    }))
    .toSorted((a, b) =>
      (a.span.start ?? "~").localeCompare(b.span.start ?? "~")
    );

  return {
    branch: scope.branch,
    chats,
    repoCommonDir: scope.repoCommonDir,
    rootSessionIds: chats.flatMap((c) =>
      c.parentSessionId === null || !known.has(c.parentSessionId)
        ? [c.sessionId]
        : []
    ),
    since: scope.since,
    unattributed: {
      adapters: [...new Set(unattributed.map((e) => e.adapterId))].toSorted(),
      events: unattributed.length,
      reason:
        unattributed.length === 0
          ? null
          : "AI events without a session id cannot be placed in a chat (e.g. aggregate usage exports)",
    },
  };
};
