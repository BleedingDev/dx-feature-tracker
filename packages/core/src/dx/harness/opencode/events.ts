// @effect-diagnostics nodeBuiltinImport:off -- Event ids need a synchronous deterministic sha256 inside the pure mapper; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { DateTime } from "effect";

import type {
  AiAttribution,
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
import { harnessAdapterId } from "../pending.js";
import {
  aiTokensOf,
  attributionOf,
  effortOf,
  modelRawOf,
} from "./attribution.js";
import type { Placement, SessionPlacement } from "./placement.js";
import type { OcModel, OcTokens } from "./rows.js";
import type { OcRequest, OcSessionView, OcTurn } from "./sessions.js";

export const OPENCODE_ADAPTER_ID = harnessAdapterId("opencode");

export const OPENCODE_ADAPTER_VERSION = "0.2.0";

export const OPENCODE_SOURCE_KIND = "opencode";

const OVERHEAD_REASON =
  "OpenCode adds title and compaction calls to the session total without storing a message for them; this is the session total minus every stored request";

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const eventIdOf = (upstreamKey: string, kind: EventKind) =>
  EventIdSchema.make(
    `sha256:${sha256Hex(`${OPENCODE_ADAPTER_ID}\u0000${upstreamKey}\u0000${kind}`)}`
  );

export const isoOf = (ms: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(ms));

export const requestKeyOf = (messageId: string): string =>
  `opencode:${messageId}`;

export const overheadKeyOf = (sessionId: string): string =>
  `opencode:${sessionId}:overhead`;

const USAGE_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "usage.tokens.inputFresh",
    method: "source-reported",
    note: "OpenCode tokens.input excludes cache reads and writes",
    rawName: "tokens.input",
    unit: "tokens",
  },
  {
    field: "usage.tokens.output",
    method: "derived",
    note: "OpenCode stores visible output and reasoning apart; output here is their sum",
    rawName: "tokens.output + tokens.reasoning",
    unit: "tokens",
  },
  {
    field: "usage.toolFigure",
    method: "estimated",
    note: "OpenCode's own list-price cost; 0 means free or unpriced and is left out",
    rawName: "cost",
    unit: "USD",
  },
];

export interface EventContext {
  readonly context: FlightContext;
  readonly origin: Origin;
}

const flightContext = (base: FlightContext, placement: Placement) => {
  const { git } = placement;

  if (git.worktreePath === null) {
    return {
      ...base,
      branch: null,
      flightId: null,
      headSha: null,
      repoCommonDir: null,
      worktreePath: null,
    };
  }

  const sameFlight = base.worktreePath === git.worktreePath;

  return {
    branch: git.branch,
    flightId: sameFlight ? base.flightId : null,
    headSha: git.headSha,
    repoCommonDir: git.repoCommonDir,
    worktreePath: git.worktreePath,
  };
};

interface EnvelopeInput {
  readonly ai: AiAttribution;
  readonly at: number;
  readonly identity: Partial<EventIdentity>;
  readonly kind: EventKind;
  readonly observedAt: number;
  readonly payload: DxEventEnvelope["payload"];
  readonly placement: Placement;
  readonly semantics: readonly FieldSemantics[];
  readonly upstreamKey: string;
  readonly usage: AiUsage | null;
}

const envelope = (
  ctx: EventContext,
  input: EnvelopeInput
): DxEventEnvelope => ({
  acquisition: "db-snapshot",
  adapterId: OPENCODE_ADAPTER_ID,
  adapterVersion: OPENCODE_ADAPTER_VERSION,
  ai: input.ai,
  context: flightContext(ctx.context, input.placement),
  eventId: eventIdOf(input.upstreamKey, input.kind),
  evidence: {
    bounded: true,
    hash: null,
    ref: `${OPENCODE_ADAPTER_ID}:${input.upstreamKey}`,
  },
  fieldSemantics: input.semantics,
  identity: { ...emptyEventIdentity, ...input.identity },
  kind: input.kind,
  observedAt: isoOf(input.observedAt),
  occurredAt: isoOf(input.at),
  occurredAtPrecision: "exact",
  origin: ctx.origin,
  payload: {
    ...input.payload,
    branchSource: input.ai.branchSource,
    sourceKind: OPENCODE_SOURCE_KIND,
  },
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: input.ai.harnessVersion,
  upstreamKey: input.upstreamKey,
  usage: input.usage,
});

type TokenKey = keyof OcTokens;

const pieceOf = (
  tokens: OcTokens,
  share: number,
  extra: (key: TokenKey) => number
): OcTokens => {
  const part = (key: TokenKey) => Math.floor(tokens[key] * share) + extra(key);

  return {
    cacheRead: part("cacheRead"),
    cacheWrite: part("cacheWrite"),
    input: part("input"),
    output: part("output"),
    reasoning: part("reasoning"),
  };
};

