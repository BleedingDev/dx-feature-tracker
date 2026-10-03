# Agent query contract

Status: execution under validation. S00 froze the interfaces; S02 completed its owned query checks, and R00 has a read implementation checkpoint. The candidate build, connected behavior checks and release gate remain separate. Runtime capability discovery decides what an installed build supports. Parent design: [agent system](agent-system.md). Implementation: S00, S01, S02, R00 and S05 in the [follow-up plans](../../plans/agent-system/README.md).

## Read policy and orientation

The negotiated profile is `dx.agent.v1`. Existing read contracts accept it in an optional `agentQuery` wrapper. The legacy usage `agent` field remains an agent filter. Scope and view selectors stay in the capability's ordinary input fields; the composition resolves omitted selectors and records the resulting scope.

All four policies are required in `agentQuery.policies`:

| Policy | Values and effect |
| --- | --- |
| Acquisition | `recorded-only` uses stored observations; `refresh-selected` requests selected acquisition. |
| Prices | `pinned` reuses basis prices; `cached-only` permits cached prices; `refresh-selected` requests selected price refresh. |
| Derivation | `ready-only` requires a retained view; `bounded-refresh` permits derivation within the request budget. |
| Learning | `hidden` withholds learning references; `selected-scope` permits scoped recall where the active composition supports it. |

Recorded-only acquisition with pinned or cached-only prices performs no acquisition or network request. It can still write bounded basis, result and cursor metadata, which the response reports. These logical effect counts exclude SQLite connection initialization, migrations and writer-owner lease metadata. They are not a claim of zero filesystem writes by the process. The recorded query runner does not execute acquisition or price refresh. Those require selected operations; an unsupported request returns a typed reason. A missing ready view returns `view-not-ready` with recovery information, without an unlimited rebuild.

Omitting `agentQuery` retains the legacy contract's behavior. Agent guidance passes `profileVersion`, `policies` and the full `budget` explicitly. Optional `basisId`, `previousBasisId` and `detail: summary | expanded` select reuse, comparison and presentation. The response acknowledges the profile and effective policies. Unsupported profiles, policies and excess negotiated fields reject at the input boundary. Human auto-sync remains a separate compatibility path. `--no-sync` alone is not an offline guarantee.

The agent `dx_status` path reads bounded cached descriptor and coverage metadata. It can return an indexed latest basis header for the exact resolved scope, with that basis's original window and resume reference. It performs no event-history scan, session-file discovery, current Git attribution or price initialization. An unpinned request can resolve current repository/worktree scope through bounded Git metadata. A retained basis skips that resolver and preserves its original scope and window. A detailed source probe is a selected operation. Installed hooks without observed emissions do not establish verified capture.

`dx_status` retains `StatusReport` with descriptors, store information and contract version/digest; the negotiated response adds `context`. That context states the resolved scope, effective read policies, freshness, coverage, measured work and available next references. Installation, host approval, readability and observed capture remain distinct concepts. A richer combined installation-status record is a future extension, not a field promised by `dx.context.v1`. Wider repository or source selection remains explicit.

## Pin the full basis

`AnalysisBasis` has schema version `dx.basis.v1` and binds:

| Input | What must remain fixed |
| --- | --- |
| Identity and query | Store generation, repository/worktree identity, branch/flight selection, normalized filters, absolute half-open window, timezone and query clock |
| Evidence | Store event watermark, selected event digest, persisted source coverage and acquisition receipts, origin mix |
| Interpretation | Contract/schema version, enabled descriptor versions, reconciliation/attribution policy versions and all Git/ref/mapping observations those policies used |
| Calculation | Metric definitions and implementation versions, price-sheet content hashes and effective dates, relevant configuration digest |
| Compatibility | Supported result schemas/projection versions and retained interpretation inputs |

The basis ID identifies evidence and interpretation inputs. Each computed view binds that basis, capability, normalized view parameters and result/projection version. It has its own result reference, canonical digest, completeness and retained ordered projection. Analyze, a usage grouping and a request drilldown can share a basis while having different results. Page size and presentation layout do not change that view's digest. Partial aggregation has a partial result identity and cannot impersonate its completed result. A reference belongs to a store generation and scope, so restoring/resetting a store cannot make an old handle resolve to unrelated data.

