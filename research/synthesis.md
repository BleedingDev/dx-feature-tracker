# dx-feature-tracker: standalone Ratstack product

Historical synthesis of the 2026-09-30 research revision. Its deadline, Cursor-first scope and pending gates describe that proposal. Current direction is [VISION](../VISION.md), [product decisions](../docs/product/decisions.md) and the proposed [agent system](../docs/architecture/agent-system.md). New execution uses [the separate follow-up graph](../plans/agent-system/README.md), not the original 79-node selection. Source reports remain evidence for their dated claims; installed versions and capabilities must be checked.

Revision date: 30 September 2026. User-authoritative direction: a separate tool, Ratstack, four hours, lean execution, native agents at high concurrency, and maximal credible telemetry without Enterprise access. There is no Biomem product, runtime, API, CLI, memory or promotion integration. The prior two-person/24-hour proposal and required Biomem memory loop are superseded. Original artifacts are preserved under `history/v1/`.

## Decision

Build an independent local evidence recorder that correlates development activity to repository, worktree, immutable flight and observed Git history. Project deterministic reports through Ratstack CLI and MCP. The demo stays in Cursor. Launch source adapters, metric projectors, fixtures, protocol tests and adversarial checks in parallel against one frozen interface.

The product should answer: "Which feedback loops repeated during this feature, what evidence supports that, and what should I test before my next push?" Its value is making fragmented evidence inspectable. A flight metaphor, chat interface, AI token counter or attribution percentage is not novel by itself. Existing [DX reports](https://docs.getdx.com/reports/ai-effectiveness/) and [LinearB MCP](https://linearb.io/platform/mcp-server) overlap substantially. Compete on self-serve local installation, no organization-admin dependency, source breadth and auditable per-flight calculations. Those are design targets; competitive exclusivity and demand are unproven.

Pitch: "Cursor helps you write code. dx-feature-tracker shows how the feature actually developed, with evidence for what slowed its feedback down."

## Correction that changes data collection

**No Enterprise API does not mean no tokens, no attribution, or no useful historical data.** The first pass confused missing official API guarantees with unavailable local evidence. The new research adds routes that deserve implementation and validation.

- Current Entire source and a [Cursor usage collector](https://github.com/SebberSky/cursor-token-usage) parse optional stop-hook usage fields. Official hooks docs do not promise those fields. Capture them when present, preserve their raw categories, then verify incremental versus cumulative behavior before summing. Parser support is not proof of the installed build.
- Local Cursor databases can contain message/token/model/tool metadata, checkpoints and Cursor-produced commit attribution. Feature-detect recognized tables/columns and snapshot safely. Some values are placeholders or context-window occupancy, not billable totals. [Pinned codeburn parser](https://github.com/getagentseal/codeburn/blob/986d72ce1efbfaf40b3c9d4050d9ecdbc24be986/src/providers/cursor.ts)
- Personal usage CSV is a documented manual route. It can provide source counts and sometimes numeric cost, but branch/session IDs and price semantics vary. [Cursor staff guidance](https://forum.cursor.com/t/usage-api-cli-command/160967)
- A user-initiated export of already-loaded dashboard usage responses may supply richer session IDs. It is an isolated optional parser for user-owned data, with pagination/coverage checks. No copying cookies or credentials is needed or planned.
- The [Cursor SDK](https://cursor.com/docs/sdk/typescript) supports prospective run accounting through user API keys. It measures those instrumented runs, not all native IDE history. Access and billing settlement still need a capability probe.
- Git AI/Entire imports and observed edit snapshots can support provenance. Commit AI share, heuristic attribution and strict observed-line survival remain different metrics.

Source reports contain exact published paths, schemas, pinned implementations and semantic traps. The implementation gate is whether a route delivers a recognized record on the intended build, not whether it has a glossy supported API.

## Broad collection map

| Route family | Accessible evidence | Honest limits / action |
|---|---|---|
| Cursor Agent/Tab/tool/shell hooks | Future activity, edits, durations, session and generation IDs | Probe installed events; optional token fields remain raw until semantics verified |
| IDE global/workspace DBs | Historical conversations, bubbles, request/model IDs, checkpoints/context and sparse timing | Opt-in read-only snapshots, schema/version gates; no universal completeness |
| Cursor JSONL/TXT/manual exports | Conversation/tool content and edit candidates | Missing timestamps/usage/success remain missing; attempted tool call is not applied edit |
| Cursor CLI databases/output | Session/workspace metadata, content blobs, tool boundaries | Legacy and lowercase new paths; protobuf/JSON decoder gated; no guaranteed output tokens |
| Cursor AI tracking DB | Commit/conversation/request attribution and scored lines | Source-reported attribution, not independently verified review survival |
| Personal CSV | Model/date/count/category rows and supplied costs | Account totals may be exact source values while flight allocation remains reconstructed/unassigned |
| Dashboard response JSON | Possible richer request/conversation fields | Explicit browser export, allowlisted fields only, undocumented format and completeness gates |
| Cursor SDK | Tagged future run IDs, source tokens, optional settled charges | Instrumented SDK traffic only; SDK key support is not every-account entitlement proof |
| Provider exports/owned gateway | User-owned receipts or observed API response counters | BYOK/native/provider traffic boundaries explicit; account aggregates are not per-feature bills |
| Git AI / Entire | Notes, checkpoints, sessions, attribution and optional usage | Do not install/init/push metadata silently; keep source semantics and cumulative-window dedupe |
| Git history/worktrees/reflogs/stash | Commit/diff/ref context, current dirty state, retained reference movements | Local expiry/rebase gaps; first commit is not active-work start |
| Shell/command wrapper | Monotonic command duration, exit state, current context | Only observed commands; shell history lacks reliable full timing |
| Structured local/CI tests | Test identity, attempts, duration, failure signatures | Requires emitted/retained artifacts; passing after changed code is not proof of flakiness |
| IDE diagnostics/terminal/activity | Diagnostic lifetimes, terminal state, editor liveness | Cursor compatibility with VS Code APIs must be tested; inactivity is not waiting |
| Package install/compiler/dev-server/HMR | Selected timing records, compiler phases, feedback events | Instrument or import retained logs; HMR event is not visual correctness |
| Actions/checks/statuses | Attempts, jobs, steps, annotations and external CI transitions | Rate limits, retention and cross-source duplicates; no pure queue-cause inference |
| PR timeline/reviews/comments/threads | Ready/request/change/approval/merge chronology, discussion and snapshots | Review effort and exact historical thread-resolution time are not established |
| Selected CI logs/artifacts/deployments | Failure evidence, test reports, environment transitions | Bounded opt-in bytes, archive/XML safety; staging/production scope explicit |
| Other coding-agent exports | Consented local supported-host usage/session imports | Separate adapter/version checks; do not transfer execution to another agent host |
| Manual markers | Explicit flight boundaries and blocked-on-CI claims | Useful optional evidence, not mandatory interaction every turn |

This is a broad credible-route catalogue, not a proof that every source can be enabled within four hours. Each adapter must emit tested data or a terminal unsupported/disabled manifest. A failed optional adapter reduces coverage, not the integrity of the report.

## Ratstack choice, precisely

Use the pinned [Ratstack reference](https://github.com/joelhooks/rat-stack/tree/753c7b07dcc516037dd1d455a8766bf112084844), not arbitrary Effect examples. Keep capability schemas/handlers, required support services, CLI/MCP projections and the fence. Put new domain modules under `packages/core/src/dx/`; composition stays in the existing CLI application. Omit cloud/web/auth/code-mode from the first executable composition. A dashboard remains an independent optional consumer.

Ratstack's existing database cartridge is D1/Hyperdrive RunLog; its test engines are not a persistent local flight database. Add a narrow scoped `node:sqlite` EventStore using the selected Node runtime. The upstream minimum is Node 24.18.0; actual SQLite/runtime/fence compatibility remains a bootstrap proof. Exact pins and source links are in [Ratstack research](reports/revision/ratstack.md).

Ratstack's hosted HTTP MCP and local stdio composition advertise different protocol versions. Test the actual Cursor launch, initialization, tools/list and call through the built artifact. Do not infer local compatibility from the public website's server.

## Agent execution model

No human team-size assumption. Configured native limit is 50 threads; session offers 51 slots. Schedule against the lower limit. Reserve the root and allow at most 49 active workers. More than 50 useful assignments run across waves; the plan does not need a config change. The implementation clock starts when execution begins.

Use bounded module assignments plus explicit root-owned G00–G04 phase gates. A02/A07/A08 are one integrator’s sequential milestone tasks. All 48 source/metric/report module lanes remain independently implementable after G00; scheduling prioritizes a presentable v0/v1 and reserves four worker slots for core checks/repairs. Core audits and final release do not wait on optional collectors. [Phase gates](phase-gates.md) define full checks, actual Cursor validation, real source probes, last-green artifacts and stopping rules. Every gate remains pending until execution demonstrates it.

Four-hour checkpoints trigger cut decisions, not automatic gate success. Stop with the highest passed v0/v1/v2 artifact, or report no-go. Concurrency cannot prove unknown source semantics or guarantee delivery speed.

## Metric honesty, without discarding available data

Keep four axes: origin live/imported/synthetic; acquisition hook/DB/export/API; measurement source-reported/reconstructed/estimated/unavailable; attribution strong/provisional/unassigned. A record may have exact imported account tokens and uncertain flight allocation. One confidence badge cannot express that.

Use explicit numerator, denominator, checkpoint, coverage and missing reasons. Missing cost is not $0. A source-provided zero is preserved with semantics. Context-window meter is a separate useful signal and must not be summed as spend. Cached counters may be inclusive in one source and independent buckets in another; semantic mapping is source/version-specific.

Flight span is recorded wall-clock, not active work. Sum of job durations is compute; union of intervals is elapsed execution. Confirmed human blocking needs explicit evidence. A recommendation can identify repeated failures and suggest the existing local test. Causal savings/productivity remain unestablished.

Strict retention is allowed for uniquely tracked observed AI-origin line instances through a named checkpoint. Imported Cursor scores are source-attributed commit share; Entire percentages are heuristic. Unknown changes remain unknown, not human. Git AI `ai_accepted/ai_additions` still cannot establish retention. Line survival says nothing about correctness or value.

## Evidence and finding verdicts

| Finding | Verdict | Evidence / limit | Decision |
|---|---|---|---|
| Useful non-admin local telemetry exists | SUPPORTED | Official hooks/exports, published parsers, Git/test APIs | Implement broad gated adapters |
| Optional native stop token fields may be usable | SUPPORTED for parser evidence; INCONCLUSIVE for installed availability/semantics | Entire and usage-collector source; official omission | Opportunistic capture plus two-turn/cumulative probe |
| Native branch bill can always be exact | CONTESTED | Export IDs, category/cost gaps and multi-branch sessions | Separate source totals, allocated estimates and remainder |
| Local snapshots can support observed strict survival | SUPPORTED as design; runtime coverage unverified | Hook edits plus ordered before/after lineage | Pure projector and adversarial fixtures; no semantic correctness claim |
| Every retrospective action can be recovered | WEAK | Local expiry, missing fields and unsupported layouts | Preserve gaps; no universal completeness claim |
| Ratstack supplies the necessary projection pattern | SUPPORTED | Pinned contracts/handlers/projections | One shared capability, deterministic output |
| Forty-nine workers produce forty-ninefold speedup | WEAK | Integration/resources and access remain serial | Wide ownership fanout with explicit bottlenecks |
| Standalone per-flight evidence will attract users | INCONCLUSIVE | Competitive precedent, no demand experiment | Demo a useful investigation; test adoption afterward |
| One flight proves productivity or saved minutes | INCONCLUSIVE | No counterfactual, activity is multidimensional | Keep claims descriptive and testable |

## Demo

Show a real flight with Git context, one supported non-admin AI route and imported CI/PR evidence. Add local command/test feedback and detailed reviews only when those optional routes are enabled. Run `/dx-analyze`, inspect the arithmetic and source links, then `/dx-explain` to inspect repeated feedback. If `/dx analyze` subcommand syntax works on the actual build, keep it; otherwise use the tested explicit skill names.

Also prepare a separate labelled adversarial fixture with overlap, reruns and partial attribution. It proves calculation behavior, not that those events happened live. The user can inspect the coverage table and see which adapter failed or is disabled. No Biomem daemon, lesson save or second-flight memory recall is required.

No external-product promotion is included. No outreach/publication is performed by this planning task.

## Reports and limits

Eight revision reports: [Ratstack](reports/revision/ratstack.md), [local Cursor](reports/revision/cursor-local.md), [usage/export routes](reports/revision/usage-exports.md), [provenance](reports/revision/provenance.md), [local DX](reports/revision/local-dx.md), [parallel execution](reports/revision/parallel-execution.md), [GitHub expansion](reports/revision/github-expanded.md), [adversarial audit](reports/revision/brutal-audit.md).

114 distinct source URLs appear in these revision reports. Sources include official contracts, pinned code and public synthetic fixtures; counts are not independent organizations or accuracy benchmarks. No personal DB/account/session data, installs, upstream runtime execution or product implementation was performed. All eight reports were reviewed before this synthesis. Account/runtime behavior and four-hour implementation success remain unverified until execution.
