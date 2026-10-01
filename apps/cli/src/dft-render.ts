import type {
  FlightHistoryRow,
  HistoryMeasure,
  SyncReport,
  SyncStep,
} from "@rat-stack/core/dx";

export const UNASSIGNED_LABEL = "unassigned";

interface ModelTurnLike {
  readonly effort: string | null;
  readonly maxMode: boolean | null;
  readonly model: string;
}

interface ChatLineLike {
  readonly category: string;
  readonly estimate: boolean;
  readonly ledger: string;
  readonly value: number;
}

interface ChatValueLike {
  readonly value: number | null;
}

export interface ChatNode {
  readonly agentTimeMs: ChatValueLike;
  readonly branches?: readonly string[];
  readonly childSessionIds: readonly string[];
  readonly modelTimeline: readonly ModelTurnLike[];
  readonly modelTimelineReason: string | null;
  readonly money: readonly ChatLineLike[];
  readonly sessionId: string;
  readonly title: { readonly value: string } | null;
  readonly tokens: readonly ChatLineLike[];
  readonly toolCalls: ChatValueLike;
}

const DASH = "-";

const SECOND = 1000;

const MINUTE = 60 * SECOND;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const GROUP_WINDOW_MS = 15 * MINUTE;

const TOP_MODELS = 4;

const REASON_LENGTH = 60;

export interface RenderOptions {
  readonly now: number;
  readonly verbose: boolean;
}

interface Missing {
  readonly label: string;
  readonly reason: string;
}

const round1 = (value: number): string => {
  const text = value.toFixed(1);

  return text.endsWith(".0") ? text.slice(0, -2) : text;
};

export const formatUsd = (value: number): string => {
  if (value > 0 && value < 0.01) {
    return "<$0.01";
  }

  return value >= 1000
    ? `$${Math.round(value).toLocaleString("en-US")}`
    : `$${value.toFixed(2)}`;
};

export const formatCount = (value: number): string => {
  const abs = Math.abs(value);

  if (abs >= 1_000_000_000) {
    return `${round1(value / 1_000_000_000)}B`;
  }

  if (abs >= 1_000_000) {
    return `${round1(value / 1_000_000)}M`;
  }

  if (abs >= 10_000) {
    return `${String(Math.round(value / 1000))}k`;
  }

  if (abs >= 1000) {
    return `${round1(value / 1000)}k`;
  }

  return String(Math.round(value));
};

export const formatDuration = (ms: number): string => {
  if (ms < MINUTE) {
    return ms <= 0 ? "0m" : "<1m";
  }

  if (ms < HOUR) {
    return `${String(Math.round(ms / MINUTE))}m`;
  }

  if (ms < DAY) {
    const minutes = Math.round(ms / MINUTE);

    return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  }

  const hours = Math.round(ms / HOUR);

  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
};