Relative dates resolve once. A `7d` query followed tomorrow uses the same absolute bounds when it reuses a basis. Evidence arriving after its watermark creates a new basis. A pinned answer never consults today's filesystem to replace historical worktree identity or attribution inputs.

Persist sufficient derived results and interpretation inputs to reproduce a basis without maintaining executable copies of every prior metric module. If a requested detail was not retained and cannot be reproduced under the pinned versions, return `basis-incompatible` or `basis-content-unavailable`. Existing snapshots are `evidence-selection-only` until an upgrade can demonstrate full binding. Never retroactively claim stronger reproducibility or silently use latest.

`dx_analyze`, `dx_usage`, `dx_explain` and `dx_evidence` accept `agentQuery.basisId`. A newly created basis may write declared bounded metadata/results; follow-up reads reuse it. `previousBasisId` requests a metadata comparison with the selected current basis. The difference classifies evidence, coverage, attribution, definitions, prices, scope and window changes, and states comparability with reasons. Detailed `changedRefs`, `unchangedCount` and invalidated result lists require a separate bounded evidence comparison. V1 discloses their unavailability rather than inventing a delta. Arithmetic across incompatible units or windows requires an explicit non-comparable interpretation.

## Common response context

Negotiated analyze, usage, explain and evidence return `AgentQueryOutput`, rather than only adding fields to their legacy result:

```text
AgentQueryOutput
  context
  result: retained result metadata, query/result digests and completeness
  view: summary, items, series, disclosures, nextCursor, nextSeriesCursor
  resolutions: per-reference states and reasons
  difference: metadata basis comparison or null
```

`context` has schema version `dx.context.v1`. The [query schemas](../../packages/core/src/dx/model/agent-query.ts) define its fields:

```text
context
  schemaVersion, profileVersion, effectivePolicies
  id, storeId, storeGeneration, basisId, resultRef, resultDigest, reproducibility
  scope: repoId, worktreeId, branchSelection, flightId, tools, sources
  window: sinceInclusive, untilExclusive, timezone, resolvedAt
  revisions: evidence, derivation, attribution, definitions, prices, config
  coverage: source states and gaps
  originMix
  freshness: source observed times, last success, stale/unsettled reasons
  completeness: aggregation, items, series, missingRefs, omittedItems, omittedSeries, reason
  effects: acquisitionReceiptIds, cacheWrites, basisWrites, networkRequests
  resources: measured work, applied limits, limitReached, continuation
  next: typed references
```

The context's `scope` also carries `resolution`, which explains omitted-selector resolution. `reproducibility` is `retained-inputs`, `retained-results-only`, `evidence-selection-only` or `none`. The result metadata has version `dx.result.v1`; the current ordered view decoder has version `dx.projection.v1`. Effect Schema defines these shapes and transport schemas derive from it.

`aggregation` distinguishes complete, partial and unavailable. Item truncation can coexist with a complete total only when the full aggregation actually completed. `other` is an aggregation group, not a paging cursor. Series buckets and stack cardinality have independent bounds. A complete group total cannot hide an incomplete series. Omitted stack details retain complete bucket totals and report `omittedStacks` in the view.

The required budget fields are `maxFacts`, `maxDecodedBytes`, `maxElapsedMs`, `maxOutputBytes`, `maxItems`, `maxSeriesBuckets`, `maxStacks` and `maxNetworkRequests`. V1 schema ceilings are 100,000 facts, 64 MiB decoded bytes, 60 seconds, 4 MiB output, 500 items, 366 series buckets, 50 stacks and 100 network requests. The producer measures examined rows, UTF8 decoded bytes, elapsed time and the whole serialized response. Unknown measurements remain null. The 2048-byte schema floor does not guarantee that a particular context fits. Reject an insufficient cap instead of discarding mandatory scope, gaps or continuation metadata.

## Summary before expansion

| Capability | Compact answer | Focused expansion |
| --- | --- | --- |
| `dx_status` | Context, readiness, freshness, policies and compatible handles | One selected source's probe or operation descriptor |
| `dx_analyze` | Defined totals, important gaps, disagreements and a few supported findings | One metric's arithmetic or one finding's supporting and conflicting observations |
| `dx_usage` | Requested groups, separate ledgers, `other`, unattributed remainder and coverage | A group's deduplicated requests, field winners and candidate account links |
| `dx_explain` | A bounded timeline or requested relationship | Request/session/metric/finding relations within the same basis |
| `dx_evidence` | Allowlisted metadata, provenance and explicit missing references | Selected permitted redacted fields within the same basis |

