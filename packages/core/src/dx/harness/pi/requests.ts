import { DateTime, Option, Schema } from "effect";

import { nestedMessagesOf, subagentResultsOf, toolCallsOf } from "./entries.js";
import type {
  PiEntry,
  PiFile,
  PiLine,
  PiMessage,
  PiSubagentResult,
  PiToolCall,
  PiUsage,
} from "./entries.js";

export type PiRequestKind =
  | "assistant"
  | "tool"
  | "subagent"
  | "compaction"
  | "branch-summary"
  | "usage";

export interface PiAgent {
  readonly cwd: string | null;
  readonly id: string;
  readonly type: string;
}

export interface PiRequest {
  readonly agent: PiAgent | null;
  readonly at: string | null;
  readonly effort: string | null;
  readonly entryId: string;
  readonly key: string;
  readonly kind: PiRequestKind;
  readonly label: string | null;
  readonly modelRaw: string | null;
  readonly offset: number;
  readonly piProvider: string | null;
  readonly responseId: string | null;
  readonly responseModel: string | null;
  readonly stopReason: string | null;
  readonly turnId: string | null;
  readonly usage: PiUsage | null;
}

export interface PiTurn {
  readonly at: string | null;
  readonly effort: string | null;
  readonly entryId: string;
  readonly index: number;
  readonly key: string;
  readonly modelRaw: string | null;
  readonly offset: number;
  readonly piProvider: string | null;
}

export interface PiSessionReading {
  readonly copied: number;
  readonly duplicates: number;
  readonly requests: readonly PiRequest[];
  readonly title: string | null;
  readonly toolPaths: ReadonlyMap<string, readonly string[]>;
  readonly turns: readonly PiTurn[];
}

interface Selection {
  readonly model: string | null;
  readonly provider: string | null;
  readonly servedModel: string | null;
  readonly servedProvider: string | null;
  readonly thinking: string | null;
}

export const PATH_ARGUMENTS: readonly string[] = [
  "path",
  "file_path",
  "filePath",
  "cwd",
  "directory",
  "dir",
];

const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString);

export const entryKeyOf = (entry: PiEntry): string | null =>
  entry.id === undefined || entry.id === null
    ? null
    : `${entry.id}|${entry.timestamp ?? ""}`;

const requestKeyOf = (entry: PiEntry): string =>
  `pi:${entry.id ?? "-"}:${entry.timestamp ?? "-"}`;

const isoOf = (input: number | string): string | null =>
  Option.getOrNull(Option.map(DateTime.make(input), DateTime.formatIso));

const isoOfMillis = (millis: number | null | undefined): string | null =>
  millis === null || millis === undefined || !Number.isFinite(millis)
    ? null
    : isoOf(millis);

export const isoOfText = (text: string | null | undefined): string | null =>
  text === null || text === undefined ? null : isoOf(text);

const argumentText = (call: PiToolCall, key: string): string | null => {
  const args = call.arguments ?? null;

  return args === null ? null : Option.getOrNull(decodeText(args[key]));
};

const pathsOfCall = (call: PiToolCall): readonly string[] =>
  PATH_ARGUMENTS.flatMap((key) => {
    const value = argumentText(call, key);

    return value === null ? [] : [value];
  });

const rootSelection = (header: PiEntry | null): Selection => ({
  model: header?.modelId ?? null,
  provider: header?.provider ?? null,
  servedModel: null,
  servedProvider: null,
  thinking: header?.thinkingLevel ?? null,
});

const nextSelection = (entry: PiEntry, prior: Selection): Selection => {
  if (entry.type === "model_change") {
    return {
      ...prior,
      model: entry.modelId ?? prior.model,
      provider: entry.provider ?? prior.provider,
    };
  }

  if (entry.type === "thinking_level_change") {
    return { ...prior, thinking: entry.thinkingLevel ?? prior.thinking };
  }

  const message = entry.message ?? null;

  if (entry.type === "message" && message?.role === "assistant") {
    return {
      ...prior,
      servedModel: message.model ?? prior.servedModel,
      servedProvider: message.provider ?? prior.servedProvider,
    };
  }

  return prior;
};

interface Walk {
  readonly line: PiLine;
  readonly selection: Selection;
  readonly turnId: string | null;
}

