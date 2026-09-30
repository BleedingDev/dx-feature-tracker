# Four-hour parallel execution contract

This is a proposed execution design for a separate dx-feature-tracker using Ratstack. The four-hour deadline is fixed by the user. Agent capacity is at most 49 workers plus the root under a `max_threads=50` configuration, even if the runtime reports 51 slots. There is no assumption about the number of humans. The assignments below are bounded deliverables, not estimates of worker speed. This report does not authorize implementation.

## Ruthless scope decision

The release criterion is an actual Cursor chat command that produces a reproducible report and evidence timeline for one selected repository/flight, using at least live Git and one real non-Enterprise AI observation route when that route is supported on the demo installation. GitHub CI and review imports can run before the demo and remain visible as imported evidence. Unsupported local Cursor layouts must return unavailable with a reason. A real source route failing is a valid result; never substitute fixture events silently.

A second, explicitly labelled fixture flight exercises failed CI, reruns, overlap, partial AI attribution, branch changes and the report. This makes the arithmetic demonstrable even when the actual development history is uneventful. It must never appear as live data. Launch broad collector work in parallel, but only enable adapters that pass their version/format gate. Disabled adapters and unavailable fields stay in the capability report. A beautiful dashboard does not rescue a broken Cursor workflow.

Ratstack is the selected product stack. A sole scaffold owner must freeze the exact generated tree, package manager, runtime and package versions after checking the actual template. Do not let workers independently reinterpret its stack. Collector, metric and report modules should remain pure enough to test without starting the web app. Resolve the MCP transport and local bridge separately from the browser UI; a deployed web server cannot directly read a developer's Git checkout or local Cursor database.

## Contracts to freeze before production fan-out

Write these under `src/dx/contracts/`, adapting only the root prefix to the verified Ratstack layout. One owner controls the complete contract folder. Everyone imports leaf modules directly; no shared barrel file.

- `event.ts` defines schema version, event ID, source and adapter version, upstream ID, kind, occurred time or null, observed time, canonical repo ID, worktree ID, flight ID or null, commit SHA or null, evidence reference, redacted payload and origin. Origin is captured, imported or fixture. Reconstruction and estimation are metric properties, not claims that a source event was observed.
- `coverage.ts` defines source range, status complete/partial/unavailable, last sync, recognized version/format, dropped event count and reason codes. Unavailable is not an empty success.
- `collector.ts` defines `collect(context, cursor, abortSignal) -> {events, coverage, nextCursor}`. No adapter opens the production store, modifies configuration, fetches Git history implicitly or emits a report. An adapter may use its own cache folder under the run-owned path. Store ingestion is the only production writer.
- `store.ts` defines append/idempotent-upsert, event queries, coverage writes and an immutable report snapshot. Use content hash plus upstream identity for snapshots; keep rerun attempts. Metrics receive plain event arrays from a consistent snapshot rather than reading SQLite independently.
- `metric.ts` defines value or null, unit, measured/reconstructed/proxy/estimated/unavailable, definition, evidence IDs, numerator, denominator, coverage, as-of and reason. Each metric uses integer milliseconds or exact decimal representations where appropriate. Model-price estimates stay separate from charged cost.
- `report.ts` defines flight identity, source capability table, metric list, evidence-backed findings, ordered timeline, associations and report version. Analyze and explain use one report snapshot.
- `capabilities.ts` defines a source registry descriptor and the config schema. Only integration owns the registry. Independent workers export one descriptor each; they do not register themselves by editing a common file.

Freeze v1 with concrete JSON examples for one event, a missing-time event, partial coverage, a measured metric and an unavailable metric. Record a digest in `docs/execution/contracts-v1.md`. After freeze, proposals go to the contract steward; workers cannot extend shared schemas unilaterally. Add optional fields only when an accepted adapter needs them. The steward owns any approved change and informs every affected owner.

## Ownership and integration policy

Root schedules nodes and manages the deadline. It does not become the default merge mechanic or write into worker folders. Worker A02 is the sole integration owner. A01 alone owns manifests, lockfile, generator output and package/TypeScript configuration. A03 alone owns contracts. A04 alone owns the fixture index; fixture contributors own individual fixture folders. A02 owns source registries, app/CLI/MCP entrypoint wiring and any shared export file. Storage owner B01 owns all migrations and production write paths.

