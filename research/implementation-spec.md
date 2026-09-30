# Standalone Ratstack implementation contract

Authoritative scope: separate dx-feature-tracker, Ratstack, four-hour execution deadline, agent-owned parallel lanes, no Enterprise requirement. This is a proposed build specification. No application code exists as a result of this planning session.

## Upstream and proposed files

Pinned upstream Ratstack SHA: 753c7b07dcc516037dd1d455a8766bf112084844. Actual upstream boundaries are apps/cli → packages/core → packages/capability. Use exact package/runtime pins from reports/revision/ratstack.md; bootstrap reads the installed Effect AGENTS.md and version-matched source before edits. Keep checks, hooks, diagnostics and pnpm. No cross-host agent CLI.

Proposed product modules, not upstream existing files:

```text
packages/core/src/dx/
  contracts/          A03 owns schemas only
  model/              A03 owns event/report/coverage types
  storage/            B01 owns sole production writer and migrations
  collectors/<id>/    one B-owner per adapter
  correlation/<id>/   one B-owner per join stage
  metrics/<id>/       one B-owner per pure metric
  reports/<id>/       one B-owner per report stage
  cli/                B38 capability/renderer modules only
  mcp/                B39 capability definitions, no second transport
packages/core/test/dx/<id>.test.ts
packages/core/test/dx/fixtures/<id>/
apps/cli/src/         A02 alone owns composition/command/surfaces wiring
.cursor/skills/      B40 owns explicit analyze/explain skills
```

A01 alone owns manifests/lockfile/scaffold/toolchain settings, A03 alone owns shared schemas, A04 alone owns the fixture index, One sequential integration owner holds A02/A07/A08 and alone owns module registration/barrels/entrypoint wiring. B01 alone owns database migrations. Workers never modify someone else's module, register themselves in shared files, install dependencies, run whole-tree formatters or create independent stacks.

## Freeze contracts, then fan out

Use Effect Schema for cross-process contracts and typed failures, not independently hand-written JSON Schema. Define proposed capability names dx_status, dx_collect, dx_mark, dx_analyze, dx_explain and dx_evidence through Ratstack defineContract/implement. Derive CLI/MCP projections. Recording/import/marking mutate local state; report reads do not silently sync; analyze may persist immutable snapshot metadata only. MCP diagnostics go to stderr.

Frozen v1 envelope includes stable event ID, schema/adapter/source versions, kind, upstream object key, occurred time nullable, observed time, origin, acquisition, repo/worktree/flight context, session/generation/request/commit identity nullable, evidence hash/ref, bounded source payload and field semantics. Metric output includes nullable value, unit, definition, numerator/denominator/checkpoint, evidence IDs, source coverage, measurement and attribution state, as-of and reason.

Separate record origin from calculation method. Synthetic fixtures never masquerade as imported observations. An estimated visible-text token count cannot be attached to the same field as source-reported usage without an explicit method discriminator.

Services:

- Collector receives explicit selected context/input, cancellation, bounded shared API access and optional owned scratch path. Returns event batch + coverage + cursor. It never opens the production DB or renders reports.
- EventStore owns append/snapshot queries and coverage. It uses scoped node:sqlite resources after a real runtime feature probe, short transactions and one writer. Immutable report snapshots feed all metrics.
- Correlation takes normalized events and mappings, produces evidence-linked strong/provisional/unassigned joins. Historical events never inherit today's branch silently.
- Metric is pure snapshot → values/finding candidates. Every metric owner works against canonical fixtures before real sources are ready.
- Report composes metric results and evidence; renderers do not recompute arithmetic. Analyze returns an immutable snapshot ID. dx_analyze, dx_explain and dx_evidence accept optional snapshotId/asOf inputs; explain/evidence reuse analyze’s ID on request. Expired/unknown snapshots produce an explicit error. Choosing latest returns its ID and discloses changed evidence; never silently substitute latest.
- Each module exports a descriptor and writes an isolated handoff manifest. Integration registers only compatible/tested ready modules; disabled descriptors remain in status.

