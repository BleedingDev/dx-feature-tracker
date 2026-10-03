# dx-feature-tracker contracts v1 (A03, frozen)

Scope: this page preserves the original capability/event-v1 checkpoint and records the S00 agent contract freeze below. Current events use v2; usage retains its independent v1 contract. The new agent schemas are frozen interfaces. Runtime support still requires producer behavior and integration evidence, so this freeze alone does not advertise installed capabilities.

Status: FROZEN at interface checkpoint. Owner: A03 contract steward. Version tag `dx.contracts.v1`.
Changes after freeze: additive optional fields only, via A03; breaking changes need a v2 tag and gate approval.

Code lives in `packages/core/src/dx/model/` (data schemas, Effect Schema) and `packages/core/src/dx/contracts/`
(service interfaces, capability contracts, typed errors, compile-only fakes).

**Naming (lint-enforced):** every schema value is `XSchema`; its decoded type is `X` (`type X = typeof XSchema.Type`).
Branded IDs: `EventIdSchema.make("...")` produces an `EventId`. **No barrels** (oxc no-barrel-file): import each symbol from
its defining file, e.g. `import type { DxEventEnvelope } from "../../model/event.js"`,
`import { EventStore } from "../../contracts/event-store.js"`. One error class per file (`contracts/error-*.ts`).
No comments in source (repo lint); semantics live here.

The legacy checkpoint digest is `CONTRACT_DIGEST` in `contracts/version.ts`. It preserves the original source checkpoint and historical fixtures; it is not a current full-tree digest. The separately frozen agent digest below binds the new negotiated contracts.

## Honesty rules encoded in types

- Every measured number is `number | null`; null means **unavailable** and must carry a `reason`. Zero is a measured zero.
- `origin` (where the record came from) is separate from `method` (how a value was calculated).
  Origins: `live | imported | replay | fixture | synthetic`. Fixture/synthetic never masquerade as imported/live.
- Value methods: `source-reported | observed | derived | estimated | user-claimed`. An estimated token count can
  never share a field with a source-reported one without this discriminator.
- `MeasurementState`: `measured | partial | estimated | unavailable | unsupported | disabled`.
- `AttributionState`: `strong | provisional | unassigned | not-applicable`. Absence of AI evidence is not human evidence.

## Model (`model/`)

| File | Exports |
| --- | --- |
| `ids.ts` | branded `EventId, FlightId, SnapshotId, EvidenceId, DescriptorId, MetricId, RequestKey, TurnKey, OverlapGroupId` |
| `common.ts` | `Origin, Acquisition, ValueMethod, MeasurementState, AttributionState, IsoTimestamp, Unavailable` |
| `event.ts` | `DxEventEnvelope` (v1 envelope), `EventKind`, `FlightContext`, `EventIdentity`, `EvidenceRef`, `FieldSemantics`, `EventBatch` |
| `coverage.ts` | `SourceCoverage`, `CoverageState`, `SourceGap`, `CollectCursor` |
| `ai.ts` | `AiRequestIdentity`, `AiTurnIdentity`, `AiUsageMeasurement`, `OverlapGroup`, `OverlapPolicy`, `LedgerKind` |
| `interval.ts` | `Interval`, `IntervalUnionResult`, `IntervalHelpers` (interface; B27 implements) |
| `metric.ts` | `MetricValue`, `MetricResult`, `MetricDefinitionRef`, `FindingCandidate` |
| `snapshot.ts` | `SnapshotManifest`, `SnapshotSelector` |
| `descriptor.ts` | `ModuleDescriptor`, `ModuleKind`, `ModuleReadiness` |
| `probe.ts` | `ProbeReceipt` (non-content) |
| `report.ts` | `AnalyzeReport`, `ExplainTimeline`, `TimelineEntry`, `EvidenceItem`, `StatusReport` |

### Event envelope v1 (`DxEventEnvelope`)