export const splitTokens = (
  tokens: OcTokens,
  shares: readonly number[]
): readonly OcTokens[] => {
  const floors = shares.map((share) => pieceOf(tokens, share, () => 0));

  const remainder = (key: TokenKey) =>
    tokens[key] - floors.reduce((sum, piece) => sum + piece[key], 0);

  return shares.map((share, index) =>
    pieceOf(tokens, share, (key) => (index === 0 ? remainder(key) : 0))
  );
};

const figureOf = (cost: number | null): ToolFigure | null =>
  cost === null || cost <= 0
    ? null
    : { amount: cost, currency: "USD", kind: "api-equivalent" };

const usageOf = (
  requestKey: string,
  tokens: OcTokens,
  cost: number | null
): AiUsage => ({
  premiumRequests: null,
  requestKey,
  serviceTier: null,
  speed: null,
  tokens: aiTokensOf(tokens),
  toolFigure: figureOf(cost),
});

const rawTokens = (tokens: OcTokens) => ({
  cacheRead: tokens.cacheRead,
  cacheWrite: tokens.cacheWrite,
  input: tokens.input,
  output: tokens.output,
  reasoning: tokens.reasoning,
  total: null,
});

const costPayload = (cost: number | null) =>
  cost === null || cost <= 0
    ? null
    : {
        currency: "USD",
        ledger: "list-price-estimate",
        method: "estimated",
        value: cost,
      };

const modelPayload = (model: OcModel | null) => ({
  effort: effortOf(model),
  model: modelRawOf(model),
  modelId: model?.id ?? null,
  providerId: model?.providerId ?? null,
});

const requestEvents = (
  ctx: EventContext,
  view: OcSessionView,
  request: OcRequest,
  placements: readonly Placement[]
): DxEventEnvelope[] => {
  const { message } = request;

  const durationMs =
    message.completed === null || message.completed < message.created
      ? null
      : message.completed - message.created;

  const base = {
    ...modelPayload(request.model),
    agent: message.agent,
    durationMs,
    error: message.error,
    failed: request.failed,
    finish: message.finish,
    messageType: message.type,
    parentSessionId: view.session.parentId,
    scope: "request",
    storedIn: message.table,
    toolCalls: message.paths.length,
  };

  const identity = {
    generationId: message.id,
    requestId: message.id,
    sessionId: view.session.id,
    turnId: request.turnId,
  };

  const attribution = (placement: Placement) =>
    attributionOf({
      branchSource: placement.branchSource,
      cwd: request.cwd,
      model: request.model,
      session: view.session,
    });

  const [placement] = placements;

  if (request.tokens === null) {
    return placement === undefined
      ? []
      : [
          envelope(ctx, {
            ai: attribution(placement),
            at: message.created,
            identity,
            kind: "ai.request",
            observedAt: message.updated,
            payload: base,
            placement,
            semantics: [],
            upstreamKey: `opencode:message:${message.id}`,
            usage: null,
          }),
        ];
  }

  const { tokens } = request;

  if (placements.length <= 1) {
    return placement === undefined
      ? []
      : [
          envelope(ctx, {
            ai: attribution(placement),
            at: message.created,
            identity,
            kind: "ai.usage",
            observedAt: message.updated,
            payload: {
              ...base,
              cost: costPayload(request.cost),
              requestKey: requestKeyOf(message.id),
              tokens: rawTokens(tokens),
            },
            placement,
            semantics: USAGE_SEMANTICS,
            upstreamKey: `opencode:message:${message.id}`,
            usage: usageOf(requestKeyOf(message.id), tokens, request.cost),
          }),
        ];
  }

  const pieces = splitTokens(
    tokens,
    placements.map((part) => part.share)
  );

  return placements.flatMap((part, index) => {
    const piece = pieces[index];
    const key = `${requestKeyOf(message.id)}:split:${part.git.worktreePath ?? "-"}`;

    if (piece === undefined) {
      return [];
    }

    const cost = request.cost === null ? null : request.cost * part.share;

    return [
      envelope(ctx, {
        ai: attribution(part),
        at: message.created,
        identity: { ...identity, requestId: `${message.id}:split:${index}` },
        kind: "ai.usage",
        observedAt: message.updated,
        payload: {
          ...base,
          cost: costPayload(cost),
          requestKey: key,
          share: part.share,
          splitOf: requestKeyOf(message.id),
          tokens: rawTokens(piece),
        },
        placement: part,
        semantics: USAGE_SEMANTICS,
        upstreamKey: `opencode:message:${message.id}:split:${part.git.worktreePath ?? "-"}`,
        usage: usageOf(key, piece, cost),
      }),
    ];
  });
};

