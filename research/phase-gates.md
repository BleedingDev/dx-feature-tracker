# Stoppable phases and validation

These are product milestones, not estimates. The four-hour deadline still applies. Every gate is pending until execution produces its evidence. Passing plan-graph validation does not pass a product gate.

| Phase | Presentable result | Required checks | Stop or continue |
|---|---|---|---|
| P0 foundation | Ratstack starts; capability contracts and compatible runtime are demonstrated. This is a technical checkpoint, not a finished product demo. | Verified bootstrap commands, package checks, SQLite append/reopen probe, real stdio MCP initialize/tools-list/call, frozen contracts and owned paths. | Stop with a technical proof if runtime is incompatible. Fix the foundation before admitting product integration. |
| P1 v0 recorder/replay | Actual Cursor analyze/explain shows real Git identity and an explicitly labelled adversarial replay for AI/CI. Evidence links, missing states and restart work. | Built-artifact boot, deterministic replay, duplicate ingestion, immutable snapshot reuse, overlapping interval arithmetic, branch ambiguity, sanitized export, actual Cursor command invocation, clean restart and workspace checks. | This is a presentable v0. If time or source access fails later, keep this verified artifact and disclose the replay scope. |
| P2 v1 real flight | Actual Cursor analyzes a selected real branch with real Git, one validated non-admin AI route and real imported Actions/PR evidence. | All P1 regressions; source/version probes; pagination/attempt/job coverage; known AI-route group rule; cross-source dedupe; partial-data/errors; source-linked calculations; clean restart; actual Cursor rehearsal and workspace checks. | This is the target working feature tracker. Unknown tokens/cost/survival stay explicitly unavailable. Stop here without UI or optional adapters. |
| P3 v2 evidence extensions | v1 plus whichever optional routes pass their own gates. Examples include verified usage/cost, strict observed survival, local test feedback, detailed reviews or dashboard. | Only enabled modules are promoted. Run their targeted correctness/version/privacy tests, all earlier regressions, workspace checks and a Cursor rehearsal for the final artifact. | Disable or quarantine a failing extension and keep the last passed version. No optional metric can invalidate a preserved verified v1 artifact. |

| P4 release | Final frozen artifact, installer/restart rehearsal and explicit last-green verdict. | G03 disposition, C16 final fence and all prior regressions, actual Cursor restart with pre-restart snapshot, clean config merge/uninstall fixture, claims review. | Present the exact last passed artifact. Unchecked later work remains unreleased. |

## Gate evidence and promotion

The root is gate authority; A02 owns integrated code; C owners supply independent checks. A01 publishes an executable command manifest with exact argv, cwd, prerequisites and expected result against the selected checkout. Its entries include bootstrap checks, SQLite reopen, built CLI/MCP smoke, fixture replay, phase regressions, restart, export and installed Cursor invocation. A01 may ask each owner for commands, but it is the sole manifest editor. A command not yet verified is marked prospective; it cannot satisfy a gate.

Use `pnpm turbo run check test build` for each candidate milestone before promotion. A01 verifies the command against the selected scaffold. Run it through one validation queue, with no duplicate whole-workspace suites. Targeted owner tests precede this gate. If a required check fails, do not skip or weaken it.

Freeze the candidate artifact before running checks. The validation input is a named commit/content digest, contract digest, enabled-module set and schema version. Test and demo that exact artifact. Keep dependency/build trees shared and registered; do not create one install per agent. A02/root select an isolated integration snapshot for validation or briefly pause producers while the candidate is tested. Unfinished optional files must not be included in the candidate compile/test graph. Quarantine them in their owner's work branch or exclude them through explicit build configuration, never hide failures of enabled code.

Store receipts at docs/execution/phases/g00.json through g04.json, with milestone, candidate digest, enabled descriptors, actual command exit codes/log references, source coverage, Cursor invocation evidence, gaps and verdict. Root alone owns these receipts. Preserve the last passed runnable artifact and sanitized demo bundle before enabling new modules. A later build cannot overwrite the only known working demo.

An actual Cursor validation means the installed client launches the built server, initializes MCP, lists tools, calls analyze and explain against the same snapshot, and follows an evidence reference. Capture client/build versions, returned snapshot IDs and observable output. A CLI call or synthetic client is useful protocol testing, but cannot substitute for this gate. If client automation is unavailable, the operator performs these steps and records the observed result. Pending observation remains pending; do not invent approval.

## Acceleration and stopping

Use the milestone dependency set as the scheduler's first priority. Reserve worker admission for integrator, gate validators and repairs; source breadth fills remaining slots. A fifty-node ready frontier is not a command to launch every optional collector before the core can be presented.

A passed gate permits its milestone to be presented immediately. The root may stop at any passed gate and report its exact capabilities. Starting P3 never requires disabling a passed P2 artifact. Four-hour checkpoints trigger cuts or a gate attempt; elapsed time never counts as gate success. At T+240 stop and present the highest passed artifact, or report no presentable artifact if only P0 passed.

If an optional worker stalls, cancel its assignment through the supported agent controls, collect its bounded handoff, and mark the route disabled in the candidate manifest. Its terminal receipt must not be treated as a completed implementation. Do not wait for all optional adapters to pass before validating v0/v1.

## Encoded gates and priority

G00–G04 are executable root-owned graph nodes. G00 freezes the foundation; G01 depends on built v0 integration and its core checks; G02 depends on real integration/probes/client validation and has an additional runtime predicate requiring at least one verified real B05/B07/B08 route. Graph dependency completion is necessary but never sufficient for gate pass. Optional group members need not all finish; root evaluates actual receipts. G03 depends only on G02 and consumes whatever optional receipts exist at freeze. C16/G04 never depend on optional producer completion.

A02, A07 and A08 are one integrator’s sequential baton for v0, v1 and extensions. Shared paths are intentional only for this sequence. C09 validates v0 in Cursor; C17 validates real v1. A06 records actual presence/version facts; A09 runs real-input probes through the built composition.

Root reserves four of the 49 worker slots for ready core validators and repairs. Admit milestone producers/integrator first, then core C nodes, then optional routes. If necessary pause the lowest-priority optional work to admit a core repair. Early read-only source/schema preparation may use spare slots while the scaffold is being created; production edits wait for G00. The graph frontier is not the admission policy. No agent creates an independent dependency tree.

Input selection is root-owned during P0 or supplied before T0: recorder repo, demo repo, exact permitted local inputs, GitHub read access and Cursor operator. Do not move implementation outside the four-hour clock. Missing inputs are immediately not-attempted, and exports/operator actions remain pending until observed. SQLite/runtime failure leaves P0 no-go if no compatible supported Node passes; no rushed alternative store is implied.

Required live-core v1 includes available real GitHub CI/PR evidence. Missing GitHub access can produce degraded-live with explicit gap; it cannot pass the full live-core predicate. Source tokens, flight charges and AI survival remain separately gated. Each enabled optional route needs a real receipt before being described as live, unsupported-layout rejection and content redaction checks.
