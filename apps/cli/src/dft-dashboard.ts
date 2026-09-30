// @effect-diagnostics nodeBuiltinImport:off -- The dashboard writes one HTML file and hands it to the system browser at the process boundary.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { gitSelectorResolver, makeDxChatsCapability } from "@rat-stack/core/dx";
import type { FlightHistoryRow, HistoryMeasure } from "@rat-stack/core/dx";
import { Data, DateTime, Effect, Option } from "effect";

import {
  collapseTurns,
  enterpriseHtml,
  formatAgo,
  formatCount,
  formatDuration,
  formatUsd,
} from "./dft-render.js";
import { VERSION } from "./version.js";

export class DashboardWriteError extends Data.TaggedError(
  "DashboardWriteError"
)<{
  readonly message: string;
  readonly path: string;
}> {}

interface DashboardTurn {
  readonly effort: string | null;
  readonly maxMode: boolean | null;
  readonly model: string;
}

interface DashboardLine {
  readonly category: string;
  readonly estimate: boolean;
  readonly ledger: string;
  readonly value: number;
}

export interface DashboardChat {
  readonly agentTimeMs: { readonly value: number | null };
  readonly branches?: readonly string[];
  readonly childSessionIds: readonly string[];
  readonly modelTimeline: readonly DashboardTurn[];
  readonly money: readonly DashboardLine[];
  readonly sessionId: string;
  readonly title: { readonly value: string } | null;
  readonly tokens: readonly DashboardLine[];
  readonly toolCalls: { readonly value: number | null };
}

export interface DashboardChats {
  readonly chats: readonly DashboardChat[];
  readonly repoCommonDir: string | null;
  readonly rootSessionIds: readonly string[];
}

export interface DashboardHistory {
  readonly rows: readonly FlightHistoryRow[];
  readonly since: string | null;
}

export type DashboardScope = "repo" | "all";

export interface DashboardBranch {
  readonly chats: DashboardChats | null;
  readonly row: FlightHistoryRow;
}

export interface DashboardData {
  readonly account: readonly FlightHistoryRow[];
  readonly branches: readonly DashboardBranch[];
  readonly generatedAt: number;
  readonly repoLabel: string;
  readonly scope: DashboardScope;
  readonly since: string | null;
  readonly titles: boolean;
  readonly version: string;
}

export interface RenderDashboardOptions {
  readonly timeZone?: string;
}

const DASH = "-";