const plural = (count: number, word: string): string =>
  `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

export const formatAge = (ms: number): string => {
  if (ms < HOUR) {
    return `${String(Math.max(1, Math.round(ms / MINUTE)))} min`;
  }

  if (ms < DAY) {
    return plural(Math.round(ms / HOUR), "hour");
  }

  return plural(Math.round(ms / DAY), "day");
};

export const formatAgo = (iso: string | null, now: number): string => {
  if (iso === null) {
    return DASH;
  }

  const ms = now - Date.parse(iso);

  if (Number.isNaN(ms)) {
    return DASH;
  }

  return ms < MINUTE ? "just now" : `${formatAge(ms)} ago`;
};

const shortReason = (reason: string): string => {
  const cut = reason.split(/; | \(|\. /u)[0] ?? reason;

  return cut.length > REASON_LENGTH
    ? `${cut.slice(0, REASON_LENGTH - 1).trimEnd()}…`
    : cut;
};

const missingFooter = (
  missing: readonly Missing[],
  verbose: boolean
): readonly string[] => {
  const unique = missing.filter(
    (item, index) =>
      missing.findIndex((other) => other.label === item.label) === index
  );

  if (unique.length === 0) {
    return [];
  }

  if (!verbose) {
    return [
      "",
      `Missing: ${unique.map((item) => item.label).join(", ")}. Add --verbose to see why.`,
    ];
  }

  const width = Math.max(...unique.map((item) => item.label.length));

  return [
    "",
    "Missing:",
    ...unique.map(
      (item) =>
        `  ${item.label.padEnd(width)}  ${item.reason.charAt(0).toUpperCase()}${item.reason.slice(1)}`
    ),
  ];
};

const blockLines = (
  rows: readonly (readonly [string, string])[]
): readonly string[] => {
  const width = Math.max(...rows.map(([label]) => label.length));

  return rows.map(([label, text]) => `${label.padEnd(width)}  ${text}`);
};

export const table = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
  rightAligned: ReadonlySet<number>
): readonly string[] => {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length))
  );

  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) =>
        rightAligned.has(column)
          ? cell.padStart(widths[column] ?? 0)
          : cell.padEnd(widths[column] ?? 0)
      )
      .join("  ")
      .trimEnd();

  return [line(header), ...rows.map(line)];
};

const SOURCE_LABELS = new Map([
  ["claude-jsonl", "Claude Code"],
  ["codex-session", "Codex"],
  ["cursor-cli", "Cursor CLI"],
  ["cursor-hooks", "Cursor hooks"],
  ["cursor-local-db", "Cursor app data"],
  ["cursor-transcripts", "Cursor chats"],
  ["cursor-usage-api", "Cursor account"],
  ["cursor-usage-export", "Cursor usage CSV"],
  ["entire-checkpoints", "Entire"],
  ["git-history", "git"],
  ["git-identity", "git"],
  ["git-observation", "git"],
  ["local-test", "tests"],
  ["manual", "manual marks"],
  ["opencode", "OpenCode"],
  ["shell-command", "shell"],
]);

const SKIP_PHRASES = new Map([
  ["cursor-local-db", "not read automatically (shared by all projects)"],
  ["cursor-transcripts", "no Cursor chats for this folder yet"],
]);

export const sourceLabel = (id: string): string => {
  const bare = id.replace(/^collector[./]/u, "");

  return SOURCE_LABELS.get(bare) ?? bare;
};

export const sourceNote = (step: SyncStep): string => {
  if (step.status !== "synced") {
    return (
      SKIP_PHRASES.get(step.source.replace(/^collector[./]/u, "")) ??
      shortReason(step.reason ?? "not available")
    );
  }

  return step.inserted === 0 || step.inserted === null
    ? plural(step.duplicates ?? 0, "event")
    : `${plural((step.duplicates ?? 0) + step.inserted, "event")} (${formatCount(step.inserted)} new)`;
};

const syncTotals = (report: SyncReport) => {
  const synced = report.steps.filter((step) => step.status === "synced");

  return {
    inserted: synced.reduce((sum, step) => sum + (step.inserted ?? 0), 0),
    skipped: report.steps.filter((step) => step.status === "unavailable"),
    synced,
  };
};

export const syncText = (report: SyncReport, verbose: boolean): string => {
  const totals = syncTotals(report);
  const sources = plural(totals.synced.length, "source");

  const head =
    totals.inserted === 0
      ? `dft: up to date (${sources} checked)`
      : `dft: synced ${plural(totals.inserted, "new event")} from ${sources}`;

  if (!verbose) {
    return head;
  }

  return [
    head,
    ...report.steps.map((step) =>
      step.status === "synced"
        ? `  ✓ ${sourceLabel(step.source)}: ${formatCount(step.inserted ?? 0)} new, ${formatCount(step.duplicates ?? 0)} already stored`
        : `  – ${sourceLabel(step.source)}: ${step.reason ?? "not available"}`
    ),
  ].join("\n");
};

export const syncNote = (
  report: SyncReport,
  verbose: boolean
): string | null =>
  verbose || syncTotals(report).inserted > 0 ? syncText(report, verbose) : null;

interface StatusLike {
  readonly snapshotCount: number | null;
  readonly storePath: string | null;
}

const tildePath = (file: string, home: string): string =>
  home !== "" && file.startsWith(home) ? `~${file.slice(home.length)}` : file;

export const statusText = (
  status: StatusLike,
  sync: SyncReport | null,
  options: RenderOptions & { readonly home: string }
): string => {
  const head = `Store: ${status.storePath === null ? DASH : tildePath(status.storePath, options.home)}`;

  if (sync === null) {
    return [head, "", "Sources not checked (--no-sync)."].join("\n");
  }

  const branch = sync.context.branch ?? "detached HEAD";

  const rows = sync.steps.map(
    (step) =>
      [
        step.status === "synced" ? "✓" : "–",
        sourceLabel(step.source),
        step.status !== "synced" && options.verbose
          ? (step.reason ?? "not available")
          : sourceNote(step),
      ] as const
  );

  const width = Math.max(...rows.map(([, label]) => label.length));

  return [
    head,
    `Branch: ${branch}`,
    "",
    ...rows.map(
      ([mark, label, text]) => `${mark} ${label.padEnd(width)}  ${text}`
    ),
  ].join("\n");
};

interface AnalyzeMetricLike {
  readonly metricId: string;
  readonly method: string;
  readonly reason: string | null;
  readonly unit: string;
  readonly value: number | null;
}

export interface AnalyzeLike {
  readonly metrics: readonly AnalyzeMetricLike[];
  readonly snapshot: { readonly selector: { readonly branch: string | null } };
}

export interface AnalyzeExtras {
  readonly models: readonly (readonly [string, number])[];
  readonly status: string | null;
}

const priceTableLabel = (reason: string | null): string => {
  if (/^method=[^;]*cursor-list-price/u.test(reason ?? "")) {
    return "list price; Auto from Cursor";
  }

  const match = /price-table:(?<table>[^@;\s]+)@(?<date>[\d-]+)/u.exec(
    reason ?? ""
  );

  return match === null
    ? "list price"
    : `list price, ${match.groups?.table ?? ""} ${match.groups?.date ?? ""}`;
};

const stripMethod = (reason: string): string =>
  reason.replace(/^method=[^;]*; /u, "");

const analyzeMetrics = (report: AnalyzeLike) => {
  const byId = new Map(report.metrics.map((m) => [m.metricId, m]));
  const missing: Missing[] = [];

  const value = (id: string, label: string): number | null => {
    const metric = byId.get(id);

    if (metric === undefined || metric.value === null) {
      missing.push({
        label,
        reason: stripMethod(metric?.reason ?? "not computed"),
      });

      return null;
    }

    return metric.value;
  };

  const quiet = (id: string): number | null => byId.get(id)?.value ?? null;

  return { byId, missing, quiet, value };
};

const estimateText = (
  byId: ReadonlyMap<string, AnalyzeMetricLike>,
  missing: Missing[]
): string | null => {
  const priced = byId.get("dx.cost.list-price-estimate.price-table.usd");
  const source = byId.get("dx.cost.list-price-estimate.source.usd");

  if (priced !== undefined && priced.value !== null) {
    return `${formatUsd(priced.value)} estimate (${priceTableLabel(priced.reason)})`;
  }

  if (source !== undefined && source.value !== null) {
    return `${formatUsd(source.value)} estimate (list price)`;
  }

  missing.push({
    label: "estimate",
    reason: stripMethod(priced?.reason ?? "no token counts to price"),
  });

  return null;
};

const show = (value: number | null, format: (n: number) => string): string =>
  value === null ? DASH : format(value);

const present = (parts: readonly (string | null)[]): string => {
  const kept = parts.filter((part): part is string => part !== null);

  return kept.length === 0 ? DASH : kept.join(" · ");
};

const AUTO_MODELS = new Set(["auto", "default"]);

const modelLabel = (model: string): string =>
  AUTO_MODELS.has(model.toLowerCase()) ? "Auto" : model;

export const modelShares = (
  chats: readonly ChatNode[]
): readonly (readonly [string, number])[] => {
  const counts = new Map<string, number>();

  for (const chat of chats) {
    for (const turn of chat.modelTimeline) {
      const model = modelLabel(turn.model);
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([model, count]) => [model, count / total] as const);
};

const modelsText = (models: readonly (readonly [string, number])[]): string => {
  const top = models
    .slice(0, TOP_MODELS)
    .map(([model, share]) => `${model} ${String(Math.round(share * 100))}%`);

  const rest = models.length - TOP_MODELS;

  return [...top, ...(rest > 0 ? [`+${String(rest)} more`] : [])].join(" · ");
};

const piece = (
  value: number | null,
  text: (n: number) => string,
  skipZero = false
): string | null =>
  value === null || (skipZero && value === 0) ? null : text(value);

const analyzeHead = (
  report: AnalyzeLike,
  extras: AnalyzeExtras | null,
  branchAge: number | null
): string =>
  [
    report.snapshot.selector.branch ?? "all branches",
    ...(extras?.status === null ||
    extras?.status === undefined ||
    extras.status === "unknown"
      ? []
      : [extras.status]),
    ...(branchAge === null ? [] : [`${formatAge(branchAge)} old`]),
  ].join(" · ");

const linesChanged = (added: number | null, deleted: number | null) =>
  (added ?? 0) === 0 && (deleted ?? 0) === 0
    ? null
    : `+${show(added, formatCount)} −${show(deleted, formatCount)} lines`;

const NO_AI_HINT = [
  "",
  "No AI cost or tokens recorded for this branch yet.",
  "Use Cursor on this branch, then run dft analyze again.",
];

export const analyzeText = (
  report: AnalyzeLike,
  extras: AnalyzeExtras | null,
  options: RenderOptions
): string => {
  const { missing, quiet, value, byId } = analyzeMetrics(report);
  const branchAge = value("dx.flight.branch-age.ms", "branch age");
  const billed = value("dx.cost.charge.usd", "billed");
  const metered = value("dx.cost.metered.usd", "Cursor's figure");
  const estimate = estimateText(byId, missing);
  const input = value("dx.ai-usage.tokens.input", "tokens");
  const output = value("dx.ai-usage.tokens.output", "tokens");
  const active = value("dx.flight.active.ms", "active time");
  const agent = value("dx.flight.agent.ms", "agent time");
  const commits = value("dx.flight.commits", "commits");

  const rows: (readonly [string, string])[] = [
    [
      "Cost",
      present([
        piece(billed, (n) => `${formatUsd(n)} billed`),
        piece(metered, (n) => `${formatUsd(n)} Cursor's figure`),
        estimate,
      ]),
    ],
    [
      "Tokens",
      present([
        piece(input, (n) => `${formatCount(n)} in`),
        piece(
          quiet("dx.ai-usage.tokens.cached-input"),
          (n) => `${formatCount(n)} cached`,
          true
        ),
        piece(
          quiet("dx.ai-usage.tokens.cache-write"),
          (n) => `${formatCount(n)} cache write`,
          true
        ),
        piece(output, (n) => `${formatCount(n)} out`),
        piece(
          quiet("dx.ai-usage.tokens.reasoning"),
          (n) => `${formatCount(n)} reasoning`,
          true
        ),
      ]),
    ],
    [
      "Time",
      present([
        piece(branchAge, (n) => `${formatDuration(n)} on branch`),
        piece(active, (n) => `${formatDuration(n)} active`),
        piece(agent, (n) => `${formatDuration(n)} agent`),
      ]),
    ],
    [
      "Work",
      present([
        piece(commits, (n) => plural(n, "commit")),
        piece(quiet("dx.git.files-changed"), (n) => plural(n, "file"), true),
        linesChanged(
          quiet("dx.git.lines-added"),
          quiet("dx.git.lines-deleted")
        ),
        piece(quiet("dx.flight.tool-calls"), (n) => plural(n, "tool call")),
        piece(quiet("dx.ai-usage.requests"), (n) => plural(n, "request")),
      ]),
    ],
  ];

  if (extras !== null && extras.models.length > 0) {
    rows.push(["Models", modelsText(extras.models)]);
  }

  const noAi = [billed, metered, estimate, input].every((x) => x === null);

  const shown =
    billed === null
      ? missing
      : missing.filter((item) => item.label !== "Cursor's figure");

  return [
    analyzeHead(report, extras, branchAge),
    "",
    ...blockLines(rows),
    ...(noAi && !options.verbose
      ? NO_AI_HINT
      : missingFooter(shown, options.verbose)),
  ].join("\n");
};

