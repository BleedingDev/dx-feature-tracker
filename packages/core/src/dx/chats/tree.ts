import { harnessOfEvent, rulesForEvent } from "../harness/rules.js";
import type { ChatChannelRole, ChatEvidenceRole } from "../harness/rules.js";
import { accountAiUsage } from "../metrics/ai-usage/ledger.js";
import type { LedgerTotal } from "../metrics/ai-usage/ledger.js";
import type { DxEventEnvelope } from "../model/event.js";
import type { FactEstimator } from "../usage/estimate.js";
import { CHAT_FILTERS } from "./contract.js";
import type {
  ChatFilter,
  ChatFilters,
  ChatLedgerLine,
  ChatNode,
  ChatSourceId,
  ChatValue,
  ChatsReport,
  ModelTurn,
} from "./contract.js";
import { modelEffortOf } from "./effort.js";
import {
  booleanField,
  effortField,
  maxModeField,
  numberField,
  textField,
} from "./payload.js";
import { hasFactFilters, sessionUsage } from "./usage.js";
import type { SessionUsage } from "./usage.js";

export interface ChatTreeScope {
  readonly branch: string | null;
  readonly repoCommonDir: string | null;
  readonly since: string | null;
}

export interface ChatTreeOptions {
  readonly estimate?: FactEstimator;
  readonly estimateLabel?: string;
  readonly filters?: ChatFilters;
}

const present = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

const sessionIdOf = (event: DxEventEnvelope): string | null =>
  present(event.ai?.sessionId) ?? present(event.identity.sessionId);

const sourceKindOf = (event: DxEventEnvelope): string | null =>
  textField(event.payload, "sourceKind");

const roleOf = (event: DxEventEnvelope): ChatChannelRole | null =>
  rulesForEvent(event).chatRole(event);

const hasRole =
  (role: ChatEvidenceRole) =>
  (event: DxEventEnvelope): boolean =>
    roleOf(event)?.role === role;

const isHooks = hasRole("prompt-hooks");

const isLocalDb = hasRole("chat-store");

const isCli = hasRole("agent-stream");

const isTranscript = hasRole("transcript");

type RoleLabel = keyof ChatChannelRole["labels"];

const labelOf = (
  events: readonly DxEventEnvelope[],
  label: RoleLabel
): string => {
  for (const event of events) {
    const found = roleOf(event)?.labels[label];

    if (found !== undefined) {
      return found;
    }
  }

  return label;
};

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

const sourceIdKind = (event: DxEventEnvelope): ChatSourceId["kind"] =>
  roleOf(event)?.idKind ?? "sessionId";

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
  const streams = events.filter(isCli);
  const cli = sumOf(streams, (e) => numberField(e.payload, "durationMs"));

  if (cli !== null) {
    return available(cli, labelOf(streams, "duration"), "source-reported");
  }

  const stops = events.filter(
    (e) => isHooks(e) && e.payload.hookEvent === "stop"
  );

  const hooks = sumOf(stops, (e) => numberField(e.payload, "durationMs"));

  if (hooks !== null) {
    return available(hooks, labelOf(stops, "duration"), "source-reported");
  }

  return unavailable(
    "no source reported agent duration for this chat (needs an agent stream or a stop hook with duration)"
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
      labelOf(submits, "requests"),
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
      labelOf(userTurns, "requests"),
      "observed"
    );
  }

  return unavailable("no prompt-submit hook, usage request or user bubble");
};