Each worker owns its listed module directory and its own test file. Every worker receives: absolute repo root, allowed paths, forbidden shared paths, frozen contract digest, input fixture IDs, required output, acceptance command and upstream dependencies. Tell all workers they share the codebase and must preserve others' edits. A review worker writes a finding or patch proposal in its assigned output folder; it cannot silently edit another owner's module.

Use one shared checkout with disjoint path ownership, or existing configured worktrees if the operator already has a robust lifecycle. Do not create 50 dependency trees, installations or branches merely to demonstrate concurrency. If worktrees are selected, each must have a named branch and parent-owned cleanup. An agent never removes its own working directory. One package install serves the shared checkout. One integration process owns watch/build/test services and cancels only its own processes.

Every node completion requires code or a report at its declared path, one meaningful test/fixture where relevant, an exact command/result, declared gaps and dependency/API changes. A chat statement alone is not completion. Workers write status to unique `docs/execution/nodes/<id>.md` files. The root consumes these files; there is no shared status file that 50 workers overwrite.

## Assignment manifest

Paths are prospective, relative to the verified new repository. Core means needed for the minimum credible release. Expansion means launchable in parallel but excluded if unfinished at the source cut gate. Verification means independent validation of produced outputs.

### Wave A: freeze and unblock

| ID | Owner paths | Deliverable | Role/dependencies |
|---|---|---|---|
| A01 | package manifests, lockfile, build config, generated Ratstack entry tree | Verified Ratstack scaffold, pinned install, app starts, runtime/MCP viability probe | Core; start immediately |
| A02 | `src/dx/registry/`, shared app/CLI/MCP wiring | One integration owner, explicit adapter/metric registry, end-to-end skeleton | Core; coordinate with A01/A03 |
| A03 | `src/dx/contracts/`, contract digest | Frozen interfaces and compile-only fake implementations | Core; start immediately |
| A04 | `fixtures/index.*`, `fixtures/core/` | Redacted fixture vocabulary and common golden report inputs | Core; A03 review |
| A05 | `docs/execution/ownership.md`, `docs/execution/launch-policy.md` | Exact ownership manifest and dependency-aware launch instructions | Core; start immediately |
| A06 | `docs/execution/capability-gates.md` | Actual demo environment entitlement/version probe recipe with no personal-data reading during planning | Core; start immediately |

### Wave B: independent source, metric and product modules

Launch after the relevant contract exists. Adapter workers can prepare parsers and test samples before store integration. Each source owns `src/dx/collectors/<name>/` and matching `tests/collectors/<name>.test.*`; metric workers own their named directory and test. There are 42 assignments in this wave. A01-A06 can continue or take completed-node replacements without exceeding 49 active workers.