const assistantRequest = (walk: Walk, message: PiMessage): PiRequest => ({
  agent: null,
  at: isoOfText(walk.line.entry.timestamp) ?? isoOfMillis(message.timestamp),
  effort: message.thinkingLevel ?? walk.selection.thinking,
  entryId: walk.line.entry.id ?? "-",
  key: requestKeyOf(walk.line.entry),
  kind: "assistant",
  label: null,
  modelRaw: message.model ?? null,
  offset: walk.line.offset,
  piProvider: message.provider ?? null,
  responseId: message.responseId ?? null,
  responseModel: message.responseModel ?? null,
  stopReason: message.stopReason ?? null,
  turnId: walk.turnId,
  usage: message.usage ?? null,
});

const summaryRequest = (
  walk: Walk,
  kind: PiRequestKind,
  usage: PiUsage
): PiRequest => ({
  agent: null,
  at: isoOfText(walk.line.entry.timestamp),
  effort: walk.selection.thinking,
  entryId: walk.line.entry.id ?? "-",
  key: requestKeyOf(walk.line.entry),
  kind,
  label: null,
  modelRaw: walk.selection.servedModel ?? walk.selection.model,
  offset: walk.line.offset,
  piProvider: walk.selection.servedProvider ?? walk.selection.provider,
  responseId: null,
  responseModel: null,
  stopReason: null,
  turnId: walk.turnId,
  usage,
});

const usageEntryRequest = (walk: Walk, usage: PiUsage): PiRequest => ({
  ...summaryRequest(walk, "usage", usage),
  effort: null,
  label: walk.line.entry.kind ?? null,
  modelRaw: walk.line.entry.model ?? null,
  piProvider: walk.line.entry.provider ?? null,
});

const toolUsageRequest = (walk: Walk, usage: PiUsage): PiRequest => ({
  ...summaryRequest(walk, "tool", usage),
  effort: null,
  modelRaw: null,
  piProvider: null,
});

const subagentRequests = (
  walk: Walk,
  message: PiMessage,
  calls: ReadonlyMap<string, PiToolCall>
): readonly PiRequest[] => {
  const callId = message.toolCallId ?? walk.line.entry.id ?? "-";
  const call = calls.get(callId) ?? null;
  const cwd = call === null ? null : argumentText(call, "cwd");
  const base = requestKeyOf(walk.line.entry);

  const forResult = (
    result: PiSubagentResult,
    index: number
  ): readonly PiRequest[] => {
    const agent: PiAgent = {
      cwd,
      id: `${callId}#${String(index)}`,
      type: result.agent ?? message.toolName ?? "subagent",
    };

    const nested = nestedMessagesOf(result).filter(
      (item) =>
        item.role === "assistant" &&
        item.usage !== undefined &&
        item.usage !== null
    );

    if (nested.length > 0) {
      return nested.map((item, position) => ({
        ...assistantRequest(walk, item),
        agent,
        at: isoOfMillis(item.timestamp) ?? isoOfText(walk.line.entry.timestamp),
        effort: item.thinkingLevel ?? null,
        key: `${base}:agent:${String(index)}:${String(position)}`,
        kind: "subagent" as const,
      }));
    }

    const usage = result.usage ?? null;

    return usage === null
      ? []
      : [
          {
            ...toolUsageRequest(walk, usage),
            agent,
            key: `${base}:agent:${String(index)}`,
            kind: "subagent" as const,
            label: "aggregate",
            modelRaw: result.model ?? null,
            stopReason: result.stopReason ?? null,
          },
        ];
  };

  return subagentResultsOf(message).flatMap(forResult);
};

const requestsOfLine = (
  walk: Walk,
  calls: ReadonlyMap<string, PiToolCall>
): readonly PiRequest[] => {
  const { entry } = walk.line;
  const message = entry.message ?? null;
  const usage = entry.usage ?? null;

  if (entry.type === "message" && message !== null) {
    if (message.role === "assistant") {
      return [assistantRequest(walk, message)];
    }

    if (message.role === "toolResult") {
      const own =
        message.usage === undefined || message.usage === null
          ? []
          : [toolUsageRequest(walk, message.usage)];

      return [...own, ...subagentRequests(walk, message, calls)];
    }

    return [];
  }

  if (usage === null) {
    return [];
  }

  if (entry.type === "compaction") {
    return [summaryRequest(walk, "compaction", usage)];
  }

  if (entry.type === "branch_summary") {
    return [summaryRequest(walk, "branch-summary", usage)];
  }

  return entry.type === "usage" ? [usageEntryRequest(walk, usage)] : [];
};

const turnOfLine = (walk: Walk, index: number): PiTurn => ({
  at: isoOfText(walk.line.entry.timestamp),
  effort: walk.selection.thinking,
  entryId: walk.line.entry.id ?? "-",
  index,
  key: `pi:turn:${walk.line.entry.id ?? "-"}:${walk.line.entry.timestamp ?? "-"}`,
  modelRaw: walk.selection.model,
  offset: walk.line.offset,
  piProvider: walk.selection.provider,
});

