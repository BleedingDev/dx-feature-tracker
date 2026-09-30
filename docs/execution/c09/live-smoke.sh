#!/usr/bin/env bash
# C09 live Cursor smoke. Run via: /Users/satan/bin/owned-temp-dir --run c09-smoke -- bash docs/execution/c09/live-smoke.sh
# Creates a throwaway demo repo in $OWNED_TEMP_DIR, installs project-level hooks (never ~/.cursor),
# drives real cursor-agent activity on a feature branch, then collects/analyzes/explains that branch.
set -uo pipefail
REC="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$REC/docs/execution/c09/run"
T="${OWNED_TEMP_DIR:?run under owned-temp-dir}"
DEMO="$T/demo"; STORE="${C09_STORE:-$T/store/events.sqlite}"; CLI="$REC/apps/cli/dist/cli.js"
mkdir -p "$OUT" "$DEMO" "$(dirname "$STORE")"
export DX_STORE="$STORE" DX_REPO="$DEMO"
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/steps.log"; }
: > "$OUT/steps.log"
dx(){ node "$CLI" dx "$@"; }

cd "$DEMO"
git init -q -b main && git config user.email c09@example.invalid && git config user.name c09
printf 'export const add = (a: number, b: number) => a + b;\n' > math.ts
git add -A && git commit -qm init
git checkout -qb feature/c09-live
log "demo repo ready on $(git branch --show-current)"

node "$REC/scripts/dx-install.ts" install --target "$DEMO" --store "$STORE" > "$OUT/install.json" 2>"$OUT/install.err"; log "install exit $?"
dx mark --help >/dev/null 2>&1
dx mark --kind start --flight feature/c09-live --repo "$DEMO" > "$OUT/mark-start.json" 2>&1; log "mark start exit $?"

log "cursor-agent $(cursor-agent --version 2>&1)"
cursor-agent -p --trust --force --output-format stream-json --workspace "$DEMO" \
  "Add a function mul(a,b) to math.ts that multiplies two numbers, then run: node -e \"console.log(1)\". Keep it minimal." \
  > "$T/cursor-stream.jsonl" 2> "$OUT/cursor-agent.err"
log "cursor-agent exit $?"
cp "$T/cursor-stream.jsonl" "$T/cursor-stream.keep" 2>/dev/null
git add -A -- . ':!.cursor' 2>/dev/null; git commit -qm "add mul" ; log "commit exit $?"

SPOOL="$(ls -d "${DFT_HOME:-$HOME/.dft}"/spool/"$(basename "$DEMO")"-*/cursor-hooks 2>/dev/null | head -1)"
log "spool files: $(ls "$SPOOL" 2>/dev/null | wc -l | tr -d ' ')"
dx collect --source collector.cursor-hooks --input "$SPOOL" --repo "$DEMO" > "$OUT/collect-hooks.json" 2>&1; log "collect cursor-hooks exit $?"
dx collect --source collector/cursor-cli --input "$T/cursor-stream.jsonl" --repo "$DEMO" > "$OUT/collect-cursor-cli.json" 2>&1; log "collect cursor-cli exit $?"
dx collect --source collector.git-history --input "$DEMO" --repo "$DEMO" > "$OUT/collect-git.json" 2>&1; log "collect git-history exit $?"
dx collect --source collector.git-observation --input "$DEMO" --repo "$DEMO" > "$OUT/collect-gitobs.json" 2>&1; log "collect git-observation exit $?"
dx analyze --flight feature/c09-live --repo "$DEMO" > "$OUT/analyze-flight-flag.json" 2>&1; log "analyze --flight exit $? (flight-id selector)"
dx analyze --repo "$DEMO" > "$OUT/analyze.json" 2>&1; log "analyze (repo+current branch) exit $?"
SNAP=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.snapshotId||j.snapshot?.snapshotId||"")}catch{}' "$OUT/analyze.json")
log "snapshot $SNAP"
if [ -n "$SNAP" ]; then dx explain --snapshotId "$SNAP" --limit 200 > "$OUT/explain.json" 2>&1; else dx explain --limit 200 > "$OUT/explain.json" 2>&1; fi
log "explain exit $?"
# stream-json summary only (no prompt/response text is copied into the repo)
node -e '
const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
const types={};let result=null;for(const l of L){try{const j=JSON.parse(l);const k=j.type+(j.subtype?":"+j.subtype:"");types[k]=(types[k]||0)+1;if(j.type==="result"){result={duration_ms:j.duration_ms,usage:j.usage,is_error:j.is_error,session_id:j.session_id}}}catch{}}
console.log(JSON.stringify({lines:L.length,types,result},null,1))' "$T/cursor-stream.jsonl" > "$OUT/cursor-stream-summary.json"

# MCP: Cursor itself lists and calls the installed built server (project .cursor/mcp.json)
(cd "$DEMO" && cursor-agent mcp list > "$OUT/cursor-mcp-list.txt" 2>&1); log "cursor mcp list exit $?"
(cd "$DEMO" && cursor-agent mcp list-tools rat-stack > "$OUT/cursor-mcp-list-tools.txt" 2>&1); log "cursor mcp list-tools exit $?"
perl -e 'alarm 200; exec @ARGV' cursor-agent -p --trust --force --approve-mcps --output-format stream-json --workspace "$DEMO" \
  "Call the rat-stack MCP tool dx_analyze for this repository's current branch (no flight argument) and call it exactly once, then reply with only the value of metric dx.ai-usage.tokens.input." \
  > "$T/cursor-mcp-stream.jsonl" 2> "$OUT/cursor-agent-mcp.err"
log "cursor-agent mcp call exit $?"
node -e '
const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);const calls=[];let answer=null;
for(const l of L){try{const j=JSON.parse(l);if(j.type==="tool_call"){const tc=j.tool_call||{};const k=Object.keys(tc)[0];const v=tc[k]||{};calls.push({subtype:j.subtype,kind:k,name:v.args?.name||v.args?.toolName||v.args?.tool_name||null,ok:j.subtype==="completed"?!!(v.result&&!v.result.error):null})}if(j.type==="result")answer=String(j.result||"").slice(0,200)}catch{}}
console.log(JSON.stringify({toolCalls:calls,finalAnswer:answer},null,1))' "$T/cursor-mcp-stream.jsonl" > "$OUT/cursor-mcp-call-summary.json"
dx status > "$OUT/status.json" 2>&1
log "done"