| ID | Owner module or output | Deliverable | Gate |
|---|---|---|---|
| B01 | `src/dx/storage/` | Single-writer store, schema, migrations, snapshot queries, replay idempotence | Core |
| B02 | collectors/git-identity | Repo common-dir, worktree, branch, HEAD, base-SHA context | Core |
| B03 | collectors/git-history | Commit times, numstat/diff metadata, explicit first-observed distinction | Core |
| B04 | collectors/git-observation | Opt-in future branch/edit observation; no claim of complete historical activity | Expansion |
| B05 | collectors/cursor-hooks | Supported hook JSON decoder, spool files, version/capability check | Core candidate |
| B06 | collectors/cursor-local-db | Read-only copied/snapshotted local database parser for recognized published layouts | Expansion |
| B07 | collectors/cursor-transcripts | Local exported transcript/chat parser with mapped/unmapped usage | Core candidate |
| B08 | collectors/cursor-usage-export | User-provided documented CSV/JSON usage import, exact charges if present | Core candidate |
| B09 | collectors/cursor-extension | Supported VS Code/Cursor extension activity route feasibility and minimal descriptor | Expansion |
| B10 | collectors/cursor-cli | Cursor CLI output/log route, version fixture, source coverage | Expansion |
| B11 | collectors/claude | Consented Claude JSONL usage import for cross-agent development flights | Expansion |
| B12 | collectors/codex | Consented Codex session usage import with session allocation uncertainty | Expansion |
| B13 | collectors/opencode | OpenCode exported session/token import | Expansion |
| B14 | collectors/provider-usage | Explicit supplied provider receipt/usage file import; no account-wide auto-fetch | Expansion |
| B15 | collectors/github-runs | Actions runs and attempts with pagination/ETag/partial states | Core |
| B16 | collectors/github-jobs | Attempt-specific jobs, start/end/status and missing timestamps | Core |
| B17 | collectors/github-pr | PR metadata, head/base repository IDs and commit links | Core |
| B18 | collectors/github-review | Review events/timeline and requested-review episodes | Expansion |
| B19 | collectors/github-checks | Check runs/statuses outside Actions; conservative duplication handling | Expansion |
| B20 | collectors/shell-command | Opt-in command wrapper durations/exit status; no ambient shell-history scrape | Expansion |
| B21 | collectors/local-test | JUnit/structured test import and command-session joins | Expansion |
| B22 | collectors/manual | Explicit start/stop/wait markers and labelled user claims | Core |
| B23 | `src/dx/correlation/repo/` | Canonical repo/worktree mapping and path containment | Core |
| B24 | `src/dx/correlation/flight/` | Immutable flight ID, aliases, explicit start, branch reuse and detached state | Core |
| B25 | `src/dx/correlation/github/` | PR/head-SHA/attempt joins, unassigned ambiguous events | Core |
| B26 | `src/dx/correlation/ai/` | Conversation/branch event joins and allocated/unallocated fractions | Core |
| B27 | metrics/intervals | Interval union and sum, censoring, clock errors | Core |
| B28 | metrics/git | Commit/file/churn summary with base-SHA definition | Core |
| B29 | metrics/ci | Feedback latency, job sum, overlap, failed attempts and retries | Core |
| B30 | metrics/ai-usage | Measured usage categories, duplicate detection, uncovered usage | Core |
| B31 | metrics/cost | Charges versus versioned price estimates versus subscription allocation | Expansion |
| B32 | metrics/review | Time-to-first-review/review episodes with missing boundaries | Expansion |
| B33 | metrics/provenance | Attribution/survival only with validated lineage and denominator | Expansion |
| B34 | metrics/friction | Ranked evidenced findings, thresholds and null-safe recommendation templates | Core |
| B35 | `src/dx/reports/analyze/` | Deterministic analyze report from typed metric outputs | Core |
| B36 | `src/dx/reports/explain/` | Stable timeline, source lanes, uncertain ordering and pagination | Core |
| B37 | `src/dx/reports/evidence/` | Redaction and bounded original source links/refs | Core |
| B38 | `src/dx/cli/commands/` | start, collect/import, analyze, explain, status with cached report path | Core |
| B39 | `src/dx/mcp/handlers/` | MCP analyze/explain/status/evidence handlers, stdout protocol isolation | Core |
| B40 | `.cursor/skills/dx-analyze/`, `.cursor/skills/dx-explain/` | Actual Cursor command invocation and output-preservation instructions | Core |
| B41 | `src/dx/ui/flight/` | Ratstack flight page using report JSON and capability table | Expansion |
| B42 | `src/dx/ui/timeline/` | Timeline/evidence drill-down from frozen report JSON | Expansion |

Do not label an uncertain API adapter core until its research/runtime probe confirms support. B05-B08 are independent candidates for the no-Enterprise AI path, with one working candidate sufficient for the minimum release. Their failure states remain useful deliverables.

### Wave C: adversarial tests, packaging and release

Reuse completed workers. These 16 assignments bring the manifest to 64 bounded assignments. Review workers depend only on their target module/fixture reaching testable state and do not wait for every adapter.

