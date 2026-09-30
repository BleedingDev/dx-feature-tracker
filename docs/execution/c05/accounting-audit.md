# C05 accounting audit findings (B30 ai-usage ledger)

Audited: `packages/core/src/dx/metrics/ai-usage/{normalize,ledger,metric}.ts` (B30).
Test: `packages/core/test/dx/audits/c05.test.ts`, fixture `packages/core/test/dx/fixtures/c05/accounting-audit.json` (synthetic, origin=fixture).
Check: `pnpm --filter @rat-stack/core exec vitest run test/dx/audits/c05.test.ts` -> exit 0, 10 passed (2026-09-30 14:27 CEST).

## Verified correct
- Cache categories: `cacheRead` -> cached-input, `cacheWrite` -> cache-write, reasoning and input stay separate; no `total` is synthesized when the source reports none.
- Keyed duplicate import (same eventId + requestId twice) is counted once (requestCount 1, 3 rows collapsed).
- Global ledger collapses one request reported on two branches (107, not 207); null branch lands in `(no branch)`.
- Absent tokens/costs (null) are `unavailable` with a reason, never 0; an explicit source-reported 0 stays 0 / measured.
- Usage CSV row carrying only `payload.requestKey` next to SDK detail for the same slot is left unresolved, not summed.
- Stop hook (verified semantics) + local DB + Entire sharing session+generation collapse to one request; hook is preferred by precedence.

## Defects (pinned as KNOWN DEFECT tests asserting current wrong values; owner B30)
1. **Duplicate unkeyed import double counts.** Same eventId imported twice with no request/session keys: input = 18 instead of 9. Fix: dedupe rows by (evidenceId, slot) in `normalizeAiUsage`/`accountAiUsage` before summing.
2. **Per-branch ledgers double count cross-branch requests.** `accountAiUsageByBranch` splits by branch before request dedup, so a request reported on `feature/a` (sdk) and `main` (local-db) counts on both: per-branch sum 207 vs global 107. Fix: dedupe globally, then attribute each collapsed group to the preferred member's branch (or report as mixed-branch/unassigned).
3. **Cross-namespace keys never join.** Dashboard row keyed `request:r9` (requestId only) and hook/DB/Entire keyed `session:conv9:id:r9` (generationId) are summed: 1000 input instead of 500. Fix: also emit a bare `request:<generationId>` key, or a `generation:<id>` key both sides share, when semantics confirm generationId == requestId.

## Notes / not tested
- Per-slot precedence can mix sources inside one request (e.g. input from sdk, cache-write from claude-jsonl). Acceptable only if every source uses the same input semantics (inclusive vs exclusive of cached tokens); no source currently declares this, so mixed-semantics input is not detectable.
- `payload.requestKey` is read for scope but not used as a match key (defect 1-adjacent: keyed CSV can never collapse, only go unresolved).
- Live Cursor data not audited here; rerun at G02 against the enabled real ledger.
