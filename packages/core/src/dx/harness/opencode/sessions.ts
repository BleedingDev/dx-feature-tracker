import type {
  OcMessage,
  OcModel,
  OcRows,
  OcSession,
  OcTokens,
} from "./rows.js";

export interface OcRequest {
  readonly cost: number | null;
  readonly cwd: string;
  readonly failed: boolean;
  readonly message: OcMessage;
  readonly model: OcModel | null;
  readonly tokens: OcTokens | null;
  readonly turnId: string | null;
}

export interface OcTurn {
  readonly agent: string | null;
  readonly cwd: string;
  readonly id: string;
  readonly at: number;
  readonly model: OcModel | null;
}

export interface OcOverhead {
  readonly at: number;
  readonly cost: number | null;
  readonly tokens: OcTokens;
}

export interface OcSessionView {
  readonly cwd: string;
  readonly inFlight: number;
  readonly lastModel: OcModel | null;
  readonly models: readonly OcModel[];
  readonly overhead: OcOverhead | null;
  readonly overcount: OcTokens | null;
  readonly replayed: number;
  readonly requests: readonly OcRequest[];
  readonly session: OcSession;
  readonly turns: readonly OcTurn[];
}

export const ZERO_TOKENS: OcTokens = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  reasoning: 0,
};

const TOKEN_KEYS: readonly (keyof OcTokens)[] = [
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
];

export const anyTokens = (tokens: OcTokens): boolean =>
  TOKEN_KEYS.some((key) => tokens[key] > 0);

export const addTokens = (a: OcTokens, b: OcTokens): OcTokens => ({
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
});

const minus = (a: OcTokens, b: OcTokens, sign: 1 | -1): OcTokens => {
  const part = (key: keyof OcTokens) => Math.max((a[key] - b[key]) * sign, 0);

  return {
    cacheRead: part("cacheRead"),
    cacheWrite: part("cacheWrite"),
    input: part("input"),
    output: part("output"),
    reasoning: part("reasoning"),
  };
};

const byOrder = (a: OcMessage, b: OcMessage): number =>
  a.created - b.created ||
  (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) ||
  a.id.localeCompare(b.id);

const isRequestMessage = (message: OcMessage): boolean =>
  message.type === "assistant" || message.type === "compaction";

const isSettled = (message: OcMessage): boolean => {
  if (message.type === "compaction") {
    return message.status !== "pending" && message.status !== "running";
  }

  return (
    message.completed !== null ||
    message.error !== null ||
    message.finish !== null
  );
};

const signatureOf = (message: OcMessage): string =>
  `${message.created}|${message.model?.providerId ?? "-"}/${message.model?.id ?? "-"}|${TOKEN_KEYS.map((key) => message.tokens?.[key] ?? "-").join(",")}`;

export const isReplay = (
  message: OcMessage,
  source: readonly OcMessage[]
): boolean =>
  source.some(
    (original) =>
      original.id === message.id ||
      (isRequestMessage(original) &&
        isRequestMessage(message) &&
        signatureOf(original) === signatureOf(message))
  );

const initialCwd = (
  session: OcSession,
  messages: readonly OcMessage[]
): string => {
  const firstSwitch = messages.find(
    (message) => message.type === "location-switched"
  );

  return firstSwitch?.previousDirectory ?? session.directory;
};

const sameModel = (a: OcModel | null, b: OcModel | null) =>
  a?.id === b?.id &&
  a?.providerId === b?.providerId &&
  a?.variant === b?.variant;

interface Walk {
  cwd: string;
  inFlight: number;
  model: OcModel | null;
  readonly models: OcModel[];
  readonly requests: OcRequest[];
  turn: string | null;
  readonly turns: OcTurn[];
}

const trackModel = (walk: Walk, model: OcModel | null) => {
  if (model !== null) {
    walk.model = model;

    if (!walk.models.some((known) => sameModel(known, model))) {
      walk.models.push(model);
    }
  }
};

const turnModelGaps = (walk: Walk, request: OcRequest) => {
  const index = walk.turns.findIndex((turn) => turn.id === request.turnId);
  const turn = walk.turns[index];

  if (turn !== undefined && turn.model === null && request.model !== null) {
    walk.turns[index] = { ...turn, model: request.model };
  }
};

const stepRequest = (walk: Walk, message: OcMessage, latest: boolean): void => {
  if (!isSettled(message) && latest) {
    walk.inFlight += 1;

    return;
  }

  const model = message.model ?? walk.model;
  trackModel(walk, model);

  const tokens =
    message.tokens !== null && anyTokens(message.tokens)
      ? message.tokens
      : null;

  const request: OcRequest = {
    cost: message.cost,
    cwd: message.cwd ?? walk.cwd,
    failed: message.error !== null || message.finish === "error",
    message,
    model,
    tokens,
    turnId: message.parentId ?? walk.turn,
  };

  walk.requests.push(request);
  turnModelGaps(walk, request);
};