| ID | Owner paths | Deliverable | Dependencies |
|---|---|---|---|
| C01 | `tests/contract/`, `fixtures/contract/` | Reject invalid envelopes, unknown versions, metric null/coverage rules | A03/A04 |
| C02 | `tests/storage-replay/`, `fixtures/replay/` | Replay twice, out-of-order snapshots, retained failed attempts, crash recovery | B01 |
| C03 | `tests/identity-adversarial/`, `fixtures/identity/` | Worktrees, branch reuse/rename, rebase, forks, detached/unborn HEAD | B02/B23/B24 |
| C04 | `tests/ci-arithmetic/`, `fixtures/ci/` | Overlap, null/end clocks, reruns, cancellation and independent hand-calculated goldens | B15/B16/B27/B29 |
| C05 | `tests/ai-accounting/`, `fixtures/ai/` | Cache categories, duplicate imports, mixed branches, absent costs and tokens | B26/B30/B31 |
| C06 | `tests/local-adapter-versions/`, `fixtures/cursor-versions/` | Unsupported layout/version rejects safely; read-only snapshot evidence | B05-B10 |
| C07 | `tests/report-goldens/`, `fixtures/reports/` | Golden analyze/explain, unavailable fields visible, evidence joins | B35-B37 |
| C08 | `tests/mcp-protocol/`, `fixtures/mcp/` | Launch process, protocol-only stdout, cancellation, bounded pagination | B39/A02 |
| C09 | `docs/execution/cursor-live-smoke.md` | Actual Cursor command smoke and captured outcome; write no fictional success | B40/B39/A02 |
| C10 | `tests/privacy/`, `fixtures/privacy/` | Synthetic secrets/prompts/tool instructions redact and never execute | B37/source adapters |
| C11 | `tests/github-permissions/`, `fixtures/github-errors/` | No auth, expired auth, partial pages, 403/429/5xx and cache behavior | B15-B19 |
| C12 | `tests/local-runtime/`, `fixtures/runtime/` | No repo, no GitHub, offline, store busy, corrupt spool, missing adapter | B01/B38 |
| C13 | `scripts/dx-install.*`, `docs/install.md` | Owned config merge/backup and installation/uninstall dry run | A01/B40 |
| C14 | `docs/demo.md`, `fixtures/demo-script/` | Rehearsable live flight plus separately labelled adversarial fixture flight | B35/B36/C09 |
| C15 | `docs/pitch.md`, `docs/claims-audit.md` | Evidence-backed claims, product separation, no fabricated productivity causality | C07/C14 |
| C16 | `docs/release-checklist.md`, `docs/known-gaps.md` | Independent release verdict, supported route matrix, minimum release acceptance | C01-C15 as applicable |

If useful, 50+ agents may participate across these waves. The manifest does not require all 64 tasks to pass for a four-hour release. Expansion nodes can complete as disabled tested adapters or documented unsupported routes. Counting agent launches is not an acceptance condition.

## Dependency graph and deadline gates

The minimum path is A01+A03+A04, then B01+B02+B03+one of B05/B07/B08+B15+B16+B22-B30, then B34-B40, then C04+C05+C07-C10+C14+C16. Several nodes in this notation are independent, not an ordered sequence. Make each assignment a separate `.plan.md` or a single task node. A giant plan with sequential todos would destroy the intended fan-out. Use explicit edges for actual imports; test shards may depend on interfaces plus fake implementations before real adapters land.

The root reserves A02's attention for integration throughout. A02 does not wait until all workers finish. It connects each core descriptor when its fixture passes, runs the report spine and maintains a single combined compile/test result. Partial adapter failures remain local. Registry flags can disable an unfinished adapter without deleting source or test files.

The gates below are elapsed checkpoints within the user's four hours, not predicted task durations. Start the clock only when execution begins, not during this research/planning revision.

