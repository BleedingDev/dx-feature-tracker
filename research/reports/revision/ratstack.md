# Ratstack: verified local architecture for standalone dx-feature-tracker

Research date: 2026-09-30. Source snapshot: `joelhooks/rat-stack` main commit `753c7b07dcc516037dd1d455a8766bf112084844` (commit authored 2026-09-28). Read-only public HTTP/API research; no clone, install, execution of upstream code, or access to private local telemetry. Runtime claims below are unverified until the scaffold boot gate runs.

## Decision

Use Ratstack's **one contract → one Effect handler → CLI and MCP projections**. Ship a local process with a persistent EventStore. Cut the cloud website, auth, infra, code-mode sandbox, browser RPC and shipped file-inspection example from the baseline composition. Preserve the scaffold's checks and exact dependency line. Biomem is not an implementation dependency.

The hard engineering seam is not MCP or a dashboard: it is **source adapters → validated evidence envelope → idempotent event store → deterministic correlation/metrics → report**. Fifty agents must implement isolated adapters, fixtures, metrics and proofs against that frozen seam. They must not each invent a collector framework, database schema, capability registry or lockfile edit.

## Exact observed pins and requirements

| Area | Exact upstream declaration | Implication |
|---|---|---|
| Runtime | Node `>=24.18.0` | Boot with this line; do not assume older hackathon machines work |
| Package manager | `pnpm@11.3.0`; engines pnpm `>=11.1.2` | One bootstrap owner installs once |
| Effect | `4.0.0-rc.117` | RC API; inspect installed source, do not paste Effect 3 recipes |
| Node platform | `@effect/platform-node 4.0.0-rc.117` | NodeServices, NodeRuntime, stdio transport |
| TypeScript / diagnostics | `7.0.2`, `@effect/tsgo 0.45.0` | prepare patches typechecker; preserve diagnostics |
| Tests | `vitest 5.0.1`, `@effect/vitest 4.0.0-rc.117` | Use Effect test utilities, not improvised runtimes |
| Lifecycle | `xstate 6.0.0-alpha.59`, `@xstate/effect 0.1.0-alpha.2` | Keep for genuine recorder lifecycle if used; no state machine for every parser |
| Cloud | `alchemy 2.0.0-beta.79` | Existing footprint optional; local baseline requires no deployment |
| Upstream database | Drizzle `1.0.0-rc.5-ab785fc`, `@effect/sql-pg 4.0.0-rc.117`, `pg 8.23.0` | D1/Hyperdrive models, not already a local SQLite recorder |
| Local database test engines | `sql.js 1.14.2`, `@electric-sql/pglite 0.3.15`, devDependencies | Test-only layers are not shipped persistent database support |