const walkSession = (
  session: OcSession,
  messages: readonly OcMessage[]
): Walk => {
  const walk: Walk = {
    cwd: initialCwd(session, messages),
    inFlight: 0,
    model: session.model,
    models: [],
    requests: [],
    turn: null,
    turns: [],
  };

  const lastRequest = messages.findLast(isRequestMessage);

  for (const message of messages) {
    switch (message.type) {
      case "location-switched": {
        walk.cwd = message.directory ?? walk.cwd;
        break;
      }

      case "model-switched": {
        trackModel(walk, message.model);
        break;
      }

      case "user": {
        walk.turn = message.id;
        trackModel(walk, message.model);
        walk.turns.push({
          agent: message.agent,
          at: message.created,
          cwd: message.cwd ?? walk.cwd,
          id: message.id,
          model: message.model,
        });
        break;
      }

      case "agent-switched": {
        break;
      }

      case "assistant":
      case "compaction": {
        stepRequest(walk, message, message === lastRequest);
        break;
      }

      default: {
        break;
      }
    }
  }

  return walk;
};

const overheadOf = (
  session: OcSession,
  requests: readonly OcRequest[],
  inFlight: readonly OcMessage[]
) => {
  if (session.tokens === null) {
    return { overcount: null, overhead: null };
  }

  let counted = ZERO_TOKENS;
  let spent = 0;

  for (const request of requests) {
    counted =
      request.tokens === null ? counted : addTokens(counted, request.tokens);
    spent += request.cost ?? 0;
  }

  for (const message of inFlight) {
    counted =
      message.tokens === null ? counted : addTokens(counted, message.tokens);
  }

  const cost = session.cost === null ? null : session.cost - spent;

  const rest = minus(session.tokens, counted, 1);
  const over = minus(session.tokens, counted, -1);

  return {
    overcount: anyTokens(over) ? over : null,
    overhead: anyTokens(rest)
      ? {
          at: session.created,
          cost: cost === null || cost <= 1e-9 ? null : cost,
          tokens: rest,
        }
      : null,
  };
};

export const viewSession = (
  session: OcSession,
  own: readonly OcMessage[],
  forkSource: readonly OcMessage[]
): OcSessionView => {
  const ordered = own.toSorted(byOrder);

  const kept =
    forkSource.length === 0
      ? ordered
      : ordered.filter((message) => !isReplay(message, forkSource));

  const walk = walkSession(session, kept);

  const lastRequest = kept.findLast(isRequestMessage);

  const inFlight =
    lastRequest !== undefined && !isSettled(lastRequest) ? [lastRequest] : [];

  const { overcount, overhead } = overheadOf(session, walk.requests, inFlight);

  return {
    cwd: initialCwd(session, kept),
    inFlight: walk.inFlight,
    lastModel: walk.model,
    models: walk.models,
    overcount,
    overhead,
    replayed: ordered.length - kept.length,
    requests: walk.requests,
    session,
    turns: walk.turns,
  };
};

const tokenSum = (tokens: OcTokens | null): number =>
  tokens === null
    ? 0
    : tokens.input +
      tokens.output +
      tokens.reasoning +
      tokens.cacheRead +
      tokens.cacheWrite;

const copyRank = (message: OcMessage): readonly number[] => [
  isSettled(message) ? 0 : 1,
  -tokenSum(message.tokens),
  message.table === "session_message" ? 0 : 1,
];

const betterCopy = (a: OcMessage, b: OcMessage): OcMessage => {
  const left = copyRank(a);
  const right = copyRank(b);
  const index = left.findIndex((value, at) => value !== right[at]);

  return index === -1 || (left[index] ?? 0) < (right[index] ?? 0) ? a : b;
};

export const pickCopies = (
  messages: readonly OcMessage[]
): readonly OcMessage[] => {
  const byId = new Map<string, OcMessage>();

  for (const message of messages) {
    const known = byId.get(message.id);

    byId.set(
      message.id,
      known === undefined ? message : betterCopy(known, message)
    );
  }

  return [...byId.values()];
};

const larger = (a: OcTokens | null, b: OcTokens | null): OcTokens | null => {
  if (a === null || b === null) {
    return a ?? b;
  }

  return {
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    reasoning: Math.max(a.reasoning, b.reasoning),
  };
};

const mergeCopies = (a: OcSession, b: OcSession): OcSession => {
  const [primary, other] = a.table === "session_v2" ? [a, b] : [b, a];

  return {
    ...primary,
    cost:
      primary.cost === null || other.cost === null
        ? (primary.cost ?? other.cost)
        : Math.max(primary.cost, other.cost),
    title: primary.title ?? other.title,
    tokens: larger(primary.tokens, other.tokens),
    updated: Math.max(primary.updated, other.updated),
  };
};

export const mergeSessions = (
  sessions: readonly OcSession[]
): readonly OcSession[] => {
  const byId = new Map<string, OcSession>();

  for (const session of sessions) {
    const known = byId.get(session.id);

    byId.set(
      session.id,
      known === undefined ? session : mergeCopies(known, session)
    );
  }

  return [...byId.values()];
};

export const viewSessions = (rows: OcRows): readonly OcSessionView[] => {
  const bySession = new Map<string, OcMessage[]>();

  for (const message of pickCopies(rows.messages)) {
    bySession.set(message.sessionId, [
      ...(bySession.get(message.sessionId) ?? []),
      message,
    ]);
  }

  return mergeSessions(rows.sessions)
    .toSorted((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    .map((session) =>
      viewSession(
        session,
        bySession.get(session.id) ?? [],
        session.forkOf === null ? [] : (bySession.get(session.forkOf) ?? [])
      )
    );
};
