# DX Flight Recorder contracts v1 (A03, frozen)

Status: FROZEN at interface checkpoint. Owner: A03 contract steward. Version tag `dx.contracts.v1`.
Changes after freeze: additive optional fields only, via A03; breaking changes need a v2 tag and gate approval.

Code lives in `packages/core/src/dx/model/` (data schemas, Effect Schema) and `packages/core/src/dx/contracts/`
(service interfaces, capability contracts, typed errors, compile-only fakes).

**Naming (lint-enforced):** every schema value is `XSchema`; its decoded type is `X` (`type X = typeof XSchema.Type`).
Branded IDs: `EventIdSchema.make("...")` produces an `EventId`. **No barrels** (oxc no-barrel-file): import each symbol from
its defining file, e.g. `import type { DxEventEnvelope } from "../../model/event.js"`,
`import { EventStore } from "../../contracts/event-store.js"`. One error class per file (`contracts/error-*.ts`).
No comments in source (repo lint); semantics live here.

The contract digest is `CONTRACT_DIGEST` in `contracts/version.ts`: sha256 over `== <path>\n<content>` of sorted
`model/*.ts` + `contracts/*.ts` excluding `version.ts` (paths relative to `packages/core/src/dx`).

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
(default `$DX_STORE` or `~/.dx-flight-recorder/events.sqlite`), `--replay` (use separate replay store), `--snapshot-id`, `--as-of`.
Live and replay stores are separate files; never merged silently.
