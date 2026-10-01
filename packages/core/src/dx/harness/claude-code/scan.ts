import type { ByteLine, SplitLines } from "./lines.js";
import { subagentChatId } from "./paths.js";
import { decodeClaudeLine } from "./rows.js";
import type {
  AssistantRow,
  ClaudeRow,
  CostRow,
  SkipReason,
  TitleSource,
  ToolCall,
} from "./rows.js";

export interface SubagentMeta {
  readonly agentType: string | null;
  readonly parentAgentId: string | null;
  readonly worktreePath: string | null;
}

export interface FileChunk {
  readonly idle: boolean;
  readonly lines: SplitLines;
  readonly meta: SubagentMeta | null;
  readonly mtimeMs: number | null;
  readonly offset: number;
  readonly path: string;
  readonly quiet: boolean;
  readonly size: number | null;
  readonly turnId: string | null;
}

export interface FileState {
  readonly mtimeMs: number | null;
  readonly offset: number;
  readonly path: string;
  readonly pending: boolean;
  readonly size: number | null;
  readonly turnId: string | null;
}

export interface ChatInfo {
  readonly agentId: string | null;
  readonly agentType: string | null;
  readonly chatId: string;
  readonly isSidechain: boolean;
  readonly parentChatId: string | null;
  readonly sessionId: string | null;
}

export interface RequestPick {
  readonly calls: readonly ToolCall[];
  readonly chat: ChatInfo;
  readonly file: string;
  readonly firstTimestamp: string | null;
  readonly key: string;
  readonly row: AssistantRow;
  readonly rows: number;
  readonly turnId: string | null;
}

export interface CostPick {
  readonly file: string;
  readonly row: CostRow;
  readonly sessionId: string;
}

export interface ScanTally {
  apiErrors: number;
  malformed: number;
  noUsage: number;
  synthetic: number;
  unkeyed: number;
  unparsedAssistant: number;
  unsettled: number;
}

export interface ScanResult {
  readonly costs: readonly CostPick[];
  readonly requests: readonly RequestPick[];
  readonly states: readonly FileState[];
  readonly tally: ScanTally;
  readonly titles: ReadonlyMap<string, string>;
}

interface Entry {
  readonly line: ByteLine;
  readonly row: ClaudeRow;
  readonly turnBefore: string | null;
}

interface FileScan {
  readonly chunk: FileChunk;
  readonly entries: readonly Entry[];
  readonly lastProgress: number;
  readonly turnAfter: string | null;
  readonly unread: ByteLine | null;
}

interface Appearance {
  readonly file: number;
  readonly first: number;
  last: number;
  sawFinal: boolean;
}

interface Group {
  readonly appearances: Appearance[];
  best: AssistantRow;
  bestFile: number;
  readonly calls: Map<string, ToolCall>;
  readonly chat: ChatInfo;
  readonly firstTimestamp: string | null;
  readonly key: string;
  rows: number;
  readonly turnId: string | null;
}

const isProgress = (row: ClaudeRow): boolean =>
  row.kind === "assistant" ||
  row.kind === "boundary" ||
  row.kind === "cost" ||
  row.kind === "skipped";

const scanFile = (chunk: FileChunk): FileScan => {
  const lines =
    chunk.idle && chunk.lines.partial !== null
      ? [...chunk.lines.complete, chunk.lines.partial]
      : chunk.lines.complete;

  const entries: Entry[] = [];
  let turn = chunk.turnId;
  let lastProgress = -1;

  for (const line of lines) {
    const row = decodeClaudeLine(line.text);
    const turnBefore = turn;

    if (row.kind === "user") {
      turn = row.promptId ?? row.uuid ?? turn;
    }

    if (isProgress(row)) {
      lastProgress = entries.length;
    }

    entries.push({ line, row, turnBefore });
  }

  return {
    chunk,
    entries,
    lastProgress,
    turnAfter: turn,
    unread: chunk.idle ? null : chunk.lines.partial,
  };
};

export const groupKeyOf = (row: AssistantRow): string | null => {
  if (row.requestId !== null) {
    return `request:${row.messageId ?? "-"}:${row.requestId}`;
  }

  if (row.messageId !== null) {
    return `message:${row.messageId}`;
  }

  return row.sessionId === null || row.uuid === null
    ? null
    : `row:${row.sessionId}:${row.uuid}`;
};