interface TimelineEntryLike {
  readonly kind: string;
  readonly lane: string;
  readonly occurredAt: string | null;
  readonly summary: string;
}

interface ExplainLike {
  readonly entries: readonly TimelineEntryLike[];
  readonly total: number;
}

interface EventGroup {
  readonly entries: TimelineEntryLike[];
  readonly lane: string;
  readonly start: number | null;
}

const summaryNumber = (summary: string, key: string): number => {
  const match = new RegExp(`\\b${key}=(\\d+)`, "u").exec(summary);

  return match === null ? 0 : Number(match[1]);
};

const countKinds = (entries: readonly TimelineEntryLike[]) => {
  const count = (predicate: (kind: string) => boolean) =>
    entries.filter((entry) => predicate(entry.kind)).length;

  const sum = (key: string) =>
    entries.reduce(
      (total, entry) => total + summaryNumber(entry.summary, key),
      0
    );

  return {
    added: sum("linesAdded"),
    commands: count((kind) => kind === "command.run"),
    commits: count((kind) => kind === "git.commit"),
    deleted: sum("linesDeleted"),
    diff: entries.findLast((entry) => entry.kind === "git.diff"),
    edits: count((kind) => kind === "ai.tool-edit"),
    files: sum("filesChanged"),
    markers: count((kind) => kind.startsWith("marker.")),
    observations: count((kind) => kind === "git.observation"),
    prompts: count((kind) => kind === "ai.request" || kind === "ai.turn"),
    replies: sum("assistantMessages"),
    sessions: count((kind) => kind === "ai.session"),
    tests: count((kind) => kind === "test.result"),
    toolCalls: sum("toolCalls"),
    usage: count((kind) => kind === "ai.usage"),
  };
};

