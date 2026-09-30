import { enterpriseHtml } from "./dft-render.js";
import { VERSION } from "./version.js";

const STYLE = `
:root{color-scheme:dark;--bg:#0b0b0c;--surface:#151517;--raised:#1c1c1f;--text:#f4f4f5;--muted:#a1a1aa;--faint:#71717a;--line:rgb(255 255 255 / .09);--ring:rgb(255 255 255 / .07);--accent:#f0b44c;--on-accent:#0b0b0c;--bad:#f87171;--good:#86efac;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--gutter:16px;--radius:10px}
@media (min-width:640px){:root{--gutter:24px}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:400 14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;overflow-x:hidden}
a{color:inherit}
button,input,select{font:inherit;color:inherit}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:16px;padding:10px var(--gutter);background:rgb(11 11 12 / .92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font:600 15px/1 var(--mono);text-decoration:none}
.brand svg{width:22px;height:22px}
nav{display:flex;gap:4px}
nav a,nav button{padding:6px 10px;border:0;border-radius:6px;background:none;font:inherit;text-decoration:none;color:var(--muted);cursor:pointer}
nav button:hover{color:var(--text)}
nav a[aria-current=page]{color:var(--text);background:var(--surface)}
.live{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--faint);font-size:12px;white-space:nowrap}
.live i{width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px rgb(134 239 172 / .12)}
.live.off i{background:var(--faint);box-shadow:none}
main{max-width:1400px;margin:0 auto;padding:20px var(--gutter) 48px}
h1{font-size:20px;line-height:1.3;margin:0 0 4px;overflow-wrap:anywhere}
h2{font-size:13px;font-weight:600;color:var(--muted);margin:0 0 10px;text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}
.quiet{color:var(--faint);font-size:13px;margin:12px 2px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:0 0 16px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;min-width:0}
.tile dt{color:var(--muted);font-size:12px}
.tile dd{margin:2px 0 0;font-size:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile small{display:block;color:var(--faint);font-size:11px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:16px}
@media (max-width:480px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.tile dd{font-size:17px}}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
select,input[type=text]{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px 10px;min-width:0}
select{max-width:100%}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.seg button{background:transparent;border:0;padding:6px 12px;color:var(--muted);cursor:pointer}
.seg button[aria-pressed=true]{background:var(--raised);color:var(--text)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
table{border-collapse:collapse;width:100%}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
th{font-size:12px;color:var(--muted);font-weight:500}
th button{all:unset;cursor:pointer}
th[aria-sort=ascending] button::after{content:" \\2191"}
th[aria-sort=descending] button::after{content:" \\2193"}
.num{text-align:right}
td.branch a{font-weight:600;text-decoration:none;display:inline-block;max-width:280px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
td.branch a:hover{color:var(--accent)}
tbody tr{cursor:pointer}
tbody tr:hover{background:var(--raised)}
.tag{font-size:11px;color:var(--accent);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.flash{animation:flash 1.6s ease-out}
@keyframes flash{from{color:var(--accent)}to{color:inherit}}
.empty{padding:28px;text-align:center;color:var(--muted)}
.crumb{margin:0 0 8px;color:var(--muted);font-size:13px}
.crumb a{text-decoration:none;color:var(--muted)}
.crumb a:hover{color:var(--text)}
.cols{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
@media (min-width:900px){.cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;min-width:0}
pre{margin:0;font:12px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}
details{margin-top:16px}
summary{cursor:pointer;color:var(--muted)}
details pre{margin-top:10px}
ul.chats,ul.chats ul{list-style:none;margin:0;padding:0}
ul.chats ul{margin-left:14px;border-left:2px solid var(--line);padding-left:12px}
ul.chats li{padding:6px 0}
.chat-title{font-weight:600;overflow-wrap:anywhere}
.models{font-size:12px;color:var(--accent)}
.stack{display:grid;gap:16px}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;gap:10px;align-items:baseline;padding:5px 0;flex-wrap:wrap}
.ok{color:var(--good)}
.no{color:var(--faint)}
.repo{border-top:1px solid var(--line);padding:12px 0}
.repo:first-of-type{border-top:0;padding-top:0}
.repo .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.repo .path{font:12px var(--mono);color:var(--faint);overflow-wrap:anywhere}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row input[type=text]{flex:1 1 220px}
.btn{background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent);font-weight:600}
.btn.danger{border-color:rgb(248 113 113 / .5);color:var(--bad)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.danger-zone{border-color:rgb(248 113 113 / .35)}
.danger-zone h3{font-size:14px;margin:0 0 6px}
.danger-zone section{border-top:1px solid var(--line);padding:14px 0}
.danger-zone section:first-of-type{border-top:0;padding-top:0}
.plan{margin:8px 0;color:var(--muted);min-height:21px}
code{font:12px var(--mono);background:var(--raised);padding:1px 5px;border-radius:4px}
label.switch{display:flex;gap:10px;align-items:center;cursor:pointer}
.foot{max-width:1400px;margin:0 auto;padding:0 var(--gutter) 32px;color:var(--faint);font-size:12px}
.foot p{margin:0}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100% - 32px);background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:8px 14px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
#toast.bad{color:var(--bad)}
.intro{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:var(--gutter);background:rgb(5 5 6 / .84);backdrop-filter:blur(6px)}
.intro-box{position:relative;width:min(960px,100%);aspect-ratio:16/9;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--bg);box-shadow:0 24px 80px rgb(0 0 0 / .6)}
.intro-box video{display:block;width:100%;height:100%;object-fit:cover}
.intro-skip{position:absolute;right:12px;bottom:12px;background:rgb(28 28 31 / .88)}
.intro-play{position:absolute;left:12px;bottom:12px;display:flex;align-items:center;gap:6px;border:0;border-radius:6px;padding:6px 14px 6px 10px;background:var(--accent);color:var(--on-accent);font-weight:600;cursor:pointer}
.intro-play svg{width:16px;height:16px}
.intro-play:focus-visible,.intro-skip:focus-visible,nav button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

const introFile = (name: string) =>
  `/intro/${name}?v=${encodeURIComponent(VERSION)}`;

const INTRO_NAV = `<button type="button" id="nav-intro">Intro</button>`;

const INTRO_OVERLAY = `<div id="intro" class="intro" role="dialog" aria-modal="true" aria-label="dft intro" hidden>
<div class="intro-box">
<video id="intro-video" muted playsinline preload="none" poster="${introFile("dft-intro-poster.png")}"><source src="${introFile("dft-intro.webm")}" type="video/webm"><source src="${introFile("dft-intro.mp4")}" type="video/mp4"></video>
<button type="button" class="intro-play" id="intro-play" aria-label="Play intro" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>Play</button>
<button type="button" class="btn intro-skip" id="intro-skip">Skip</button>
</div>
</div>
`;

const body = (intro: boolean) => `
<header class="bar">
<a class="brand" href="#/"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#151517"/><path d="M11 7v18M11 12c0 5 10 3 10 9" fill="none" stroke="#f0b44c" stroke-width="3" stroke-linecap="round"/><circle cx="21" cy="22" r="3" fill="#f0b44c"/></svg>dft</a>
<nav><a href="#/" data-nav="branches">Branches</a><a href="#/setup" data-nav="setup">Setup</a>${intro ? INTRO_NAV : ""}</nav>
<span id="live" class="live off" aria-live="off"><i></i><span id="live-text">connecting</span></span>
</header>
<main>
<section id="v-branches">
<dl class="tiles" id="totals"></dl>
<div class="tools">
<select id="repo-filter" aria-label="Repo"><option value="">All repos</option></select>
<div class="seg" role="group" aria-label="Time range"><button type="button" data-since="7d">7 days</button><button type="button" data-since="30d">30 days</button><button type="button" data-since="all">All time</button></div>
</div>
<div class="scroll"><table id="table"><thead><tr></tr></thead><tbody></tbody></table><p id="empty" class="empty" hidden>No branches with activity in this time range.</p></div>
<p id="account" class="quiet" hidden></p>
</section>
<section id="v-branch" hidden>
<p class="crumb"><a href="#/">Branches</a> / <span id="b-repo"></span></p>
<h1 id="b-name"></h1>
<p id="b-where" class="muted"></p>
<dl class="tiles" id="b-tiles"></dl>
<div class="cols">
<div class="panel"><h2>Chats</h2><div id="b-chats"></div></div>
<div class="panel"><h2>Timeline</h2><pre id="b-timeline"></pre></div>
</div>
<details><summary>Full report, as dft analyze prints it</summary><pre id="b-report"></pre></details>
</section>
<section id="v-setup" hidden>
<div class="stack">
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
var KEY="dft.intro.seen";
var back=null;
var calm=!!(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);
function seen(){try{return localStorage.getItem(KEY)==="1";}catch(e){return false;}}
function remember(){try{localStorage.setItem(KEY,"1");}catch(e){}}
function onKey(e){if(e.key==="Escape")close();}
function close(){if(box.hidden)return;video.pause();video.autoplay=false;box.hidden=true;document.removeEventListener("keydown",onKey);if(back&&back.focus)back.focus();back=null;}
function start(){play.hidden=true;video.autoplay=true;var p=video.play();if(p&&p.catch)p.catch(function(){video.autoplay=false;play.hidden=false;play.focus();});}
function open(){remember();back=document.activeElement;box.hidden=false;document.addEventListener("keydown",onKey);try{video.currentTime=0;}catch(e){}
if(calm){video.autoplay=false;play.hidden=false;play.focus();}else{skip.focus();start();}}
video.addEventListener("ended",close);
var last=video.querySelector("source:last-of-type");if(last)last.addEventListener("error",close);
skip.addEventListener("click",close);
play.addEventListener("click",start);
box.addEventListener("click",function(e){if(e.target===box)close();});
var again=document.getElementById("nav-intro");if(again)again.addEventListener("click",open);
if(!seen())open();
})();
`;

const SCRIPT = `
(function(){
"use strict";
var token=document.querySelector('meta[name="dft-token"]').getAttribute("content");
var $=function(id){return document.getElementById(id);};
var COLS=[["repo","Repo",0],["branch","Branch",0],["worktree","Worktree",0],["status","Status",0],["last","Last active",1],["agent","Agent time",1],["tokens","Tokens",1],["billed","Billed",1],["estimate","Estimate",1],["chats","Chats",1],["commits","Commits",1]];
var state={since:"30d",repo:"",sort:"last",dir:-1,rows:[],updated:0,online:false,branchRoot:null,setup:null};
try{var saved=localStorage.getItem("dft.since");if(saved)state.since=saved;}catch(e){}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function getJson(url){return fetch(url,{headers:{accept:"application/json"}}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.statusText);return j;});});}
function post(body){return fetch("/api/action",{method:"POST",headers:{"content-type":"application/json","x-dft-token":token},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.statusText);return j;});});}
var toastTimer=0;
function toast(text,bad){var t=$("toast");t.textContent=text;t.className="show"+(bad?" bad":"");clearTimeout(toastTimer);toastTimer=setTimeout(function(){t.className="";},4200);}
function setText(el,text){if(el.textContent!==text){var had=el.textContent!=="";el.textContent=text;if(had){el.classList.remove("flash");void el.offsetWidth;el.classList.add("flash");}}}
function ago(ms){var s=Math.max(0,Math.round(ms/1000));if(s<60)return s+" s ago";var m=Math.round(s/60);if(m<60)return m+" min ago";return Math.round(m/60)+" h ago";}
function tick(){var el=$("live-text");$("live").className="live"+(state.online?"":" off");el.textContent=state.online?(state.updated?"live · updated "+ago(Date.now()-state.updated):"live"):"offline · retrying";}
setInterval(tick,1000);
function fresh(){state.updated=Date.now();tick();}
function route(){var h=location.hash.replace(/^#/,"")||"/";var q=h.indexOf("?");var p=q===-1?h:h.slice(0,q);var params=new URLSearchParams(q===-1?"":h.slice(q+1));if(p==="/branch")return{name:"branch",repo:params.get("repo")||"",branch:params.get("branch")||""};if(p==="/setup")return{name:"setup"};return{name:"branches"};}
function tiles(el,list){if(el.children.length!==list.length){el.innerHTML=list.map(function(){return '<div class="tile"><dt></dt><dd></dd><small></small></div>';}).join("");}
list.forEach(function(item,i){var t=el.children[i];setText(t.querySelector("dt"),item.label);setText(t.querySelector("dd"),item.text);t.querySelector("small").textContent=item.note||"";});}
function branchHref(row){return "#/branch?repo="+encodeURIComponent(row.commonDir||"")+"&branch="+encodeURIComponent(row.branch||"");}
var head=$("table").tHead.rows[0];
COLS.forEach(function(c){var th=document.createElement("th");th.scope="col";if(c[2])th.className="num";th.innerHTML='<button type="button">'+esc(c[1])+"</button>";th.querySelector("button").addEventListener("click",function(){if(state.sort===c[0])state.dir=-state.dir;else{state.sort=c[0];state.dir=c[2]?-1:1;}paintRows();});head.appendChild(th);});
var rowEls=new Map();
function makeRow(row){var tr=document.createElement("tr");COLS.forEach(function(c){var td=document.createElement("td");if(c[2])td.className="num";if(c[0]==="branch"){td.className="branch";td.innerHTML="<a></a>";}if(c[0]==="worktree")td.innerHTML='<span class="tag" hidden></span>';tr.appendChild(td);});tr.addEventListener("click",function(e){if(e.target.closest("a"))return;location.hash=tr.getAttribute("data-href");});return tr;}
function fillRow(tr,row){tr.setAttribute("data-href",branchHref(row));COLS.forEach(function(c,i){var td=tr.cells[i];var cell=row.cells[c[0]];if(c[0]==="branch"){var a=td.firstChild;a.href=branchHref(row);setText(a,cell.t);a.title=cell.t;}else if(c[0]==="worktree"){var tag=td.firstChild;tag.hidden=cell.t==="";tag.textContent=cell.t;tag.title=String(cell.v);}else setText(td,cell.t);});}
function paintRows(){var body=$("table").tBodies[0];var seen=new Set();state.rows.forEach(function(row){seen.add(row.key);var tr=rowEls.get(row.key);if(!tr){tr=makeRow(row);rowEls.set(row.key,tr);}fillRow(tr,row);});rowEls.forEach(function(tr,key){if(!seen.has(key)){tr.remove();rowEls.delete(key);}});
var k=state.sort;var numeric=COLS.some(function(c){return c[0]===k&&c[2];});var sorted=state.rows.slice().sort(function(a,b){var x=a.cells[k].v,y=b.cells[k].v;return (numeric?Number(x)-Number(y):String(x).localeCompare(String(y)))*state.dir;});
sorted.forEach(function(row){body.appendChild(rowEls.get(row.key));});
Array.prototype.forEach.call(head.cells,function(th,i){th.setAttribute("aria-sort",COLS[i][0]===k?(state.dir>0?"ascending":"descending"):"none");});
$("empty").hidden=state.rows.length!==0;}
function paintFilters(repos){var sel=$("repo-filter");var want=[""].concat(repos.map(function(r){return r.id;}));var have=Array.prototype.map.call(sel.options,function(o){return o.value;});if(want.join("\\n")!==have.join("\\n")){sel.innerHTML='<option value="">All repos</option>'+repos.map(function(r){return '<option value="'+esc(r.id)+'">'+esc(r.name)+"</option>";}).join("");}sel.value=state.repo;
Array.prototype.forEach.call(document.querySelectorAll("[data-since]"),function(b){b.setAttribute("aria-pressed",String(b.getAttribute("data-since")===state.since));});}
function loadBranches(){return getJson("/api/branches?since="+encodeURIComponent(state.since)+"&repo="+encodeURIComponent(state.repo)).then(function(res){var v=res.view;tiles($("totals"),v.totals);state.rows=v.rows;paintFilters(v.repos);paintRows();var acc=$("account");acc.hidden=v.account===null;if(v.account!==null)setText(acc,v.account);fresh();}).catch(function(e){toast(e.message,true);});}
$("repo-filter").addEventListener("change",function(){state.repo=this.value;loadBranches();});
Array.prototype.forEach.call(document.querySelectorAll("[data-since]"),function(b){b.addEventListener("click",function(){state.since=b.getAttribute("data-since");try{localStorage.setItem("dft.since",state.since);}catch(e){}paintFilters([]);loadBranches();});});
var lastBranch="";
function loadBranch(){var r=route();return getJson("/api/branch?repo="+encodeURIComponent(r.repo)+"&branch="+encodeURIComponent(r.branch)+"&since="+encodeURIComponent(state.since)).then(function(res){var v=res.view;var key=r.repo+"\\n"+r.branch;if(key!==lastBranch){$("b-tiles").innerHTML="";lastBranch=key;}state.branchRoot=v.repoRoot;setText($("b-name"),v.branch);setText($("b-repo"),v.repo);$("b-where").textContent=v.worktrees.length?v.worktrees.join(", "):"";tiles($("b-tiles"),v.summary.map(function(s){return{label:s.label,text:s.text};}));
if($("b-chats").getAttribute("data-html")!==v.chats){$("b-chats").innerHTML=v.chats;$("b-chats").setAttribute("data-html",v.chats);}setText($("b-timeline"),v.timeline);setText($("b-report"),v.report);document.title="dft · "+v.branch;fresh();}).catch(function(e){$("b-name").textContent=r.branch;$("b-where").textContent=e.message;$("b-tiles").innerHTML="";$("b-chats").innerHTML="";$("b-timeline").textContent="";});}
function planWords(t){var parts=[];function add(n,one,many){if(n>0)parts.push(n.toLocaleString("en-US")+" "+(n===1?one:many));}add(t.events,"event","events");add(t.commitSnapshots,"commit snapshot","commit snapshots");add(t.storeSnapshots,"stored report","stored reports");add(t.spoolFiles,"hook file waiting to import","hook files waiting to import");add(t.coverage,"source record","source records");return parts.length?parts.join(", "):"nothing";}
function confirmBox(input,button,text){input.value="";input.placeholder=text?"type "+text:"";input.setAttribute("data-want",text||"");button.disabled=true;}
[["d-confirm","d-go"],["r-confirm","r-go"],["b-confirm","b-go"]].forEach(function(p){$(p[0]).addEventListener("input",function(){var want=this.getAttribute("data-want");$(p[1]).disabled=!want||this.value!==want;});});
function loadDeletePlan(){var repo=$("d-repo").value;if(!repo){$("d-plan").textContent="No tracked repos.";confirmBox($("d-confirm"),$("d-go"),"");return;}getJson("/api/plan?kind=delete&repo="+encodeURIComponent(repo)).then(function(p){$("d-plan").innerHTML="Removes "+esc(planWords(p.totals))+" from "+p.branches+" branch"+(p.branches===1?"":"es")+". dft saves a backup first, so you can restore it below. Type <code>"+esc(p.confirmText)+"</code> to confirm.";confirmBox($("d-confirm"),$("d-go"),p.confirmText);}).catch(function(e){$("d-plan").textContent=e.message;});}
function loadResetPlan(){getJson("/api/plan?kind=reset").then(function(p){$("r-plan").innerHTML="Removes "+esc(planWords(p.totals))+" from "+p.repos+" repo"+(p.repos===1?"":"s")+". Tracked repos stay tracked. dft saves a backup first, so you can restore it below. Type <code>"+esc(p.confirmText)+"</code> to confirm.";confirmBox($("r-confirm"),$("r-go"),p.confirmText);}).catch(function(e){$("r-plan").textContent=e.message;});}
function paintBackupPlan(){var id=$("b-pick").value;$("b-pick").parentNode.hidden=!id;$("b-confirm").parentNode.hidden=!id;if(!id){$("b-plan").textContent="No backups yet. dft saves one before every delete, reset or restore.";confirmBox($("b-confirm"),$("b-go"),"");return;}$("b-plan").innerHTML="Replaces the current data with this backup. dft backs up the current data first, so you can undo it. Type <code>restore</code> to confirm.";confirmBox($("b-confirm"),$("b-go"),"restore");}
$("d-repo").addEventListener("change",loadDeletePlan);
$("b-pick").addEventListener("change",paintBackupPlan);
function syncSelect(sel,items){var want=items.map(function(i){return i.value+"\\t"+i.text;}).join("\\n");if(sel.getAttribute("data-list")===want)return false;var keep=sel.value;sel.innerHTML=items.map(function(i){return '<option value="'+esc(i.value)+'">'+esc(i.text)+"</option>";}).join("");sel.setAttribute("data-list",want);if(items.some(function(i){return i.value===keep;}))sel.value=keep;return true;}
function repoHtml(r){var src=r.sources.length?'<ul class="list">'+r.sources.map(function(s){return '<li><span class="'+(s.ok?"ok":"no")+'">'+(s.ok?"\\u2713":"\\u25CB")+"</span><span>"+esc(s.label)+'</span><span class="muted">'+esc(s.note)+"</span></li>";}).join("")+"</ul>":'<p class="muted">Sources show up after the first sync.</p>';
return '<div class="repo"><div class="head"><strong>'+esc(r.name)+'</strong><span class="muted">'+esc(r.lastSync)+"</span>"+(r.hooks?'<span class="tag">hooks installed</span>':'<button type="button" class="btn" data-hooks="'+esc(r.root)+'">Install hooks</button>')+'<button type="button" class="btn" data-untrack="'+esc(r.root)+'">Stop tracking</button></div><div class="path">'+esc(r.root)+"</div>"+(r.error?'<p class="no">'+esc(r.error)+"</p>":"")+src+"</div>";}
function loadSetup(){return getJson("/api/setup").then(function(s){var html=s.repos.length?s.repos.map(repoHtml).join(""):'<p class="muted">No repos tracked. Add one below.</p>';if($("s-repos").getAttribute("data-html")!==html){$("s-repos").innerHTML=html;$("s-repos").setAttribute("data-html",html);}
$("s-usage").checked=s.usage.enabled;$("s-usage-note").textContent=s.usage.enabled?s.usage.note:"Off. Turn it on to see what your Cursor account billed.";
if(syncSelect($("d-repo"),s.repos.map(function(r){return{value:r.root,text:r.name+"  "+r.root};})))loadDeletePlan();
if(syncSelect($("b-pick"),s.backups.map(function(b){return{value:b.id,text:b.text};})))paintBackupPlan();
$("s-where").textContent="Data folder "+s.dftHome+". Store "+s.store+".";state.setup=s;fresh();}).catch(function(e){toast(e.message,true);});}
function act(body,button){if(button)button.disabled=true;return post(body).then(function(r){toast(r.message,false);return true;}).catch(function(e){toast(e.message,true);return false;}).then(function(ok){if(button)button.disabled=false;loadSetup();return ok;});}
$("s-repos").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;if(b.hasAttribute("data-hooks"))act({action:"hooks",path:b.getAttribute("data-hooks")},b);if(b.hasAttribute("data-untrack"))act({action:"untrack",path:b.getAttribute("data-untrack")},b);});
$("s-add-btn").addEventListener("click",function(){var v=$("s-add").value.trim();if(!v)return;act({action:"track",path:v},this).then(function(ok){if(ok)$("s-add").value="";});});
$("s-usage").addEventListener("change",function(){act({action:"usage",enabled:this.checked},null);});
$("s-export").addEventListener("click",function(){act({action:"export"},this);});
$("d-go").addEventListener("click",function(){act({action:"delete",path:$("d-repo").value,confirm:$("d-confirm").value},this).then(function(){$("d-repo").removeAttribute("data-list");loadDeletePlan();loadResetPlan();});});
$("r-go").addEventListener("click",function(){act({action:"reset",confirm:$("r-confirm").value},this).then(function(){loadResetPlan();loadDeletePlan();});});
$("b-go").addEventListener("click",function(){act({action:"restore",id:$("b-pick").value},this).then(function(){loadResetPlan();loadDeletePlan();});});
function show(){var r=route();["branches","branch","setup"].forEach(function(n){$("v-"+n).hidden=n!==r.name;});Array.prototype.forEach.call(document.querySelectorAll("[data-nav]"),function(a){var on=a.getAttribute("data-nav")===(r.name==="branch"?"branches":r.name);if(on)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");});
if(r.name==="branches"){document.title="dft · branches";paintFilters([]);loadBranches();}else if(r.name==="branch"){loadBranch();}else{document.title="dft · setup";loadSetup();loadResetPlan();}}
window.addEventListener("hashchange",function(){window.scrollTo(0,0);show();});
var queue=[];var flushTimer=0;
function flush(){var changes=queue;queue=[];var r=route();if(r.name==="branches"){loadBranches();return;}if(r.name==="setup"){loadSetup();loadResetPlan();return;}
var wide=changes.some(function(c){return c.reason!=="sync";});var mine=changes.some(function(c){return c.repo===state.branchRoot&&(c.branches.length===0||c.branches.indexOf(r.branch)!==-1);});if(wide||mine)loadBranch();}
var dropped=false;
function connect(){var es=new EventSource("/events");es.addEventListener("change",function(e){try{queue.push(JSON.parse(e.data));}catch(err){return;}clearTimeout(flushTimer);flushTimer=setTimeout(flush,250);});es.onerror=function(){state.online=false;dropped=true;tick();};es.onopen=function(){state.online=true;tick();if(dropped){dropped=false;show();}};}
show();connect();
})();
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
    '<meta name="color-scheme" content="dark">',
    '<meta name="theme-color" content="#0b0b0c">',
    '<meta name="referrer" content="no-referrer">',
    `<meta name="dft-token" content="${token}">`,
    "<title>dft · branches</title>",
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body(options.intro === true),
    `<script>${SCRIPT}</script>`,
    ...(options.intro === true ? [`<script>${INTRO_SCRIPT}</script>`] : []),
    "</body>",
    "</html>",
    "",
  ].join("\n");
