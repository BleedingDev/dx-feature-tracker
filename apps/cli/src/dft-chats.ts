import { dashboardStateKit } from "./dft-dashboard-state.js";
import {
  collapseTurns,
  formatAgo,
  formatCount,
  formatDuration,
  formatUsd,
} from "./dft-render.js";
import type { RenderOptions } from "./dft-render.js";

interface TurnLike {
  readonly effort: string | null;
  readonly maxMode: boolean | null;
  readonly model: string;
  readonly scope?: string;
}

interface LedgerLineLike {
  readonly category: string;
  readonly estimate: boolean;
  readonly ledger: string;
  readonly value: number;
}

export interface ChatUsageLike {
  readonly billed: number | null;
  readonly estimate: number | null;
  readonly requests: number;
  readonly tokens: { readonly total: number | null };
  readonly toolFigure: number | null;
  readonly unpriced: number;
}

export interface ChatLike {
  readonly agentTimeMs: { readonly value: number | null };
  readonly agentType?: string | null;
  readonly branches?: readonly string[];
  readonly childSessionIds: readonly string[];
  readonly modelTimeline: readonly TurnLike[];
  readonly modelTimelineReason?: string | null;
  readonly money: readonly LedgerLineLike[];
  readonly requests?: { readonly value: number | null };
  readonly sessionId: string;
  readonly span?: {
    readonly end: string | null;
    readonly start: string | null;
  };
  readonly title: { readonly value: string } | null;
  readonly tokens: readonly LedgerLineLike[];
  readonly tool?: string | null;
  readonly toolCalls: { readonly value: number | null };
  readonly usage?: ChatUsageLike;
}

export interface ChatsReportLike {
  readonly branch: string | null;
  readonly chats: readonly ChatLike[];
  readonly estimateLabel?: string;
  readonly filters?: Readonly<Record<string, readonly string[] | undefined>>;
  readonly repoCommonDir?: string | null;
  readonly rootSessionIds: readonly string[];
  readonly totals?: ChatUsageLike;
  readonly unattributed: { readonly events: number };
}

const DASH = "-";

const plural = (count: number, word: string): string =>
  `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

const sumLines = (lines: readonly LedgerLineLike[]): number | null =>
  lines.length === 0 ? null : lines.reduce((sum, line) => sum + line.value, 0);

const ledgerSum = (chat: ChatLike, ledger: string): number | null =>
  sumLines(
    chat.money.filter(
      (line) => line.ledger === ledger && line.category !== "total"
    )
  );

const estimateOf = (chat: ChatLike): number | null =>
  chat.usage?.estimate ?? sumLines(chat.money.filter((line) => line.estimate));

const billedOf = (chat: ChatLike): number | null =>
  chat.usage?.billed ?? ledgerSum(chat, "charge");

const toolFigureOf = (chat: ChatLike): number | null =>
  chat.usage?.toolFigure ?? ledgerSum(chat, "metered");

const tokenTotalOf = (chat: ChatLike): number | null => {
  const fromUsage = chat.usage?.tokens.total ?? null;

  if (fromUsage !== null) {
    return fromUsage;
  }

  const total = chat.tokens.find((line) => line.category === "total");

  return total === undefined
    ? sumLines(chat.tokens.filter((line) => line.category !== "reasoning"))
    : total.value;
};

export const chatMoneyParts = (
  money: {
    readonly billed: number | null;
    readonly estimate: number | null;
    readonly toolFigure: number | null;
  },
  unpriced = 0
): readonly string[] => {
  const parts = [
    ...(money.estimate === null
      ? []
      : [
          `${formatUsd(money.estimate)} estimate${unpriced > 0 ? ` (${plural(unpriced, "request")} unpriced)` : ""}`,
        ]),
    ...(money.toolFigure === null
      ? []
      : [`${formatUsd(money.toolFigure)} tool's figure`]),
    ...(money.billed === null ? [] : [`${formatUsd(money.billed)} billed`]),
  ];

  return parts.length === 0 ? [`${DASH} cost`] : parts;
};

const timeOf = (chat: ChatLike): string | null => {
  if (chat.agentTimeMs.value !== null) {
    return `${formatDuration(chat.agentTimeMs.value)} agent time`;
  }

  const start = chat.span?.start ?? null;
  const end = chat.span?.end ?? null;

  if (start === null || end === null) {
    return null;
  }

  const ms = Date.parse(end) - Date.parse(start);

  return Number.isNaN(ms) || ms <= 0 ? null : `lasted ${formatDuration(ms)}`;
};