const uncommitted = (summary: string): string => {
  const files = summaryNumber(summary, "filesChanged");

  return files === 0
    ? ""
    : `uncommitted changes (+${formatCount(summaryNumber(summary, "linesAdded"))} −${formatCount(summaryNumber(summary, "linesDeleted"))}, ${plural(files, "file")})`;
};

const groupPhrase = (entries: readonly TimelineEntryLike[]): string => {
  const c = countKinds(entries);

  const parts = [
    c.sessions > 0 ? plural(c.sessions, "chat") : "",
    c.prompts > 0 ? plural(c.prompts, "prompt") : "",
    c.replies > 0
      ? `${formatCount(c.replies)} ${c.replies === 1 ? "reply" : "replies"}`
      : "",
    c.toolCalls > 0 ? plural(c.toolCalls, "tool call") : "",
    c.edits > 0 ? `${plural(c.edits, "file")} edited` : "",
    c.commits > 0
      ? `${plural(c.commits, "commit")} (+${formatCount(c.added)} −${formatCount(c.deleted)}, ${plural(c.files, "file")})`
      : "",
    c.diff === undefined ? "" : uncommitted(c.diff.summary),
    c.commands > 0 ? plural(c.commands, "command") : "",
    c.tests > 0 ? plural(c.tests, "test run") : "",
    c.markers > 0 ? plural(c.markers, "marker") : "",
  ].filter((part) => part !== "");

  if (parts.length > 0) {
    return parts.join(", ");
  }

  if (c.usage > 0) {
    return plural(c.usage, "usage record");
  }

  return c.observations > 0
    ? "branch created or moved"
    : plural(entries.length, "event");
};