| Checkpoint | Required observable result | Mandatory cut action |
|---|---|---|
| T+15 min | Ratstack skeleton chosen, exact runtime known, contract v1 and owner paths published | If generation/runtime fails, preserve Ratstack output and choose its verified supported path; stop speculative framework swaps |
| T+45 min | Store ingests golden fixture; cached analyze/explain reach CLI/MCP skeleton; live Git collection works | Root focuses integration and contract blockers; stop new dependency proposals and schema changes |
| T+90 min | One no-Enterprise AI route has a real recognized input, or truthful unavailable result; GitHub run/job import works or reports permissions gap | Enable only demonstrated adapters; unsupported source experiments cannot block core |
| T+150 min | Actual Cursor chat command returns analyze/explain; evidence links and unavailable fields survive output | Freeze collector enablement and report schema; cut UI/provenance/new-provider work from release |
| T+180 min | Full demo path replayed; arithmetic, secret-redaction and protocol tests pass | Fix only broken release criteria; all other nodes hand off docs/tests and stop adding functionality |
| T+210 min | Rehearsal completes from a restart; fixture mode visibly separate; installer/config path verified | Freeze packages and features; preserve release artifact and prepare final claims/gaps |
| T+240 min | Deliver runnable command workflow, source capability matrix, actual test verdict and demo script | Stop implementation; publish the actual supported subset, with unresolved gaps |

At each cut, stop or redirect unfinished expansion workers cleanly, preserving their files and test evidence. Never kill another session's processes. A deadline cannot justify marking a failed acceptance test complete. If actual Cursor invocation remains broken at the hard deadline, report that failure and demo the verified CLI/report; do not claim the required Cursor demo passed.

## Concurrent failure modes to prevent

| Risk | Concrete control |
|---|---|
| 50 agents all install or modify lockfile | A01 alone installs/pins; workers request dependencies in their node file |
| Global build is red due to half-written modules | Each owner runs its shard; integration imports only landed descriptors; explicit feature gate |
| Metrics workers disagree on meanings | Frozen definitions and independent arithmetic fixture goldens; C04/C05 reject semantic drift |
| Schema merges consume the deadline | Single steward, leaf imports, optional extensions by recorded approval only |
| SQLite locks and mixed-time reports | One writer and one immutable report snapshot per command |
| Same source observation counted several times | Source IDs/content hashes and explicit cross-route duplicate policy; never text/time-only dedupe |
| Local Cursor storage differs by release | Version detection, recognized-layout fixtures, isolated read-only adapter, unavailable fallback |
| Copied DB contains secrets/private chat | Explicit opt-in, bounded read-only snapshot and adapter redaction; never inspect live personal data during planning |
| Shared fixture index or barrel is overwritten | A04/A02 sole ownership; workers write shard folders only |
| Integration worker swamped by 42 finishes | Node acceptance commands and artifact manifests; adapters register through one fixed descriptor; optional failures disabled |
| Review agents edit outside their lane | Finding/patch proposal ownership and explicit transfer before a fix |
| Source adapters need internet during every report | Cached snapshots; collection is separate from report rendering |
| UI consumes stale/incompatible metrics | Same report contract and fixture as CLI/MCP, no independent calculations in UI |
| Huge context and polling waste four hours | Bounded worker brief, unique result file, parent reads completion summaries and reacts to blockers |
| Workers declare success with fictional live data | C09 records actual Cursor outcome; demo origin labels and evidence IDs are mandatory |
| Plan graph falsely serializes broad work | One node per ownership lane and explicit real dependencies; inspect frontier width before launching |

The main scarce resources are contract decisions, integration ownership and real environment access. Parallel agents accelerate independent adapters, parsers and verification. They cannot remove those dependencies. The plan therefore gives those dependencies sole owners and cuts unfinished optional work without weakening evidence honesty.

## Sources for orchestration constraints

- User correction in the current conversation is the authority for four hours, separate product, Ratstack and high agent concurrency.
- The runtime context is the authority for 51 available slots; parent reports the configured `max_threads=50`, so schedule at the lower ceiling.
- The plan-graph skill documents that inter-plan edges connect the final source todo to the first destination todo. Separate ownership nodes avoid accidentally serializing broad lanes.
- `research/implementation-spec.md` supplied the prior event/store/metric concerns. Its Biomem coupling and first-hour pinning assumption are superseded here.

Source-specific adapter viability and exact Ratstack template paths must come from the sibling research reports. This document deliberately does not invent unsupported token fields, hidden Cursor schemas or Ratstack dependencies.
