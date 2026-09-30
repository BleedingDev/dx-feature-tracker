#!/usr/bin/env bash
# C14 demo rehearsal. Two separately labelled flights, each in its own throwaway repo + store:
#   live         real cursor-agent activity on branch feature/c14-live (needs a logged-in cursor-agent)
#   adversarial  ADVERSARIAL FIXTURE FLIGHT: synthetic inputs from packages/core/test/dx/fixtures/c14
#                replayed through the real built CLI on branch fixture/c14-adversarial (no Cursor needed)
# Run: /Users/satan/bin/owned-temp-dir --run c14-rehearse -- bash docs/execution/c14/rehearse.sh [live|adversarial|all]
# Only project-level .cursor/ in the throwaway repo is written; ~/.cursor/hooks.json is hashed before/after.
set -uo pipefail
MODE="${1:-all}"
REC="$(cd "$(dirname "$0")/../../.." && pwd)"
T="${OWNED_TEMP_DIR:?run under owned-temp-dir}"
CLI="$REC/apps/cli/dist/cli.js"; FX="$REC/packages/core/test/dx/fixtures/c14"
hash_user_hooks(){ [ -f "$HOME/.cursor/hooks.json" ] && shasum -a 256 "$HOME/.cursor/hooks.json" | cut -d' ' -f1 || echo absent; }
USER_HOOKS_BEFORE=$(hash_user_hooks)

new_repo(){ # $1 dir $2 branch
  mkdir -p "$1" && cd "$1" || exit 2
  git init -q -b main && git config user.email c14@example.invalid && git config user.name c14
  printf 'export const add = (a, b) => a + b;\n' > math.mjs
  git add -A && git commit -qm init && git checkout -qb "$2"
}

adversarial(){
  local OUT="$REC/docs/execution/c14/adversarial" DEMO="$T/adv" BR="fixture/c14-adversarial"
  mkdir -p "$OUT" "$T/adv-store"; : > "$OUT/steps.log"
  export DX_STORE="$T/adv-store/events.sqlite" DX_REPO="$DEMO"
  log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/steps.log"; }
  new_repo "$DEMO" "$BR"; log "LABEL: ADVERSARIAL FIXTURE FLIGHT (synthetic, origin=fixture/adversarial) branch $BR"
  node "$CLI" dx mark --kind start --flight "$BR" --repo "$DEMO" > "$OUT/mark-start.json" 2>&1; log "mark start exit $?"
  local n=0
  while IFS= read -r line; do
    n=$((n+1)); payload="${line//__DEMO__/$DEMO}"; payload="${payload#MALFORMED }"
    printf '%s' "$payload" | node "$CLI" dx hook > "$OUT/hook-$n.out" 2>&1; log "hook payload $n exit $?"
  done < "$FX/hook-payloads.jsonl"
  # two commits touching the same file (observable rework)
  printf 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n' > math.mjs; git add math.mjs && git commit -qm "add mul"; log "commit 1 exit $?"
  printf 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\nexport const div = (a, b) => a / b;\n' > math.mjs; git add math.mjs && git commit -qm "add div"; log "commit 2 exit $?"
  sed "s#__DEMO__#$DEMO#g" "$FX/cursor-stream.jsonl" > "$T/adv-stream.jsonl"
  SPOOL="$DEMO/.dx-flight-recorder/cursor-hooks-spool"; log "spool files: $(ls "$SPOOL" 2>/dev/null | wc -l | tr -d ' ')"
  cp -R "$SPOOL" "$T/adv-spool-copy" 2>/dev/null
  node "$CLI" dx collect --source collector.cursor-hooks --input "$SPOOL" --repo "$DEMO" > "$OUT/collect-hooks.json" 2>&1; log "collect cursor-hooks exit $?"
  node "$CLI" dx collect --source collector/cursor-cli --input "$T/adv-stream.jsonl" --repo "$DEMO" > "$OUT/collect-cursor-cli.json" 2>&1; log "collect cursor-cli exit $?"
  node "$CLI" dx collect --source collector/cursor-cli --input "$T/adv-stream.jsonl" --repo "$DEMO" > "$OUT/recollect-cursor-cli.json" 2>&1; log "re-collect cursor-cli exit $?"
  node "$CLI" dx collect --source collector/local-test --input "$FX/junit-fail.xml" --repo "$DEMO" > "$OUT/collect-local-test.json" 2>&1; log "collect local-test exit $?"
  node "$CLI" dx collect --source collector.git-history --input "$DEMO" --repo "$DEMO" > "$OUT/collect-git.json" 2>&1; log "collect git-history exit $?"
  node "$CLI" dx collect --source collector.git-observation --input "$DEMO" --repo "$DEMO" > "$OUT/collect-gitobs.json" 2>&1; log "collect git-observation exit $?"
  node "$CLI" dx analyze --repo "$DEMO" > "$OUT/analyze.json" 2>&1; log "analyze exit $?"
  SNAP=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.snapshot?.snapshotId||j.snapshotId||"")}catch{}' "$OUT/analyze.json")
  node "$CLI" dx explain --snapshotId "$SNAP" --limit 200 > "$OUT/explain.json" 2>&1; log "explain exit $? snapshot $SNAP"
  node --input-type=module - "$OUT" "$FX/expected.json" "$T/adv-spool-copy" > "$OUT/check.json" <<'JS'