const LOCAL_PARTS = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const localParts = (ms: number): Readonly<Record<string, string>> =>
  Object.fromEntries(
    LOCAL_PARTS.formatToParts(ms).map((part) => [part.type, part.value])
  );

const dayKey = (ms: number | null): string => {
  if (ms === null) {
    return "Undated";
  }

  const parts = localParts(ms);

  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
};

const clock = (ms: number | null): string => {
  if (ms === null) {
    return "     ";
  }

  const parts = localParts(ms);

  return `${parts.hour ?? ""}:${parts.minute ?? ""}`;
};

const entryTime = (entry: TimelineEntryLike): number | null => {
  if (entry.occurredAt === null) {
    return null;
  }

  const ms = Date.parse(entry.occurredAt);

  return Number.isNaN(ms) ? null : ms;
};

const groupEntries = (
  entries: readonly TimelineEntryLike[]
): readonly EventGroup[] => {
  const groups: EventGroup[] = [];

  for (const entry of entries) {
    const at = entryTime(entry);
    const last = groups.at(-1);

    const joins =
      last !== undefined &&
      last.lane === entry.lane &&
      dayKey(last.start) === dayKey(at) &&
      (at === null ||
        last.start === null ||
        at - last.start <= GROUP_WINDOW_MS);

    if (joins) {
      last.entries.push(entry);
    } else {
      groups.push({ entries: [entry], lane: entry.lane, start: at });
    }
  }

  return groups;
};

export const explainText = (
  timeline: ExplainLike,
  branch: string | null
): string => {
  const entries = timeline.entries.filter(
    (entry) =>
      entry.kind !== "git.diff" ||
      summaryNumber(entry.summary, "filesChanged") > 0
  );

  if (entries.length === 0) {
    return `No activity recorded for ${branch ?? "this branch"} yet.`;
  }

  const groups = groupEntries(entries);

  const width = Math.max(
    ...groups.map((group) => sourceLabel(group.lane).length)
  );

  const lines: string[] = [];

  let day: string | null = null;

  for (const group of groups) {
    const key = dayKey(group.start);

    if (key !== day) {
      lines.push(...(day === null ? [] : [""]), key);
      day = key;
    }

    lines.push(
      `  ${clock(group.start)}  ${sourceLabel(group.lane).padEnd(width)}  ${groupPhrase(group.entries)}`
    );
  }

  const more =
    timeline.total > timeline.entries.length
      ? [
          "",
          `Showing ${formatCount(timeline.entries.length)} of ${formatCount(timeline.total)} events.`,
        ]
      : [];

  return [...lines, ...more].join("\n");
};

