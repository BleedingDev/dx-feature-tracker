// @effect-diagnostics nodeBuiltinImport:off -- The dashboard writes one HTML file and hands it to the system browser at the process boundary.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { gitSelectorResolver, makeDxChatsCapability } from "@rat-stack/core/dx";
import type {
  DxUsageInputType,
  DxUsageOutputType,
  FlightHistoryRow,
  HistoryMeasure,
} from "@rat-stack/core/dx";
import { Data, DateTime, Effect, Option } from "effect";

import { chatLabel, chatStatsParts } from "./dft-chats.js";
import type { ChatLike } from "./dft-chats.js";
import { USAGE_STYLE, usageSection } from "./dft-dashboard-usage.js";
import type { StaticUsage } from "./dft-dashboard-usage.js";
import {
  collapseTurns,
  enterpriseHtml,
  formatAgo,
  formatCount,
  formatDuration,
  formatUsd,
} from "./dft-render.js";
import type { CostOptions } from "./dft-session.js";
import { VERSION } from "./version.js";

export class DashboardWriteError extends Data.TaggedError(
  "DashboardWriteError"
)<{
  readonly message: string;
  readonly path: string;
}> {}

export type DashboardChat = ChatLike;

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

export interface DashboardLedger {
  readonly billed: number | null;
  readonly estimate: number | null;
  readonly tokens: number | null;
  readonly toolFigure: number | null;
}

export interface DashboardLedgers {
  readonly branches: ReadonlyMap<string, DashboardLedger>;
  readonly unlinked: DashboardLedger | null;
}