export const chatStatsParts = (
  chat: ChatLike,
  now: number
): readonly string[] => {
  const tokens = tokenTotalOf(chat);
  const requests = chat.usage?.requests ?? chat.requests?.value ?? null;
  const time = timeOf(chat);
  const start = chat.span?.start ?? null;

  return [
    ...chatMoneyParts(
      {
        billed: billedOf(chat),
        estimate: estimateOf(chat),
        toolFigure: toolFigureOf(chat),
      },
      chat.usage?.unpriced ?? 0
    ),
    tokens === null ? `${DASH} tokens` : `${formatCount(tokens)} tokens`,
    ...(requests === null || requests === 0
      ? []
      : [plural(requests, "request")]),
    ...(chat.toolCalls.value === null
      ? []
      : [plural(chat.toolCalls.value, "tool call")]),
    ...(time === null ? [] : [time]),
    ...(start === null ? [] : [`started ${formatAgo(start, now)}`]),
  ];
};

const { shortSession } = dashboardStateKit();

const shortId = (sessionId: string): string => {
  const tail = sessionId.split(/[:/]/u).at(-1) ?? sessionId;

  return shortSession(tail.replace(/^agent-/u, ""));
};

export const chatLabel = (
  chat: ChatLike,
  depth: number,
  titles = true
): string => {
  const title =
    titles && chat.title !== null && chat.title.value.trim() !== ""
      ? chat.title.value
      : null;

  if (depth === 0) {
    return title ?? `chat ${shortId(chat.sessionId)}`;
  }

  const agent = chat.agentType ?? null;
  const kind = agent === null ? "subagent" : `subagent ${agent}`;

  return title === null || title === agent
    ? `${kind} (${shortId(chat.sessionId)})`
    : `${kind}: ${title}`;
};

const toolBadge = (chat: ChatLike): string =>
  chat.tool === undefined || chat.tool === null ? "" : `[${chat.tool}] `;

const toolCounts = (report: ChatsReportLike): string => {
  const counts = new Map<string, number>();

  for (const chat of report.chats) {
    const tool = chat.tool ?? null;

    if (tool !== null) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([tool, count]) => `${tool} ${String(count)}`)
    .join(", ");
};

const filterText = (report: ChatsReportLike): string | null => {
  const parts = Object.entries(report.filters ?? {}).flatMap(
    ([name, values]) =>
      values === undefined || values.length === 0
        ? []
        : [`${name} ${values.join(", ")}`]
  );

  return parts.length === 0 ? null : `Only ${parts.join("; ")}.`;
};

const placeOf = (report: ChatsReportLike): string => {
  if (report.branch !== null) {
    return `on ${report.branch}`;
  }

  return report.repoCommonDir === null ? "in every repo" : "on every branch";
};

const headingOf = (report: ChatsReportLike, subagents: number): string => {
  const topLevel = report.chats.length - subagents;
  const where = placeOf(report);
  const tools = toolCounts(report);

  const count =
    subagents === 0
      ? `${plural(report.chats.length, "chat")} ${where}`
      : `${plural(topLevel, "chat")} ${where}, with ${plural(subagents, "subagent")}`;

  return tools === "" ? count : `${count} (${tools})`;
};

const totalsLine = (report: ChatsReportLike): string | null => {
  const totals = report.totals ?? null;

  if (totals === null || totals.requests === 0) {
    return null;
  }

  return [
    "Total:",
    chatMoneyParts(totals, totals.unpriced).join(" · "),
    "·",
    totals.tokens.total === null
      ? `${DASH} tokens`
      : `${formatCount(totals.tokens.total)} tokens`,
    "·",
    plural(totals.requests, "request"),
  ].join(" ");
};