const outputOf = (row: AssistantRow): number => row.usage?.output_tokens ?? -1;

const hasCacheSplit = (row: AssistantRow): boolean =>
  row.usage?.cache_read_input_tokens !== undefined &&
  row.usage.cache_read_input_tokens !== null;

export const betterRow = (
  candidate: AssistantRow,
  current: AssistantRow,
  sameFile: boolean
): boolean => {
  if (candidate.usage === null) {
    return false;
  }

  if (current.usage === null) {
    return true;
  }

  const delta = outputOf(candidate) - outputOf(current);

  if (delta !== 0) {
    return delta > 0;
  }

  if (hasCacheSplit(candidate) !== hasCacheSplit(current)) {
    return hasCacheSplit(candidate);
  }

  return sameFile;
};

const callsOf = (row: AssistantRow): Map<string, ToolCall> =>
  new Map(
    row.calls.map((call, index) => [
      call.id ?? `${row.uuid ?? "-"}#${String(index)}`,
      call,
    ])
  );

const chatOf = (row: AssistantRow, meta: SubagentMeta | null): ChatInfo => {
  const session = row.sessionId;

  if (row.agentId === null || session === null) {
    return {
      agentId: row.agentId,
      agentType: row.isSidechain ? row.attributionAgent : null,
      chatId: session ?? "unknown-session",
      isSidechain: row.isSidechain,
      parentChatId: null,
      sessionId: session,
    };
  }

  const parentAgent = meta?.parentAgentId ?? null;

  return {
    agentId: row.agentId,
    agentType: meta?.agentType ?? row.attributionAgent,
    chatId: subagentChatId(session, row.agentId),
    isSidechain: true,
    parentChatId:
      parentAgent === null ? session : subagentChatId(session, parentAgent),
    sessionId: session,
  };
};

const emptyTally = (): ScanTally => ({
  apiErrors: 0,
  malformed: 0,
  noUsage: 0,
  synthetic: 0,
  unkeyed: 0,
  unparsedAssistant: 0,
  unsettled: 0,
});

const SKIP_COUNTERS: Readonly<
  Record<SkipReason, "apiErrors" | "synthetic" | "unparsedAssistant">
> = {
  "api-error": "apiErrors",
  synthetic: "synthetic",
  "unparsed-assistant": "unparsedAssistant",
};

const TITLE_RANK: Readonly<Record<TitleSource, number>> = {
  agent: 2,
  ai: 1,
  custom: 0,
};

interface Collected {
  readonly costs: Map<string, { readonly file: number; index: number }>;
  readonly groups: Map<string, Group>;
  readonly tally: ScanTally;
  readonly titles: Map<string, { rank: number; title: string }>;
}

const addAssistant = (
  into: Collected,
  file: number,
  index: number,
  entry: Entry,
  scan: FileScan
): void => {
  const { row } = entry;

  if (row.kind !== "assistant") {
    return;
  }

  const key = groupKeyOf(row);

  if (key === null) {
    into.tally.unkeyed += 1;

    return;
  }

  const group = into.groups.get(key);

  if (group === undefined) {
    into.groups.set(key, {
      appearances: [
        { file, first: index, last: index, sawFinal: row.stopReason !== null },
      ],
      best: row,
      bestFile: file,
      calls: callsOf(row),
      chat: chatOf(row, scan.chunk.meta),
      firstTimestamp: row.timestamp,
      key,
      rows: 1,
      turnId: entry.turnBefore,
    });

    return;
  }

  group.rows += 1;

  for (const [id, call] of callsOf(row)) {
    group.calls.set(id, call);
  }

  const appearance = group.appearances.find((seen) => seen.file === file);

  if (appearance === undefined) {
    group.appearances.push({
      file,
      first: index,
      last: index,
      sawFinal: row.stopReason !== null,
    });
  } else {
    appearance.last = index;
    appearance.sawFinal ||= row.stopReason !== null;
  }

  if (betterRow(row, group.best, group.bestFile === file)) {
    group.best = row;
    group.bestFile = file;
  }
};