const turnKey = (turn: ModelTurnLike): string => {
  const traits = [
    ...(turn.effort === null ? [] : [turn.effort]),
    ...(turn.maxMode === true ? ["max"] : []),
  ];

  const model = modelLabel(turn.model);

  return traits.length === 0 ? model : `${model} ${traits.join("+")}`;
};

export const collapseTurns = (timeline: readonly ModelTurnLike[]): string => {
  const counts = new Map<string, number>();

  for (const turn of timeline) {
    const key = turnKey(turn);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => `${key} ×${String(count)}`)
    .join(", ");
};

const measureValue = (measure: HistoryMeasure): number | null => measure.value;

const rowTokens = (row: FlightHistoryRow): number | null => {
  const total = row.tokens.find((token) => token.category === "total");

  if (total !== undefined && total.measure.value !== null) {
    return total.measure.value;
  }

  const values = row.tokens
    .filter(
      (token) => token.category !== "reasoning" && token.category !== "total"
    )
    .flatMap((token) =>
      token.measure.value === null ? [] : [token.measure.value]
    );

  return values.length === 0 ? null : values.reduce((sum, n) => sum + n, 0);
};

const rowEstimate = (row: FlightHistoryRow): number | null =>
  measureValue(row.money.estimatedPriceTable) ??
  measureValue(row.money.estimatedSource);

const repoName = (commonDir: string): string => {
  const parts = commonDir.split("/").filter((part) => part !== "");
  const last = parts.at(-1);

  return (last === ".git" ? parts.at(-2) : last) ?? commonDir;
};

const rowBilled = (row: FlightHistoryRow): number | null =>
  measureValue(row.money.billed) ?? measureValue(row.money.metered);

const mainWorktree = (commonDir: string | null): string | null =>
  commonDir !== null && commonDir.endsWith("/.git")
    ? commonDir.slice(0, -"/.git".length)
    : null;

const baseName = (file: string): string =>
  file.split("/").findLast((part) => part !== "") ?? file;

const worktreeCandidates = (row: FlightHistoryRow): readonly string[] => {
  if (row.worktree === undefined) {
    return row.worktrees;
  }

  return row.worktree === null ? [] : [row.worktree];
};

export const linkedWorktree = (row: FlightHistoryRow): string | null => {
  const main = mainWorktree(row.repoCommonDir);

  if (main === null) {
    return null;
  }

  const linked = worktreeCandidates(row).find((file) => file !== main);

  return linked === undefined ? null : baseName(linked);
};

const withWorktree = (name: string, row: FlightHistoryRow | null): string => {
  const worktree = row === null ? null : linkedWorktree(row);

  return worktree === null ? name : `${name} (worktree: ${worktree})`;
};

const worktreeFolder = (row: FlightHistoryRow): string => {
  const linked = linkedWorktree(row);

  if (linked !== null) {
    return linked;
  }

  const main = mainWorktree(row.repoCommonDir);

  return main !== null && worktreeCandidates(row).includes(main)
    ? baseName(main)
    : DASH;
};

const historyRowCells = (
  row: FlightHistoryRow,
  now: number,
  options: { readonly showRepo: boolean; readonly showWorktree: boolean }
): readonly string[] => [
  `${options.showRepo && row.repoCommonDir !== null ? `${repoName(row.repoCommonDir)}:` : ""}${row.branch ?? UNASSIGNED_LABEL}`,
  ...(options.showWorktree ? [worktreeFolder(row)] : []),
  row.status.value === "unknown" ? DASH : row.status.value,
  formatAgo(row.lastActivityAt, now),
  show(measureValue(row.agentTime), formatDuration),
  show(rowTokens(row), formatCount),
  show(rowBilled(row), formatUsd),
  show(rowEstimate(row), formatUsd),
  show(measureValue(row.chats), formatCount),
  show(measureValue(row.commits), formatCount),
];