// Shared helpers for C14 checkers: read CLI outputs and index analyze metrics by id.
import fs from "node:fs";
import path from "node:path";
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const metricMap = (analyze) => Object.fromEntries((analyze?.metrics ?? []).map((m) => [m.metricId ?? m.id, m.value]));
const walk = (dir) => { const out = []; if (!dir || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); } return out; };
const checker = () => { const results = []; const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
  const finish = (extra) => { const failed = results.filter((r) => !r.pass).length; console.log(JSON.stringify({ ...extra, passed: results.length - failed, failed, results }, null, 1)); process.exit(failed ? 1 : 0); };
  return { ok, finish }; };
// Asserts the ADVERSARIAL FIXTURE FLIGHT outputs stay honest: no canary leak, duplicates collapsed,
// truncated/usage-less lines not counted, money/reasoning unavailable, hook survives malformed stdin.
const [out, expectedFile, spoolCopy] = process.argv.slice(2);
const exp = readJson(expectedFile); const { ok, finish } = checker();
const analyze = readJson(path.join(out, "analyze.json")); const explain = readJson(path.join(out, "explain.json"));
const m = metricMap(analyze);
const steps = fs.readFileSync(path.join(out, "steps.log"), "utf8");
const hookExits = [...steps.matchAll(/hook payload (\d+) exit (\d+)/g)].map((x) => Number(x[2]));
ok("hook never fails Cursor (all payloads incl. malformed exit 0)", hookExits.length > 0 && hookExits.every((e) => e === 0), hookExits);
ok("every collect/analyze/explain step exit 0", ![...steps.matchAll(/(collect|analyze|explain)[^\n]* exit (\d+)/g)].some((x) => x[2] !== "0"), null);
const scanned = [...walk(out).filter((f) => !f.endsWith("steps.log") && !f.endsWith("check.json")), ...walk(spoolCopy)];
const leaks = scanned.filter((f) => { const t = fs.readFileSync(f, "utf8"); return exp.canaries.some((c) => t.includes(c)); }).map((f) => path.basename(f));
ok("no prompt/command/secret canary in spool or any CLI output", leaks.length === 0, { scannedFiles: scanned.length, leaks });
const spoolFiles = walk(spoolCopy).length;
ok("spool holds only well-formed payloads (malformed skipped)", spoolFiles > 0 && spoolFiles <= exp.hookSpoolMaxFiles, spoolFiles);
ok("tokens.input counts duplicate result once and ignores truncated line", m["dx.ai-usage.tokens.input"] === exp.tokens.input, m["dx.ai-usage.tokens.input"]);
ok("tokens.output", m["dx.ai-usage.tokens.output"] === exp.tokens.output, m["dx.ai-usage.tokens.output"]);
ok("tokens.cached-input", m["dx.ai-usage.tokens.cached-input"] === exp.tokens["cached-input"], m["dx.ai-usage.tokens.cached-input"]);
ok("reasoning tokens unavailable (null), not 0", m["dx.ai-usage.tokens.reasoning"] === null, m["dx.ai-usage.tokens.reasoning"]);
const money = Object.entries(m).filter(([k]) => k.startsWith("dx.cost.") || k.startsWith("dx.ai-usage.money."));
ok("all money metrics unavailable (no fabricated charge or estimate)", money.length > 0 && money.every(([, v]) => v === null), Object.fromEntries(money));
const cliCov = readJson(path.join(out, "collect-cursor-cli.json"))?.coverage;
const codes = (cliCov?.gaps ?? []).map((g) => g.code);
ok("cursor-cli coverage discloses result-without-usage", codes.includes("result-without-usage"), codes);
ok("cursor-cli coverage is not 'complete' despite rejected/truncated lines", cliCov && cliCov.state !== "complete", cliCov?.state);
const re = readJson(path.join(out, "recollect-cursor-cli.json"));
ok("re-collect of same stream inserts 0 new rows", re && re.inserted === 0, re && { inserted: re.inserted, duplicates: re.duplicates });
ok("local test run and failure visible", m["dx.friction.test-runs"] === exp.tests.runs && m["dx.friction.test-failures"] === exp.tests.failures, { runs: m["dx.friction.test-runs"], failures: m["dx.friction.test-failures"] });
ok("branch commits observed", (m["dx.flight.commits"] ?? 0) >= exp.commits, { flightCommits: m["dx.flight.commits"], gitCommits: m["dx.git.commits"] });
const entries = explain?.entries ?? explain?.timeline?.entries ?? [];
ok("explain returns a timeline for the fixture snapshot", entries.length > 0, entries.length);
finish({ label: "ADVERSARIAL FIXTURE FLIGHT (synthetic)", branch: exp.branch, snapshotId: analyze?.snapshot?.snapshotId ?? null,
  observed: { toolCalls: m["dx.flight.tool-calls"], failedCommands: m["dx.friction.failed-commands"], filesRetouched: m["dx.git.files-retouched"], reworkedFiles: m["dx.friction.reworked-files"], duplicateRowsCollapsed: m["dx.ai-usage.duplicate-rows-collapsed"] } });