Finite recording/retry/cancellation lifecycles follow the pinned Ratstack XState/Effect pattern if retained. Pure parsers and reducers need no state machine. Config/migration/API errors are typed expected failures, not catch-all silent zeros.

## Source protocols and priority

Core live candidates: Git snapshots/history, project Agent/Tab hooks, optional observed usage, selected transcript or personal usage import, explicit command/test capture and on-demand Actions/PR evidence. One supported real no-admin AI route is sufficient for the live release criterion. Launch other routes concurrently; report their readiness accurately.

Local Cursor DBs are user-owned source data. Explicit opt-in scope selects a repository/session/input. Use a read-only connection and consistent SQLite backup to operation-owned scratch; no live immutable=true, non-atomic sidecar copy, VACUUM, checkpoint or schema mutation. Recognize ItemTable/cursorDiskKV and optional composerHeaders; feature-detect column/version layouts. Keep uppercase IDE Cursor and lowercase newer CLI cursor roots distinct. Raw source content is optional, bounded and local.

Hook capture writes an atomic bounded spool record and returns without network. Capture optional usage fields even if undocumented, with raw semantics/version. Test two turns, duplicate stop emissions and subagent rollups before summing. Preserve missing versus zero. Context meter, inclusive stop-input counters, normalized fresh input and CSV buckets have different mappings. Unsupported format returns a reason, not an empty success.

JSONL import uses complete-record watermarks, rotation/truncation handling and event-time uncertainty. A Write/StrReplace tool_use is a candidate attempt; successful result/postimage supports applied state. Model turn history is not a bill when usage is absent.

Personal CSV parsing uses actual header maps and row schema variants, preserves raw categories, charges versus Included/absent, date precision and rejected/unassigned rows. Do not assume two equal rows are duplicates; request IDs are preferred. Dashboard JSON accepts only user-exported usage fields, no cookies/headers/HAR credentials. Expected versus observed pages define completeness.

SDK telemetry covers recorder-tagged prospective runs only; do not build a new AI assistant to obtain numbers. Implement as optional bridge/input or shim after actual API access is proven. Provider receipts and explicit owned traffic are separate accounting sources.

Git AI stats/notes describe attested committed composition, not universal acceptance. Entire root/session totals and cumulative checkpoint transcripts require dedupe; heuristic percentages remain labelled estimated/source-attributed. Analyzing must not initialize either tool or push Git refs.

B15 exclusively owns packages/core/src/dx/services/github-api/, the shared API broker/cache/auth service. A03 freezes its interface and consumers implement against fake brokers; A02 composes it. It owns pagination, concurrency, rate-limit retry, cache/request coalescing and credential redaction. GitHub collectors share this broker and bounded request policy. Preserve run attempts and attempt-specific jobs, synthetic PR refs, forks and many-to-many links. Actions/check/status observations of the same execution are links, not three compute totals. Comment bodies, logs and artifacts are separately bounded opt-in inputs. Archive/XML parsers never execute content or allow traversal/entities. Retention/access/pagination gaps remain visible.

## Identity and arithmetic

Flight UUID is immutable. Repository common-dir maps worktrees locally and GitHub numeric IDs remotely. Branch labels are aliases. Preserve observed SHAs across rebases; explicit start freezes base and time. Ambiguous forks/multi-root/detached contexts stay unassigned. A command captures start/end context, monotonic duration and exit state; branch or dirty-content changes during it make interpretation explicit.

CI compute is sum of completed job runtimes. Execution coverage is interval union. Feedback pending requires valid attempt trigger/completion evidence or a labelled proxy. REST updated_at is not completion, initial run created_at is not rerun enqueue. Approval snapshots do not invent historical approval timestamps. Inactivity cannot establish blocked human time.

Tokens retain source category semantics and coverage. Charges, metered values, provider list-price estimates, subscription allocation and unallocated spend are separate. Raw counters whose cumulative behavior is not verified are displayed as observed raw counters, not summed feature usage.