`schemaVersion: "dx.event.v1"`, `eventId` (stable, deterministic: sha256 of adapterId + upstreamKey + kind),
`adapterId`, `adapterVersion`, `sourceVersion: string | null`, `kind`, `upstreamKey`, `occurredAt: iso | null`,
`occurredAtPrecision: exact | second | minute | day | unknown`, `observedAt: iso`, `origin`, `acquisition`,
`context: FlightContext` (repoCommonDir, worktreePath, branch, headSha, flightId: all nullable),
`identity: EventIdentity` (sessionId, generationId, requestId, turnId, commitSha, githubRunId, githubAttempt, prNumber: all nullable),
`evidence: EvidenceRef` (hash sha256, ref string, bounded boolean), `payload: Record<string, unknown>` (bounded; <= 16 KiB serialized
is the producer's duty), `fieldSemantics: ReadonlyArray<FieldSemantics>` (field, method, unit, raw source name, note).

### Coverage (`SourceCoverage`)

adapterId, state (`complete | partial | none | unsupported | disabled | error`), window from/to nullable,
expectedItems/observedItems nullable, gaps (code + message), watermark nullable.
Collectors return `EventBatch = { events, coverage, cursor }`.

### AI identity and overlap policy (frozen)

- Canonical request key: `source:<sourceKind>:request:<requestId>` when a source request ID exists; else
  `source:<sourceKind>:session:<sessionId>:turn:<turnIndex|generationId>`; else no canonical key (row is `unassigned`).
- Turn key: `<sessionId>:<generationId|turnIndex>`. Duplicate stop emissions with identical turn key collapse.
- Precedence (per request key, highest first; `AI_SOURCE_PRECEDENCE`): `usage-csv > dashboard-json > sdk > provider-receipt > hooks-stop > local-db > claude-jsonl > codex-session > opencode > entire > transcript-estimate`.
- Overlap policy: measurements sharing a strong key collapse into one `OverlapGroup` with `resolution: collapsed`, keeping all
  member evidence IDs. Aggregate ledgers vs detail ledgers that may overlap are `alternative` ledgers, never summed.
  Unresolved overlap stays `unresolved` and visibly unassigned. Cumulative windows are differenced only after
  `cumulativeVerified: true`. B26 correlates, B30 accounts, C05 tests.
- Token categories keep raw source names (`rawCategory`) plus normalized category
  (`input | cached-input | cache-write | output | reasoning | total | other`).
- Money: `charge` (billed), `metered`, `list-price-estimate`, `subscription-allocation`, `unallocated` are separate `LedgerKind`s.

### Interval helper API (frozen; B27 implements, B29 consumes)

```ts
interface IntervalHelpers {
  union(intervals: ReadonlyArray<Interval>): IntervalUnionResult   // merged, totalMs, censored count, clockErrors
  sum(intervals: ReadonlyArray<Interval>): { totalMs: number | null; excluded: number }
  overlap(a: Interval, b: Interval): number | null
}
Interval = { startMs: number | null, endMs: number | null, evidenceIds, label }
```
Null start/end -> censored, excluded from arithmetic and counted; end < start -> clockError.

### Metric output (`MetricResult`)

metricId, definition {id, version, description, unit}, value nullable, unit, numerator/denominator nullable,
checkpoint nullable, evidenceIds, coverage (SourceCoverage[]), measurement, attribution, method, asOf, reason nullable.
Zero denominator => value null, measurement `unavailable`, reason required.

### SnapshotManifest (durable)

This is the original design guarantee. Legacy snapshot selection does not fully bind all attribution/price/implementation inputs and retains evidence-selection-only reproducibility. Implemented [full analysis bases](../architecture/agent-queries.md#pin-the-full-basis) provide the negotiated query path with their documented retention and compatibility limits. Do not infer that stronger guarantee from a legacy snapshot ID.

snapshotId, eventWatermark, selector {flightId|repoCommonDir|branch|from/to}, contractDigest, contractVersion,
enabledDescriptors [{id, version}], metricDefinitions [{id, version}], originMix {origin -> count}, createdAt.
Analyze persists snapshot metadata only; never collects/syncs implicitly. Unknown/expired snapshot -> `SnapshotNotFound` error.
Requesting "latest" returns its ID plus `changedSince` disclosure; never silently substitutes.

### Descriptor

id, version, kind (`collector | correlation | metric | report | service | surface`), owner (node ID),
readiness (`ready | degraded | unsupported | disabled`), requiredInputs, supportedFields, gaps, fixtureIds, contractVersion.
Disabled descriptors remain listed in status; integration registers only `ready`/`degraded` tested modules.

### ProbeReceipt (non-content)

probeId, adapterId, probedAt, sourceKind, present boolean, version nullable, layout nullable, readable boolean,
itemCount nullable, notes (no content, no paths outside selected input, no secrets).

## Contracts (`contracts/`)

| File | Exports |
| --- | --- |
| `version.ts` | `CONTRACT_VERSION = "dx.contracts.v1"`, `CONTRACT_DIGEST` |
| `error-<name>.ts` | one `Schema.TaggedError` class each: `InvalidInput` (error-invalid-input), `UnsupportedSource`, `SourceUnavailable`, `StoreBusy`, `StoreError`, `SnapshotNotFound`, `ContractMismatch`, `GitHubApiError` (error-github-api), `Cancelled` |
| `errors.ts` | failure unions `CollectFailureSchema`, `QueryFailureSchema`, `MarkFailureSchema` (+ types) |
| `services.ts` | plain interfaces: `CollectInput`, `CollectError`, `DxCollector`, `AppendResult`, `StoreSnapshot`, `StoreFailure`, `EventStoreService`, `Correlation`, `CorrelationMapping`, `DxCorrelator`, `MetricOutput`, `DxMetric`, `ReportComposerService`, `GitHubRequest`, `GitHubPage`, `GitHubProbe`, `GitHubApiBrokerService` |
| `event-store.ts` | `EventStore` Context.Service (B01 provides layer) |
| `report-composer.ts` | `ReportComposer` Context.Service (B35 provides layer) |
| `github-api-broker.ts` | `GitHubApiBroker` Context.Service (B15 provides layer) |
| `capabilities.ts` | `defineContract` values `dxStatusContract, dxCollectContract, dxMarkContract, dxAnalyzeContract, dxExplainContract, dxEvidenceContract`; input/output schemas; `CapabilityNames` |
| `cli-params.ts` | `DxCliParamsSchema`, `STORE_ENV_VAR`, `DEFAULT_STORE_RELATIVE`, `DEFAULT_REPLAY_STORE_RELATIVE` |
| `fakes.ts` | `makeFakeCollector`, `makeFakeEventStore`, `fakeGitHubApiBroker`, `fakeMetric`, `fakeReportComposer`, `fakeDescriptor`, `fakeManifest`, `emptyCoverage`, `emptySelector`, `FAKE_TIMESTAMP`, `FakeEventStoreLayer`, `FakeGitHubApiBrokerLayer`, `FakeReportComposerLayer` |

Collectors, correlators and metrics are **plain exported values** (`DxCollector`, `DxCorrelator`, `DxMetric`), not Context services,
because many exist; the integration owner (A02/A07) registers them. Singleton runtime services (`EventStore`, `ReportComposer`,
`GitHubApiBroker`) are Context services. Model helpers: `canonicalRequestKey`, `canonicalTurnKey`, `AI_SOURCE_PRECEDENCE`,
`OverlapPolicy` (model/ai.ts), `isHonestMetric` (model/metric.ts), `emptyFlightContext`, `emptyEventIdentity`,
`EVENT_SCHEMA_VERSION`, `MAX_PAYLOAD_BYTES` (model/event.ts), `REPORT_SCHEMA_VERSION` (model/report.ts).

### Service signatures (Effect)

- `Collector.collect(input: CollectInput) -> Effect<EventBatch, UnsupportedSource | SourceUnavailable | InvalidInput | Cancelled>`;
  `CollectInput = { adapterId, selectedInput (path/ref), context, cursor | null, scratchDir | null, origin }`. Never opens the production DB.
- `EventStore`: `append(batch) -> { inserted, duplicates }`, `snapshot(selector) -> { manifest, events, coverage }`,
  `getSnapshot(snapshotId)`, `putSnapshotManifest(manifest)`, `coverage(selector)`. Errors: `StoreBusy | StoreError | SnapshotNotFound`.
- `Correlator.correlate(events, mappings) -> ReadonlyArray<Correlation>` (strong/provisional/unassigned with evidence).
- `Metric.compute(snapshot) -> ReadonlyArray<MetricResult>` pure; plus `descriptor`.
- `ReportComposer.analyze(snapshot, metrics) -> AnalyzeReport`; renderers never recompute arithmetic.
- `GitHubApiBroker` (B15 implements in `packages/core/src/dx/services/github-api/`):
  `request({ route, params, etag | null, maxPages }) -> Effect<GitHubPage[], GitHubApiError | Cancelled>` where
  `GitHubPage = { status, etag | null, fromCache, body: unknown, rateLimitRemaining | null, partial }`;
  plus `probe() -> { authenticated, rateLimitRemaining | null }`. It owns pagination, concurrency, retry, cache, redaction.

### Capability I/O

- `dx_status {}` -> `StatusReport` (descriptors, store path, snapshot count, contract version).
- `dx_collect { source, input?, repo?, flight?, since? }` -> `{ adapterId, inserted, duplicates, coverage }` (mutation).
- `dx_mark { kind: start|stop|wait-start|wait-stop|claim, flight?, label?, note? }` -> `{ eventId, flightId }` (mutation).
- `dx_analyze { flight?, repo?, snapshotId?, asOf? }` -> `AnalyzeReport` (persists snapshot metadata only).
- `dx_explain { flight?, snapshotId?, asOf?, cursor?, limit? }` -> `ExplainTimeline`.
- `dx_evidence { evidenceIds, snapshotId?, asOf? }` -> `{ items: EvidenceItem[] }` (redacted, bounded).
Input fields must not be named `json` or `yes` (Ratstack CLI reserves them).

### CLI parameters (frozen)

`--source <adapterId>`, `--input <path|ref>`, `--repo <path>`, `--flight <flightId>`, `--store <dbPath>`
(default `$DX_STORE` or `~/.dft/dft.db`), `--replay` (use separate replay store), `--snapshot-id`, `--as-of`.
Live and replay stores are separate files; never merged silently.


## Agent contract freeze, S00

Ownership was activated by root on `feat/agent-system` against baseline `eddcedb29c3900a1e5e365dc3999bf6f7fdcfd7b`. Historical source owners are idle. The agent model is additive to legacy event/report/usage contracts and uses its own explicit versions. All schemas are Effect Schema definitions; transport schemas derive from the capability contracts.

| Defining module | Version and exports |
| --- | --- |
| `model/agent-common.ts` | `dx.agent.v1`; `StoreIdentity`, `AgentHandle`, `AgentRef`, `AgentScope`, `AgentWindow`, `AgentReadPolicies`, `AgentBudget`, `AgentRequest`, `AgentRefResolution` |
| `model/agent-query.ts` | `dx.basis.v1`, `dx.result.v1`, `dx.context.v1`; `AnalysisBasis`, `AnalysisBasisMetadata`, `AgentResult`, `AgentResultMetadata`, `AgentCursor`, `AgentCompleteness`, `AgentWork`, `AgentResponseContext`, `AgentBasisDifference`, `AgentQueryInput`, `AgentView`, `AgentResultPageInput`, `AgentResultPage`, `AgentQueryOutput` |
| `model/agent-operation.ts` | `dx.operation.v1`; `OperationKind`, `OperationBounds`, `OperationArguments`, `OperationDescriptor`, `OperationPrecondition`, `OperationPlan`, `OperationStep`, `OperationReceipt`, `OperationInput`, `OperationOutput` |
| `model/agent-learning.ts` | `dx.learning.v1`; `LearningApplicability`, `Investigation`, `Lesson`, `LearningRecord`, `Evaluation`, `LearningFilter`, `LearningMatch`, `LearningInput`, `LearningOutput` |
| `contracts/error-agent.ts` | `AgentError`, with stable code, retryability, handle, revisions and recovery action |
| `contracts/agent-store.ts` | `AgentStore` Context.Service, `AgentStoreService`, `AgentStoreFailure`, `AgentEventPageInput`, `AgentEventPage`, `AgentBasisMetadataRead` |
| `contracts/agent.ts` | `AgentFailureSchema`, `dxOperationContract`, `dxLearningContract` |
| `contracts/fake-agent-store.ts` | `makeFakeAgentStore(overrides)`, `FakeAgentStoreLayer`; explicitly unavailable fixture defaults, overridable per port |
| `contracts/agent-fixtures.ts` | Labelled fixture vocabulary and compile-only consumers for missing refs, stale generations, ambiguous attribution and two price/attribution versions |

Each model type has a matching exported `XSchema`. New contracts accept `{ request: OperationInput }` and `{ request: LearningInput }`, because the projection contract requires a top-level Struct. Their discriminated requests expose plan/apply/get/cancel and list/get/record/evaluate/supersede respectively. They permit tracker operations only, with no command execution field. Discovery must mark unimplemented adapters disabled with a reason.

Existing status/analyze/explain/evidence/usage inputs accept optional `agentQuery: AgentRequest`. This name avoids the existing usage `agent` filter. Omission preserves legacy behavior; a supplied profile must validate the literal version and all explicit policies/budgets. Status keeps its legacy shape with optional context and does not invent a result or basis. Other negotiated reads return `AgentQueryOutput`; legacy shapes retain optional context and resolver disclosures. Evidence additionally exposes missing IDs and snapshot identity. Unsupported fields or versions must fail before legacy decoding can drop them. Existing snapshot manifests remain evidence-selection-only.

The generic query request is `{ capability, agent, selectors, cursor?, refs? }`. `selectors` maps allowlisted selector names to string lists, including resolved query/window/grouping inputs. It is not a transport escape for arbitrary operations. The producer validates supported names and explicit scope. The response is `{ context, result, view, resolutions, difference }`. `result` is metadata and its full-view digest. `view` contains bounded structured JSON summary/items/series, disclosures and independent item/series continuation handles. It never duplicates the full retained JSON projection in a response.

### Identity, basis and result binding

A handle includes ID, canonical store ID and store generation. A typed reference adds kind, version and an optional basis ID. Branch labels and filesystem paths do not replace canonical repo/worktree identities. A resolved window fixes its absolute half-open bounds, timezone and query clock. The acquisition, price, derivation and learning policies are separate fields. Recorded-only acquisition with pinned or cached-only prices permits no acquisition network work; declared bounded cache/basis writes remain visible.

`AnalysisBasis` retains unchanged ordered events, coverage, acquisition receipts, origin mix, descriptor/metric versions, reconciliation/attribution versions, exact price contents and effective dates, config digest and serialized interpretation inputs. It states its reproducibility level and supported result versions. Interpretation inputs and price contents are trusted only after the owning producer validates their schema. They are stored JSON, never executable instructions. Missing historical detail returns a typed content-unavailable or incompatible failure.

`AgentResult` binds one basis, capability, semantic query digest, projection version, canonical result digest, completeness, retained reference-resolution states and retained ordered projection. Page size and output layout do not alter semantic digests. The retained projection has the `AgentView` data shape. Result digests bind semantic completeness and reference states alongside the full view. A warm read returns those retained states; it cannot replace an originally invalid/missing reference with a current-store lookup. Pagination reads indexed retained items and series, prioritizing the requested cursor axis; it must not decode and sort the full retained answer again. `AgentCursor` identifies its items/series/work axis and distinguishes output pages from work continuations and binds query/result/version/order. `storeRevision` additionally invalidates mutable work after restore/reset.

Output bytes, decoded bytes, facts, item count, series buckets, stacks, elapsed time and network requests have separate bounds. The schema permits at most 500 output items, 366 series buckets, 50 stacks and 4 MiB output. The 2048-byte schema minimum is an initial envelope floor, not a promise that every context fits. The producer measures the actual required envelope and rejects an insufficient cap. Unknown measured resources remain null. Output truncation and partial aggregation have distinct completeness states.

### Injected persistence ports

`AgentStore` is separate from legacy `EventStore`; existing mocks are unchanged. S01 supplies both services from the same SQLite connection and serialized writer. No port carries an unfulfilled Effect requirement. All ports fail through `AgentStoreFailure = AgentError | StoreBusy | StoreError`.

```text
identity -> StoreIdentity
readEventPage(selector, watermark, cursor, fact/byte/time caps) -> bounded events, coverage, watermark, measured work and continuation
putBasis / getBasis / latestBasis -> immutable retained basis
getBasisMetadata / latestBasisMetadata / latestBasisForScope -> no retained events, interpretation JSON or price contents
readCoverage(scope, source/byte caps) -> bounded current coverage metadata and measured work
putResult / getResult / findResult -> immutable full retained view
getResultMetadata / findResultMetadata -> no ordered projection
readResultPage(handle, item/series positions and work/output caps) -> indexed bounded AgentView and measured work
putCursor / getCursor -> generation/version-bound continuation
putOperationPlan / getOperationPlan -> immutable reviewable plan
reserveOperation(handle, expectedDigest, key) -> one durable receipt or same-key reuse
getOperation / updateOperation(expectedRevision) -> recoverable CAS lifecycle
appendOperationStep / requestOperationCancellation(expectedRevision) -> journal and cancellation under writer
createLearning / getLearning(handle, revision?) / listLearning -> scoped bounded records and indexed historical revisions
updateLearning(expectedRevision, key) -> CAS revision, preserving previous records
appendEvaluation(key) / getEvaluation / listEvaluations -> independent append-only evaluations and indexed idempotent replay
resolveRefs(refs, scope?) -> per-reference found/invalid/missing/withheld/over-budget/stale-generation
```

Metadata records disclose retained event count, interpretation bytes and total retained decoded bytes so a producer can reject expensive full reads before decoding. Basis metadata and scoped latest-basis reads accept an optional decoded-byte cap and check serialized size before parsing. Indexed result paging bounds combined examined facts, decoded bytes, elapsed time, items, buckets and stacks. `readEventPage` additionally accepts optional scope and normalized filters so the selected source/tool/worktree predicates can run before decoding. A storage read captures events and coverage together; unrelated append-only ingestion does not invalidate a correctly captured immutable selection. The selected-event digest is SHA-256 over the canonical ordered raw event bodies; the event watermark identifies the store selection boundary. Producers retain raw observations unchanged and record derived attribution separately.

### Operation and learning invariants

A plan separates consent state, validity, preconditions and forecast from execution and verification. Apply names a generation-bound plan handle, expected digest and idempotency key, plus scoped consent receipt references and optional exact destructive confirmation. A string that looks like a consent receipt is not authorization. Same-key changed payloads conflict. Journals precede effects and retain indeterminate external steps. A succeeded execution is not verified evidence commitment. Spool writes stay spooled until append verification.

Receipts preserve exact removed references/counts and their reason when unavailable, remaining store generation, backup identities/generations/content digests/restoration versions, and export basis/disclosure/destination/content digest. Destructive targets above the retained exact-ref bound require a supported bounded plan or explicit unsupported result; a truncated deletion list cannot authorize wider removal.

Learning records carry explicit author kind, scope/window, tool/source/definition versions, workflow/coverage requirements, evidence and limitations. Retrieval can include a selected basis and full applicability context. Scope-only retrieval discloses compatibility unknown rather than claiming current support. Get requires selected scope, and citations resolve under that visibility separately from applicability.

An evaluation targets `{ kind: investigation|lesson, id, revision }`. It appends independently from parent CAS and records criterion, actual outcome, origin mix, coverage and comparability limits. Earlier revision support cannot automatically support a changed claim. Fixture/synthetic/replay evaluations cannot support a live lesson, including mixed-origin evaluations. Descriptive association, operator report and causal criterion are separate relations. Supersession preserves the older claim and evaluations. Prose remains data and never changes acquisition, pricing, accounting or retry behavior.

### Verification boundary

S00 owns the contract and command catalog freeze. Producer tests, integration availability and release claims belong to their assigned owners. `docs/execution/commands.json` records exact argv, cwd, prerequisites, scope and observed exits. A null observed exit means unverified. The S00 receipt records the final digest and checks; historical verified receipts do not prove current-source behavior.

The agent contract version is `dx.agent-contracts.v1`. Its digest is `sha256:4f1c6fb18975c5595e21f4b097f7b095cf245697d94cf3f12002472fd7cf0535`, exported by `contracts/agent-version.ts`. The hash consumes sorted relative paths as `== <path>\n<source>`, over `model/agent-common.ts`, `model/agent-query.ts`, `model/agent-operation.ts`, `model/agent-learning.ts`, `model/report.ts`, `contracts/agent-store.ts`, `contracts/agent.ts`, `contracts/error-agent.ts`, `contracts/capabilities.ts` and `usage/contract.ts`. Fakes, receipts and the version file are excluded. Any change to those defining files requires a refreshed digest before release.

Effect4 decoding does not read parse options from schema annotations. Negotiated input boundaries that reject excess fields must pass `{ onExcessProperty: "error" }` explicitly to the Schema decoder. Unsupported profile versions and policy values reject under the schemas' literal fields; the common optional wrapper ensures the profile itself is validated rather than discarded by legacy decoding. The schema probe verifies excess-field rejection with those explicit options and does not claim that every installed projection already uses them.

Learning lists use `LearningSummary`: bounded claim/question, truncation state, status, applicability/match reasons, evidence-availability counts, latest-evaluation reference and one drilldown reference. They do not embed whole records or evaluation histories. Record replies return at most8 normalized-lexical near-duplicate candidates and explicit search limits. Search is scoped and never merges records automatically; a skipped search reports null remaining availability and its reason. `get` remains the expanded typed read.

### Additive operation recovery and measured metadata reads

`dx_operation` get returns `{ action: "get", receipt, reviewedPlan, reviewedPlanUnavailableReason }`. Both new fields are present. A retained matching plan is paired with a null unavailable reason; a missing/mismatched plan returns null and an explicit reason. The reviewed scope, normalized arguments, bounds and original digest let a fresh agent reconstruct a replan request without replaying a transcript. This addition changes no apply input or authorization rule, and keeps the existing agent/profile/operation versions.

`AgentStore.getOperationPlanForReceipt(operation)` is a read-only historical lookup. It starts from an existing retained receipt and reservation, checks the operation/plan IDs, original store identity/generation and digest, and returns only that matching immutable plan. Reset/restore receipt aliases may recover this historical context. Returned plan identity remains original, and its current validity can be stale. This read never grants consent, revives a pending plan, permits apply in an old generation or authorizes a different scope. The coordinator also verifies the canonical plan digest before exposing the plan. Its digest treats validity as the original valid state, so a later stale marker does not change the proof of reviewed immutable arguments. Apply still checks current validity and expiry independently. Missing content remains unavailable with a reason.

`AgentStore.readBasisMetadata(handle, maxDecodedBytes)` and `readLatestBasisMetadataForScope(scope, maxDecodedBytes)` return `AgentBasisMetadataRead`. It contains nullable `metadata` and measured `decodedBytes`/`factsExamined`. Each production call performs one bounded indexed header read. It admits the stored header byte count before parsing and reports the actual stored bytes it decoded, including noncanonical JSON spacing. It never substitutes the smaller size of a normalized `JSON.stringify(metadata)`. A missing header returns null/0/0. A matching header over the cap returns null/0/1, which states that the header was inspected but no JSON was decoded; callers disclose budget refusal. A successful read returns the parsed header, its actual admitted byte count and one examined row. Existing metadata get/latest ports preserve their compatibility behavior.

`AgentStore.readResultMetadata(handle, maxDecodedBytes)` and `readMatchingResultMetadata(basis, capability, queryDigest, maxDecodedBytes)` return `AgentResultMetadataRead = { metadata: AgentResultMetadata | null, decodedBytes: number, factsExamined: number }`. They measure the actual stored result-header bytes separately from retained item-page decoding. The matching lookup selects one indexed result header; its basis-availability check reads no JSON body. Missing, refused and successful reads use the same null/0/0, null/0/1 and actual-bytes/1 rules as the measured basis ports. Stale or tombstoned handles still produce typed errors. Existing get/find metadata ports remain available. Query callers account for their separate measured basis read and add the result-header measurements to the same request budget.

`AgentStore.readCursor(handle, maxDecodedBytes)` returns `AgentCursorRead = { cursor: AgentCursor | null, decodedBytes: number, factsExamined: number }`. It admits the actual stored cursor-body bytes before parsing and uses the same missing/refused/success measurement rules. Binding validation uses indexed scalar fields without decoding basis or result headers behind the caller's budget. Query callers measure and validate those headers separately. Typed expiry, stale-generation and binding errors remain; legacy `getCursor` is unchanged.

The compile-only fake ports return null or null/0/0 because they retain no matching content. A fixture override that retains content must count its actual synthetic serialized bytes and enforce the cap before decoding. Two schema fixtures cover the retained reviewed plan and unavailable plan replies with explicit null fields. Production historical binding and exact SQL byte measurement require the assigned storage/coordinator tests and final root gate. The earlier `8d6d14cc...b337684` and `ecb827e0...fe1e0be` freezes remain preserved in the S00 JSON receipt history; the current defining-file digest above supersedes it.

### Database compatibility metadata

The S01 source now defines database schema version8. Version7 is the historical storage checkpoint, separate from the legacy event/contract versions above. Migration8 adds only `CREATE INDEX agent_operation_aliases_operation ON agent_operation_aliases(operation_id)`; `rewriteEventBody` is null. It leaves event bodies and the frozen public schemas, ports, versions and agent contract digest unchanged.

The associated internal binding repair flattens retained operation aliases and keeps consumed terminal bindings available for read-only recovery. It preserves receipt state, revision, times, steps, effects and reviewed proof; it does not restore unused apply authority. S01 closed with 21/21 scoped cases, including controlled version7-to8 migration and repeated reset/restore recovery. Root Build7 packaged candidate7 passed its native rehearsal. A read-only probe of the root-owned rehearsal database confirmed `PRAGMA user_version = 8`, SQLite `3.53.1`, Node `24.18.0` and the exact alias index above. This confirms the built candidate's database version; it does not claim that an existing user database has already migrated. The S03 test-boundary fix is closed. Build7/native9 observations remain historical. Root fence9 passed the exact `pnpm exec turbo run check test build` command with `VITEST_MAX_WORKERS=1`: exit 0, 18/18 tasks, 2001 passed and 3 skipped, with complete reports and unchanged source/compiled identities verified after the gate. Native10 passed on the same compiled candidate with 14 JSON-RPC frames, no stdout noise and no stderr. Native11 then passed on the exact final source and compiled candidate in 26.726s with 14 JSON-RPC frames, no stdout noise and no stderr. Root verified equality after both gate and native rehearsal across 1058 source files, 1820 dist files, 4 manifests, 6 guidance files and 3 assets. Both exact owned resource registrations were released with exit 0, owned scratch/export/PIDs were closed, and cleanup left preexisting trees/stores untouched. Root S07 reports acceptance fulfilled; [its receipt](nodes/s07.json) records closure. Four reserved operation kinds and existing live-host verification limits remain. Detailed current identities, reports and historical observations are in the S00 JSON receipt.