const collect = (scans: readonly FileScan[]): Collected => {
  const into: Collected = {
    costs: new Map(),
    groups: new Map(),
    tally: emptyTally(),
    titles: new Map(),
  };

  for (const [file, scan] of scans.entries()) {
    for (const [index, entry] of scan.entries.entries()) {
      const { row } = entry;

      switch (row.kind) {
        case "assistant": {
          addAssistant(into, file, index, entry, scan);
          break;
        }

        case "skipped": {
          into.tally[SKIP_COUNTERS[row.reason]] += 1;
          break;
        }

        case "malformed": {
          into.tally.malformed += 1;
          break;
        }

        case "title": {
          const chat = row.sessionId;
          const rank = TITLE_RANK[row.source];
          const seen = chat === null ? undefined : into.titles.get(chat);

          if (chat !== null && (seen === undefined || rank <= seen.rank)) {
            into.titles.set(chat, { rank, title: row.title });
          }

          break;
        }

        case "cost": {
          if (row.sessionId !== null) {
            into.costs.set(row.sessionId, { file, index });
          }

          break;
        }

        case "boundary":
        case "other":
        case "user": {
          break;
        }

        default: {
          break;
        }
      }
    }
  }

  return into;
};

const settledIn = (appearance: Appearance, scan: FileScan): boolean =>
  scan.chunk.idle ||
  scan.lastProgress > appearance.last ||
  (appearance.sawFinal && scan.chunk.quiet);

const holdAt = (
  holds: Map<number, number>,
  file: number,
  index: number
): void => {
  const current = holds.get(file);

  if (current === undefined || index < current) {
    holds.set(file, index);
  }
};

const stateOf = (scan: FileScan, hold: number | undefined): FileState => {
  const held = hold === undefined ? undefined : scan.entries[hold];
  const { chunk } = scan;

  if (held !== undefined) {
    return {
      mtimeMs: chunk.mtimeMs,
      offset: held.line.start,
      path: chunk.path,
      pending: true,
      size: chunk.size,
      turnId: held.turnBefore,
    };
  }

  const end =
    scan.unread?.start ??
    scan.entries.at(-1)?.line.end ??
    chunk.lines.partial?.start ??
    chunk.offset;

  return {
    mtimeMs: chunk.mtimeMs,
    offset: Math.max(end, chunk.offset),
    path: chunk.path,
    pending: scan.unread !== null,
    size: chunk.size,
    turnId: scan.turnAfter,
  };
};

const isCost = (row: ClaudeRow | undefined): row is CostRow =>
  row?.kind === "cost";

export const scanChunks = (chunks: readonly FileChunk[]): ScanResult => {
  const scans = chunks.map(scanFile);
  const into = collect(scans);
  const holds = new Map<number, number>();
  const requests: RequestPick[] = [];

  for (const group of into.groups.values()) {
    const settled = group.appearances.every((appearance) => {
      const scan = scans[appearance.file];

      return scan !== undefined && settledIn(appearance, scan);
    });

    if (!settled) {
      into.tally.unsettled += 1;

      for (const appearance of group.appearances) {
        holdAt(holds, appearance.file, appearance.first);
      }
    } else if (group.best.usage === null) {
      into.tally.noUsage += 1;
    } else {
      requests.push({
        calls: [...group.calls.values()],
        chat: group.chat,
        file: scans[group.bestFile]?.chunk.path ?? "",
        firstTimestamp: group.firstTimestamp,
        key: group.key,
        row: group.best,
        rows: group.rows,
        turnId: group.turnId,
      });
    }
  }

  const costs: CostPick[] = [];

  for (const [sessionId, at] of into.costs) {
    const scan = scans[at.file];
    const row = scan?.entries[at.index]?.row;

    if (scan !== undefined && isCost(row)) {
      if (scan.chunk.quiet) {
        costs.push({ file: scan.chunk.path, row, sessionId });
      } else {
        holdAt(holds, at.file, at.index);
      }
    }
  }

  return {
    costs,
    requests,
    states: scans.map((scan, file) => stateOf(scan, holds.get(file))),
    tally: into.tally,
    titles: new Map(
      [...into.titles.entries()].map(([chat, seen]) => [chat, seen.title])
    ),
  };
};
