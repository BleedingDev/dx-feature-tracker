# Four-hour execution with presentable stopping points

DX Flight Recorder is a separate Ratstack tool. Four hours is a hard deadline, not a task estimate. No human team size is assumed. Implementation and every runtime gate remain pending.

## Phases and validation

Read [phase gates](phase-gates.md) for exact deliverables, checks, receipts and cut rules. The graph encodes five root-owned gates:

| Gate | Stop output | Acceptance |
|---|---|---|
| G00 / P0 | Working foundation and frozen contracts | Verified runtime, SQLite, built CLI/MCP baseline, ownership, command manifest and full fence |
| G01 / P1 v0 | Real Git plus explicitly labelled AI/CI replay, analyze/explain in actual Cursor | Core module tests, replay/dedup/snapshot/privacy checks, built package, installer, restart, full fence and actual client observation |
| G02 / P2 v1 | Real selected flight with Git, one verified non-admin AI route and CI/PR evidence | Real source receipts, composed end-to-end test, core audits, prior regressions, full fence and actual Cursor rehearsal |
| G03 / P3 v2 | v1 plus individually validated optional extensions | Freeze actual passing enabled set; unsupported/nonpassing work disabled or quarantined without blocking v1 |
| G04 / P4 release | Frozen tested release or explicit last-green verdict | Installer/restart/replay/claims rehearsal and final fence on the same artifact |

P0 is a technical checkpoint. v0 can be presented as a labelled replay product. v1 is the target real flight recorder. v2 is optional source/metric breadth. A no-access CI result is degraded-live, not full live-core. No source values for cost/tokens/survival are invented. A phase gate cannot pass from graph dependencies or elapsed time alone.

At each candidate promotion run `pnpm turbo run check test build` through one queue, using A01-verified configuration. Preserve a named commit/digest and runnable artifact for every passed gate. Actual Cursor checks use the built executable and installed target configuration; a CLI or mock protocol test cannot substitute. Gate receipts record commands/results, versions, snapshot ID, enabled descriptors, source coverage and observable demo evidence. An unavailable Cursor operator leaves client validation pending. Stop at the highest passed artifact without claiming unverified extensions.

## Parallel admission and integration

Configured capacity is 50 threads; use root plus at most49 workers. Reserve four worker slots for ready core validators and repairs. Admit milestone producers and the integrator first, core auditors next, optional sources with remaining capacity. Pause the lowest-priority optional task if a core fix needs a slot. The ready frontier is not a scheduler priority order.

A01/A03/A05/A06 begin foundation work; A04 follows A03. Read-only source preparation may use spare slots during scaffold creation. A03 production writes wait for A01 scaffold-created signal, and no generator rerun follows that signal. G00 is the production fanout barrier for all 48 independent B module lanes. They work against frozen contracts/fixtures without waiting for real sources. They do not all need simultaneous admission.

One integration owner holds a sequential baton: A02 builds v0 after its minimum modules land; A07 composes real v1 after G01; A08 admits optional extensions after G02. Shared paths are never edited concurrently by separate owners. A06 records actual host facts; A09 probes explicitly selected real inputs through the built composition. C09 verifies v0 in Cursor and C17 verifies real v1. C13 owns target MCP/hooks/skills installation. Root owns source selection and all phase receipts.

Input selection is done during P0 or supplied beforehand, without moving implementation outside the deadline: recorder/demo repository, permitted source paths, GitHub access and Cursor operator. Missing inputs are not-attempted immediately. Never initialize the home directory or inspect unrelated private sessions.

Core audits no longer wait for optional collectors. Optional privacy/version/accounting/layout checks belong to each enabled extension. C16 and G04 depend on G03 disposition, not completion of optional producers. Disabled registry state alone is insufficient: unfinished code must pass the full fence or stay out of the tested candidate tree. Preserve the last green demo before changing enabled modules.

## Deadline cuts

| Checkpoint | Decision, not effort estimate |
|---|---|
| T+15 | Attempt G00 freeze; if it fails, hold production fanout and fix or report bootstrap no-go |
| T+45 | Attempt presentable v0; if absent, stop optional admission and prioritize spine repairs |
| T+90 | Select demonstrated real AI/GitHub inputs; concentrate source effort on nearest viable route |
| T+150 | Freeze extensions and record G03 disposition; late optional landings stay excluded |
| T+180 | Correctness/release fixes only |
| T+210 | Actual Cursor restart and rehearsal of final candidate |
| T+240 | Stop and report the highest passed artifact or no-go |

G03 requires a passed G02. If v1 has not passed at freeze, disable optional admission immediately, preserve passed v0, and continue only core repairs. If v1 later passes, G03 records a bounded no-extension disposition. These times trigger decisions; they do not automatically satisfy phase gates.

## Executable plan graph

[79 assignments](plan-index.md) and the [canonical manifest](execution-manifest.json) (the plan files are in [`/plans`](/plans)). All tasks remain pending. Strict graph validation passed with no warnings or errors: 79 plans, 145 edges ([validation summary](phase-plan-validation.json), [Mermaid DAG](dag.mmd)).

## Demonstration

Invoke tested `/dx-analyze` and `/dx-explain` with the same snapshot ID, then follow an evidence link. Use `/dx analyze` syntax only if that routing was actually verified. Show real failures/overlap only when present; otherwise use a separately labelled adversarial replay. Context-window occupancy is not billable usage, account spend is not feature spend, and CI feedback latency is not developer blocked time. Cost allocation requires enabled B31; strict AI survival requires observed lineage and a named checkpoint. Without their gates show unavailable.

The look-back flight uses retained Git/GitHub/transcript/export evidence. A short prospective flight begins only after hooks are installed and an authorized Cursor operator generates events. Prepare inspectable sanitized reports and installation instructions; this planning task publishes nothing.

[Factory Opus 5.5 review](reviews/factory-opus-5-5-phase-review.md) and [feedback dispositions](reviews/feedback-dispositions.md) document the revision.
