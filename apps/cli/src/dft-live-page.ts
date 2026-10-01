import { CAPTURE_TOOL_NAMES } from "./dft-capture.js";
import { dashboardStateScript } from "./dft-dashboard-state.js";
import { enterpriseHtml } from "./dft-render.js";
import { VERSION } from "./version.js";

export const TOOL_LABELS: ReadonlyMap<string, string> = new Map([
  ...Object.entries(CAPTURE_TOOL_NAMES),
  ["cursor", "Cursor"],
]);

export const TOOL_ORDER: readonly string[] = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
  "omp",
  "deepseek",
  "cursor",
];

export const DIMENSION_LABELS = {
  branch: "Branch",
  day: "Day",
  effort: "Effort",
  model: "Model",
  provider: "Model provider",
  repo: "Project",
  session: "Session",
  tool: "Tool",
  via: "Via",
  week: "Week",
  worktree: "Worktree",
};

export const METRIC_LABELS = {
  billed: "Billed",
  estimate: "Estimate",
  requests: "Requests",
  sessions: "Sessions",
  tokens: "Tokens",
  toolFigure: "Tool's figure",
};

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--surface:#ffffff;--raised:#f0efec;--text:#151515;--muted:#55544f;--faint:#7c7b75;--line:rgb(0 0 0 / .1);--grid:#e6e5e0;--accent:#a8610a;--accent-fill:#f0b44c;--on-accent:#151515;--bad:#c23a3a;--good:#1d7f3a;--bar-bg:rgb(247 247 245 / .92);--scrim:rgb(20 20 20 / .55);--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s-other:#a3a29b;--s-none:#d3d2cb;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--gutter:16px;--radius:10px}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--surface:#151517;--raised:#1f1f22;--text:#f4f4f5;--muted:#a1a1aa;--faint:#7c7c85;--line:rgb(255 255 255 / .09);--grid:#2a2a2e;--accent:#f0b44c;--accent-fill:#f0b44c;--on-accent:#0b0b0c;--bad:#f87171;--good:#86efac;--bar-bg:rgb(11 11 12 / .92);--scrim:rgb(5 5 6 / .84);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s-other:#6b6b72;--s-none:#3a3a40}}
@media (min-width:640px){:root{--gutter:24px}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:400 14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;overflow-x:hidden}
a{color:inherit}
button,input,select{font:inherit;color:inherit}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:16px;padding:10px var(--gutter);background:var(--bar-bg);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font:600 15px/1 var(--mono);text-decoration:none}
.brand svg{width:22px;height:22px}
nav.main{display:flex;gap:4px}
nav.main a,nav.main button{padding:6px 10px;border:0;border-radius:6px;background:none;font:inherit;text-decoration:none;color:var(--muted);cursor:pointer}
nav.main button:hover,nav.main a:hover{color:var(--text)}
nav.main a[aria-current=page]{color:var(--text);background:var(--raised)}
.live{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--faint);font-size:12px;white-space:nowrap;min-width:0;overflow:hidden}
.live i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px rgb(134 239 172 / .14)}
.live.off i{background:var(--faint);box-shadow:none}
@media (max-width:480px){.bar{gap:8px}.live span{display:none}}
main{max-width:1400px;margin:0 auto;padding:16px var(--gutter) 48px}
h1{font-size:20px;line-height:1.3;margin:0 0 4px;overflow-wrap:anywhere}
h2{font-size:12px;font-weight:600;color:var(--muted);margin:0 0 10px;text-transform:uppercase;letter-spacing:.05em}
.muted{color:var(--muted)}
.quiet{color:var(--faint);font-size:12px;margin:10px 2px 0}
.crumbs{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;margin:0 0 12px;font-size:13px;color:var(--faint)}
.crumbs a{color:var(--muted);text-decoration:none;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumbs a:hover{color:var(--text);text-decoration:underline}
.crumbs span[aria-current]{color:var(--text);font-weight:600;overflow-wrap:anywhere}
.crumbs .dim{color:var(--faint)}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--surface);max-width:100%;overflow-x:auto}
.seg button{background:transparent;border:0;padding:6px 11px;color:var(--muted);cursor:pointer;white-space:nowrap}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--raised);color:var(--text);font-weight:600}
.seg button:focus-visible,.btn:focus-visible,.chip button:focus-visible,select:focus-visible,input:focus-visible,tr[tabindex]:focus-visible,.tile[role=button]:focus-visible{outline:2px solid var(--accent-fill);outline-offset:1px}
select,input[type=text],input[type=search],input[type=date]{background:var(--surface);border:1px solid var(--line);border-radius:7px;padding:5px 9px;min-width:0}
select{max-width:100%}
label.inline{display:inline-flex;gap:6px;align-items:center;color:var(--muted)}
.custom{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;color:var(--muted)}
.chips{display:contents}
.chip{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--surface);max-width:100%}
.chip button{background:none;border:0;cursor:pointer;padding:4px 10px;color:var(--text);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:999px}
.chip button.x{padding:4px 9px 4px 2px;color:var(--faint)}
.chip button.x:hover{color:var(--bad)}
.chip b{font-weight:500;color:var(--muted)}
.addf{position:relative}
.menu{position:absolute;z-index:6;top:calc(100% + 4px);left:0;min-width:190px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:4px;box-shadow:0 12px 32px rgb(0 0 0 / .18)}
.menu button{display:block;width:100%;text-align:left;background:none;border:0;border-radius:5px;padding:6px 10px;cursor:pointer}
.menu button:hover,.menu button:focus-visible{background:var(--raised);outline:none}
.facet{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px;margin:0 0 12px}
.facet-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.facet-head strong{margin-right:auto}
.facet-head input{flex:1 1 180px}
.facet ul{list-style:none;margin:0;padding:0;max-height:300px;overflow:auto;border-top:1px solid var(--line)}
.facet li label{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:6px 4px;border-bottom:1px solid var(--line);cursor:pointer}
.facet li label:hover{background:var(--raised)}
.facet li .v{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.facet li .n{color:var(--muted);text-align:right;min-width:56px}
.facet .row{margin-top:10px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin:4px 0 14px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;min-width:0;margin:0}
.tile[role=button]{cursor:pointer}
.tile[role=button]:hover{border-color:var(--faint)}
.tile[aria-pressed=true]{border-color:var(--accent-fill);box-shadow:inset 0 0 0 1px var(--accent-fill)}
.tile dt{color:var(--muted);font-size:12px}
.tile dd{margin:2px 0 0;font-size:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile small{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:var(--faint);font-size:11px;font-weight:400;line-height:1.35;min-height:15px;overflow-wrap:anywhere}
@media (max-width:480px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.tile dd{font-size:17px}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;min-width:0}
.chart-panel{margin-bottom:14px;position:relative}
.chart-head{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.chart-head h2{margin:0}
#u-chart{width:100%;height:220px;display:block;touch-action:pan-y}
#u-chart text{fill:var(--faint);font:11px var(--sans)}
#u-chart .grid{stroke:var(--grid);stroke-width:1}
#u-chart .base{stroke:var(--faint);stroke-width:1}
#u-chart rect.seg{stroke:var(--surface);stroke-width:1.5}
#u-chart rect.hit{fill:transparent;cursor:pointer}
#u-chart rect.band{fill:transparent}
#u-chart rect.band.on{fill:var(--raised)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12px;color:var(--muted)}
.legend span{display:inline-flex;gap:6px;align-items:center;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw{flex:none;display:inline-block;width:10px;height:10px;border-radius:3px}
.tip{position:absolute;z-index:4;pointer-events:none;background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;min-width:160px;box-shadow:0 8px 24px rgb(0 0 0 / .2)}
.tip div{display:flex;gap:8px;align-items:center;justify-content:space-between}
.tip div span:first-child{display:inline-flex;gap:6px;align-items:center}
.tip strong{display:block;margin-bottom:4px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
table{border-collapse:collapse;width:100%}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
thead th{font-size:12px;color:var(--muted);font-weight:500}
tfoot td{border-top:1px solid var(--line);border-bottom:0;font-weight:600}
.num{text-align:right}
td.on,th.on{color:var(--text);font-weight:600}
td.label{max-width:380px;overflow:hidden;text-overflow:ellipsis}
td.label .sw{margin-right:8px;vertical-align:-1px}
td.label a{font-weight:600;text-decoration:none}
td.label a:hover{color:var(--accent);text-decoration:underline}
td.share{width:22%;min-width:120px}
.share-bar{display:flex;align-items:center;gap:8px}
.share-bar i{display:block;height:6px;border-radius:3px;background:var(--accent-fill);min-width:2px}
.share-bar span{color:var(--faint);font-size:12px;min-width:34px}
tr.drill{cursor:pointer}
tr.drill:hover{background:var(--raised)}
tr.pinned td{color:var(--muted);font-style:italic}
tr.pinned td.num{font-style:normal}
@media (max-width:640px){.opt{display:none}#u-metric{display:none}.panel{padding:12px}#s-tools td,#s-tools th,#s-sources td,#s-sources th{white-space:normal}td.share{width:auto;min-width:90px}td.label{max-width:150px}th,td{padding:7px 8px}}
.flash{animation:flash 1.6s ease-out}
@keyframes flash{from{color:var(--accent)}to{color:inherit}}
.empty{padding:28px;text-align:center;color:var(--muted)}
.error{border:1px solid rgb(248 113 113 / .45);color:var(--bad);border-radius:8px;padding:8px 12px;margin:0 0 12px}
.cols{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;margin-top:16px}
@media (min-width:900px){.cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
pre{margin:0;font:12px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}
details{margin-top:16px}
summary{cursor:pointer;color:var(--muted)}
details pre{margin-top:10px}
ul.chats,ul.chats ul{list-style:none;margin:0;padding:0}
ul.chats ul{margin-left:14px;border-left:2px solid var(--line);padding-left:12px}
ul.chats li{padding:6px 0}
.chat-title{font-weight:600;overflow-wrap:anywhere}
.models{font-size:12px;color:var(--accent)}
.tag{font-size:11px;color:var(--accent);border:1px solid var(--line);border-radius:4px;padding:0 5px;white-space:nowrap}
.stack{display:grid;gap:16px}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;gap:10px;align-items:baseline;padding:5px 0;flex-wrap:wrap}
.ok{color:var(--good)}
.no{color:var(--faint)}
.warn{color:var(--accent)}
.repo{border-top:1px solid var(--line);padding:12px 0}
.repo:first-of-type{border-top:0;padding-top:0}
.repo .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.repo .path{font:12px var(--mono);color:var(--faint);overflow-wrap:anywhere}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row input[type=text]{flex:1 1 220px}
.btn{background:var(--raised);border:1px solid var(--line);border-radius:7px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent-fill);color:var(--on-accent);border-color:var(--accent-fill);font-weight:600}
.btn.danger{border-color:rgb(248 113 113 / .5);color:var(--bad)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.danger-zone{border-color:rgb(248 113 113 / .35)}
.danger-zone h3{font-size:14px;margin:0 0 6px}
.danger-zone section{border-top:1px solid var(--line);padding:14px 0}
.danger-zone section:first-of-type{border-top:0;padding-top:0}
.plan{margin:8px 0;color:var(--muted);min-height:21px}
code{font:12px var(--mono);background:var(--raised);padding:1px 5px;border-radius:4px}
label.switch{display:flex;gap:10px;align-items:center;cursor:pointer}
.panel .scroll{border-radius:8px}
.facts{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 10px;color:var(--muted);font-size:13px}
.facts b{color:var(--text);font-weight:600}
.foot{max-width:1400px;margin:0 auto;padding:0 var(--gutter) 32px;color:var(--faint);font-size:12px}
.foot p{margin:0}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100% - 32px);background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:8px 14px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
#toast.bad{color:var(--bad)}
.intro{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:var(--gutter);background:var(--scrim);backdrop-filter:blur(6px)}
.intro-box{position:relative;width:min(960px,100%);aspect-ratio:16/9;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:#0b0b0c;box-shadow:0 24px 80px rgb(0 0 0 / .6)}
.intro-box video{display:block;width:100%;height:100%;object-fit:cover}
.intro-skip{position:absolute;right:12px;bottom:12px;background:rgb(28 28 31 / .88);color:#f4f4f5}
.intro-play{position:absolute;left:12px;bottom:12px;display:flex;align-items:center;gap:6px;border:0;border-radius:6px;padding:6px 14px 6px 10px;background:#f0b44c;color:#0b0b0c;font-weight:600;cursor:pointer}
.intro-play svg{width:16px;height:16px}
.intro-play:focus-visible,.intro-skip:focus-visible,nav.main button:focus-visible,nav.main a:focus-visible{outline:2px solid var(--accent-fill);outline-offset:2px}
`;

const introFile = (name: string) =>
  `/intro/${name}?v=${encodeURIComponent(VERSION)}`;

const INTRO_NAV = `<button type="button" id="nav-intro">Intro</button>`;

const INTRO_OVERLAY = `<div id="intro" class="intro" role="dialog" aria-modal="true" aria-label="dft intro" hidden>
<div class="intro-box">
<video id="intro-video" muted playsinline preload="none" poster="${introFile("dft-intro-poster.png")}"><source src="${introFile("dft-intro.webm")}" type="video/webm"><source src="${introFile("dft-intro.mp4")}" type="video/mp4"></video>
<button type="button" class="intro-play" id="intro-play" aria-label="Play intro" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg><span id="intro-play-label">Play</span></button>
<button type="button" class="btn intro-skip" id="intro-skip">Close</button>
</div>
</div>
`;

const body = (intro: boolean) => `
<header class="bar">
<a class="brand" href="#/"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#151517"/><path d="M11 7v18M11 12c0 5 10 3 10 9" fill="none" stroke="#f0b44c" stroke-width="3" stroke-linecap="round"/><circle cx="21" cy="22" r="3" fill="#f0b44c"/></svg>dft</a>
<nav class="main"><a href="#/" data-nav="usage">Usage</a><a href="#/setup" data-nav="setup">Setup</a>${intro ? INTRO_NAV : ""}</nav>
<span id="live" class="live off" aria-live="off"><i></i><span id="live-text">connecting</span></span>
</header>
<main>
<section id="v-usage" aria-label="Usage">
<nav class="crumbs" id="u-crumbs" aria-label="Breadcrumb"></nav>
<div class="filters">
<div class="seg" role="group" aria-label="Time range" id="u-range"><button type="button" data-range="7d">7 days</button><button type="button" data-range="30d">30 days</button><button type="button" data-range="all">All time</button><button type="button" data-range="custom">Custom</button></div>
<span class="custom" id="u-custom" hidden><input type="date" id="u-from" aria-label="From"><span>to</span><input type="date" id="u-to" aria-label="To (inclusive)"></span>
<div class="chips" id="u-chips"></div>
<div class="addf"><button type="button" class="btn" id="u-add" aria-haspopup="true" aria-expanded="false">+ Filter</button><div class="menu" id="u-menu" role="menu" hidden></div></div>
</div>
<div class="filters">
<label class="inline">Group by <select id="u-by"></select></label>
<div class="seg" role="group" aria-label="Measure" id="u-metric"></div>
</div>
<div class="facet" id="u-facet" hidden>
<div class="facet-head"><strong id="f-title"></strong><input type="search" id="f-search" placeholder="Search" aria-label="Search values"><button type="button" class="btn" id="f-close">Close</button></div>
<ul id="f-list"></ul>
<div class="row"><button type="button" class="btn primary" id="f-apply">Apply</button><button type="button" class="btn" id="f-clear">Clear filter</button><span class="muted" id="f-note"></span></div>
</div>
<p class="error" id="u-error" hidden></p>
<dl class="tiles" id="u-tiles"></dl>
<div class="panel chart-panel"><div class="chart-head"><h2 id="u-chart-title">Over time</h2><span class="quiet" id="u-window" style="margin:0"></span></div><svg id="u-chart" role="img" aria-label="Usage over time"></svg><div class="tip" id="u-tip" hidden></div><div class="legend" id="u-legend"></div></div>
<div class="scroll"><table id="u-table"><thead><tr></tr></thead><tbody></tbody><tfoot></tfoot></table><p id="u-empty" class="empty" hidden>No AI requests match. Widen the time range or remove a filter.</p></div>
<p class="quiet" id="u-notes"></p>
</section>
<section id="v-branch" hidden>
<nav class="crumbs" id="b-crumbs" aria-label="Breadcrumb"></nav>
<h1 id="b-name"></h1>
<p id="b-where" class="muted"></p>
<dl class="tiles" id="b-tiles"></dl>
<dl class="tiles" id="b-summary"></dl>
<div class="panel"><h2>Models, by tokens</h2><div class="scroll"><table id="b-models"><thead><tr><th scope="col">Model</th><th scope="col">Share of tokens</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Estimate</th><th scope="col" class="num opt">Requests</th></tr></thead><tbody></tbody></table></div></div>
<div class="cols">
<div class="panel"><h2>Chats</h2><div id="b-chats"></div></div>
<div class="panel"><h2>Timeline</h2><pre id="b-timeline"></pre></div>
</div>
<details><summary>Full report, as dft analyze prints it</summary><pre id="b-report"></pre></details>
</section>
<section id="v-setup" hidden>
<div class="stack">
<div class="panel"><h2>Tools</h2><div class="scroll"><table id="s-tools"><thead><tr><th scope="col">Tool</th><th scope="col" class="opt">Installed</th><th scope="col" class="num">Sessions</th><th scope="col">Capture</th><th scope="col" class="opt">Telemetry</th><th scope="col">Last event</th></tr></thead><tbody></tbody></table></div>
<p class="quiet">Capture is the project hooks or extension that <code>dft install</code> writes into a tracked repo. Telemetry is the opt-in OpenTelemetry export from <code>dft install --telemetry</code>.</p></div>
<div class="panel"><h2>Sources</h2><div class="facts" id="s-facts"></div><div class="scroll"><table id="s-sources"><thead><tr><th scope="col">Tool</th><th scope="col" class="num opt">Requests</th><th scope="col" class="num">Disagreements</th><th scope="col">Fields</th></tr></thead><tbody></tbody></table></div>
<p class="quiet">When a tool's session file, hooks and telemetry disagree on a request, dft keeps the most precise source and counts the disagreement here.</p></div>
<div class="panel"><h2>Tracked repos</h2><div id="s-repos"></div>
<div class="row" style="margin-top:12px"><input type="text" id="s-add" placeholder="/path/to/repo" aria-label="Repo folder to track"><button type="button" class="btn" id="s-add-btn">Track</button></div>
</div>
<div class="panel"><h2>Cursor usage import</h2>
<label class="switch"><input type="checkbox" id="s-usage"><span>Import usage from your Cursor account every few minutes</span></label>
<p class="quiet" id="s-usage-note"></p>
</div>
<div class="panel"><h2>Export</h2>
<div class="row"><button type="button" class="btn" id="s-export">Save a static page</button><span class="muted">One HTML file you can keep or share. It loads nothing from the internet.</span></div>
</div>
<div class="panel danger-zone"><h2>Danger zone</h2>
<section><h3>Delete a repo's data</h3>
<div class="row"><select id="d-repo" aria-label="Repo to delete"></select></div>
<p class="plan" id="d-plan"></p>
<div class="row"><input type="text" id="d-confirm" autocomplete="off" aria-label="Confirmation"><button type="button" class="btn danger" id="d-go" disabled>Delete data</button></div>
</section>
<section><h3>Reset the store</h3>
<p class="plan" id="r-plan"></p>
<div class="row"><input type="text" id="r-confirm" autocomplete="off" aria-label="Confirmation"><button type="button" class="btn danger" id="r-go" disabled>Reset store</button></div>
</section>
<section><h3>Restore a backup</h3>
<div class="row"><select id="b-pick" aria-label="Backup to restore"></select></div>
<p class="plan" id="b-plan"></p>
<div class="row"><input type="text" id="b-confirm" autocomplete="off" aria-label="Confirmation"><button type="button" class="btn danger" id="b-go" disabled>Restore</button></div>
</section>
</div>
<p class="quiet" id="s-where"></p>
</div>
</section>
</main>
<footer class="foot"><p>${enterpriseHtml()}</p></footer>
${intro ? INTRO_OVERLAY : ""}<div id="toast" role="status" aria-live="polite"></div>
`;

const INTRO_SCRIPT = `
(function(){
"use strict";
var box=document.getElementById("intro");
if(!box)return;
var video=document.getElementById("intro-video");
var play=document.getElementById("intro-play");
var skip=document.getElementById("intro-skip");
var label=document.getElementById("intro-play-label");
var KEY="dft.intro.seen";
var back=null;
var calm=!!(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);
function seen(){try{return localStorage.getItem(KEY)==="1";}catch(e){return false;}}
function remember(){try{localStorage.setItem(KEY,"1");}catch(e){}}
function onKey(e){if(e.key==="Escape")close();}
function close(){if(box.hidden)return;video.pause();video.autoplay=false;box.hidden=true;document.removeEventListener("keydown",onKey);if(back&&back.focus)back.focus();back=null;}
function start(){play.hidden=true;if(video.ended){try{video.currentTime=0;}catch(e){}}video.autoplay=true;var p=video.play();if(p&&p.catch)p.catch(function(){video.autoplay=false;play.hidden=false;play.focus();});}
function open(){remember();label.textContent="Play";back=document.activeElement;box.hidden=false;document.addEventListener("keydown",onKey);try{video.currentTime=0;}catch(e){}
if(calm){video.autoplay=false;play.hidden=false;play.focus();}else{skip.focus();start();}}
video.addEventListener("ended",function(){label.textContent="Replay";play.hidden=false;play.focus();});
var last=video.querySelector("source:last-of-type");if(last)last.addEventListener("error",close);
skip.addEventListener("click",close);
play.addEventListener("click",start);
box.addEventListener("click",function(e){if(e.target===box)close();});
var again=document.getElementById("nav-intro");if(again)again.addEventListener("click",open);
if(!seen())open();
})();
`;

const labels = () =>
  `var TOOL_LABELS=${JSON.stringify(Object.fromEntries(TOOL_LABELS))};var TOOL_ORDER=${JSON.stringify(TOOL_ORDER)};var DIM_LABELS=${JSON.stringify(DIMENSION_LABELS)};var METRIC_LABELS=${JSON.stringify(METRIC_LABELS)};`;

const SCRIPT = `
const token=document.querySelector('meta[name="dft-token"]').getAttribute("content");
const $=(id)=>document.getElementById(id);
const TZ=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";}catch(e){return "UTC";}})();
const MONEY=new Set(["estimate","toolFigure","billed"]);
const view={updated:0,online:false,usageSeq:0,branchSeq:0,lastHash:null,lastName:null,facet:null,facetRows:[],facetPicked:new Set(),branchRoot:null,branchKey:""};
const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const getJson=(url)=>fetch(url,{headers:{accept:"application/json"}}).then((r)=>r.json().then((j)=>{if(!r.ok)throw new Error(j.error||r.statusText);return j;}));
const post=(body)=>fetch("/api/action",{method:"POST",headers:{"content-type":"application/json","x-dft-token":token},body:JSON.stringify(body)}).then((r)=>r.json().then((j)=>{if(!r.ok)throw new Error(j.error||r.statusText);return j;}));
let toastTimer=0;
function toast(text,bad){const t=$("toast");t.textContent=text;t.className="show"+(bad?" bad":"");clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.className="";},4200);}
function setText(el,text){if(el.textContent!==text){const had=el.textContent!=="";el.textContent=text;if(had){el.classList.remove("flash");void el.offsetWidth;el.classList.add("flash");}}}
function ago(ms){const s=Math.max(0,Math.round(ms/1000));if(s<60)return s+" s ago";const m=Math.round(s/60);if(m<60)return m+" min ago";return Math.round(m/60)+" h ago";}
function tick(){$("live").className="live"+(view.online?"":" off");$("live-text").textContent=view.online?(view.updated?"live, updated "+ago(Date.now()-view.updated):"live"):"offline, retrying";}
setInterval(tick,1000);
function fresh(){view.updated=Date.now();tick();}
function round1(v){const r=Math.round(v*10)/10;return Number.isInteger(r)?String(r):r.toFixed(1);}
function count(v){const a=Math.abs(v);if(a>=1e9)return round1(v/1e9)+"B";if(a>=1e6)return round1(v/1e6)+"M";if(a>=1e4)return Math.round(v/1e3)+"k";if(a>=1e3)return round1(v/1e3)+"k";return String(Math.round(v));}
function usd(v){if(v>0&&v<0.01)return "<$0.01";return v>=1000?"$"+Math.round(v).toLocaleString("en-US"):"$"+v.toFixed(2);}
function fmt(metric,v){if(v===null||v===undefined)return "-";return MONEY.has(metric)?usd(v):count(v);}
function axisFmt(metric,v){if(MONEY.has(metric)){if(Number.isInteger(v))return "$"+count(v);if(v<1)return "$"+v.toFixed(2);if(v<10)return "$"+v.toFixed(1);return "$"+count(v);}return count(v);}
function tail(p,n){return p.replace(/[\\\\/]\\.git$/,"").split(/[\\\\/]/).filter(Boolean).slice(-n).join("/");}
function keyLabel(dim,key){if(key==="(unattributed)")return "(unattributed)";if(key==="(other)")return "Other";if(dim==="tool")return TOOL_LABELS[key]||key;if(dim==="repo")return key==="(no repo)"?key:tail(key,1);if(dim==="worktree")return tail(key,1);if(dim==="session")return key.length>14?key.slice(0,8):key;if(dim==="day"||dim==="week")return dayLabel(key,dim==="week");return key;}
function labelsFor(dim,keys){const short=keys.map((k)=>keyLabel(dim,k));if(dim!=="repo"&&dim!=="worktree")return short;return short.map((l,i)=>short.indexOf(l)===short.lastIndexOf(l)||keys[i]==="(no repo)"?l:tail(keys[i],2));}
const MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function dayLabel(key,week){const m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(key);if(!m)return key;return (week?"week of ":"")+MONTHS[Number(m[2])-1]+" "+Number(m[3]);}
function today(){try{return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}catch(e){return new Date().toISOString().slice(0,10);}}
function route(){return STATE.decode(location.hash);}
function go(r,push){const h=STATE.encode(r);if(h!==location.hash){if(push)history.pushState(null,"",h);else history.replaceState(null,"",h);}show();}
function edit(state){go({name:"usage",state},false);}
function slotOf(dim,key,rank){if(key==="(other)")return "var(--s-other)";if(key==="(unattributed)")return "var(--s-none)";if(dim==="tool"){const i=TOOL_ORDER.indexOf(key);return "var(--s"+((i===-1?6:i)%7+1)+")";}return rank===-1?"var(--s-other)":"var(--s"+(rank%7+1)+")";}

function paintCrumbs(el,items){el.innerHTML=items.map((c,i)=>{const label=c.dimension?'<span class="dim">'+esc(DIM_LABELS[c.dimension]||c.dimension)+'</span> '+esc(keyLabel(c.dimension,c.value)):esc(c.value);if(i===items.length-1)return '<span aria-current="page">'+label+"</span>";return '<a href="'+esc(c.hash)+'">'+label+'</a><span aria-hidden="true">/</span>';}).join(" ");}

const byEl=$("u-by");
byEl.innerHTML=STATE.BY_CHOICES.map((d)=>'<option value="'+d+'">'+esc(DIM_LABELS[d]||d)+"</option>").join("");
byEl.addEventListener("change",()=>{const s=route().state;edit({...s,by:byEl.value});});
$("u-metric").innerHTML=STATE.METRICS.map((m)=>'<button type="button" data-metric="'+m+'">'+esc(METRIC_LABELS[m])+"</button>").join("");
$("u-metric").addEventListener("click",(e)=>{const b=e.target.closest("[data-metric]");if(!b)return;edit({...route().state,metric:b.getAttribute("data-metric")});});
$("u-range").addEventListener("click",(e)=>{const b=e.target.closest("[data-range]");if(!b)return;const s=route().state;const r=b.getAttribute("data-range");if(r==="custom"){const t=today();const from=STATE.addDays(t,-6);edit({...s,since:from,until:STATE.addDays(t,1)});return;}edit({...s,since:r,until:""});});
function customChanged(){const s=route().state;const from=$("u-from").value;const to=$("u-to").value;if(!from)return;edit({...s,since:from,until:to?STATE.addDays(to,1):""});}
$("u-from").addEventListener("change",customChanged);$("u-to").addEventListener("change",customChanged);

function paintControls(s){Array.prototype.forEach.call(document.querySelectorAll("[data-range]"),(b)=>b.setAttribute("aria-pressed",String(b.getAttribute("data-range")===STATE.segment(s))));
const custom=STATE.segment(s)==="custom";$("u-custom").hidden=!custom;if(custom){$("u-from").value=/^\\d{4}-\\d{2}-\\d{2}$/.test(s.since)?s.since:"";$("u-to").value=/^\\d{4}-\\d{2}-\\d{2}$/.test(s.until)?STATE.addDays(s.until,-1):"";}
byEl.value=s.by;
Array.prototype.forEach.call(document.querySelectorAll("[data-metric]"),(b)=>b.setAttribute("aria-pressed",String(b.getAttribute("data-metric")===s.metric)));
const dims=[];s.filters.forEach(([d])=>{if(dims.indexOf(d)===-1)dims.push(d);});
$("u-chips").innerHTML=dims.map((d)=>{const vals=s.filters.filter(([n])=>n===d).map(([,v])=>keyLabel(d,v));const text=vals.length>2?vals.slice(0,2).join(", ")+" +"+(vals.length-2):vals.join(", ");return '<span class="chip"><button type="button" data-edit="'+d+'" title="Change"><b>'+esc(DIM_LABELS[d]||d)+":</b> "+esc(text)+'</button><button type="button" class="x" data-drop="'+d+'" aria-label="Remove '+esc(DIM_LABELS[d]||d)+' filter">\\u2715</button></span>';}).join("");
$("u-menu").innerHTML=STATE.FILTER_DIMENSIONS.map((d)=>'<button type="button" role="menuitem" data-dim="'+d+'">'+esc(DIM_LABELS[d]||d)+"</button>").join("");
paintCrumbs($("u-crumbs"),STATE.crumbs(s));}

$("u-chips").addEventListener("click",(e)=>{const drop=e.target.closest("[data-drop]");if(drop){edit(STATE.withFilter(route().state,drop.getAttribute("data-drop"),[]));return;}const ed=e.target.closest("[data-edit]");if(ed)openFacet(ed.getAttribute("data-edit"));});
function closeMenu(){$("u-menu").hidden=true;$("u-add").setAttribute("aria-expanded","false");}
$("u-add").addEventListener("click",(e)=>{e.stopPropagation();const m=$("u-menu");m.hidden=!m.hidden;$("u-add").setAttribute("aria-expanded",String(!m.hidden));if(!m.hidden){const f=m.querySelector("button");if(f)f.focus();}});
$("u-menu").addEventListener("click",(e)=>{const b=e.target.closest("[data-dim]");if(!b)return;closeMenu();openFacet(b.getAttribute("data-dim"));});
document.addEventListener("click",(e)=>{if(!e.target.closest(".addf"))closeMenu();});
document.addEventListener("keydown",(e)=>{if(e.key==="Escape"){closeMenu();if(!$("u-facet").hidden)closeFacet();}});

function openFacet(dim){const s=route().state;view.facet=dim;view.facetPicked=new Set(s.filters.filter(([n])=>n===dim).map(([,v])=>v));$("f-title").textContent=DIM_LABELS[dim]||dim;$("f-search").value="";$("f-list").innerHTML='<li class="muted" style="padding:8px 4px">Loading</li>';$("f-note").textContent="";$("u-facet").hidden=false;$("f-search").focus();
getJson("/api/usage?"+STATE.facetQuery(s,TZ,dim)).then((out)=>{if(view.facet!==dim)return;const rows=out.groups.slice();if(out.unattributed)rows.push({...out.unattributed,key:"(none)"});view.facetRows=rows;view.facetMetric=s.metric;paintFacet();}).catch((err)=>{$("f-list").innerHTML='<li class="no" style="padding:8px 4px">'+esc(err.message)+"</li>";});}
function paintFacet(){const dim=view.facet;const q=$("f-search").value.trim().toLowerCase();const keys=view.facetRows.map((r)=>r.key);const names=labelsFor(dim,keys);const m=view.facetMetric;
const items=view.facetRows.map((r,i)=>({r,name:r.key==="(none)"?"(none)":names[i]})).filter((x)=>q===""||x.name.toLowerCase().indexOf(q)!==-1||x.r.key.toLowerCase().indexOf(q)!==-1);
$("f-list").innerHTML=items.length?items.map((x)=>'<li><label title="'+esc(x.r.key)+'"><input type="checkbox" data-key="'+esc(x.r.key)+'"'+(view.facetPicked.has(x.r.key)?" checked":"")+'><span class="v">'+esc(x.name)+'</span><span class="n">'+esc(fmt("tokens",x.r.values.tokens))+' tok</span><span class="n">'+esc(fmt(m==="tokens"?"estimate":m,x.r.values[m==="tokens"?"estimate":m]))+"</span></label></li>").join(""):'<li class="muted" style="padding:8px 4px">No values in this window.</li>';
$("f-note").textContent=view.facetPicked.size?view.facetPicked.size+" selected":"";}
$("f-search").addEventListener("input",paintFacet);
$("f-list").addEventListener("change",(e)=>{const k=e.target.getAttribute("data-key");if(k===null)return;if(e.target.checked)view.facetPicked.add(k);else view.facetPicked.delete(k);$("f-note").textContent=view.facetPicked.size?view.facetPicked.size+" selected":"";});
function closeFacet(){$("u-facet").hidden=true;view.facet=null;}
$("f-close").addEventListener("click",closeFacet);
$("f-apply").addEventListener("click",()=>{const dim=view.facet;const vals=Array.from(view.facetPicked);closeFacet();edit(STATE.withFilter(route().state,dim,vals));});
$("f-clear").addEventListener("click",()=>{const dim=view.facet;closeFacet();edit(STATE.withFilter(route().state,dim,[]));});

const TILE_NOTES={estimate:"no priced tokens",toolFigure:"no tool reported a figure",billed:"no bills imported",tokens:"",requests:""};
function ledgerTiles(el,out,metric,clickable){const rows=out.groups.concat(out.other?[out.other]:[]);
const list=STATE.METRICS.map((m)=>{const v=out.total.values[m];const from=rows.filter((r)=>(r.values[m]||0)>0).map((r)=>keyLabel("tool",r.key));let note=from.length?"from "+from.join(", "):TILE_NOTES[m];if(m==="estimate"&&out.coverage.unpriced>0)note+=(note?". ":"")+out.coverage.unpriced+" requests have no price";return{m,label:METRIC_LABELS[m],text:fmt(m,v),note};});
if(el.children.length!==list.length){el.innerHTML=list.map(()=>'<div class="tile"><dt></dt><dd></dd><small></small></div>').join("");}
list.forEach((t,i)=>{const n=el.children[i];setText(n.querySelector("dt"),t.label);setText(n.querySelector("dd"),t.text);n.querySelector("small").textContent=t.note;n.title=t.note;if(clickable){n.setAttribute("role","button");n.setAttribute("tabindex","0");n.setAttribute("data-metric-tile",t.m);n.setAttribute("aria-pressed",String(t.m===metric));}});}
$("u-tiles").addEventListener("click",(e)=>{const t=e.target.closest("[data-metric-tile]");if(t)edit({...route().state,metric:t.getAttribute("data-metric-tile")});});
$("u-tiles").addEventListener("keydown",(e)=>{if(e.key!=="Enter"&&e.key!==" ")return;const t=e.target.closest("[data-metric-tile]");if(t){e.preventDefault();edit({...route().state,metric:t.getAttribute("data-metric-tile")});}});

function bucketsFor(s,series,bucket){const have=series.map((p)=>p.bucket);if(bucket!=="day"||!have.every((b)=>/^\\d{4}-\\d{2}-\\d{2}$/.test(b)))return have;let start=null;let end=null;const t=today();
if(s.since==="7d"){start=STATE.addDays(t,-6);end=t;}else if(s.since==="30d"){start=STATE.addDays(t,-29);end=t;}else if(/^\\d{4}-\\d{2}-\\d{2}$/.test(s.since)){start=s.since;end=/^\\d{4}-\\d{2}-\\d{2}$/.test(s.until)?STATE.addDays(s.until,-1):t;}
if(start===null)return have;const out=[];let d=start;let guard=0;while(d<=end&&guard<400){out.push(d);d=STATE.addDays(d,1);guard+=1;}have.forEach((b)=>{if(out.indexOf(b)===-1)out.push(b);});return out.sort();}
function niceStep(v){if(v<=0)return 1;const p=Math.pow(10,Math.floor(Math.log10(v)));const n=v/p;return (n<=1?1:n<=2?2:n<=5?5:10)*p;}
let chartData=null;
function paintChart(s,out){const svg=$("u-chart");const metric=s.metric;const stackDim=out.stackBy;const bucket=out.bucket;
const totals=new Map();out.series.forEach((p)=>p.stacks.forEach((k)=>{if(k.key==="(other)"||k.key==="(unattributed)")return;totals.set(k.key,(totals.get(k.key)||0)+(k.values[metric]||0));}));
const order=Array.from(totals.keys()).sort((a,b)=>totals.get(b)-totals.get(a));const extra=["(other)","(unattributed)"].filter((k)=>out.series.some((p)=>p.stacks.some((x)=>x.key===k)));const keys=order.concat(extra);
const colors=new Map(keys.map((k)=>[k,slotOf(stackDim,k,order.indexOf(k))]));const names=new Map();const nm=labelsFor(stackDim,keys);keys.forEach((k,i)=>names.set(k,k==="(other)"?"Other":nm[i]));
const buckets=bucketsFor(s,out.series,bucket);const byBucket=new Map(out.series.map((p)=>[p.bucket,p]));
const W=Math.max(280,svg.clientWidth||600);const H=220;const L=48;const R=8;const T=10;const B=24;const pw=W-L-R;const ph=H-T-B;
const sums=buckets.map((b)=>{const p=byBucket.get(b);return p?p.stacks.reduce((a,k)=>a+(k.values[metric]||0),0):0;});
const top=Math.max(0,...sums);const step=niceStep(top/4);const ticks=Math.max(1,Math.ceil(top/step));const max=step*ticks;const band=pw/Math.max(1,buckets.length);const bw=Math.max(2,Math.min(32,band*0.7));
const parts=[];for(let i=0;i<=ticks;i++){const v=step*i;const y=T+ph-ph*i/ticks;parts.push('<line class="'+(i===0?"base":"grid")+'" x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'"/>');parts.push('<text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end">'+esc(axisFmt(metric,v))+"</text>");}
const every=Math.max(1,Math.ceil(buckets.length/Math.max(1,Math.floor(pw/64))));
buckets.forEach((b,i)=>{parts.push('<rect class="band" data-band="'+i+'" x="'+(L+band*i).toFixed(1)+'" y="'+T+'" width="'+band.toFixed(1)+'" height="'+ph+'"/>');});
buckets.forEach((b,i)=>{const p=byBucket.get(b);const x=L+band*i+(band-bw)/2;let y=T+ph;if(p){const ordered=keys.map((k)=>p.stacks.find((x2)=>x2.key===k)).filter(Boolean);ordered.forEach((k)=>{const v=k.values[metric]||0;if(v<=0)return;const h=ph*v/max;y-=h;parts.push('<rect class="seg" x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0.5,h).toFixed(1)+'" rx="2" style="fill:'+colors.get(k.key)+'"/>');});}
if(i%every===0)parts.push('<text x="'+(L+band*i+band/2).toFixed(1)+'" y="'+(H-6)+'" text-anchor="middle">'+esc(keyLabel(bucket,b).replace("week of ",""))+"</text>");
parts.push('<rect class="hit" data-i="'+i+'" x="'+(L+band*i).toFixed(1)+'" y="'+T+'" width="'+band.toFixed(1)+'" height="'+ph+'"/>');});
svg.setAttribute("viewBox","0 0 "+W+" "+H);svg.innerHTML=parts.join("");
chartData={buckets,byBucket,keys,colors,names,metric,bucket,s};
$("u-legend").innerHTML=keys.length>1||(keys.length===1&&stackDim)?keys.map((k)=>'<span><i class="sw" style="background:'+colors.get(k)+'"></i>'+esc(names.get(k))+"</span>").join(""):"";
$("u-chart-title").textContent=METRIC_LABELS[metric]+" per "+bucket+(stackDim?", by "+(DIM_LABELS[stackDim]||stackDim).toLowerCase()+(stackDim==="tool"?"":", top 6"):"");
svg.setAttribute("aria-label",$("u-chart-title").textContent);}
function bandOn(i){Array.prototype.forEach.call($("u-chart").querySelectorAll("rect.band"),(r)=>r.classList.toggle("on",Number(r.getAttribute("data-band"))===i));}
function tipAt(i,clientX){const d=chartData;if(!d)return;bandOn(i);const b=d.buckets[i];const p=d.byBucket.get(b);const tip=$("u-tip");const rows=p?d.keys.map((k)=>p.stacks.find((x)=>x.key===k)).filter((k)=>k&&(k.values[d.metric]||0)>0):[];
const total=rows.reduce((a,k)=>a+(k.values[d.metric]||0),0);
tip.innerHTML="<strong>"+esc(keyLabel(d.bucket,b))+"</strong>"+(rows.length?rows.map((k)=>'<div><span><i class="sw" style="background:'+d.colors.get(k.key)+'"></i>'+esc(d.names.get(k.key))+"</span><span>"+esc(fmt(d.metric,k.values[d.metric]))+"</span></div>").join("")+(rows.length>1?"<div><span>Total</span><span>"+esc(fmt(d.metric,total))+"</span></div>":""):'<div class="muted">No requests</div>');
tip.hidden=false;const panel=tip.parentNode.getBoundingClientRect();const w=tip.offsetWidth;let x=clientX-panel.left+14;if(x+w>panel.width-8)x=clientX-panel.left-w-14;tip.style.left=Math.max(8,x)+"px";tip.style.top="44px";}
$("u-chart").addEventListener("mousemove",(e)=>{const h=e.target.closest("rect.hit");if(!h){$("u-tip").hidden=true;bandOn(-1);return;}tipAt(Number(h.getAttribute("data-i")),e.clientX);});
$("u-chart").addEventListener("mouseleave",()=>{$("u-tip").hidden=true;bandOn(-1);});
$("u-chart").addEventListener("click",(e)=>{const h=e.target.closest("rect.hit");if(!h||!chartData)return;const b=chartData.buckets[Number(h.getAttribute("data-i"))];const next=STATE.drill({...chartData.s,by:chartData.bucket},b);if(next){next.state={...next.state,by:chartData.s.by==="day"||chartData.s.by==="week"?"tool":chartData.s.by};go(next,true);}});

const COLS=["tokens","requests","sessions","estimate","toolFigure","billed"];
function branchHref(s,repo,branch){return STATE.encode({name:"branch",repo,branch,state:s});}
function paintTable(s,out,chartOut){const metric=s.metric;const dim=out.groupBy;const head=$("u-table").tHead.rows[0];
head.innerHTML='<th scope="col">'+esc(DIM_LABELS[dim]||dim)+'</th><th scope="col">Share of '+esc(METRIC_LABELS[metric].toLowerCase())+"</th>"+COLS.map((c)=>'<th scope="col" class="num'+(c===metric?" on":"")+(c!==metric?" opt":"")+'">'+esc(METRIC_LABELS[c])+"</th>").join("");
const groups=out.groups;const keys=groups.map((g)=>g.key);const names=labelsFor(dim,keys);const total=out.total.values[metric]||0;
const chartKeys=chartOut&&chartOut.stackBy===dim?(()=>{const t=new Map();chartOut.series.forEach((p)=>p.stacks.forEach((k)=>{if(k.key!=="(other)"&&k.key!=="(unattributed)")t.set(k.key,(t.get(k.key)||0)+(k.values[metric]||0));}));return Array.from(t.keys()).sort((a,b)=>t.get(b)-t.get(a));})():null;
const repos=s.filters.filter(([n])=>n==="repo").map(([,v])=>v);
const row=(g,name,cls)=>{const v=g.values[metric];const pct=total>0&&v!==null&&v!==undefined?v/total:null;const drill=cls===""&&STATE.drill(s,g.key)!==null;
const color=chartKeys?slotOf(dim,g.key,chartKeys.indexOf(g.key)):dim==="tool"?slotOf("tool",g.key,0):null;
let label=esc(name);if(dim==="branch"&&repos.length===1&&cls==="")label='<a href="'+esc(branchHref(s,repos[0],g.key))+'" title="Open this branch">'+esc(name)+"</a>";
return '<tr data-key="'+esc(g.key)+'" class="'+cls+(drill?" drill":"")+'"'+(drill?' tabindex="0"':"")+' title="'+esc(g.key)+'"><td class="label">'+(color?'<i class="sw" style="background:'+color+'"></i>':"")+label+'</td><td class="share">'+(pct===null?"":'<div class="share-bar"><i style="width:'+Math.max(1,Math.round(pct*100))+'%'+(color?";background:"+color:"")+'"></i><span>'+(pct<0.01&&pct>0?"<1":Math.round(pct*100))+"%</span></div>")+"</td>"+COLS.map((c)=>'<td class="num'+(c===metric?" on":"")+(c!==metric?" opt":"")+'">'+esc(fmt(c,g.values[c]))+"</td>").join("")+"</tr>";};
const rows=groups.map((g,i)=>row(g,names[i],""));if(out.other)rows.push(row(out.other,"Other ("+out.other.groups+")","pinned"));if(out.unattributed)rows.push(row(out.unattributed,"(unattributed)","pinned"));
$("u-table").tBodies[0].innerHTML=rows.join("");
$("u-table").tFoot.innerHTML=out.total.facts?'<tr><td>Total</td><td></td>'+COLS.map((c)=>'<td class="num'+(c===metric?" on":"")+(c!==metric?" opt":"")+'">'+esc(fmt(c,out.total.values[c]))+"</td>").join("")+"</tr>":"";
$("u-empty").hidden=out.total.facts!==0;$("u-table").hidden=out.total.facts===0;}
function rowDrill(tr){const s=route().state;const next=STATE.drill(s,tr.getAttribute("data-key"));if(next)go(next,true);}
$("u-table").tBodies[0].addEventListener("click",(e)=>{if(e.target.closest("a"))return;const tr=e.target.closest("tr.drill");if(tr)rowDrill(tr);});
$("u-table").tBodies[0].addEventListener("keydown",(e)=>{if(e.key!=="Enter")return;const tr=e.target.closest("tr.drill");if(tr){e.preventDefault();rowDrill(tr);}});

function dayIn(ms,tz){try{return new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ms));}catch(e){return new Date(ms).toISOString().slice(0,10);}}
function windowText(out){const w=out.window;if(!w.since&&!w.until)return "All time, "+w.tz;const from=w.since?dayLabel(dayIn(Date.parse(w.since),w.tz),false):"start";const to=w.until?dayLabel(dayIn(Date.parse(w.until)-1,w.tz),false):"now";return from+" to "+to+", "+w.tz;}
function loadUsage(){const r=route();const s=r.state;const seq=++view.usageSeq;
Promise.all([getJson("/api/usage?"+STATE.tableQuery(s,TZ)),getJson("/api/usage?"+STATE.chartQuery(s,TZ)),getJson("/api/usage?"+STATE.toolsQuery(s,TZ))]).then(([table,chart,tools])=>{if(seq!==view.usageSeq)return;$("u-error").hidden=true;
ledgerTiles($("u-tiles"),tools,s.metric,true);paintChart(s,chart);paintTable(s,table,chart);$("u-window").textContent=windowText(table);
const notes=table.notes.slice(0,1);$("u-notes").textContent=notes.join(" ");fresh();}).catch((e)=>{if(seq!==view.usageSeq)return;$("u-error").textContent=e.message;$("u-error").hidden=false;});}
window.addEventListener("resize",()=>{if(chartData&&route().name==="usage"){clearTimeout(view.rz);view.rz=setTimeout(loadUsage,150);}});

function loadBranch(){const r=route();const seq=++view.branchSeq;const s=r.state;const q=new URLSearchParams(STATE.toolsQuery(s,TZ));q.delete("groupBy");q.delete("metrics");q.delete("sortBy");q.delete("limit");q.set("repo",r.repo);q.set("branch",r.branch);q.set("since",s.since);
const key=r.repo+"\\n"+r.branch;if(key!==view.branchKey){$("b-tiles").innerHTML="";$("b-summary").innerHTML="";$("b-models").tBodies[0].innerHTML="";$("b-chats").innerHTML='<p class="muted">Loading</p>';$("b-chats").removeAttribute("data-html");$("b-name").textContent=r.branch;$("b-where").textContent="";view.branchKey=key;}
paintCrumbs($("b-crumbs"),[{dimension:null,value:"All usage",hash:STATE.encode({name:"usage",state:{...s,by:"tool"}})},{dimension:"repo",value:r.repo,hash:STATE.encode({name:"usage",state:{...STATE.withFilter(s,"repo",[r.repo]),by:"branch"}})},{dimension:"branch",value:r.branch,hash:""}]);
getJson("/api/branch?"+q.toString()).then((res)=>{if(seq!==view.branchSeq)return;const v=res.view;view.branchRoot=v.repoRoot;setText($("b-name"),v.branch);$("b-where").textContent=v.worktrees.length?v.worktrees.join(", "):"";
ledgerTiles($("b-tiles"),v.usage.tools,s.metric,false);
const sum=$("b-summary");if(sum.children.length!==v.summary.length)sum.innerHTML=v.summary.map(()=>'<div class="tile"><dt></dt><dd></dd><small></small></div>').join("");v.summary.forEach((t,i)=>{const n=sum.children[i];setText(n.querySelector("dt"),t.label);setText(n.querySelector("dd"),t.text);});
const m=v.usage.models;const tot=m.total.values.tokens||0;const keys=m.groups.map((g)=>g.key);const mrow=(g,name)=>{const t=g.values.tokens;const pct=tot>0&&t?t/tot:null;return "<tr><td class=\\"label\\">"+esc(name)+"</td><td class=\\"share\\">"+(pct===null?"":"<div class=\\"share-bar\\"><i style=\\"width:"+Math.max(1,Math.round(pct*100))+"%\\"></i><span>"+(pct<0.01?"<1":Math.round(pct*100))+"%</span></div>")+"</td><td class=\\"num\\">"+esc(fmt("tokens",t))+"</td><td class=\\"num\\">"+esc(fmt("estimate",g.values.estimate))+"</td><td class=\\"num opt\\">"+esc(fmt("requests",g.values.requests))+"</td></tr>";};
const mrows=m.groups.map((g,i)=>mrow(g,keys[i]));if(m.other)mrows.push(mrow(m.other,"Other ("+m.other.groups+")"));if(m.unattributed&&(m.unattributed.values.tokens||m.unattributed.values.requests))mrows.push(mrow(m.unattributed,"(no model)"));
$("b-models").tBodies[0].innerHTML=mrows.length?mrows.join(""):'<tr><td colspan="5" class="muted">No AI requests on this branch in this time range.</td></tr>';
if($("b-chats").getAttribute("data-html")!==v.chats){$("b-chats").innerHTML=v.chats;$("b-chats").setAttribute("data-html",v.chats);}setText($("b-timeline"),v.timeline);setText($("b-report"),v.report);document.title="dft, "+v.branch;fresh();}).catch((e)=>{if(seq!==view.branchSeq)return;$("b-name").textContent=r.branch;$("b-where").textContent=e.message;$("b-tiles").innerHTML="";$("b-summary").innerHTML="";$("b-models").tBodies[0].innerHTML="";$("b-chats").innerHTML="";$("b-timeline").textContent="";});}

function planWords(t){const parts=[];const add=(n,one,many)=>{if(n>0)parts.push(n.toLocaleString("en-US")+" "+(n===1?one:many));};add(t.events,"event","events");add(t.commitSnapshots,"commit snapshot","commit snapshots");add(t.storeSnapshots,"stored report","stored reports");add(t.spoolFiles,"hook file waiting to import","hook files waiting to import");add(t.coverage,"source record","source records");return parts.length?parts.join(", "):"nothing";}
function confirmBox(input,button,text){input.value="";input.placeholder=text?"type "+text:"";input.setAttribute("data-want",text||"");button.disabled=true;}
[["d-confirm","d-go"],["r-confirm","r-go"],["b-confirm","b-go"]].forEach((p)=>{$(p[0]).addEventListener("input",function(){const want=this.getAttribute("data-want");$(p[1]).disabled=!want||this.value!==want;});});
function loadDeletePlan(){const repo=$("d-repo").value;if(!repo){$("d-plan").textContent="No tracked repos.";confirmBox($("d-confirm"),$("d-go"),"");return;}getJson("/api/plan?kind=delete&repo="+encodeURIComponent(repo)).then((p)=>{$("d-plan").innerHTML="Removes "+esc(planWords(p.totals))+" from "+p.branches+" branch"+(p.branches===1?"":"es")+". dft saves a backup first, so you can restore it below. Type <code>"+esc(p.confirmText)+"</code> to confirm.";confirmBox($("d-confirm"),$("d-go"),p.confirmText);}).catch((e)=>{$("d-plan").textContent=e.message;});}
function loadResetPlan(){getJson("/api/plan?kind=reset").then((p)=>{$("r-plan").innerHTML="Removes "+esc(planWords(p.totals))+" from "+p.repos+" repo"+(p.repos===1?"":"s")+". Tracked repos stay tracked. dft saves a backup first, so you can restore it below. Type <code>"+esc(p.confirmText)+"</code> to confirm.";confirmBox($("r-confirm"),$("r-go"),p.confirmText);}).catch((e)=>{$("r-plan").textContent=e.message;});}
function paintBackupPlan(){const id=$("b-pick").value;$("b-pick").parentNode.hidden=!id;$("b-confirm").parentNode.hidden=!id;if(!id){$("b-plan").textContent="No backups yet. dft saves one before every delete, reset or restore.";confirmBox($("b-confirm"),$("b-go"),"");return;}$("b-plan").innerHTML="Replaces the current data with this backup. dft backs up the current data first, so you can undo it. Type <code>restore</code> to confirm.";confirmBox($("b-confirm"),$("b-go"),"restore");}
$("d-repo").addEventListener("change",loadDeletePlan);
$("b-pick").addEventListener("change",paintBackupPlan);
function syncSelect(sel,items){const want=items.map((i)=>i.value+"\\t"+i.text).join("\\n");if(sel.getAttribute("data-list")===want)return false;const keep=sel.value;sel.innerHTML=items.map((i)=>'<option value="'+esc(i.value)+'">'+esc(i.text)+"</option>").join("");sel.setAttribute("data-list",want);if(items.some((i)=>i.value===keep))sel.value=keep;return true;}
function repoHtml(r){const src=r.sources.length?'<ul class="list">'+r.sources.map((s)=>'<li><span class="'+(s.ok?"ok":"no")+'">'+(s.ok?"\\u2713":"\\u25CB")+"</span><span>"+esc(s.label)+'</span><span class="muted">'+esc(s.note)+"</span></li>").join("")+"</ul>":'<p class="muted">Sources show up after the first sync.</p>';
return '<div class="repo"><div class="head"><strong>'+esc(r.name)+'</strong><span class="muted">'+esc(r.lastSync)+"</span>"+(r.hooks?'<span class="tag">Cursor hooks installed</span>':'<button type="button" class="btn" data-hooks="'+esc(r.root)+'">Install Cursor hooks</button>')+'<button type="button" class="btn" data-untrack="'+esc(r.root)+'">Stop tracking</button></div><div class="path">'+esc(r.root)+"</div>"+(r.error?'<p class="no">'+esc(r.error)+"</p>":"")+src+"</div>";}
function mark(v,yes,no){return v===null?'<span class="no">n/a</span>':v?'<span class="ok">\\u2713 '+esc(yes)+"</span>":'<span class="no">'+esc(no)+"</span>";}
function toolsHtml(tools){return tools.map((t)=>"<tr><td><strong>"+esc(t.name)+"</strong></td><td class=opt>"+mark(t.installed,"yes","not found")+'</td><td class="num">'+esc(count(t.sessions))+"</td><td>"+(t.capture.length?'<span class="ok">\\u2713 '+esc(t.capture.join(", "))+"</span>":'<span class="no">not set up</span>')+"</td><td class=opt>"+mark(t.telemetry,"on","off")+"</td><td>"+(t.lastEvent?esc(t.lastEvent):'<span class="no">never</span>')+"</td></tr>").join("");}
function sourcesHtml(src){if(!src.tools.length)return '<tr><td colspan="4" class="muted">No AI requests stored yet.</td></tr>';return src.tools.map((t)=>"<tr><td><strong>"+esc(t.name)+'</strong></td><td class="num opt">'+esc(count(t.requests))+'</td><td class="num">'+(t.disagreements?'<span class="warn">'+esc(count(t.disagreements))+"</span>":'<span class="ok">0</span>')+"</td><td>"+(t.fields.length?esc(t.fields.map((f)=>f.field+" "+count(f.count)).join(", ")):'<span class="no">all sources agree</span>')+"</td></tr>").join("");}
function loadSetup(){return getJson("/api/setup").then((s)=>{const html=s.repos.length?s.repos.map(repoHtml).join(""):'<p class="muted">No repos tracked. Add one below.</p>';if($("s-repos").getAttribute("data-html")!==html){$("s-repos").innerHTML=html;$("s-repos").setAttribute("data-html",html);}
$("s-tools").tBodies[0].innerHTML=toolsHtml(s.tools);
const src=s.sources;$("s-facts").innerHTML="<span><b>"+esc(count(src.facts))+"</b> requests</span><span><b>"+esc(count(src.matched))+"</b> joined across sources</span><span><b>"+esc(count(src.unresolved))+"</b> left out as unmatched</span><span><b>"+esc(count(src.unpriced))+"</b> without a price</span>"+(src.derivedAt?"<span>rebuilt "+esc(src.derivedAt)+"</span>":"");
$("s-sources").tBodies[0].innerHTML=sourcesHtml(src);
$("s-usage").checked=s.usage.enabled;$("s-usage-note").textContent=s.usage.enabled?s.usage.note:"Off. Turn it on to see what your Cursor account billed.";
if(syncSelect($("d-repo"),s.repos.map((r)=>({value:r.root,text:r.name+"  "+r.root}))))loadDeletePlan();
if(syncSelect($("b-pick"),s.backups.map((b)=>({value:b.id,text:b.text}))))paintBackupPlan();
$("s-where").textContent="Data folder "+s.dftHome+". Store "+s.store+".";fresh();}).catch((e)=>{toast(e.message,true);});}
function act(body,button){if(button)button.disabled=true;return post(body).then((r)=>{toast(r.message,false);return true;}).catch((e)=>{toast(e.message,true);return false;}).then((ok)=>{if(button)button.disabled=false;loadSetup();return ok;});}
$("s-repos").addEventListener("click",(e)=>{const b=e.target.closest("button");if(!b)return;if(b.hasAttribute("data-hooks"))act({action:"hooks",path:b.getAttribute("data-hooks")},b);if(b.hasAttribute("data-untrack"))act({action:"untrack",path:b.getAttribute("data-untrack")},b);});
$("s-add-btn").addEventListener("click",function(){const v=$("s-add").value.trim();if(!v)return;act({action:"track",path:v},this).then((ok)=>{if(ok)$("s-add").value="";});});
$("s-usage").addEventListener("change",function(){act({action:"usage",enabled:this.checked},null);});
$("s-export").addEventListener("click",function(){act({action:"export"},this);});
$("d-go").addEventListener("click",function(){act({action:"delete",path:$("d-repo").value,confirm:$("d-confirm").value},this).then(()=>{$("d-repo").removeAttribute("data-list");loadDeletePlan();loadResetPlan();});});
$("r-go").addEventListener("click",function(){act({action:"reset",confirm:$("r-confirm").value},this).then(()=>{loadResetPlan();loadDeletePlan();});});
$("b-go").addEventListener("click",function(){act({action:"restore",id:$("b-pick").value},this).then(()=>{loadResetPlan();loadDeletePlan();});});

function show(){const r=route();const h=location.hash;if(h===view.lastHash)return;const moved=r.name!==view.lastName;view.lastHash=h;view.lastName=r.name;if(moved)window.scrollTo(0,0);
["usage","branch","setup"].forEach((n)=>{$("v-"+n).hidden=n!==r.name;});
Array.prototype.forEach.call(document.querySelectorAll("[data-nav]"),(a)=>{const on=a.getAttribute("data-nav")===(r.name==="branch"?"usage":r.name);if(on)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");a.setAttribute("href",STATE.encode({name:a.getAttribute("data-nav"),state:r.state}));});
if(r.name==="usage"){document.title="dft, usage";if(view.facet&&moved)closeFacet();paintControls(r.state);loadUsage();}else if(r.name==="branch"){document.title="dft, "+r.branch;loadBranch();}else{document.title="dft, setup";loadSetup();loadResetPlan();}}
window.addEventListener("hashchange",show);
window.addEventListener("popstate",show);
let queue=[];let flushTimer=0;
function refresh(){const r=route();if(r.name==="usage"){loadUsage();return;}if(r.name==="setup"){loadSetup();loadResetPlan();return;}loadBranch();}
function flush(){const changes=queue;queue=[];const r=route();if(r.name!=="branch"){refresh();return;}
const wide=changes.some((c)=>c.reason!=="sync");const mine=changes.some((c)=>c.repo===view.branchRoot&&(c.branches.length===0||c.branches.indexOf(r.branch)!==-1));if(wide||mine)loadBranch();}
let dropped=false;
function connect(){const es=new EventSource("/events");es.addEventListener("change",(e)=>{try{queue.push(JSON.parse(e.data));}catch(err){return;}clearTimeout(flushTimer);flushTimer=setTimeout(flush,250);});es.onerror=()=>{view.online=false;dropped=true;tick();};es.onopen=()=>{view.online=true;tick();if(dropped){dropped=false;refresh();}};}
show();connect();
`;

export interface LivePageOptions {
  readonly intro?: boolean;
}

export const liveDashboardPage = (
  token: string,
  options: LivePageOptions = {}
): string =>
  [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#0b0b0c" media="(prefers-color-scheme: dark)">',
    '<meta name="referrer" content="no-referrer">',
    `<meta name="dft-token" content="${token}">`,
    '<link rel="icon" href="data:,">',
    "<title>dft, usage</title>",
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body(options.intro === true),
    `<script>(function(){"use strict";${dashboardStateScript()}${labels()}${SCRIPT}})();</script>`,
    ...(options.intro === true ? [`<script>${INTRO_SCRIPT}</script>`] : []),
    "</body>",
    "</html>",
    "",
  ].join("\n");
