#!/bin/bash
# C17: real Cursor flight through the built CLI + installer. Run via:
#   C17_OUT=<dir> /Users/satan/bin/owned-temp-dir --run c17 -- bash docs/execution/c17/run.sh
# Raw prompts, streams and spool stay in OWNED_TEMP_DIR (deleted); only metadata lands in C17_OUT.
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NODE="$(command -v node)"
CLI="$NODE $ROOT/apps/cli/dist/cli.js"
OUT="${C17_OUT:?set C17_OUT}"; mkdir -p "$OUT"; : > "$OUT/exits.txt"
T="${OWNED_TEMP_DIR:?run under owned-temp-dir}"
export DX_STORE="$T/store/events.sqlite"; mkdir -p "$T/store"
R="$T/c17-demo"; mkdir -p "$R"
run() { local name=$1; shift; "$@" > "$OUT/$name.out" 2> "$OUT/$name.err"; echo "$name $?" >> "$OUT/exits.txt"; }
{
  echo "recorder_head $(git -C "$ROOT" rev-parse HEAD)"
  echo "recorder_dirty_paths $(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')"
  echo "cli_dist_sha256 $(shasum -a 256 "$ROOT/apps/cli/dist/cli.js" | cut -d' ' -f1)"
  echo "installer_sha256 $(shasum -a 256 "$ROOT/scripts/dx-install.ts" | cut -d' ' -f1)"
  echo "node $("$NODE" --version)"
  echo "cursor_agent $(cursor-agent --version 2>&1)"
  echo "dx_cli_version $($CLI --version 2>&1)"
  echo "operator_role cursor-validation-owner(C17 agent)"
} > "$OUT/versions.txt"
cd "$R"
git init -q -b main; git config user.email c17@example.invalid; git config user.name c17-probe
printf 'export const add = (a, b) => a + b;\n' > math.mjs
printf '{"type":"module"}\n' > package.json
git add -A; git commit -qm init
git checkout -qb feature/c17-real-flight
echo "branch_created $(date -u +%FT%TZ)" > "$OUT/times.txt"
# Installer (built artifact path), project scope only; never ~/.cursor.
(cd "$ROOT" && run install "$NODE" scripts/dx-install.ts install --target "$R" --store "$DX_STORE")
printf '.cursor/\n' >> .git/info/exclude
shasum -a 256 "$HOME/.cursor/hooks.json" 2>/dev/null > "$OUT/user-hooks-before.txt"
echo "agent_start $(date -u +%FT%TZ)" >> "$OUT/times.txt"
for i in 1 2; do
  cursor-agent -p --output-format stream-json --force --trust "In this repo add function mul(a,b) to math.mjs, create math.test.mjs using node:test and node:assert covering add and mul, then run: node --test --test-reporter=junit --test-reporter-destination=test-results.xml math.test.mjs . Do not commit." > "$T/stream-$i.jsonl" 2> "$T/agent-$i.err"
  echo "agent_exit_$i $?" >> "$OUT/times.txt"
  grep -q '"type":"result"' "$T/stream-$i.jsonl" && break
done
echo "agent_end $(date -u +%FT%TZ)" >> "$OUT/times.txt"
shasum -a 256 "$HOME/.cursor/hooks.json" 2>/dev/null > "$OUT/user-hooks-after.txt"
git add math.mjs math.test.mjs; git commit -qm "add mul and tests"; echo "commit_exit $?" >> "$OUT/times.txt"
"$NODE" --test --test-reporter=junit --test-reporter-destination="$T/operator-junit.xml" math.test.mjs >/dev/null 2>&1; echo "operator_test_exit $?" >> "$OUT/times.txt"
SPOOL="$R/.dx-flight-recorder/cursor-hooks-spool"
echo "spool_files $(ls "$SPOOL" 2>/dev/null | wc -l | tr -d ' ')" >> "$OUT/times.txt"
run collect-git $CLI dx collect --source collector.git-history --repo "$R" --input "$R"
run collect-hooks $CLI dx collect --source collector.cursor-hooks --repo "$R" --input "$SPOOL"
S=$(ls "$T"/stream-*.jsonl | tail -1)
run collect-cli $CLI dx collect --source collector/cursor-cli --repo "$R" --input "$S"
[ -f "$R/test-results.xml" ] && run collect-test-agent $CLI dx collect --source collector/local-test --repo "$R" --input "$R/test-results.xml"
run collect-test-operator $CLI dx collect --source collector/local-test --repo "$R" --input "$T/operator-junit.xml"
run collect-gitobs $CLI dx collect --source collector.git-observation --repo "$R" --input "$R"
# Historical/imported: the Cursor transcript of this run, copied first (read-only), labelled imported.
TR=$(find "$HOME/.cursor/projects" -path '*c17-demo*' -path '*agent-transcripts*' -type f -newer "$R/package.json" 2>/dev/null | grep -v subagents | tail -1)
echo "transcript_found $([ -n "$TR" ] && echo yes || echo no)" >> "$OUT/times.txt"
if [ -n "$TR" ]; then cp "$TR" "$T/transcript-copy.${TR##*.}"; run collect-transcripts-imported $CLI dx collect --source collector.cursor-transcripts --repo "$R" --input "$(ls "$T"/transcript-copy.*)"; fi
run recollect-cli $CLI dx collect --source collector/cursor-cli --repo "$R" --input "$S"
run analyze1 $CLI dx analyze --repo "$R"
SNAP=$("$NODE" -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");const m=t.match(/"snapshotId"\s*:\s*"([^"]+)"/);console.log(m?m[1]:"")' "$OUT/analyze1.out")
echo "snapshot $SNAP" >> "$OUT/times.txt"
run analyze2-same-snapshot $CLI dx analyze --repo "$R" --snapshotId "$SNAP"
run explain-snapshot env DX_REPO="$R" $CLI dx explain --snapshotId "$SNAP" --limit 200
IDS=$("$NODE" -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");const s=new Set();for(const m of t.matchAll(/"(evidenceIds?|evidenceId)"\s*:\s*(\[[^\]]*\]|"[^"]+")/g)){const v=JSON.parse(m[2]);for(const x of [].concat(v))s.add(x)}console.log(JSON.stringify([...s].slice(0,5)))' "$OUT/explain-snapshot.out")
echo "evidence_ids_followed $IDS" >> "$OUT/times.txt"
run evidence-follow env DX_REPO="$R" $CLI dx evidence --snapshotId "$SNAP" --evidenceIds "$IDS"
run status env DX_REPO="$R" $CLI dx status
(cd "$ROOT" && run uninstall "$NODE" scripts/dx-install.ts uninstall --target "$R")
"$NODE" -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);const c={};for(const x of l){try{const j=JSON.parse(x);const k=j.type+(j.subtype?":"+j.subtype:"");c[k]=(c[k]||0)+1;if(j.usage)c.usageKeys=Object.keys(j.usage).join(",")}catch{c.bad=(c.bad||0)+1}}console.log(JSON.stringify(c))' "$S" > "$OUT/stream-shape.json"
( git log --oneline | wc -l; git diff --shortstat main..HEAD; shasum -a 256 "$S" "$T/operator-junit.xml" ) > "$OUT/inputs.txt" 2>&1