JS
  local rc=$?
  log "check-adversarial exit $rc"; return $rc
}

live(){
  local OUT="$REC/docs/execution/c14/live" DEMO="$T/live" BR="feature/c14-live"
  mkdir -p "$OUT" "$T/live-store"; : > "$OUT/steps.log"
  export DX_STORE="$T/live-store/events.sqlite" DX_REPO="$DEMO"
  log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/steps.log"; }
  new_repo "$DEMO" "$BR"; log "LABEL: LIVE FLIGHT (real cursor-agent) branch $BR"
  node "$REC/scripts/dx-install.ts" install --target "$DEMO" --store "$DX_STORE" > "$OUT/install.json" 2>&1; log "install exit $?"
  node "$CLI" dx mark --kind start --flight "$BR" --repo "$DEMO" > "$OUT/mark-start.json" 2>&1; log "mark start exit $?"
  log "cursor-agent $(cursor-agent --version 2>&1)"
  perl -e 'alarm 300; exec @ARGV' cursor-agent -p --trust --force --output-format stream-json --workspace "$DEMO" \
    "In this repo add mul(a,b) to math.mjs, create math.test.mjs using node:test and node:assert covering add and mul, then run: node --test --test-reporter=junit --test-reporter-destination=test-results.xml math.test.mjs . Do not commit." \
    > "$T/live-stream.jsonl" 2> "$OUT/cursor-agent.err"; log "cursor-agent exit $?"
  git add -A -- . ':!.dx-flight-recorder' ':!.cursor' ':!test-results.xml' 2>/dev/null; git commit -qm "add mul + tests"; log "commit exit $?"
  SPOOL="$DEMO/.dx-flight-recorder/cursor-hooks-spool"; log "spool files: $(ls "$SPOOL" 2>/dev/null | wc -l | tr -d ' ')"
  node "$CLI" dx collect --source collector.cursor-hooks --input "$SPOOL" --repo "$DEMO" > "$OUT/collect-hooks.json" 2>&1; log "collect cursor-hooks exit $?"
  node "$CLI" dx collect --source collector/cursor-cli --input "$T/live-stream.jsonl" --repo "$DEMO" > "$OUT/collect-cursor-cli.json" 2>&1; log "collect cursor-cli exit $?"
  if [ -f "$DEMO/test-results.xml" ]; then node "$CLI" dx collect --source collector/local-test --input "$DEMO/test-results.xml" --repo "$DEMO" > "$OUT/collect-local-test.json" 2>&1; log "collect local-test exit $?"; else log "no test-results.xml produced by the agent"; fi
  node "$CLI" dx collect --source collector.git-history --input "$DEMO" --repo "$DEMO" > "$OUT/collect-git.json" 2>&1; log "collect git-history exit $?"
  node "$CLI" dx collect --source collector.git-observation --input "$DEMO" --repo "$DEMO" > "$OUT/collect-gitobs.json" 2>&1; log "collect git-observation exit $?"
  node "$CLI" dx analyze --repo "$DEMO" > "$OUT/analyze.json" 2>&1; log "analyze exit $?"
  SNAP=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.snapshot?.snapshotId||j.snapshotId||"")}catch{}' "$OUT/analyze.json")
  node "$CLI" dx explain --snapshotId "$SNAP" --limit 200 > "$OUT/explain.json" 2>&1; log "explain exit $? snapshot $SNAP"
  node -e '