const accountLine = (row: FlightHistoryRow, now: number): string => {
  const billed = rowBilled(row);
  const estimate = rowEstimate(row);
  const tokens = rowTokens(row);
  const chats = measureValue(row.chats);

  const parts = present([
    billed === null ? null : `${formatUsd(billed)} billed`,
    estimate === null ? null : `${formatUsd(estimate)} estimate`,
    tokens === null ? null : `${formatCount(tokens)} tokens`,
    chats === null ? null : plural(chats, "chat"),
    `last active ${formatAgo(row.lastActivityAt, now)}`,
  ]);

  return `Cursor account, not linked to a branch: ${parts}`;
};

const unassignedHint = (
  rows: readonly FlightHistoryRow[],
  verbose: boolean
): readonly string[] =>
  rows.length === 0
    ? []
    : [
        "",
        `${UNASSIGNED_LABEL}: repo activity that could not be matched to a branch.`,
        ...(verbose
          ? [
              "  Why: the events were recorded while HEAD was detached with no branch checked out before or after it in the HEAD reflog, the reflog entry has expired, or a hook could not resolve its worktree.",
            ]
          : []),
      ];

const unlinkedFootnote = (
  rows: readonly FlightHistoryRow[]
): readonly string[] => {
  const requests = rows.reduce(
    (sum, row) => sum + (measureValue(row.requests) ?? 0),
    0
  );

  const billed = rows.reduce((sum, row) => sum + (rowBilled(row) ?? 0), 0);

  return requests === 0 && billed === 0
    ? []
    : [
        "",
        `${formatCount(requests)} Cursor requests (${formatUsd(billed)} billed) could not be matched to a branch.`,
      ];
};

export const historyText = (
  rows: readonly FlightHistoryRow[],
  options: RenderOptions & { readonly allRepos: boolean }
): string => {
  const visible = rows
    .filter((row) => options.allRepos || row.repoCommonDir !== null)
    .toSorted(
      (a, b) =>
        Date.parse(b.lastActivityAt ?? "1970-01-01") -
        Date.parse(a.lastActivityAt ?? "1970-01-01")
    );

  if (visible.length === 0) {
    return "No branches with activity in this window.";
  }

  const branches = visible
    .filter((row) => row.repoCommonDir !== null)
    .toSorted((a, b) => Number(a.branch === null) - Number(b.branch === null));

  const account = visible.filter((row) => row.repoCommonDir === null);
  const unassigned = branches.filter((row) => row.branch === null);

  const showWorktree = branches.some((row) => linkedWorktree(row) !== null);
  const shift = showWorktree ? 1 : 0;

  const lines =
    branches.length === 0
      ? ["No branches with activity in this window."]
      : table(
          [
            "BRANCH",
            ...(showWorktree ? ["WORKTREE"] : []),
            "STATUS",
            "LAST ACTIVE",
            "AGENT TIME",
            "TOKENS",
            "BILLED",
            "ESTIMATE",
            "CHATS",
            "COMMITS",
          ],
          branches.map((row) =>
            historyRowCells(row, options.now, {
              showRepo: options.allRepos,
              showWorktree,
            })
          ),
          new Set([3, 4, 5, 6, 7, 8].map((column) => column + shift))
        );

  const hasMoney = visible.some(
    (row) => rowBilled(row) !== null || rowEstimate(row) !== null
  );

  return [
    ...lines,
    ...(account.length === 0
      ? []
      : ["", ...account.map((row) => accountLine(row, options.now))]),
    ...unassignedHint(unassigned, options.verbose),
    ...unlinkedFootnote(account),
    ...(hasMoney
      ? [
          "",
          "Billed is what Cursor charged. Estimate is list price for the tokens. They are shown apart, never added.",
        ]
      : []),
  ].join("\n");
};

export interface LineFacts {
  readonly agentMs: number | null;
  readonly billed: number | null;
  readonly chats: number | null;
  readonly commits: number | null;
  readonly estimate: number | null;
  readonly tokens: number | null;
}

export const rowFacts = (row: FlightHistoryRow): LineFacts => ({
  agentMs: measureValue(row.agentTime),
  billed: rowBilled(row),
  chats: measureValue(row.chats),
  commits: measureValue(row.commits),
  estimate: rowEstimate(row),
  tokens: rowTokens(row),
});

const sumPresent = (values: readonly (number | null)[]): number | null => {
  const kept = values.filter((value): value is number => value !== null);

  return kept.length === 0 ? null : kept.reduce((sum, n) => sum + n, 0);
};

