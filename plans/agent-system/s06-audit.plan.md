---
name: dft-agent-s06-audit
overview: "Independently verify the driving loop, evidence accuracy and bounded resource use"
todos:
  - id: s06-behavior
    content: "Audit the connected orient/inspect/act/verify/resume/learn workflow"
    status: completed
  - id: s06-resources
    content: "Measure named tasks and report remaining correctness/resource gaps"
    status: completed
isProject: false
---

# dft-agent-s06-audit

## Execution notes

Depends on S05. Own only isolated s06 audit tests/fixtures and handoff. Return concrete fixes to source owners. You are not alone. Do not edit production files or silently repair another owner's implementation.

Use a labelled fixture with ambiguous account association, branch switch/path reuse, missing source, redacted evidence, overlapping attempts, changed prices, concurrent import and conflicting lesson evaluation. Complete the driving loop against frozen capability contracts, then repeat with separately selected real inputs without merging origins.

Independently inspect basis/revision binding, historical reproduction limits, stale plans, authorization, idempotency, interrupted/spooled work, missing refs, partial totals, paging and learning applicability. Reopen in a fresh process and recover every handle. Test deletion/restore only on owned fixture stores.

Measure one cold and one warm run of each named task: orient, branch summary, disputed-charge drilldown, next timeline page, incremental import and investigation resume. Record examined rows, decoded bytes, requests, output bytes, calls, elapsed time and peak memory when observable. Compare identical fixture/scopes and state the baseline. Resource improvement is measured work avoided, not inferred user productivity or saved engineering time.

Contract budgets are hard pass criteria. Performance benchmarks report observed values and tolerances established before the run; they cannot establish universal latency. No live paid model calls or cross-host CLI are necessary for the fixture audit.

## Completion criteria

- `pnpm --filter @rat-stack/core exec vitest run test/dx/s06.test.ts` passes all connected-system and adversarial cases.
- A bounded summary allows a fresh agent to choose the next supported query without a full transcript or store scan.
- Cold/warm measurements show actual work and enforce no-network recorded mode, incremental acquisition and bounded continuation.
- Every gap has an owner/disposition. Live and host claims match observed receipts; unavailable data remains visible.
- Handoff gives the frozen candidate/contract digests and an independent verdict for S07.