Observed strict AI survival assigns persistent line-instance IDs to uniquely ordered before/after snapshots. Repeated identical lines, concurrent edits, missing preimages, rename/formatting, tool retries and unknown changes have explicit unresolved states. Human rewrite requires human actor evidence; absence of AI evidence is not human evidence. A zero denominator produces unavailable. Named checkpoint and observed-generation coverage are compulsory. Heuristic semantic similarity is a separate experimental metric.

Critical-path analysis must state its dependency graph assumptions. Timeline sequence alone is not causal proof. Friction findings cite repeated test/failure evidence and suggest an inspectable experiment, without invented savings.

## Handoff, tests and resource control

Every assignment writes docs/execution/nodes/<id>.json and .md with contract digest, owner paths, ready/unsupported/disabled state, fixture IDs, exact verification command/results, source/runtime versions, gaps and dependency proposals. Handoff completion is not implementation success: a disabled optional module must never be advertised as supported. A required module cannot be substituted by an undocumented fixture and called live.

Use @effect/vitest it.effect/it.layer. Package-local behavioral test command is fixed by bootstrap; proposed default: pnpm --filter @rat-stack/core exec vitest run test/dx/<id>.test.ts. If actual upstream config needs a different command, A01 publishes it once before dispatch. Whole-repo required validation is pnpm turbo run check test build at every candidate phase gate, run by one shared coordinator queue. Do not loosen the fence to claim a four-hour success.

Run disposable jobs in owned temporary directories that are cleaned on exit, and share one dependency install. Never create 49 dependency trees or duplicate whole-suite jobs. User-intended event database is durable data, not a temporary artifact. Source snapshots/fixtures scratch have an explicit owner and cleanup. No large install/build occurred during this planning revision.

Configuration installer merges and backs up existing host entries; remove only owned entries on uninstall. Metadata default, explicit raw-content/provenance capture, sanitized export and bounded evidence display. Reports inserted in Cursor chat may reach its model provider; local storage is not an assurance that report contents never leave the machine. Recalled prompt/log text is untrusted data and cannot cause command execution.

## Release acceptance

A real Cursor invocation returns analyze/explain from the shared Ratstack capability; same input replay produces the same metrics; earlier failed attempts survive; overlap/missing-time/branch ambiguity fixtures pass; source/cost/token/retention labels are honest; unavailable routes remain visible; exported evidence contains no synthetic secret; clean restart works. Live and fixture modes never merge silently. No mandatory Biomem action remains.

## Final audit contract clarifications

AI accounting uses canonical request/turn identities, explicit source/version-specific precedence and overlap groups across hooks, local DB, Entire, dashboard, SDK and usage CSV. Strong duplicate keys collapse measurements while retaining raw evidence. Cumulative windows must be differenced only after semantic validation. Aggregates and detail that may overlap are alternative ledgers, never blindly summed. Unresolved overlap stays separate and visibly unassigned. B26 owns correlation; B30 owns ledger accounting; C05 tests cross-source duplicates.

A03 can design its unique docs draft concurrently with scaffold bootstrap, but production contract/model writes wait for A01 scaffold-created signal. No generator rerun is allowed after that signal. Local command/test feedback and detailed reviews are optional enabled-route demo additions; one validated B05/B07/B08 AI route is the group release predicate.

## Stoppable execution contract

[Phase gates](phase-gates.md) are authoritative for promotion and stopping. G00–G04, sequential A02/A07/A08 integration, A09 real probes and C09/C17 actual client validation are encoded in the graph. Root owns selected inputs, gate receipts and last-green artifact preservation. A01 owns verified command manifest and queue; C13 owns target MCP/hooks/skills merge. Snapshot manifests include watermark/context/contracts/enabled module and metric versions/origin mix, persist across restart and never recompute with mismatched versions. Live/replay stores are separate. Each phase tests a frozen candidate with full fence and required actual client observations; incomplete optional code stays out of that tree. All extension privacy/version/accounting checks run before descriptor enablement.
