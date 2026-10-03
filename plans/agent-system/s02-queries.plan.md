---
name: dft-agent-s02-queries
overview: "Make recorded queries bounded, reproducible and fully traceable"
todos:
  - id: s02-basis
    content: "Bind attribution, reconciliation, price and metric inputs to analysis bases"
    status: completed
  - id: s02-views
    content: "Add progressive query views, shared disclosures, continuations and deltas"
    status: completed
isProject: false
---

# dft-agent-s02-queries

## Execution notes

Start after S00 freezes ports; implement against fake storage concurrently with S01. R00 verifies the real composition after both finish. Own only manifest query/report/usage/correlation/cost paths, isolated s02 tests/fixtures and handoff. You are not alone in the codebase. Read [agent queries](../../docs/architecture/agent-queries.md).

Start at `reports/analyze/select.ts::selectAnalyzeSnapshot`, `usage/load.ts::usageFacts`, `usage/derive.ts::deriveUsageRows`, `usage/query.ts::queryUsage`, explain timeline and evidence resolver. Verify current signatures before edits. Preserve observations and reconcile through basis-bound mappings; pinned reads do not reattribute through current Git state. Capture exact price-sheet content and calculation definitions used.

Expose winner/candidate sources and per-field disagreement. Timing-only account links remain provisional, not strong dedupe identity. Keep observed account totals and unexplained remainder alongside reconstructed branch shares. Version changed reconciliation so old bases/results remain explainable.

Implement summary/detail modes, typed references, arithmetic and attribution drilldowns, stable indexed paging, independently bounded groups/series and work continuations. Retain existing evidence missing/disclosure data. Compare bases by evidence, coverage, interpretation, definition, prices and scope; label incompatible comparisons. Recorded-only/cached-price reads perform no acquisition/network and only explicitly permitted bounded derivation/basis writes.

Push selectors into fact selection. Reuse per-family refresh and cache ordered projections. A page must not re-sort/decode all events. Budget exhaustion cannot turn partial aggregation into an apparently complete total. Return measured work, omitted counts and continuation.

## Completion criteria

- `pnpm --filter @rat-stack/core exec vitest run test/dx/s02.test.ts` covers price/policy drift, branch/path reuse, midnight pagination, missing/withheld refs, provisional account joins and incompatible comparisons.
- Instrumented fixtures prove query limits bound examined/decoded work as well as output. Test top-N separately from partial aggregation and series truncation.
- Existing usage, price-book and explain/evidence behavioral cases remain correct through the catalog's owner checks. Add tests only for genuine behavioral gaps.
- The same basis and projection have the same semantic result digest across repeated calls; unknown legacy reproduction is explicit.
- Handoff lists supported views, schema versions, resource measurements and any output fields S05 must preserve.