export const reportFacts = (report: AnalyzeLike): LineFacts => {
  const byId = new Map(report.metrics.map((m) => [m.metricId, m.value]));
  const metric = (id: string): number | null => byId.get(id) ?? null;

  return {
    agentMs: metric("dx.flight.agent.ms"),
    billed: metric("dx.cost.charge.usd") ?? metric("dx.cost.metered.usd"),
    chats: null,
    commits: metric("dx.flight.commits"),
    estimate:
      metric("dx.cost.list-price-estimate.price-table.usd") ??
      metric("dx.cost.list-price-estimate.source.usd"),
    tokens: sumPresent([
      metric("dx.ai-usage.tokens.input"),
      metric("dx.ai-usage.tokens.cached-input"),
      metric("dx.ai-usage.tokens.cache-write"),
      metric("dx.ai-usage.tokens.output"),
    ]),
  };
};

const positive = (
  value: number | null,
  text: (n: number) => string
): readonly string[] => (value === null || value <= 0 ? [] : [text(value)]);

export const onelineText = (label: string, facts: LineFacts | null): string => {
  const ai =
    facts === null
      ? []
      : [
          ...positive(facts.billed, (n) => `${formatUsd(n)} billed`),
          ...positive(facts.estimate, (n) => `${formatUsd(n)} est`),
          ...positive(facts.tokens, (n) => `${formatCount(n)} tokens`),
          ...positive(facts.agentMs, (n) => `${formatDuration(n)} agent`),
          ...positive(facts.chats, (n) => plural(n, "chat")),
        ];

  const commits = positive(facts?.commits ?? null, (n) => plural(n, "commit"));

  const parts =
    ai.length === 0 ? ["no AI usage yet", ...commits] : [...ai, ...commits];

  return `${label}  ${parts.join(" · ")}`;
};

const rowName = (row: FlightHistoryRow, showRepo: boolean): string =>
  row.repoCommonDir === null
    ? "Cursor account"
    : `${showRepo ? `${repoName(row.repoCommonDir)}:` : ""}${row.branch ?? UNASSIGNED_LABEL}`;

export const branchOneline = (
  branch: string,
  row: FlightHistoryRow | null,
  fallback: LineFacts | null = null
): string =>
  onelineText(
    withWorktree(branch, row),
    row === null ? fallback : rowFacts(row)
  );

export const historyOneline = (
  rows: readonly FlightHistoryRow[],
  options: { readonly allRepos: boolean }
): string => {
  const visible = rows
    .filter((row) => options.allRepos || row.repoCommonDir !== null)
    .toSorted(
      (a, b) =>
        Date.parse(b.lastActivityAt ?? "1970-01-01") -
        Date.parse(a.lastActivityAt ?? "1970-01-01")
    );

  if (visible.length === 0) {
    return "No branches with activity in this window.";
  }

  const labels = visible.map((row) =>
    withWorktree(rowName(row, options.allRepos), row)
  );

  const width = Math.max(...labels.map((label) => label.length));

  return visible
    .map((row, index) =>
      onelineText((labels[index] ?? "").padEnd(width), rowFacts(row))
    )
    .join("\n");
};

export const snapshotLine = (
  branch: string | null,
  row: FlightHistoryRow | null
): string => `dft: ${branchOneline(branch ?? "(detached)", row)}`;

export const ledgerValues = (row: FlightHistoryRow): readonly number[] =>
  [
    row.money.billed,
    row.money.metered,
    row.money.estimatedSource,
    row.money.estimatedPriceTable,
  ].flatMap((measure) => (measure.value === null ? [] : [measure.value]));

export const ENTERPRISE_LINKEDIN = "https://www.linkedin.com/in/bleedingdev/";

export const ENTERPRISE_EMAIL = "petr.glaser@bleeding.dev";

export const ENTERPRISE_PITCH =
  "Want it for your whole company? All repos, all features, all people.";

export const enterpriseLine = (color = false): string => {
  const text = `${ENTERPRISE_PITCH} Write me: LinkedIn ${ENTERPRISE_LINKEDIN} or email ${ENTERPRISE_EMAIL}`;

  return color ? `\u001B[2m${text}\u001B[22m` : text;
};

export const withEnterpriseLine = (text: string, color = false): string =>
  `${text}\n\n${enterpriseLine(color)}`;

export const enterpriseHtml = (): string =>
  `${ENTERPRISE_PITCH} Write me: <a href="${ENTERPRISE_LINKEDIN}" target="_blank" rel="noopener">LinkedIn</a> or <a href="mailto:${ENTERPRISE_EMAIL}" target="_blank" rel="noopener">email</a>`;
