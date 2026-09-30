#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="node $ROOT/apps/cli/dist/cli.js"
OUT="${A09_OUT:?set A09_OUT to an output dir}"
mkdir -p "$OUT"
T="$OWNED_TEMP_DIR"
export DX_STORE="$T/store/events.sqlite"; mkdir -p "$T/store"
R="$T/a09-demo"; mkdir -p "$R"; cd "$R"
git init -q -b main; git config user.email a09@example.invalid; git config user.name a09-probe
printf 'export const add = (a, b) => a + b;\n' > math.mjs
printf '{"type":"module"}\n' > package.json
printf '.dx-flight-recorder/\n.cursor/\n' > .gitignore
git add -A; git commit -qm "init"
git checkout -qb feature/a09-cost-probe
mkdir -p .cursor
node -e '
const ev=["sessionStart","sessionEnd","beforeSubmitPrompt","afterAgentResponse","afterAgentThought","beforeShellExecution","afterShellExecution","beforeMCPExecution","afterMCPExecution","beforeReadFile","afterFileEdit","preToolUse","postToolUse","stop"];
const cmd=process.argv[1];const hooks={};for(const e of ev)hooks[e]=[{command:cmd}];
require("fs").writeFileSync(".cursor/hooks.json",JSON.stringify({version:1,hooks},null,2));' "$CLI dx hook"
echo "start $(date -u +%FT%TZ)" > "$OUT/times.txt"
for i in 1 2 3; do
cursor-agent -p --output-format stream-json --force --trust "In this repo, add a function mul(a,b) to math.mjs (if missing), create math.test.mjs using node:test and node:assert covering add and mul (if missing), then run: node --test --test-reporter=junit --test-reporter-destination=test-results.xml math.test.mjs . Do not commit." > "$T/stream-$i.jsonl" 2> "$T/agent-$i.err"
echo "agent_exit_$i $?" >> "$OUT/times.txt"
grep -q '"type":"result"' "$T/stream-$i.jsonl" && break
done
echo "end $(date -u +%FT%TZ)" >> "$OUT/times.txt"
git add math.mjs math.test.mjs 2>/dev/null; git commit -qm "add mul and tests" ; echo "commit_exit $?" >> "$OUT/times.txt"
# operator local test run (in addition to agent's)
node --test --test-reporter=junit --test-reporter-destination="$T/operator-junit.xml" math.test.mjs >/dev/null 2>&1; echo "operator_test_exit $?" >> "$OUT/times.txt"
# transcripts: find newest under ~/.cursor/projects matching repo basename
TR=$(find ~/.cursor/projects -path '*a09-demo*' -path '*agent-transcripts*' -type f -newer "$R/package.json" 2>/dev/null | grep -v subagents | tail -1)
echo "transcript_found $([ -n "$TR" ] && echo yes || echo no)" >> "$OUT/times.txt"
[ -n "$TR" ] && cp "$TR" "$T/transcript-copy.${TR##*.}"
# local db backup copy
node -e 'const {DatabaseSync,backup}=require("node:sqlite");const s=new DatabaseSync(process.argv[1],{readOnly:true});backup(s,process.argv[2]).then(()=>{s.close();console.log("ok")})' ~/.cursor/ai-tracking/ai-code-tracking.db "$T/ai-code-tracking.backup.db" > "$OUT/dbbackup.txt" 2>&1
echo "db_backup_exit $?" >> "$OUT/times.txt"
mkdir -p "$T/scratch-db"
run() { local name=$1; shift; "$@" > "$OUT/$name.out" 2> "$OUT/$name.err"; echo "$name $?" >> "$OUT/exits.txt"; }
run collect-git $CLI dx collect --source collector.git-history --repo "$R" --input "$R"
run collect-hooks $CLI dx collect --source collector.cursor-hooks --repo "$R" --input "$R/.dx-flight-recorder/cursor-hooks-spool"
for f in "$T"/stream-*.jsonl; do b=$(basename $f .jsonl); run collect-cli-$b $CLI dx collect --source collector/cursor-cli --repo "$R" --input "$f"; done
[ -f "$T"/transcript-copy.* ] && run collect-transcripts $CLI dx collect --source collector.cursor-transcripts --repo "$R" --input "$(ls "$T"/transcript-copy.*)"
run collect-localdb $CLI dx collect --source cursor-local-db --repo "$R" --input "$T/ai-code-tracking.backup.db"
[ -f "$R/test-results.xml" ] && run collect-test-agent $CLI dx collect --source collector/local-test --repo "$R" --input "$R/test-results.xml"
run collect-test-operator $CLI dx collect --source collector/local-test --repo "$R" --input "$T/operator-junit.xml"
run collect-gitobs $CLI dx collect --source collector.git-observation --repo "$R" --input "$R"
# idempotence
run recollect-hooks $CLI dx collect --source collector.cursor-hooks --repo "$R" --input "$R/.dx-flight-recorder/cursor-hooks-spool"
run recollect-cli $CLI dx collect --source collector/cursor-cli --repo "$R" --input "$(ls "$T"/stream-*.jsonl | tail -1)"
cd "$R"
run analyze1 $CLI dx analyze --repo "$R"
run analyze2 $CLI dx analyze --repo "$R"
run explain $CLI dx explain --flight "$(git rev-parse --abbrev-ref HEAD)" --limit 200
run explain-default env DX_REPO="$R" $CLI dx explain --limit 200
run status $CLI dx status
# hashes of inputs (no content)
( cd "$T"; shasum -a 256 stream-*.jsonl operator-junit.xml ai-code-tracking.backup.db transcript-copy.* 2>/dev/null; wc -l stream-*.jsonl; ls "$R/.dx-flight-recorder/cursor-hooks-spool" | wc -l; [ -f "$R/test-results.xml" ] && shasum -a 256 "$R/test-results.xml"; git -C "$R" log --oneline | wc -l; git -C "$R" diff --shortstat main..HEAD ) > "$OUT/inputs.txt" 2>&1
# stream event type counts (keys only)
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);const c={};for(const x of l){try{const j=JSON.parse(x);const k=j.type+(j.subtype?":"+j.subtype:"");c[k]=(c[k]||0)+1;if(j.type==="result")c.resultKeys=Object.keys(j).join(",");if(j.usage)c.usageKeys=Object.keys(j.usage).join(",")}catch{c.bad=(c.bad||0)+1}}console.log(JSON.stringify(c))' "$(ls "$T"/stream-*.jsonl | tail -1)" > "$OUT/stream-shape.json"
# spool event kinds
node -e 'const fs=require("fs"),p=process.argv[1];const c={};for(const f of fs.readdirSync(p)){try{const j=JSON.parse(fs.readFileSync(p+"/"+f,"utf8"));const k=j.hookEventName||j.event||j.kind||"?";c[k]=(c[k]||0)+1}catch{}}console.log(JSON.stringify(c))' "$R/.dx-flight-recorder/cursor-hooks-spool" > "$OUT/spool-shape.json" 2>&1
cat "$T"/agent-*.err > "$OUT/agent.err.txt"
