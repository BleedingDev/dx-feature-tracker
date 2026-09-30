#!/bin/bash
# C16 final fence: rerun the release checks against the CURRENT working tree and write a receipt.
#   /Users/satan/bin/owned-temp-dir --run c16-fence -- bash docs/execution/c16/final-fence.sh
# Read-only except: turbo build outputs (dist/) and docs/execution/c16/fence-receipt.json.
# Adversarial replay is C14's script (it writes C14's folder): bash docs/execution/c14/rehearse.sh adversarial
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; cd "$ROOT"
T="${OWNED_TEMP_DIR:?run under owned-temp-dir}"
digest() { (git rev-parse HEAD; git status --porcelain --untracked-files=all | awk '{print $NF}' | sort | while read -r f; do [ -f "$f" ] && shasum -a 256 "$f"; done) | shasum -a 256 | cut -d' ' -f1; }
H0=$(shasum -a 256 "$HOME/.cursor/hooks.json" 2>/dev/null | cut -d' ' -f1)
D0=$(digest); S0=$(date +%FT%T%z)
pnpm exec turbo run check test build --continue --output-logs=errors-only > "$T/fence.log" 2>&1; FENCE=$?
FAILED=$(grep -E '^Failed:' "$T/fence.log" | sed 's/^Failed: *//')
bash docs/execution/c15/audit-claims.sh > "$T/audit.log" 2>&1; AUDIT=$?
AUDITLINE=$(tail -1 "$T/audit.log")
D1=$(digest); H1=$(shasum -a 256 "$HOME/.cursor/hooks.json" 2>/dev/null | cut -d' ' -f1)
node -e 'const [s,d0,d1,f,fl,a,al,h0,h1]=process.argv.slice(1);const ok=f==="0"&&a==="0"&&d0===d1&&h0===h1;
require("fs").writeFileSync(process.argv[10],JSON.stringify({schema:"dxfr-c16-fence/v1",startedAt:s,finishedAt:new Date().toISOString(),
digestBefore:"sha256:"+d0,digestAfter:"sha256:"+d1,treeStable:d0===d1,
commands:[{argv:["pnpm","exec","turbo","run","check","test","build","--continue"],exit:+f,failed:fl||null},{argv:["bash","docs/execution/c15/audit-claims.sh"],exit:+a,result:al}],
userCursorHooksUnchanged:h0===h1,verdict:ok?"fence-pass":"no-go"},null,1)+"\n")' \
  "$S0" "$D0" "$D1" "$FENCE" "$FAILED" "$AUDIT" "$AUDITLINE" "$H0" "$H1" "$ROOT/docs/execution/c16/fence-receipt.json"
cat "$ROOT/docs/execution/c16/fence-receipt.json"
[ "$FENCE" = 0 ] && [ "$AUDIT" = 0 ] && [ "$D0" = "$D1" ] && [ "$H0" = "$H1" ]