const ESCAPES = new Map([
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["'", "&#39;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

export const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>"']/gu, (char) => ESCAPES.get(char) ?? char);

const orDash = <A>(value: A | null, format: (value: A) => string): string =>
  value === null ? DASH : format(value);

const measure = (item: HistoryMeasure): number | null => item.value;

export const rowTokens = (row: FlightHistoryRow): number | null => {
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

export const rowCursorFigure = (row: FlightHistoryRow): number | null =>
  measure(row.money.metered);

export const rowBilled = (row: FlightHistoryRow): number | null =>
  measure(row.money.billed) ?? measure(row.money.metered);

export const rowEstimate = (row: FlightHistoryRow): number | null =>
  measure(row.money.estimatedPriceTable) ?? measure(row.money.estimatedSource);

const sumOrNull = (values: readonly (number | null)[]): number | null => {
  const present = values.filter((value): value is number => value !== null);

  return present.length === 0
    ? null
    : present.reduce((sum, value) => sum + value, 0);
};

export const repoName = (commonDir: string | null): string => {
  if (commonDir === null) {
    return DASH;
  }

  const parts = commonDir.split(/[/\\]/u).filter((part) => part !== "");
  const last = parts.at(-1);

  return (last === ".git" ? parts.at(-2) : last) ?? commonDir;
};

export const baseName = (file: string): string =>
  file.split(/[/\\]/u).findLast((part) => part !== "") ?? file;

const dateFormat = (
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions
) =>
  new Intl.DateTimeFormat(
    "en-US",
    timeZone === undefined ? options : { ...options, timeZone }
  );

const dayText = (iso: string, timeZone: string | undefined): string => {
  const at = Date.parse(iso);

  return Number.isNaN(at)
    ? DASH
    : dateFormat(timeZone, { day: "numeric", month: "short" }).format(at);
};

const stampText = (at: number, timeZone: string | undefined): string =>
  dateFormat(timeZone, {
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(at);

const rangeText = (
  rows: readonly FlightHistoryRow[],
  timeZone: string | undefined
): string => {
  const first = rows
    .flatMap((row) =>
      row.firstActivityAt === null ? [] : [row.firstActivityAt]
    )
    .toSorted()
    .at(0);

  const last = rows
    .flatMap((row) => (row.lastActivityAt === null ? [] : [row.lastActivityAt]))
    .toSorted()
    .at(-1);

  if (first === undefined || last === undefined) {
    return DASH;
  }

  const from = dayText(first, timeZone);
  const to = dayText(last, timeZone);

  return from === to ? from : `${from} to ${to}`;
};

interface Totals {
  readonly agentMs: number | null;
  readonly billed: number | null;
  readonly estimate: number | null;
  readonly estimatePartial: boolean;
  readonly tokens: number | null;
}

const totalsOf = (
  branches: readonly FlightHistoryRow[],
  all: readonly FlightHistoryRow[]
): Totals => ({
  agentMs: sumOrNull(branches.map((row) => measure(row.agentTime))),
  billed: sumOrNull(all.map(rowBilled)),
  estimate: sumOrNull(all.map(rowEstimate)),
  estimatePartial: all.some(
    (row) => rowTokens(row) !== null && rowEstimate(row) === null
  ),
  tokens: sumOrNull(all.map(rowTokens)),
});

const tile = (label: string, value: string, note = ""): string =>
  `<div class="tile"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}${
    note === "" ? "" : `<small>${escapeHtml(note)}</small>`
  }</dd></div>`;

const sumLines = (lines: readonly DashboardLine[]): number =>
  lines.reduce((sum, line) => sum + line.value, 0);

const chatMoney = (chat: DashboardChat): string => {
  const ledgerLines = (ledger: string) =>
    chat.money.filter(
      (line) => line.ledger === ledger && line.category !== "total"
    );

  const billed = ledgerLines("charge");
  const metered = ledgerLines("metered");
  const estimate = chat.money.filter((line) => line.estimate);
  const paid = billed.length > 0 ? billed : metered;

  const parts = [
    ...(paid.length === 0 ? [] : [`${formatUsd(sumLines(paid))} billed`]),
    ...(estimate.length === 0
      ? []
      : [`${formatUsd(sumLines(estimate))} estimate`]),
  ];

  return parts.length === 0 ? `${DASH} cost` : parts.join(" · ");
};

const chatTokens = (chat: DashboardChat): string => {
  const total = chat.tokens.find((line) => line.category === "total");

  if (total !== undefined) {
    return `${formatCount(total.value)} tokens`;
  }

  const parts = chat.tokens.filter((line) => line.category !== "reasoning");

  return parts.length === 0
    ? `${DASH} tokens`
    : `${formatCount(sumLines(parts))} tokens`;
};

const chatStats = (chat: DashboardChat): string =>
  [
    chatMoney(chat),
    chatTokens(chat),
    chat.agentTimeMs.value === null
      ? `${DASH} agent time`
      : `${formatDuration(chat.agentTimeMs.value)} agent time`,
    ...(chat.toolCalls.value === null
      ? []
      : [
          `${formatCount(chat.toolCalls.value)} tool call${chat.toolCalls.value === 1 ? "" : "s"}`,
        ]),
  ].join(" · ");

const chatTitle = (chat: DashboardChat, titles: boolean): string =>
  titles && chat.title !== null && chat.title.value.trim() !== ""
    ? chat.title.value
    : `chat ${chat.sessionId.slice(0, 8)}`;

export const chatList = (
  report: DashboardChats,
  branch: string,
  titles: boolean
): string => {
  if (report.chats.length === 0) {
    return `<p class="muted">No chats recorded on this branch.</p>`;
  }

  const byId = new Map(report.chats.map((chat) => [chat.sessionId, chat]));
  const seen = new Set<string>();

  const item = (chat: DashboardChat, depth: number): string => {
    if (seen.has(chat.sessionId)) {
      return "";
    }

    seen.add(chat.sessionId);

    const children = chat.childSessionIds.flatMap((id) => {
      const child = byId.get(id);
      const html = child === undefined ? "" : item(child, depth + 1);

      return html === "" ? [] : [html];
    });

    const others = (chat.branches ?? []).filter((name) => name !== branch);
    const models = collapseTurns(chat.modelTimeline);

    return [
      `<li${depth > 0 ? ' class="sub"' : ""}>`,
      `<div class="chat-title">${depth > 0 ? '<span class="tag">subagent</span> ' : ""}${escapeHtml(chatTitle(chat, titles))}</div>`,
      `<div class="muted">${escapeHtml(chatStats(chat))}</div>`,
      models === "" ? "" : `<div class="models">${escapeHtml(models)}</div>`,
      others.length === 0
        ? ""
        : `<div class="muted">Also on ${escapeHtml(others.join(", "))}</div>`,
      children.length === 0 ? "" : `<ul>${children.join("")}</ul>`,
      "</li>",
    ].join("");
  };

  const roots = report.rootSessionIds.flatMap((id) => {
    const chat = byId.get(id);

    return chat === undefined ? [] : [chat];
  });

  const items = [...roots, ...report.chats].flatMap((chat) => {
    const html = item(chat, 0);

    return html === "" ? [] : [html];
  });

  return `<ul class="chats">${items.join("")}</ul>`;
};

interface Cell {
  readonly className?: string;
  readonly html: string;
  readonly sort: string;
}

const numberCell = (
  value: number | null,
  format: (value: number) => string
): Cell => ({
  className: "num",
  html: escapeHtml(orDash(value, format)),
  sort: value === null ? "-1" : String(value),
});

const textCell = (text: string, title = ""): Cell => ({
  html:
    title === ""
      ? escapeHtml(text)
      : `<span title="${escapeHtml(title)}">${escapeHtml(text)}</span>`,
  sort: text.toLowerCase(),
});

const percent = (value: number | null, max: number): string =>
  value === null || max <= 0
    ? "0"
    : String(Math.max(1, Math.round((value / max) * 100)));

const barCell = (row: FlightHistoryRow, max: number): Cell => {
  const billed = rowBilled(row);
  const estimate = rowEstimate(row);

  return {
    className: "bars",
    html: [
      `<span class="bar billed" style="width:${percent(billed, max)}%"></span>`,
      `<span class="bar estimate" style="width:${percent(estimate, max)}%"></span>`,
    ].join(""),
    sort: String(Math.max(billed ?? -1, estimate ?? -1)),
  };
};

const worktreeCell = (row: FlightHistoryRow): Cell => {
  const first = row.worktree ?? row.worktrees[0];

  if (first === undefined) {
    return textCell(DASH);
  }

  const rest = row.worktrees.filter((worktree) => worktree !== first).length;

  const label =
    rest === 0 ? baseName(first) : `${baseName(first)} +${String(rest)}`;

  return textCell(label, row.worktrees.join("\n"));
};

const COLUMNS: readonly (readonly [string, boolean])[] = [
  ["Repo", false],
  ["Branch", false],
  ["Worktree", false],
  ["Status", false],
  ["Last active", true],
  ["Agent time", true],
  ["Tokens", true],
  ["Billed", true],
  ["Estimate", true],
  ["Cost", true],
  ["Chats", true],
  ["Commits", true],
];

const chatsNote = (branch: DashboardBranch, titles: boolean): string => {
  if (branch.row.branch === null) {
    return `<p class="muted">Chats are listed only for named branches.</p>`;
  }

  if (branch.chats === null) {
    return `<p class="muted">Chats for this branch could not be read. Its worktree may be gone.</p>`;
  }

  return chatList(branch.chats, branch.row.branch, titles);
};

const branchRows = (
  branch: DashboardBranch,
  data: DashboardData,
  max: number
): string => {
  const { row } = branch;
  const name = row.branch ?? "unassigned";
  const repo = repoName(row.repoCommonDir);

  const last =
    row.lastActivityAt === null ? null : Date.parse(row.lastActivityAt);

  const cells: readonly Cell[] = [
    textCell(repo, row.repoCommonDir ?? ""),
    { ...textCell(name), className: "branch" },
    worktreeCell(row),
    textCell(row.status.value === "unknown" ? DASH : row.status.value),
    {
      html:
        row.lastActivityAt === null
          ? DASH
          : `<span title="${escapeHtml(row.lastActivityAt)}">${escapeHtml(formatAgo(row.lastActivityAt, data.generatedAt))}</span>`,
      sort: last === null || Number.isNaN(last) ? "-1" : String(last),
    },
    numberCell(measure(row.agentTime), formatDuration),
    numberCell(rowTokens(row), formatCount),
    numberCell(rowBilled(row), formatUsd),
    numberCell(rowEstimate(row), formatUsd),
    barCell(row, max),
    numberCell(measure(row.chats), formatCount),
    numberCell(measure(row.commits), formatCount),
  ];

  const search = [repo, name, ...row.worktrees].join(" ").toLowerCase();

  const tds = cells
    .map(
      (cell) =>
        `<td${cell.className === undefined ? "" : ` class="${cell.className}"`} data-v="${escapeHtml(cell.sort)}">${cell.html}</td>`
    )
    .join("");

  return [
    `<tr class="row" tabindex="0" aria-expanded="false" data-q="${escapeHtml(search)}">${tds}</tr>`,
    `<tr class="detail" hidden><td colspan="${String(COLUMNS.length)}">${chatsNote(branch, data.titles)}</td></tr>`,
  ].join("\n");
};

const branchTable = (data: DashboardData): string => {
  if (data.branches.length === 0) {
    return `<p class="empty">No branches with activity in this window.</p>`;
  }

  const max = Math.max(
    0,
    ...data.branches.flatMap(({ row }) => [
      rowBilled(row) ?? 0,
      rowEstimate(row) ?? 0,
    ])
  );

  const head = COLUMNS.map(
    ([label, numeric]) =>
      `<th scope="col" aria-sort="none"${numeric ? ' class="num"' : ""}><button type="button"${numeric ? ' data-num="1"' : ""}>${escapeHtml(label)}</button></th>`
  ).join("");

  return [
    `<div class="tools"><input id="filter" type="search" placeholder="Filter by repo, branch or worktree" aria-label="Filter branches"><span class="muted">Click a branch to see its chats.</span></div>`,
    `<div class="scroll"><table id="branches"><thead><tr>${head}</tr></thead><tbody>`,
    ...data.branches.map((branch) => branchRows(branch, data, max)),
    "</tbody></table></div>",
  ].join("\n");
};

const accountBlock = (data: DashboardData): string => {
  if (data.account.length === 0) {
    return "";
  }

  const billed = sumOrNull(data.account.map(rowBilled));
  const estimate = sumOrNull(data.account.map(rowEstimate));
  const tokens = sumOrNull(data.account.map(rowTokens));
  const chats = sumOrNull(data.account.map((row) => measure(row.chats)));

  const last = data.account
    .flatMap((row) => (row.lastActivityAt === null ? [] : [row.lastActivityAt]))
    .toSorted()
    .at(-1);

  const parts = [
    ...(billed === null ? [] : [`${formatUsd(billed)} billed`]),
    ...(estimate === null ? [] : [`${formatUsd(estimate)} estimate`]),
    ...(tokens === null ? [] : [`${formatCount(tokens)} tokens`]),
    ...(chats === null
      ? []
      : [`${formatCount(chats)} chat${chats === 1 ? "" : "s"}`]),
    `last active ${formatAgo(last ?? null, data.generatedAt)}`,
  ];

  return `<p class="account"><strong>Not linked to a branch:</strong> ${escapeHtml(parts.join(" · "))}</p>`;
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1c1c1a;--muted:#6b6b66;--line:#e4e3df;--panel:#fff;--hover:#f3f2ee;--billed:#2f6fdb;--estimate:#b9c7e4;--accent:#2f6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#9c9b95;--line:#2d2d2a;--panel:#1d1d1b;--hover:#252523;--billed:#6d9cf0;--estimate:#3a4a6a;--accent:#8fb3f5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
main{max-width:1400px;margin:0 auto;padding:24px 16px 40px}
h1{font-size:20px;margin:0 0 2px}
.muted,small{color:var(--muted)}
.sub{margin:0 0 16px;color:var(--muted)}
dl.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:0 0 20px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile dt{color:var(--muted);font-size:12px}
.tile dd{margin:2px 0 0;font-size:20px;font-weight:600}
.tile small{display:block;font-size:11px;font-weight:400}
.tools{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
#filter{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);min-width:260px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{border-collapse:collapse;width:100%}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{position:sticky;top:0;background:var(--panel);font-size:12px;color:var(--muted);font-weight:500}
th button{all:unset;cursor:pointer}
th[aria-sort=ascending] button::after{content:" ▲"}
th[aria-sort=descending] button::after{content:" ▼"}
.num{text-align:right}
td.branch{font-weight:600;max-width:320px;overflow:hidden;text-overflow:ellipsis}
tr.row{cursor:pointer}
tr.row:hover,tr.row:focus-visible,tr.row[aria-expanded=true]{background:var(--hover);outline:none}
td.bars{min-width:110px;width:12%}
.bar{display:block;height:5px;border-radius:3px;margin:2px 0;min-width:0}
.bar.billed{background:var(--billed)}
.bar.estimate{background:var(--estimate)}
tr.detail td{white-space:normal;background:var(--bg);padding:10px 16px 14px}
ul.chats,ul.chats ul{list-style:none;margin:0;padding:0}
ul.chats ul{margin-left:22px;border-left:2px solid var(--line);padding-left:12px}
ul.chats li{padding:6px 0}
.chat-title{font-weight:600}
.models{font-size:12px}
.tag{font-size:11px;font-weight:500;color:var(--accent);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.account{margin:14px 0 0;padding:10px 12px;border:1px dashed var(--line);border-radius:8px}
.empty{padding:24px;text-align:center;color:var(--muted)}
.legend{display:inline-flex;gap:12px;align-items:center}
.legend i{display:inline-block;width:14px;height:5px;border-radius:3px;margin-right:4px;vertical-align:middle}
footer{margin-top:20px;color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between}
.enterprise{flex-basis:100%;margin:0;color:var(--muted);opacity:.8}
`;

const SCRIPT = `
(function(){
var table=document.getElementById("branches");if(!table)return;
var body=table.tBodies[0];var col=-1;var dir=1;
function toggle(row){var open=row.getAttribute("aria-expanded")==="true";row.setAttribute("aria-expanded",String(!open));row.nextElementSibling.hidden=open;}
Array.prototype.forEach.call(table.tHead.rows[0].cells,function(th,i){th.querySelector("button").addEventListener("click",function(){
var numeric=this.hasAttribute("data-num");dir=col===i?-dir:(numeric?-1:1);col=i;
var rows=Array.prototype.slice.call(body.querySelectorAll("tr.row"));
rows.sort(function(a,b){var x=a.cells[i].getAttribute("data-v"),y=b.cells[i].getAttribute("data-v");return (numeric?Number(x)-Number(y):x.localeCompare(y))*dir;});
rows.forEach(function(r){var d=r.nextElementSibling;body.appendChild(r);body.appendChild(d);});
Array.prototype.forEach.call(table.tHead.rows[0].cells,function(h,j){h.setAttribute("aria-sort",j===i?(dir>0?"ascending":"descending"):"none");});});});
body.addEventListener("click",function(e){var r=e.target.closest("tr.row");if(r)toggle(r);});
body.addEventListener("keydown",function(e){if(e.key!=="Enter"&&e.key!==" ")return;var r=e.target.closest("tr.row");if(r){e.preventDefault();toggle(r);}});
var filter=document.getElementById("filter");
filter.addEventListener("input",function(){var q=filter.value.trim().toLowerCase();
Array.prototype.forEach.call(body.querySelectorAll("tr.row"),function(r){var hit=r.getAttribute("data-q").indexOf(q)!==-1;r.hidden=!hit;if(!hit){r.nextElementSibling.hidden=true;r.setAttribute("aria-expanded","false");}});});
})();
`;

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

export const renderDashboard = (
  data: DashboardData,
  options: RenderDashboardOptions = {}
): string => {
  const rows = data.branches.map((branch) => branch.row);
  const all = [...rows, ...data.account];
  const totals = totalsOf(rows, all);

  const scopeText =
    data.scope === "all" ? "All repos" : `Repo ${data.repoLabel}`;

  const windowText =
    data.since === null
      ? "all time"
      : `since ${dayText(data.since, options.timeZone)}`;

  const tiles = [
    tile("Billed", orDash(totals.billed, formatUsd)),
    tile(
      "Estimate",
      orDash(totals.estimate, formatUsd),
      totals.estimatePartial ? "some tokens have no price" : "list price"
    ),
    tile("Tokens", orDash(totals.tokens, formatCount)),
    tile("Agent time", orDash(totals.agentMs, formatDuration)),
    tile("Branches", formatCount(rows.length)),
    tile("Active", rangeText(all, options.timeZone)),
  ].join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>AI cost · ${escapeHtml(data.scope === "all" ? "all repos" : data.repoLabel)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<header>",
    "<h1>AI cost per branch</h1>",
    `<p class="sub">${escapeHtml(`${scopeText} · ${windowText}`)}</p>`,
    `<dl class="totals">${tiles}</dl>`,
    "</header>",
    branchTable(data),
    accountBlock(data),
    "<footer>",
    `<span>Billed is what Cursor charged. Estimate is list price for the tokens. They are shown apart, never added. <span class="legend"><span><i style="background:var(--billed)"></i>billed</span><span><i style="background:var(--estimate)"></i>estimate</span></span></span>`,
    `<span>Generated ${escapeHtml(stampText(data.generatedAt, options.timeZone))} · dft ${escapeHtml(data.version)}</span>`,
    `<p class="enterprise">${enterpriseHtml()}</p>`,
    "</footer>",
    "</main>",
    `<script>${SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
};

export interface DashboardHistoryQuery {
  readonly allRepos: boolean;
  readonly repo: string;
  readonly since?: string;
}

export interface DashboardChatsQuery {
  readonly branch: string;
  readonly repo: string;
  readonly since?: string;
}

export interface DashboardSources<HE, HR, CE, CR> {
  readonly chats: (
    input: DashboardChatsQuery
  ) => Effect.Effect<DashboardChats, CE, CR>;
  readonly history: (
    input: DashboardHistoryQuery
  ) => Effect.Effect<DashboardHistory, HE, HR>;
}

export interface DashboardOptions {
  readonly dftHome: string;
  readonly open?: boolean;
  readonly outPath?: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly repo: string;
  readonly scope: DashboardScope;
  readonly since?: string | undefined;
  readonly titles?: boolean;
  readonly version?: string;
}

export interface DashboardResult {
  readonly branches: number;
  readonly generatedAt: string;
  readonly opened: boolean;
  readonly path: string;
}

export const branchChats = makeDxChatsCapability({
  resolveSelector: gitSelectorResolver("."),
}).handler;

export const defaultDashboardPath = (dftHome: string): string =>
  path.join(dftHome, "dashboard.html");

const withSince = <A extends object>(
  base: A,
  since: string | undefined
): A & { since?: string } => (since === undefined ? base : { ...base, since });

export const repoPathOf = (row: FlightHistoryRow): string | null => {
  const fromCommon =
    row.repoCommonDir !== null && baseName(row.repoCommonDir) === ".git"
      ? [path.dirname(row.repoCommonDir)]
      : [];

  const candidates = [
    ...row.worktrees,
    ...fromCommon,
    ...(row.repoCommonDir === null ? [] : [row.repoCommonDir]),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const repoPathFor = (
  row: FlightHistoryRow,
  options: DashboardOptions
): string | null => (options.scope === "repo" ? options.repo : repoPathOf(row));

const loadChats = <CE, CR>(
  row: FlightHistoryRow,
  options: DashboardOptions,
  chats: (input: DashboardChatsQuery) => Effect.Effect<DashboardChats, CE, CR>
): Effect.Effect<DashboardChats | null, never, CR> => {
  const repo = repoPathFor(row, options);

  if (row.branch === null || repo === null) {
    return Effect.succeed(null);
  }

  return chats(withSince({ branch: row.branch, repo }, options.since)).pipe(
    Effect.option,
    Effect.map((report) =>
      Option.isSome(report) && report.value.repoCommonDir === row.repoCommonDir
        ? report.value
        : null
    )
  );
};

const byLastActive = (a: FlightHistoryRow, b: FlightHistoryRow): number =>
  Date.parse(b.lastActivityAt ?? "1970-01-01") -
  Date.parse(a.lastActivityAt ?? "1970-01-01");

const openerFor = (platform: NodeJS.Platform): string | null => {
  if (platform === "darwin") {
    return "open";
  }

  return platform === "linux" ? "xdg-open" : null;
};

export const openInBrowser = (file: string, platform: NodeJS.Platform) =>
  Effect.sync(() => {
    const command = openerFor(platform);

    if (command === null) {
      return false;
    }

    try {
      const child = spawn(command, [file], {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", () => {
        child.unref();
      });
      child.unref();

      return true;
    } catch {
      return false;
    }
  });

export const writeDashboard = <HE, HR, CE, CR>(
  options: DashboardOptions,
  sources: DashboardSources<HE, HR, CE, CR>
): Effect.Effect<DashboardResult, HE | DashboardWriteError, HR | CR> =>
  Effect.gen(function* dashboard() {
    const history = yield* sources.history(
      withSince(
        { allRepos: options.scope === "all", repo: options.repo },
        options.since
      )
    );

    const sorted = history.rows.toSorted(byLastActive);
    const named = sorted.filter((row) => row.repoCommonDir !== null);

    const branches = yield* Effect.all(
      named.map((row) =>
        Effect.map(loadChats(row, options, sources.chats), (chats) => ({
          chats,
          row,
        }))
      )
    );

    const now = yield* DateTime.now;
    const generatedAt = DateTime.toEpochMillis(now);

    const html = renderDashboard({
      account:
        options.scope === "all"
          ? sorted.filter((row) => row.repoCommonDir === null)
          : [],
      branches,
      generatedAt,
      repoLabel:
        named[0]?.repoCommonDir === undefined
          ? baseName(options.repo)
          : repoName(named[0].repoCommonDir),
      scope: options.scope,
      since: history.since,
      titles: options.titles ?? true,
      version: options.version ?? VERSION,
    });

    const file = path.resolve(
      options.outPath ?? defaultDashboardPath(options.dftHome)
    );

    yield* Effect.try({
      catch: (error) =>
        new DashboardWriteError({
          message: error instanceof Error ? error.message : String(error),
          path: file,
        }),
      try: () => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, html, "utf-8");
      },
    });

    const opened =
      options.open === false
        ? false
        : yield* openInBrowser(file, options.platform ?? process.platform);

    return {
      branches: branches.length,
      generatedAt: DateTime.formatIso(now),
      opened,
      path: file,
    };
  });

export const dashboardText = (result: DashboardResult): string =>
  [
    `Dashboard saved: ${result.path}`,
    result.opened
      ? "Opened in your browser."
      : "Open this file in your browser to see it.",
  ].join("\n");