const toolCallsOf = (events: readonly DxEventEnvelope[]): ChatValue => {
  const hooks = events.filter((e) => isHooks(e) && e.payload.toolCall === true);

  if (hooks.length > 0) {
    return available(hooks.length, labelOf(hooks, "toolCalls"), "observed");
  }

  const streams = events.filter(isCli);
  const cli = sumOf(streams, (e) => numberField(e.payload, "toolCalls"));

  if (cli !== null) {
    return available(cli, labelOf(streams, "toolCalls"), "source-reported");
  }

  const transcripts = events.filter(isTranscript);

  const transcript = sumOf(transcripts, (e) =>
    numberField(e.payload, "toolCalls")
  );

  if (transcript !== null) {
    return available(transcript, labelOf(transcripts, "toolCalls"), "observed");
  }

  const bubbles = events.filter(
    (e) =>
      isLocalDb(e) &&
      e.kind === "ai.turn" &&
      textField(e.payload, "toolName") !== null
  );

  if (bubbles.length > 0) {
    return available(bubbles.length, labelOf(bubbles, "toolCalls"), "observed");
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

const effortOfTurn = (event: DxEventEnvelope, rawModel: string) => {
  const fromPayload = effortField(event.payload);
  const { ai } = event;
  const aiEffort = present(ai?.effort)?.toLowerCase() ?? null;

  if (fromPayload !== null || aiEffort === null) {
    return modelEffortOf(event, rawModel, fromPayload);
  }

  if (ai?.effortSource !== "model-suffix") {
    return modelEffortOf(event, rawModel, aiEffort);
  }

  const parsed = modelEffortOf(event, rawModel, null);

  return parsed.effort === null
    ? {
        effort: aiEffort,
        effortReason: null,
        effortSource: "model-name-suffix" as const,
        model: present(ai.model) ?? parsed.model,
      }
    : parsed;
};

const modelTurnOf = (event: DxEventEnvelope): ModelTurn | null => {
  const rawModel =
    textField(event.payload, "model") ??
    present(event.ai?.modelRaw) ??
    present(event.ai?.model);

  if (rawModel === null) {
    return null;
  }

  const parsed = effortOfTurn(event, rawModel);
  const normalized = present(event.ai?.model);

  const model =
    normalized !== null && parsed.model === rawModel.trim()
      ? normalized
      : parsed.model;

  return {
    adapterId: event.adapterId,
    at: event.occurredAt,
    effort: parsed.effort,
    effortReason: parsed.effortReason,
    effortSource: parsed.effortSource,
    generationId: event.identity.generationId,
    maxMode: maxModeField(event.payload),
    model,
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
      const key = `${turn.turnId ?? turn.requestId ?? turn.generationId ?? event.eventId}|${turn.rawModel}|${turn.effort ?? "-"}`;

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

const newestFirst = (a: DxEventEnvelope, b: DxEventEnvelope) =>
  b.observedAt.localeCompare(a.observedAt) ||
  (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "") ||
  b.eventId.localeCompare(a.eventId);

const titleOf = (events: readonly DxEventEnvelope[]) => {
  for (const event of events.toSorted(newestFirst)) {
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

const firstOf = (
  events: readonly DxEventEnvelope[],
  pick: (event: DxEventEnvelope) => string | null | undefined
): string | null => {
  for (const event of events) {
    const value = present(pick(event));

    if (value !== null) {
      return value;
    }
  }

  return null;
};

const parentOf = (events: readonly DxEventEnvelope[]) =>
  firstOf(
    events,
    (event) =>
      event.ai?.parentSessionId ?? textField(event.payload, "parentSessionId")
  );

const toolOf = (events: readonly DxEventEnvelope[]) =>
  firstOf(events, harnessOfEvent);

const providersOf = (events: readonly DxEventEnvelope[]): string[] =>
  [
    ...new Set(
      events.flatMap((event) => {
        const provider = event.ai?.provider ?? "unknown";

        return provider === "unknown" ? [] : [provider];
      })
    ),
  ].toSorted();

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

const branchesOf = (events: readonly DxEventEnvelope[]): string[] => {
  const firstSeen = new Map<string, string>();

  for (const event of events) {
    const { branch } = event.context;
    const at = event.occurredAt ?? event.observedAt;
    const prior = firstSeen.get(branch ?? "");

    if (branch !== null && (prior === undefined || at < prior)) {
      firstSeen.set(branch, at);
    }
  }

  return [...firstSeen.entries()]
    .toSorted(([a, at], [b, bt]) => at.localeCompare(bt) || a.localeCompare(b))
    .map(([branch]) => branch);
};

interface NodeInput {
  readonly events: readonly DxEventEnvelope[];
  readonly meta: readonly DxEventEnvelope[];
  readonly sessionEvents: readonly DxEventEnvelope[];
  readonly sessionId: string;
  readonly usage: SessionUsage;
}

const buildNode = ({
  events,
  meta,
  sessionEvents,
  sessionId,
  usage,
}: NodeInput): Omit<ChatNode, "childSessionIds"> => {
  const account = accountAiUsage(events);

  const tokens = account.totals.flatMap((t) =>
    t.ledger === "tokens" ? [ledgerLine(t)] : []
  );

  const money = account.totals.flatMap((t) =>
    t.ledger === "tokens" ? [] : [ledgerLine(t)]
  );

  const timeline = modelTimelineOf(events);

  const title = titleOf(meta);

  const parentSessionId = parentOf(meta);

  const isSubagent = isSubagentOf(meta, parentSessionId);

  return {
    adapters: [...new Set(events.map((e) => e.adapterId))].toSorted(),
    agentId: firstOf(
      meta,
      (event) => event.ai?.agentId ?? textField(event.payload, "agentId")
    ),
    agentTimeMs: agentTimeOf(events),
    agentType: firstOf(
      meta,
      (event) => event.ai?.agentType ?? textField(event.payload, "agentType")
    ),
    branches: branchesOf(sessionEvents),
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
    providers: providersOf(events),
    requests: requestsOf(events, account.requestCount),
    sessionId,
    sourceIds: sourceIdsOf(events, sessionId),
    span: spanOf(events),
    title,
    titleUnavailableReason:
      title === null
        ? "no imported source carries a chat title; titles that can echo prompt text are dropped on import"
        : null,
    tokens,
    tokensUnavailableReason:
      tokens.length === 0 ? "no source reported tokens for this chat" : null,
    tool: toolOf(meta),
    toolCalls: toolCallsOf(events),
    usage: usage.of(sessionId),
  };
};

const isAiEvent = (event: DxEventEnvelope) =>
  event.kind.startsWith("ai.") || (isHooks(event) && event.kind === "other");

const push = (
  into: Map<string, DxEventEnvelope[]>,
  key: string,
  event: DxEventEnvelope
) => {
  const list = into.get(key);

  if (list === undefined) {
    into.set(key, [event]);
  } else {
    list.push(event);
  }
};

const cleanFilters = (filters: ChatFilters): ChatFilters => {
  const kept: Partial<Record<ChatFilter, readonly string[]>> = {};

  for (const name of CHAT_FILTERS) {
    const values = (filters[name] ?? []).flatMap((value) => {
      const trimmed = value.trim();

      return trimmed === "" ? [] : [trimmed];
    });

    if (values.length > 0) {
      kept[name] = values;
    }
  }

  return kept;
};

export const buildChatTree = (
  events: readonly DxEventEnvelope[],
  scope: ChatTreeScope,
  allBranches: readonly DxEventEnvelope[] = events,
  options: ChatTreeOptions = {}
): ChatsReport => {
  const filters = cleanFilters(options.filters ?? {});
  const acrossBranches = new Map<string, DxEventEnvelope[]>();
  const meta = new Map<string, DxEventEnvelope[]>();

  for (const event of allBranches) {
    const sessionId = sessionIdOf(event);

    if (sessionId !== null && isAiEvent(event)) {
      push(meta, sessionId, event);

      if (inScope(event, { ...scope, branch: null })) {
        push(acrossBranches, sessionId, event);
      }
    }
  }

  const bySession = new Map<string, DxEventEnvelope[]>();
  const unattributed: DxEventEnvelope[] = [];
  const scoped: DxEventEnvelope[] = [];

  for (const event of events) {
    if (isAiEvent(event) && inScope(event, scope)) {
      const sessionId = sessionIdOf(event);
      scoped.push(event);

      if (sessionId === null) {
        unattributed.push(event);
      } else {
        push(bySession, sessionId, event);
      }
    }
  }

  const usage = sessionUsage(scoped, filters, options.estimate ?? (() => null));
  const tools = filters.tool === undefined ? null : new Set(filters.tool);
  const needsFact = hasFactFilters(filters);

  const nodes = [...bySession.entries()].flatMap(([sessionId, members]) => {
    const node = buildNode({
      events: members,
      meta: meta.get(sessionId) ?? members,
      sessionEvents: acrossBranches.get(sessionId) ?? members,
      sessionId,
      usage,
    });

    const toolMatches = tools === null || tools.has(node.tool ?? "(none)");
    const factMatches = !needsFact || usage.matched.has(sessionId);

    return toolMatches && factMatches ? [node] : [];
  });

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
    estimateLabel: options.estimateLabel ?? "no prices",
    filters,
    repoCommonDir: scope.repoCommonDir,
    rootSessionIds: chats.flatMap((c) =>
      c.parentSessionId === null || !known.has(c.parentSessionId)
        ? [c.sessionId]
        : []
    ),
    since: scope.since,
    tools: [
      ...new Set(chats.flatMap((c) => (c.tool === null ? [] : [c.tool]))),
    ].toSorted(),
    totals: usage.total(known),
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
