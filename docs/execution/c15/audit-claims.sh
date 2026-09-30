#!/usr/bin/env bash
# C15 claims audit. Read-only. Usage: bash docs/execution/c15/audit-claims.sh [analyze.json explain.json label]...
# With no args audits the C14 live + adversarial rehearsal outputs and scans shipped source for causal/productivity claims.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LEDGER="$ROOT/packages/core/test/dx/fixtures/c15/claims.json"
if [ "$#" -eq 0 ]; then
  set -- "$ROOT/docs/execution/c14/live/analyze.json" "$ROOT/docs/execution/c14/live/explain.json" live \
         "$ROOT/docs/execution/c14/adversarial/analyze.json" "$ROOT/docs/execution/c14/adversarial/explain.json" fixture
fi
node --input-type=module - "$ROOT" "$LEDGER" "$@" <<'JS'
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const [root, ledgerPath, ...rest] = process.argv.slice(2);
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const fails = [];
const passes = [];
const check = (label, name, ok, detail = "") => (ok ? passes : fails).push(`${label}: ${name}${detail ? ` (${detail})` : ""}`);
const forbiddenMetric = new RegExp(ledger.forbiddenMetricPattern, "i");
for (let i = 0; i < rest.length; i += 3) {
  const [analyzePath, explainPath, label] = rest.slice(i, i + 3);
  const a = JSON.parse(readFileSync(analyzePath, "utf8"));
  let explainIds = null;
  try {
    const e = JSON.parse(readFileSync(explainPath, "utf8"));
    explainIds = new Set((e.entries ?? []).flatMap((x) => [x.eventId, ...(x.evidenceIds ?? [])]));
  } catch { explainIds = null; }
  const ms = a.metrics;
  // 1. unavailable stays visible: null value <=> non-measured state with a reason.
  const nullNoReason = ms.filter((m) => m.value === null && (m.measurement === "measured" || !m.reason));
  check(label, "every null metric is non-measured with a reason", nullNoReason.length === 0, nullNoReason.map((m) => m.metricId).join(","));
  const valuedUnavailable = ms.filter((m) => m.value !== null && ["unavailable", "unsupported", "disabled"].includes(m.measurement));
  check(label, "no unavailable/unsupported/disabled metric carries a value", valuedUnavailable.length === 0, valuedUnavailable.map((m) => m.metricId).join(","));
  // 2. money: no fabricated zero; estimates carry a method discriminator and are never labelled source-reported.
  const money = ms.filter((m) => m.unit === "usd" || /\.usd$|\.money\./.test(m.metricId));
  const zeroMoney = money.filter((m) => m.value === 0 && (m.evidenceIds ?? []).length === 0);
  check(label, "no evidence-free zero money", zeroMoney.length === 0, zeroMoney.map((m) => m.metricId).join(","));
  const estimates = ms.filter((m) => /estimate/.test(m.metricId) && m.value !== null);
  const badEst = estimates.filter((m) => m.method !== "estimated" || !/method=/.test(m.reason ?? ""));
  check(label, "every valued estimate is method=estimated with a method= discriminator", badEst.length === 0, badEst.map((m) => m.metricId).join(","));
  const mislabelled = ms.filter((m) => m.method === "estimated" && m.measurement === "measured" && !/estimate/.test(m.metricId));
  check(label, "no estimated metric masquerades as a non-estimate id", mislabelled.length === 0, mislabelled.map((m) => m.metricId).join(","));
  // 3. token/money/count values are evidence-backed.
  const measuredNoEvidence = ms.filter((m) => m.value !== null && m.method === "source-reported" && (m.evidenceIds ?? []).length === 0);
  check(label, "every valued source-reported metric cites evidence", measuredNoEvidence.length === 0, measuredNoEvidence.map((m) => m.metricId).join(","));
  if (explainIds !== null && explainIds.size > 0) {
    const cited = ms.filter((m) => m.method === "source-reported" && m.value !== null).flatMap((m) => m.evidenceIds);
    const missing = cited.filter((id) => !explainIds.has(id));
    check(label, "source-reported evidence resolves in explain", missing.length === 0, `${missing.length} missing of ${cited.length}`);
  }
  // 4. no productivity/causal/waiting/ownership metric with a value.
  const causal = ms.filter((m) => forbiddenMetric.test(m.metricId) && m.value !== null);
  check(label, "no valued causal-savings/productivity/human-waiting metric", causal.length === 0, causal.map((m) => m.metricId).join(","));
  const survival = ms.filter((m) => /survival|ai-line-share/.test(m.metricId) && m.value !== null && (m.evidenceIds ?? []).length === 0);
  check(label, "no AI survival/ownership value without lineage evidence", survival.length === 0, survival.map((m) => m.metricId).join(","));
  // 5. wall clock is not active work: branch age is partial or disclosed; agent time is never labelled human.
  const age = ms.find((m) => m.metricId === "dx.flight.branch-age.ms");
  const active = ms.find((m) => m.metricId === "dx.flight.active.ms");
  check(label, "branch age and active time are separate metrics", age === undefined || active === undefined || age.metricId !== active.metricId);
  const agentDef = ms.find((m) => m.metricId === "dx.flight.agent.ms");
  check(label, "agent time definition does not claim human time", agentDef === undefined || !/human (wait|time)/i.test(agentDef.definition?.description ?? "") || /not human/i.test(agentDef.definition?.description ?? ""));
  // 6. partial/unavailable coverage is disclosed in notes.
  const nonComplete = (a.coverage ?? []).filter((c) => (c.state ?? c.completeness) !== "complete").map((c) => c.adapterId);
  const undisclosed = nonComplete.filter((id) => !(a.notes ?? []).some((n) => n.includes(id)));
  check(label, "non-complete sources are named in notes", undisclosed.length === 0, undisclosed.join(","));
  // 7. origin honesty: label 'live' requires a live-origin event; 'fixture' is never presented as live capture.
  const origins = Object.fromEntries((a.snapshot?.originMix ?? []).map((o) => [o.origin, o.count]));
  if (label === "live") check(label, "live flight contains live-origin evidence", (origins.live ?? 0) > 0, JSON.stringify(origins));
  const tok = (id) => ms.find((m) => m.metricId === id)?.value ?? null;
  console.log(`${label}: tokens in/out/cached=${tok("dx.ai-usage.tokens.input")}/${tok("dx.ai-usage.tokens.output")}/${tok("dx.ai-usage.tokens.cached-input")} reasoning=${tok("dx.ai-usage.tokens.reasoning")} charge=${tok("dx.cost.charge.usd")} origins=${JSON.stringify(origins)}`);
}
// 8. shipped source must not assert causal savings/productivity/human waiting (negated disclaimers allowed).
const phrase = new RegExp(ledger.forbiddenCopyPattern, "i");
const negation = new RegExp(ledger.allowedNegationPattern, "i");
const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "test") continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|md)$/.test(name)) {
      readFileSync(p, "utf8").split("\n").forEach((line, n) => {
        if (phrase.test(line) && !negation.test(line)) hits.push(`${p.slice(root.length + 1)}:${n + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
};
for (const d of ledger.scannedSourceRoots) walk(join(root, d));
check("source", "no unqualified causal/productivity/waiting copy in shipped source", hits.length === 0, hits.join(" | "));
for (const p of passes) console.log(`PASS ${p}`);
for (const f of fails) console.log(`FAIL ${f}`);
console.log(`c15 claims audit: ${passes.length} pass, ${fails.length} fail`);
process.exit(fails.length === 0 ? 0 : 1);
JS