Typed references include store ID, generation, kind, version and optional basis/revision. The consuming capability validates the kinds and versions it supports. This avoids guessing filenames or replaying a transcript to follow a supported claim. Contradictory evidence remains reachable beside supporting evidence.

The table describes the intended summary-to-expansion progression. V1 exposes the existing capability selectors, structured views and supported reference resolution. A universal relationship query across every reference kind is a future extension; enumeration in the reference schema alone does not establish a public resolver.

For field winners, return the rule, winner source, candidate source references, disagreement state and measurement semantics. A timing-only account/request match remains provisional. Keep account totals, assigned share and unexplained remainder distinct. Ambiguous matches never become exact duplicate identities.

Explain and evidence retain their lower-level disclosures. Negotiated reference resolution states are `found`, `invalid`, `missing-in-basis`, `withheld`, `over-budget` and `stale-generation`, each with a reason when needed. Resolve visibility under the selected scope. A withheld reference must not expose another scope's payload. An empty list is not evidence that no observations exist. Timeline entries beyond the legacy 500-entry uncertainty analysis keep conservative uncertainty flags and a disclosure.

## Pagination, deltas and recovery

An opaque cursor binds store ID/generation, basis ID, semantic query digest, result ID, projection version, axis and stable order position. Mutable work also binds store revision. Validate all bindings. Pass the cursor in the capability's top-level `cursor` field and repeat semantic view selectors such as `groupBy`, `metrics` and `stackBy`. Source filters and the resolved window come from the basis. Detail mode and page budgets can change without changing the result digest. `view.nextCursor` pages items; `view.nextSeriesCursor` pages series.

Pages keep the resolved window, interpretation, captured prices and totals while another agent imports. Capped metadata reads and indexed retained item/series rows avoid decoding or sorting the full retained basis and view. Originally invalid, missing or withheld reference states remain part of the retained result; warm pages do not replace them with current-store lookup results.

`context.resources.continuation` handles work-budget exhaustion separately from output pagination. V1 explicitly restarts bounded computation at the same watermark, captured prices and absolute window. It does not promise incremental partial-aggregation checkpoints. A partial accumulation never becomes a complete total. Clients preserve this continuation, both output cursor lanes, disclosures and reference resolutions across CLI, MCP and dashboard presentation.

Reuse unchanged bases and computed views. Bound retained projections by bytes and explicit retention policy; eviction returns a content-unavailable state or permits bounded reconstruction under the same versions. Cache retention never silently deletes source evidence or authored learning.

`AgentError` carries `code`, `retryable`, `ref`, `expectedRevision`, `currentRevision`, `message` and `recovery { action, ref }`. Query codes include `invalid-selector`, `scope-denied`, `basis-not-found`, `basis-incompatible`, `basis-content-unavailable`, `cursor-mismatch`, `expired-cursor`, `view-not-ready`, `budget-exhausted`, `source-unavailable`, `store-busy` and `stale-generation`. Recovery actions are `retry`, `replan`, `select-scope`, `refresh-view`, `use-current-generation` or `none`. Existing compatible tagged failures remain available. Errors do not echo credentials or raw evidence. Unknown legacy snapshots and expired cursors remain distinct.

## Behavioral checks

- Analyze and explain with one basis stay identical after branch rename, worktree removal/path reuse, new ingestion and a price update. Unsupported historical detail returns a typed limitation.
- A relative-date page sequence crossing midnight keeps its first window and timezone.
- Evidence responses account for every requested ID, including missing, withheld and truncated IDs.
- A timing-only account association exposes provisional allocation and preserves the account ledger and remainder.
- A bounded summary retains gaps and uncertainty. Output truncation leaves complete totals intact; aggregation exhaustion labels totals partial.
- Cheap status performs no session scan, import or price fetch. The acknowledged recorded-only plus cached/pinned-price profile performs no network and only declared bounded cache/basis writes.
- Identical CLI/MCP/dashboard capability calls return the same semantic result digest. Their presentation differences do not change arithmetic.