const isUserMessage = (entry: PiEntry): boolean =>
  entry.type === "message" && entry.message?.role === "user";

interface Tracker {
  readonly calls: Map<string, PiToolCall>;
  readonly root: Selection;
  readonly selections: Map<string, Selection>;
  readonly turnsById: Map<string, string>;
}

interface Located {
  readonly prior: Selection;
  readonly turnId: string | null;
}

const track = (tracker: Tracker, entry: PiEntry): Located => {
  const parentId = entry.parentId ?? null;

  const prior =
    (parentId === null ? null : tracker.selections.get(parentId)) ??
    tracker.root;

  const ownId = entry.id ?? null;

  const inherited =
    parentId === null ? null : (tracker.turnsById.get(parentId) ?? null);

  const turnId = isUserMessage(entry) ? ownId : inherited;

  if (ownId !== null) {
    tracker.selections.set(ownId, nextSelection(entry, prior));
  }

  if (ownId !== null && turnId !== null) {
    tracker.turnsById.set(ownId, turnId);
  }

  const message = entry.message ?? null;

  if (message?.role === "assistant") {
    for (const call of toolCallsOf(message)) {
      if (call.id !== undefined && call.id !== null) {
        tracker.calls.set(call.id, call);
      }
    }
  }

  return { prior, turnId };
};

type Ownership = "own" | "copied" | "duplicate";

const ownershipOf = (
  entry: PiEntry,
  copiedKeys: ReadonlySet<string>,
  seen: Set<string>
): Ownership => {
  const key = entryKeyOf(entry);

  if (key === null) {
    return "own";
  }

  if (copiedKeys.has(key)) {
    return "copied";
  }

  if (seen.has(key)) {
    return "duplicate";
  }

  seen.add(key);

  return "own";
};

const toolPathsOf = (walk: Walk): readonly string[] => {
  const message = walk.line.entry.message ?? null;

  return message?.role === "assistant" && walk.turnId !== null
    ? toolCallsOf(message).flatMap(pathsOfCall)
    : [];
};

const withServedModels = (
  turns: readonly PiTurn[],
  requests: readonly PiRequest[]
): readonly PiTurn[] => {
  const served = new Map<string, PiRequest>();

  for (const request of requests) {
    if (
      request.kind === "assistant" &&
      request.turnId !== null &&
      !served.has(request.turnId)
    ) {
      served.set(request.turnId, request);
    }
  }

  return turns.map((turn): PiTurn => {
    const reply = served.get(turn.entryId);

    return reply === undefined
      ? turn
      : {
          ...turn,
          effort: reply.effort ?? turn.effort,
          modelRaw: reply.responseModel ?? reply.modelRaw ?? turn.modelRaw,
          piProvider: reply.piProvider ?? turn.piProvider,
        };
  });
};

export const readPiSession = (
  file: PiFile,
  copiedKeys: ReadonlySet<string>
): PiSessionReading => {
  const tracker: Tracker = {
    calls: new Map(),
    root: rootSelection(file.header),
    selections: new Map(),
    turnsById: new Map(),
  };

  const seen = new Set<string>();
  const toolPaths = new Map<string, string[]>();
  const requests: PiRequest[] = [];
  const turns: PiTurn[] = [];
  const counts = { copied: 0, duplicate: 0, own: 0 };
  let title: string | null = null;

  for (const line of file.lines) {
    const { entry } = line;
    const { prior, turnId } = track(tracker, entry);

    if (entry.type === "session_info") {
      title = entry.name ?? null;
    }

    const ownership = ownershipOf(entry, copiedKeys, seen);

    counts[ownership] += 1;

    if (ownership === "own") {
      const walk: Walk = { line, selection: prior, turnId };

      if (isUserMessage(entry)) {
        turns.push(turnOfLine(walk, turns.length));
      }

      const paths = toolPathsOf(walk);

      if (turnId !== null && paths.length > 0) {
        toolPaths.set(turnId, [...(toolPaths.get(turnId) ?? []), ...paths]);
      }

      requests.push(...requestsOfLine(walk, tracker.calls));
    }
  }

  return {
    copied: counts.copied,
    duplicates: counts.duplicate,
    requests,
    title,
    toolPaths,
    turns: withServedModels(turns, requests),
  };
};

export const entryKeysOf = (file: PiFile): ReadonlySet<string> =>
  new Set(
    file.lines.flatMap((line) => {
      const key = entryKeyOf(line.entry);

      return key === null ? [] : [key];
    })
  );