const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);const types={};let result=null;let toolCalls=0;
for(const l of L){try{const j=JSON.parse(l);const k=j.type+(j.subtype?":"+j.subtype:"");types[k]=(types[k]||0)+1;if(j.type==="tool_call"&&j.subtype==="completed")toolCalls++;if(j.type==="result")result={duration_ms:j.duration_ms,usage:j.usage,is_error:j.is_error}}catch{}}
console.log(JSON.stringify({lines:L.length,types,toolCallsCompleted:toolCalls,result},null,1))' "$T/live-stream.jsonl" > "$OUT/cursor-stream-summary.json"
  node "$REC/scripts/dx-install.ts" uninstall --target "$DEMO" > "$OUT/uninstall.json" 2>&1; log "uninstall exit $?"
  node --input-type=module - "$OUT" > "$OUT/check.json" <<'JS'
// Shared helpers for C14 checkers: read CLI outputs and index analyze metrics by id.
import fs from "node:fs";
import path from "node:path";
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const metricMap = (analyze) => Object.fromEntries((analyze?.metrics ?? []).map((m) => [m.metricId ?? m.id, m.value]));
const walk = (dir) => { const out = []; if (!dir || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); } return out; };
const checker = () => { const results = []; const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
  const finish = (extra) => { const failed = results.filter((r) => !r.pass).length; console.log(JSON.stringify({ ...extra, passed: results.length - failed, failed, results }, null, 1)); process.exit(failed ? 1 : 0); };
  return { ok, finish }; };