export interface DashboardData {
  readonly account: readonly FlightHistoryRow[];
  readonly branches: readonly DashboardBranch[];
  readonly generatedAt: number;
  readonly ledgers?: DashboardLedgers | null;
  readonly repoLabel: string;
  readonly scope: DashboardScope;
  readonly since: string | null;
  readonly titles: boolean;
  readonly usage?: StaticUsage | null;
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

export const rowToolFigure = (row: FlightHistoryRow): number | null =>
  measure(row.money.metered);

export const rowBilled = (row: FlightHistoryRow): number | null =>
  measure(row.money.billed);

export const rowEstimate = (row: FlightHistoryRow): number | null =>
  measure(row.money.estimatedPriceTable) ?? measure(row.money.estimatedSource);

export const ledgerKey = (
  repoCommonDir: string | null,
  branch: string | null
): string => JSON.stringify([repoCommonDir, branch]);

const legacyLedger = (row: FlightHistoryRow): DashboardLedger => ({
  billed: rowBilled(row),
  estimate: rowEstimate(row),
  tokens: rowTokens(row),
  toolFigure: rowToolFigure(row),
});

const EMPTY_LEDGER: DashboardLedger = {
  billed: null,
  estimate: null,
  tokens: null,
  toolFigure: null,
};

const ledgerOf = (
  row: FlightHistoryRow,
  ledgers: DashboardLedgers | null | undefined
): DashboardLedger =>
  ledgers === null || ledgers === undefined
    ? legacyLedger(row)
    : (ledgers.branches.get(ledgerKey(row.repoCommonDir, row.branch)) ??
      EMPTY_LEDGER);

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

const chatTitle = (
  chat: DashboardChat,
  depth: number,
  titles: boolean
): string => {
  const label = chatLabel(chat, 0, titles);
  const agent = chat.agentType ?? null;

  return depth > 0 && agent !== null && label.startsWith("chat ")
    ? `${agent} ${label.slice("chat ".length)}`
    : label;
};

export const chatList = (
  report: DashboardChats,
  branch: string,
  titles: boolean,
  now: number
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
    const tool = chat.tool ?? null;

    return [
      `<li${depth > 0 ? ' class="sub"' : ""}>`,
      `<div class="chat-title">${tool === null ? "" : `<span class="tag">${escapeHtml(tool)}</span> `}${depth > 0 ? '<span class="tag">subagent</span> ' : ""}${escapeHtml(chatTitle(chat, depth, titles))}</div>`,
      `<div class="muted">${escapeHtml(chatStatsParts(chat, now).join(" · "))}</div>`,
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

const barCell = (ledger: DashboardLedger, max: number): Cell => {
  const { billed, estimate } = ledger;

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
  ["Estimate", true],
  ["Tool's figure", true],
  ["Billed", true],
  ["Cost", true],
  ["Chats", true],
  ["Commits", true],
];

const chatsNote = (
  branch: DashboardBranch,
  titles: boolean,
  now: number
): string => {
  if (branch.row.branch === null) {
    return `<p class="muted">Chats are listed only for named branches.</p>`;
  }

  if (branch.chats === null) {
    return `<p class="muted">Chats for this branch could not be read. Its worktree may be gone.</p>`;
  }

  return chatList(branch.chats, branch.row.branch, titles, now);
};

const repoLabels = (
  rows: readonly FlightHistoryRow[]
): ReadonlyMap<string, string> => {
  const dirs = [...new Set(rows.flatMap((row) => row.repoCommonDir ?? []))];

  const names = dirs.map((dir) => repoName(dir));

  return new Map(
    dirs.map((dir, index) => {
      const name = names[index] ?? dir;

      return [
        dir,
        names.indexOf(name) === names.lastIndexOf(name)
          ? name
          : dir
              .replace(/[/\\]\.git$/u, "")
              .split(/[/\\]/u)
              .slice(-2)
              .join("/"),
      ] as const;
    })
  );
};

const branchRows = (
  branch: DashboardBranch,
  data: DashboardData,
  max: number,
  labels: ReadonlyMap<string, string>
): string => {
  const { row } = branch;
  const name = row.branch ?? "unassigned";
  const ledger = ledgerOf(row, data.ledgers);

  const repo =
    labels.get(row.repoCommonDir ?? "") ?? repoName(row.repoCommonDir);

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
    numberCell(ledger.tokens, formatCount),
    numberCell(ledger.estimate, formatUsd),
    numberCell(ledger.toolFigure, formatUsd),
    numberCell(ledger.billed, formatUsd),
    barCell(ledger, max),
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
    `<tr class="detail" hidden><td colspan="${String(COLUMNS.length)}">${chatsNote(branch, data.titles, data.generatedAt)}</td></tr>`,
  ].join("\n");
};

const branchTable = (data: DashboardData): string => {
  const labels = repoLabels(data.branches.map((item) => item.row));

  if (data.branches.length === 0) {
    return `<p class="empty">No branches with activity in this window.</p>`;
  }

  const max = Math.max(
    0,
    ...data.branches.flatMap(({ row }) => {
      const ledger = ledgerOf(row, data.ledgers);

      return [ledger.billed ?? 0, ledger.estimate ?? 0];
    })
  );

  const head = COLUMNS.map(
    ([label, numeric]) =>
      `<th scope="col" aria-sort="none"${numeric ? ' class="num"' : ""}><button type="button"${numeric ? ' data-num="1"' : ""}>${escapeHtml(label)}</button></th>`
  ).join("");

  return [
    `<div class="tools"><input id="filter" type="search" placeholder="Filter by repo, branch or worktree" aria-label="Filter branches"><span class="muted">Click a branch to see its chats.</span></div>`,
    `<div class="scroll"><table id="branches"><thead><tr>${head}</tr></thead><tbody>`,
    ...data.branches.map((branch) => branchRows(branch, data, max, labels)),
    "</tbody></table></div>",
  ].join("\n");
};

const accountLedger = (data: DashboardData): DashboardLedger | null => {
  if (data.ledgers === null || data.ledgers === undefined) {
    return data.account.length === 0
      ? null
      : {
          billed: sumOrNull(data.account.map(rowBilled)),
          estimate: sumOrNull(data.account.map(rowEstimate)),
          tokens: sumOrNull(data.account.map(rowTokens)),
          toolFigure: sumOrNull(data.account.map(rowToolFigure)),
        };
  }

  return data.ledgers.unlinked;
};

const accountBlock = (data: DashboardData): string => {
  const ledger = accountLedger(data);

  if (ledger === null) {
    return "";
  }

  const { billed, estimate, tokens, toolFigure } = ledger;
  const chats = sumOrNull(data.account.map((row) => measure(row.chats)));

  const last = data.account
    .flatMap((row) => (row.lastActivityAt === null ? [] : [row.lastActivityAt]))
    .toSorted()
    .at(-1);

  const parts = [
    ...(billed === null ? [] : [`${formatUsd(billed)} billed`]),
    ...(estimate === null ? [] : [`${formatUsd(estimate)} estimate`]),
    ...(toolFigure === null ? [] : [`${formatUsd(toolFigure)} tool's figure`]),
    ...(tokens === null ? [] : [`${formatCount(tokens)} tokens`]),
    ...(chats === null
      ? []
      : [`${formatCount(chats)} chat${chats === 1 ? "" : "s"}`]),
    ...(last === undefined
      ? []
      : [`last active ${formatAgo(last, data.generatedAt)}`]),
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

  const ledgers =
    data.usage === undefined || data.usage === null
      ? [
          tile(
            "Estimate",
            orDash(totals.estimate, formatUsd),
            totals.estimatePartial ? "some tokens have no price" : "list price"
          ),
          tile("Billed", orDash(totals.billed, formatUsd)),
          tile("Tokens", orDash(totals.tokens, formatCount)),
        ]
      : [];

  const tiles = [
    ...ledgers,
    tile("Agent time", orDash(totals.agentMs, formatDuration)),
    tile("Branches", formatCount(rows.length)),
    tile("Active", rangeText(all, options.timeZone)),
  ].join("");

  const usage =
    data.usage === undefined || data.usage === null
      ? []
      : [usageSection(data.usage)];

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>AI cost · ${escapeHtml(data.scope === "all" ? "all repos" : data.repoLabel)}</title>`,
    `<style>${STYLE}${USAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<header>",
    "<h1>AI usage and cost</h1>",
    `<p class="sub">${escapeHtml(`${scopeText} · ${windowText}`)}</p>`,
    "</header>",
    ...usage,
    `<dl class="totals">${tiles}</dl>`,
    branchTable(data),
    accountBlock(data),
    "<footer>",
    `<span>Estimate is the model maker's list price for the tokens. Tool's figure is the cost a tool reported itself. Billed is a real charge. They are shown apart, never added. <span class="legend"><span><i style="background:var(--billed)"></i>billed</span><span><i style="background:var(--estimate)"></i>estimate</span></span></span>`,
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

export interface DashboardSources<HE, HR, CE, CR, UE = never, UR = never> {
  readonly chats: (
    input: DashboardChatsQuery
  ) => Effect.Effect<DashboardChats, CE, CR>;
  readonly history: (
    input: DashboardHistoryQuery
  ) => Effect.Effect<DashboardHistory, HE, HR>;
  readonly usage?: (
    input: DxUsageInputType
  ) => Effect.Effect<DxUsageOutputType, UE, UR>;
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

export const branchChatsWith = (costOptions?: CostOptions) =>
  makeDxChatsCapability(
    costOptions === undefined
      ? { resolveSelector: gitSelectorResolver(".") }
      : { costOptions, resolveSelector: gitSelectorResolver(".") }
  ).handler;

export const branchChats = branchChatsWith();

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

const loadUsage = <UE, UR>(
  options: DashboardOptions,
  usage:
    | ((input: DxUsageInputType) => Effect.Effect<DxUsageOutputType, UE, UR>)
    | undefined
): Effect.Effect<StaticUsage | null, never, UR> => {
  if (usage === undefined) {
    return Effect.succeed(null);
  }

  const repo = options.scope === "repo" ? [options.repo] : undefined;
  const scoped: DxUsageInputType = repo === undefined ? {} : { repo };

  const base: DxUsageInputType =
    options.since === undefined ? scoped : { ...scoped, since: options.since };

  return Effect.all({
    models: usage({ ...base, groupBy: "model", limit: 12, sortBy: "estimate" }),
    series: usage({
      ...base,
      bucket: "day",
      limit: 6,
      metrics: ["estimate"],
      stackBy: "tool",
    }),
    tools: usage({ ...base, groupBy: "tool", limit: 50, sortBy: "estimate" }),
  }).pipe(
    Effect.option,
    Effect.map((loaded) => (Option.isSome(loaded) ? loaded.value : null))
  );
};

type UsageValues = DxUsageOutputType["total"]["values"];

const ledgerFrom = (values: UsageValues): DashboardLedger => ({
  billed: values.billed ?? null,
  estimate: values.estimate ?? null,
  tokens: values.tokens ?? null,
  toolFigure: values.toolFigure ?? null,
});

const branchLedgers = (
  dir: string,
  out: DxUsageOutputType
): readonly (readonly [string, DashboardLedger])[] => [
  ...out.groups.map(
    (group) => [ledgerKey(dir, group.key), ledgerFrom(group.values)] as const
  ),
  ...(out.unattributed === null
    ? []
    : [[ledgerKey(dir, null), ledgerFrom(out.unattributed.values)] as const]),
];

const loadLedgers = <UE, UR>(
  options: DashboardOptions,
  dirs: readonly string[],
  usage:
    | ((input: DxUsageInputType) => Effect.Effect<DxUsageOutputType, UE, UR>)
    | undefined
): Effect.Effect<DashboardLedgers | null, never, UR> => {
  if (usage === undefined) {
    return Effect.succeed(null);
  }

  const query: DxUsageInputType = withSince(
    {
      groupBy: "branch",
      limit: 500,
      metrics: ["tokens", "estimate", "toolFigure", "billed"],
      sortBy: "tokens",
    },
    options.since
  );

  return Effect.all({
    perRepo: Effect.all(
      dirs.map((dir) =>
        Effect.map(usage({ ...query, repo: [dir] }), (out) =>
          branchLedgers(dir, out)
        )
      )
    ),
    unlinked:
      options.scope === "all"
        ? Effect.map(usage(query), (out) =>
            out.unattributed === null
              ? null
              : ledgerFrom(out.unattributed.values)
          )
        : Effect.succeed(null),
  }).pipe(
    Effect.option,
    Effect.map((loaded) =>
      Option.isSome(loaded)
        ? {
            branches: new Map(loaded.value.perRepo.flat()),
            unlinked: loaded.value.unlinked,
          }
        : null
    )
  );
};

export const writeDashboard = <HE, HR, CE, CR, UE = never, UR = never>(
  options: DashboardOptions,
  sources: DashboardSources<HE, HR, CE, CR, UE, UR>
): Effect.Effect<DashboardResult, HE | DashboardWriteError, HR | CR | UR> =>
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

    const usage = yield* loadUsage(options, sources.usage);

    const ledgers = yield* loadLedgers(
      options,
      [...new Set(named.flatMap((row) => row.repoCommonDir ?? []))],
      sources.usage
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
      ledgers,
      repoLabel:
        named[0]?.repoCommonDir === undefined
          ? baseName(options.repo)
          : repoName(named[0].repoCommonDir),
      scope: options.scope,
      since: history.since,
      titles: options.titles ?? true,
      usage,
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