Sources: [root manifest](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/package.json), [CLI manifest](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/apps/cli/package.json), [database manifest](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/database/package.json), [generated current pins](https://ratstack.sh/pins.md), [commit](https://github.com/joelhooks/rat-stack/commit/753c7b07dcc516037dd1d455a8766bf112084844).

## Verified capability contracts and projection behavior

`defineContract(name, options)` accepts an Effect Struct input, plain output and failure schemas, description, optional approval, annotations and HTTP metadata. Plain schemas require no encoding/decoding services. Defaults for readOnly/destructive/idempotent/openWorld are false. Set truthful annotations deliberately; read-only analyze/explain should not silently run collection as a side effect.

`implement(contract, handler)` creates the capability, consults `CallWatch`, adds the contract's approval gate and surrounds the handler with recording. CallWatch is a Context.Reference with a pass-through default. It observes **your capabilities**, not all Cursor activity. Reusing Ratstack devtools alone does not deliver a dx-feature-tracker.

`toCommand(capability, options)` derives flags and positional arguments from input fields. `render` enables a human-readable renderer plus reserved `--json`; approval reserves `--yes`. Do not define input fields named `json` or `yes` when those options apply. It decodes input and encodes output with the contract schemas, so renderers should consume structured reports rather than compute metrics again.

`toToolkit(capabilities)` returns `{ toolkit, layer }`. It derives Tool success/failure schemas, input schema and annotations and captures handler requirements in the layer. The MCP composition is `McpServer.toolkit(projected.toolkit)` with `Layer.provideMerge(projected.layer)` and `McpServer.layerStdio(...)`. Logger.LogToStderr must be true: stdout belongs to MCP frames. All service layers must be provided at the application root.

Sources: [contract.ts](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/capability/src/contract.ts), [implement.ts](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/capability/src/implement.ts), [CallWatch](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/capability/src/call-watch.ts), [CLI projection](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/capability/src/to-command.ts), [MCP projection](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/capability/src/to-toolkit.ts).

### Transport trap

The public `ratstack.sh/llms.txt` describes a deployed HTTP MCP with stateless protocol `2026-07-28`, per-request headers/meta, and Durable Object sessions for older clients. **The local CLI is different:** its pinned `surfaces.ts` explicitly configures `2025-06-18`, `2025-03-26`, `2024-11-05`. It serves tools over stdio. Its HTTP devtools server binds `127.0.0.1`, path `/__rat/mcp`. Do not claim current Cursor compatibility from the website docs; test initialize → tools/list → tools/call through Cursor or a real protocol client on the selected artifact.

Sources: [public service documentation](https://ratstack.sh/llms.txt), [actual local surfaces](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/apps/cli/src/surfaces.ts), [actual commands](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/apps/cli/src/command.ts).

## Smallest local CLI + MCP slice

Retain capability contract/implementation/approval/CallWatch and command/toolkit projections, their support modules and relevant tests; retain the CLI executable/composition pattern and fence. The published keep-or-cut guide has an oversimplified CLI-only file list: `implement.ts` imports approval and CallWatch, and contract.ts imports ApprovalDenied. Follow the compiler's actual dependency closure, not literal deletion of every unlisted file.

Replace example core handlers with standalone DX handlers; do not preserve FileInspector merely because it exists. Do not physically prune every unused package before getting the core boot proof: omit unused services from composition first, then one scaffold owner prunes stale imports/exports/tests/packages coherently. `pnpm cli` currently builds the CLI dependency graph before invoking `node apps/cli/dist/cli.js`; the final Cursor configuration should use the built executable or a deterministic launcher, without build noise on stdout.

Proposed minimum product capability names: `dx_status`, `dx_collect`, `dx_analyze`, `dx_explain`. These are **new**, not upstream names. `dx_collect` records/imports evidence and is a mutation; `dx_analyze` and `dx_explain` query a frozen/current flight and return structured metrics, timeline, evidence references and coverage. Add `dx_mark` only if explicit flight boundaries/blocked intervals are needed. Slash commands are Cursor command wrappers/rules that instruct calling these tools; MCP registration itself does not create `/dx analyze`.

Sources: [keep-or-cut](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/skills/keep-or-cut/SKILL.md), [application root](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/apps/cli/src/cli.ts), [upstream architecture and fence](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/AGENTS.md).

## Local persistence decision

**Recommendation (design inference): node:sqlite behind an Effect EventStore service**, using the runtime already required by Ratstack. No extra native package installation or cloud account. DatabaseSync is synchronous; use short prepared/batched transactions and bound parameters, acquire/close with Effect scoped resource cleanup, explicit busy timeout, WAL for the product DB, schema version and deduplication indexes. A sole store/migration owner must define the schema. Do not let each collector open uncoordinated write transactions. Imported Cursor databases are separate read-only sources; never run product migrations against them.

Node 24 docs say node:sqlite reached release-candidate status at 24.15.0, below Ratstack's minimum runtime. Availability still needs a feature test in the chosen binary; lint/type diagnostics may need one documented node builtin boundary analogous to Ratstack's node:http boundary. APIs in latest docs can postdate the chosen Node release: use only verified APIs on installed 24.x. Source: [Node 24 SQLite docs](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).

Alternatives: sql.js uses the already declared test dependency but requires export/persistence plumbing and promotion to a runtime dependency; PGlite follows the Postgres test seam but brings WASM/Postgres footprint; upstream D1 adds cloud bindings and deployment, and Hyperdrive adds an external Postgres connection. Those are expansion choices, not the simplest local baseline. The upstream RunLog stores person/capability/outcome/timestamp and cannot model arbitrary DX events without new schema. Its local test adapters construct fresh in-memory engines. Sources: [RunLog model](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/database/src/model.ts), [local test layers](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/database/test/local-layers.ts), [D1 resource layer](https://github.com/joelhooks/rat-stack/blob/753c7b07dcc516037dd1d455a8766bf112084844/packages/database/src/d1.ts).

## Proposed ownership boundaries (not upstream files)

Freeze this proposed map before dispatch; adapt names once, not independently per worker:

```text
packages/core/src/dx/contracts/     schema owner: capability inputs/outputs/errors
packages/core/src/dx/model/         evidence envelope and flight identity owner
packages/core/src/dx/store/         store owner: sqlite + migration + transactions
packages/core/src/dx/adapters/<source>/   one source owner each
packages/core/src/dx/correlate/      correlation owner
packages/core/src/dx/metrics/<metric>.ts  one metric owner each
packages/core/src/dx/reports/        structured report/rendering owners
packages/core/test/dx/fixtures/<source>/ synthetic/public fixture owners
apps/cli/src/{cli,command,surfaces}.ts    ONE integration owner
.cursor/commands/                  ONE Cursor integration owner
```

Upstream boundaries are app → core → capability; preserving this map avoids 49 workers modifying package manifests and lint rules. Using new `packages/dx-*` packages instead would require manifest, barrel, workspace/lint-boundary edits and explicit ownership for each; that is possible but must be an intentional integration choice.

Shared mutation choke points: root package.json, pnpm-lock.yaml, pnpm-workspace.yaml, capability/core barrels, capability registration list, CLI root, .env.schema, lint config, tsconfig, AGENTS.md, migration sequence. Reserve them for bootstrap/schema/integration owners. Workers return modules and tests; integration owner registers only modules with passing contracts. Never launch 49 parallel installs, whole-workspace formatters, migration writers or git commits. Separate test fixture data from runtime DB paths; fixture validation does not write shared production state.

Agent scale can increase source breadth and independent proof. It cannot parallelize the final capability registry, frozen event contract, migration order, or one Cursor process handshake.

## Evidence vs inference and unresolved runtime gates

| Claim | Verdict | Evidence / next proof |
|---|---|---|
| Ratstack already supplies reusable CLI and stdio MCP capability projections | SUPPORTED | Pinned source above |
| Ratstack already supplies persistent local SQLite DX event storage | FALSE | Existing D1/Hyperdrive RunLog, local test-only engines |
| Public Ratstack MCP protocol matches local CLI protocol | FALSE | Different declared protocol lists |
| Ratstack devtools capture all Cursor AI activity | FALSE | CallWatch only sees implemented capabilities |
| Local SQLite is smallest deployment-independent store | RECOMMENDED INFERENCE | Node 24 availability + narrow adapter; test real binary and fence |
| CLI/MCP reports share one handler/result schema | SUPPORTED architectural route | defineContract/implement/projections; product still unbuilt |
| Cold scaffold works on hackathon host | UNVERIFIED | install exact pins, prepare, dependency build/typecheck |
| Cursor launches the final stdio artifact successfully | UNVERIFIED | initialize/tools/list/call, restart, no stdout contamination |
| Fifty workers avoid collisions | CONDITIONAL | frozen seam, single shared-file owners, disjoint work, integration gate |

Four-hour execution should front-load a real structured report through CLI and MCP with synthetic explicitly labelled data, then replace source fixtures independently with real adapters. Final demo must distinguish fixtures from captured/imported/reconstructed/estimated/unavailable evidence. Keep missing sources visible; no collector failure should silently become zero tokens or zero friction. No per-task duration prediction is justified by this research.