// Asserts the LIVE flight: real Cursor usage reached the store and analyze equals the source-reported stream usage.
const [out] = process.argv.slice(2); const { ok, finish } = checker();
const steps = fs.readFileSync(path.join(out, "steps.log"), "utf8");
const analyze = readJson(path.join(out, "analyze.json")); const explain = readJson(path.join(out, "explain.json"));
const m = metricMap(analyze); const s = readJson(path.join(out, "cursor-stream-summary.json"));
ok("cursor-agent exit 0", /cursor-agent exit 0/.test(steps), null);
ok("every install/collect/analyze/explain/uninstall step exit 0", ![...steps.matchAll(/(install|collect|analyze|explain|uninstall)[^\n]* exit (\d+)/g)].some((x) => x[2] !== "0"), null);
ok("real hook spool files captured", Number(/spool files: (\d+)/.exec(steps)?.[1] ?? 0) > 0, /spool files: (\d+)/.exec(steps)?.[1]);
const u = s?.result?.usage;
ok("stream result carried usage", !!u, u);
ok("analyze tokens.input == Cursor-reported inputTokens", u && m["dx.ai-usage.tokens.input"] === u.inputTokens, [m["dx.ai-usage.tokens.input"], u?.inputTokens]);
ok("analyze tokens.output == Cursor-reported outputTokens", u && m["dx.ai-usage.tokens.output"] === u.outputTokens, [m["dx.ai-usage.tokens.output"], u?.outputTokens]);
ok("analyze tokens.cached-input == cacheReadTokens", u && m["dx.ai-usage.tokens.cached-input"] === u.cacheReadTokens, [m["dx.ai-usage.tokens.cached-input"], u?.cacheReadTokens]);
ok("money unavailable (cursor-agent reports no charge)", m["dx.cost.charge.usd"] === null, m["dx.cost.charge.usd"]);
ok("branch commit observed", (m["dx.flight.commits"] ?? 0) >= 1, m["dx.flight.commits"]);
const entries = explain?.entries ?? explain?.timeline?.entries ?? [];
ok("explain timeline non-empty", entries.length > 0, entries.length);
const pick = (k) => m[k] === undefined ? "absent" : m[k];
finish({ label: "LIVE FLIGHT (real cursor-agent)", snapshotId: analyze?.snapshot?.snapshotId ?? null,
  perBranch: Object.fromEntries(["dx.ai-usage.tokens.input","dx.ai-usage.tokens.output","dx.ai-usage.tokens.cached-input","dx.ai-usage.tokens.reasoning","dx.ai-usage.requests","dx.cost.charge.usd","dx.flight.tool-calls","dx.flight.agent.ms","dx.flight.active.ms","dx.flight.branch-age.ms","dx.flight.commits","dx.git.files-changed","dx.git.lines-added","dx.git.lines-deleted","dx.friction.test-runs","dx.friction.test-failures","dx.friction.reworked-files"].map((k) => [k, pick(k)])),
  streamToolCallsCompleted: s?.toolCallsCompleted ?? null });
JS
  local rc=$?
  log "check-live exit $rc"; return $rc
}

RC=0
case "$MODE" in
  adversarial) adversarial || RC=1 ;;
  live) live || RC=1 ;;
  all) adversarial || RC=1; cd "$REC"; live || RC=1 ;;
  *) echo "usage: rehearse.sh [live|adversarial|all]"; exit 2 ;;
esac
USER_HOOKS_AFTER=$(hash_user_hooks)
echo "{\"userHooksBefore\":\"$USER_HOOKS_BEFORE\",\"userHooksAfter\":\"$USER_HOOKS_AFTER\",\"unchanged\":$([ "$USER_HOOKS_BEFORE" = "$USER_HOOKS_AFTER" ] && echo true || echo false),\"mode\":\"$MODE\",\"exit\":$RC}" > "$REC/docs/execution/c14/rehearsal-$MODE.json"
[ "$USER_HOOKS_BEFORE" = "$USER_HOOKS_AFTER" ] || RC=1
exit $RC