const overheadSignature = (tokens: OcTokens): string =>
  [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cacheRead,
    tokens.cacheWrite,
  ].join("/");

const overheadEvent = (
  ctx: EventContext,
  view: OcSessionView,
  placement: Placement
): DxEventEnvelope[] => {
  const { overhead, session } = view;

  if (overhead === null) {
    return [];
  }

  const whole = { ...placement, share: 1 };

  return [
    envelope(ctx, {
      ai: attributionOf({
        branchSource: whole.branchSource,
        cwd: view.cwd,
        model: null,
        session,
      }),
      at: overhead.at,
      identity: {
        requestId: `${session.id}:overhead`,
        sessionId: session.id,
      },
      kind: "ai.usage",
      observedAt: session.updated,
      payload: {
        cost: costPayload(overhead.cost),
        cumulative: true,
        parentSessionId: session.parentId,
        reason: OVERHEAD_REASON,
        requestKey: overheadKeyOf(session.id),
        scope: "session-overhead",
        tokens: rawTokens(overhead.tokens),
      },
      placement: whole,
      semantics: USAGE_SEMANTICS,
      upstreamKey: `opencode:session:${session.id}:overhead:${overheadSignature(overhead.tokens)}`,
      usage: usageOf(overheadKeyOf(session.id), overhead.tokens, overhead.cost),
    }),
  ];
};

const titleKey = (title: string | null): string =>
  title === null ? "-" : sha256Hex(title).slice(0, 16);

const sessionEvent = (
  ctx: EventContext,
  view: OcSessionView,
  placement: Placement
): DxEventEnvelope => {
  const { session } = view;

  return envelope(ctx, {
    ai: attributionOf({
      branchSource: placement.branchSource,
      cwd: view.cwd,
      model: view.lastModel,
      session,
    }),
    at: session.created,
    identity: { sessionId: session.id },
    kind: "ai.session",
    observedAt: session.updated,
    payload: {
      agentType: session.agent,
      archived: session.archived,
      createdAt: isoOf(session.created),
      forkOf: session.forkOf,
      isSubagent: session.parentId !== null,
      model: modelRawOf(view.lastModel),
      parentSessionId: session.parentId,
      storedIn: session.table,
      title: session.title,
    },
    placement: { ...placement, share: 1 },
    semantics: [],
    upstreamKey: `opencode:session:${session.id}:${titleKey(session.title)}:${session.archived ? "archived" : "open"}`,
    usage: null,
  });
};

const turnEvent = (
  ctx: EventContext,
  view: OcSessionView,
  turn: OcTurn,
  placement: Placement
): DxEventEnvelope =>
  envelope(ctx, {
    ai: attributionOf({
      branchSource: placement.branchSource,
      cwd: turn.cwd,
      model: turn.model,
      session: view.session,
    }),
    at: turn.at,
    identity: { sessionId: view.session.id, turnId: turn.id },
    kind: "ai.turn",
    observedAt: turn.at,
    payload: {
      ...modelPayload(turn.model),
      agent: turn.agent,
      parentSessionId: view.session.parentId,
      role: "user",
    },
    placement: { ...placement, share: 1 },
    semantics: [],
    upstreamKey: `opencode:turn:${turn.id}:${modelRawOf(turn.model) ?? "-"}:${effortOf(turn.model) ?? "-"}`,
    usage: null,
  });

export interface SessionEventsInput {
  readonly ctx: EventContext;
  readonly placement: SessionPlacement;
  readonly since: number | null;
  readonly turnPlacement: (turn: OcTurn) => Placement;
  readonly view: OcSessionView;
}

export const sessionEvents = (
  input: SessionEventsInput
): readonly DxEventEnvelope[] => {
  const { ctx, placement, since, view } = input;
  const fresh = (updated: number) => since === null || updated >= since;

  const requests = view.requests.flatMap((request) =>
    fresh(request.message.updated)
      ? requestEvents(
          ctx,
          view,
          request,
          placement.requests.get(request.message.id) ?? []
        )
      : []
  );

  const turns = view.turns.flatMap((turn) =>
    fresh(turn.at) || turn.model === null
      ? [turnEvent(ctx, view, turn, input.turnPlacement(turn))]
      : []
  );

  const sessionLevel = fresh(view.session.updated)
    ? [
        sessionEvent(ctx, view, placement.session),
        ...overheadEvent(ctx, view, placement.session),
      ]
    : [];

  return [...sessionLevel, ...turns, ...requests];
};