export const chatsText = (
  report: ChatsReportLike,
  options: RenderOptions
): string => {
  const where = placeOf(report);
  const filters = filterText(report);

  if (report.chats.length === 0) {
    return [
      `No chats recorded ${where} yet.`,
      ...(filters === null ? [] : [filters]),
    ].join("\n");
  }

  const byId = new Map(report.chats.map((chat) => [chat.sessionId, chat]));
  const lines: string[] = [];
  const seen = new Set<string>();

  const walk = (chat: ChatLike, depth: number) => {
    if (seen.has(chat.sessionId)) {
      return;
    }

    seen.add(chat.sessionId);
    const indent = depth === 0 ? "" : `${"   ".repeat(depth - 1)}└─ `;
    const detail = " ".repeat(indent.length + 2);

    lines.push(
      `${indent}${toolBadge(chat)}${chatLabel(chat, depth)}`,
      `${detail}${chatStatsParts(chat, options.now).join(" · ")}`
    );

    if (chat.modelTimeline.length > 0) {
      lines.push(`${detail}${collapseTurns(chat.modelTimeline)}`);
    } else if (options.verbose && (chat.modelTimelineReason ?? null) !== null) {
      lines.push(`${detail}models: ${chat.modelTimelineReason ?? ""}`);
    }

    const others = (chat.branches ?? []).filter(
      (name) => report.branch !== null && name !== report.branch
    );

    if (others.length > 0) {
      lines.push(`${detail}Also on ${others.join(", ")}`);
    }

    for (const childId of chat.childSessionIds) {
      const child = byId.get(childId);

      if (child !== undefined) {
        walk(child, depth + 1);
      }
    }
  };

  const roots = report.rootSessionIds.flatMap((id) => {
    const chat = byId.get(id);

    return chat === undefined ? [] : [chat];
  });

  for (const chat of [...roots, ...report.chats]) {
    if (!seen.has(chat.sessionId) && lines.length > 0) {
      lines.push("");
    }

    walk(chat, 0);
  }

  const subagents = new Set(
    report.chats.flatMap((chat) =>
      chat.childSessionIds.filter((id) => byId.has(id))
    )
  ).size;

  const totals = totalsLine(report);

  const notes = [
    ...(filters === null ? [] : [filters]),
    ...(options.verbose && report.estimateLabel !== undefined
      ? [
          `Estimate: tokens x the model maker's public price (${report.estimateLabel}). The tool's own figure and billed amounts are separate and never added to it.`,
        ]
      : []),
    ...(report.unattributed.events > 0
      ? [
          `${plural(report.unattributed.events, "event")} on this account are not linked to a chat.`,
        ]
      : []),
  ];

  return [
    headingOf(report, subagents),
    ...(totals === null ? [] : [totals]),
    "",
    ...lines,
    ...(notes.length === 0 ? [] : ["", ...notes]),
  ].join("\n");
};

const TITLE_LEFT_OUT =
  "titles are left out of exports; add --titles to include them";

interface TitledChat {
  readonly title: unknown;
  readonly titleUnavailableReason: string | null;
}

export const withoutTitles = <
  C extends TitledChat,
  R extends { readonly chats: readonly C[] },
>(
  report: R
) => ({
  ...report,
  chats: report.chats.map((chat) => ({
    ...chat,
    title: null,
    titleUnavailableReason:
      chat.title === null ? chat.titleUnavailableReason : TITLE_LEFT_OUT,
  })),
});

export interface ChatsFlagValues {
  readonly allBranches: boolean;
  readonly effort: readonly string[];
  readonly model: readonly string[];
  readonly provider: readonly string[];
  readonly tool: readonly string[];
  readonly via: readonly string[];
}

const LIST_FLAGS = ["effort", "model", "provider", "tool", "via"] as const;

const splitList = (values: readonly string[]): readonly string[] =>
  values.flatMap((value) =>
    value.split(",").flatMap((part) => {
      const trimmed = part.trim();

      return trimmed === "" ? [] : [trimmed];
    })
  );

interface ChatsInput {
  allBranches?: boolean;
  branch?: string;
  effort?: readonly string[];
  model?: readonly string[];
  provider?: readonly string[];
  repo: string;
  since?: string;
  tool?: readonly string[];
  via?: readonly string[];
}

export const chatsInputOf = (
  flags: ChatsFlagValues & {
    readonly branch: string | undefined;
    readonly since: string | undefined;
  },
  repo: string
): ChatsInput => {
  const input: ChatsInput = { repo };

  if (flags.allBranches) {
    input.allBranches = true;
  } else if (flags.branch !== undefined) {
    input.branch = flags.branch;
  }

  if (flags.since !== undefined) {
    input.since = flags.since;
  }

  for (const name of LIST_FLAGS) {
    const values = splitList(flags[name]);

    if (values.length > 0) {
      input[name] = values;
    }
  }

  return input;
};
