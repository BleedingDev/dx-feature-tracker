# Ownership manifest (A05)

Historical rendering generated from `research/execution-manifest.json` (sha256 `edf6d82859a14264908703404829a285d66a5e014297004e762a4958b91b46ca`, 79 nodes, 145 edges). That manifest wins for its original execution selection; its table and receipts are preserved. New agent-system work uses the separately activated ownership below. The historical manifest cannot silently override an activated follow-up assignment.

## Agent-system follow-up ownership

The user authorized full implementation on 2026-10-02. Root activated the exact source assignments in [plans/agent-system/manifest.json](../../plans/agent-system/manifest.json) on `feat/agent-system` after verifying that the earlier native agents completed read-only work. S00 owns the shared contract freeze. Producers start from that freeze and implement concurrently through typed ports; read and release gates still require their dependencies. [execution.json](../../plans/agent-system/execution.json) records the current assignments and phase state.

| Node | Exclusive responsibility after activation | Prior ownership being transferred |
| --- | --- | --- |
| S00 | Contracts/model, frozen contract documentation and command catalog | A03 and A01 command-catalog responsibility |
| S01 | Storage, migrations, durable basis/journal/learning persistence | B01 |
| S02 | Reports, usage, reconciliation and cost/price-book query semantics | B23-B37 relevant paths and later usage/price additions |
| S03 | Operations, live administration and `registry/sync.ts` | Later live additions and the sync portion of integration |
| S04 | New learning service | Newly assigned path |
| R00 then S05 | One sequential integration owner for CLI app/adapters, shared registration/composition, host guidance and installer; root gates the initial read milestone | B38-B40, C13, A02/A07/A08 relevant paths and later app additions |
| S06 | Isolated independent audit tests/fixtures | Newly assigned paths; production fixes return to owners |
| S07 | Root release receipt, active design/plan status, and opt-in strict toolkit decoding/test | Root phase authority; narrow projection strengthening |

Every node has its own tests/fixtures where assigned and `docs/execution/nodes/<node>.json|.md` handoff. The exact manifest resolves file/subtree boundaries; this summary is not permission to expand them. Historical fixture index, manifests/lockfiles, generators and fence settings are outside the reassignment. No worker creates its own dependency tree. S00 owns the exact agent contract files listed in the manifest. The shared `contracts/capabilities.ts` registration belongs to R00/S05. Only the R00/S05 sequential owner edits shared registration; root alone runs R00/S07 release queues. Unowned source paths require explicit assignment.

Root assigned `packages/core/test/dx/branch-switch.test.ts` to S02, `packages/core/test/dx/live-engine.test.ts` and `packages/core/test/dx/restore-old-backup.test.ts` to S03, and `packages/core/test/dx/integration/sync-home.test.ts` to S05 after the full follow-up fence exposed compatibility failures. These exact transfers preserve the tests' replay, restoration and source-isolation behavior. Other historical test paths retain their existing ownership.

The remaining rules/table describe the original execution. Their unowned-document restriction does not block the user's explicit design revision or the separately activated follow-up scope.

## Rules

- Each node writes only its listed paths plus `docs/execution/nodes/<id>.json` and `.md` (its handoff).
- A trailing `/` means the whole subtree. `*` globs are exact package manifests only (A01).
- Forbidden to every non-owner: A03 contracts/model (`packages/core/src/dx/contracts/`, `packages/core/src/dx/model/`), B01 storage/migrations (`packages/core/src/dx/storage/`), A01 package/lock/workspace files, the A02/A07/A08 integration registry/composition/barrel (`packages/core/src/dx/index.ts`), and A04 fixture index (`packages/core/test/dx/fixtures/index.json`).
- Only A01 installs dependencies. Other owners record dependency needs as gaps.
- Only root/gate nodes (G00-G04) write `docs/execution/phases/` and commit/push.
- Scaffold files created by A01 that no node lists (for example `turbo.json`, root `tsconfig.json`, lint/vitest configs, package entry points outside `packages/core/src/dx/`) belong to A01 until G00; after G00 changes route through A01 or gate repair.
- Unowned files (for example `README.md`, `IDEA.md`, `research/`, `plans/`, root configs not listed below) are read-only during execution.
- Machine check: no two nodes share a path, except the intentional sequential baton A02 -> A07 -> A08 (24 path overlaps, all within the baton). Unexpected overlaps: 0.

## Nodes

| ID | Role | Owner | Exclusive paths | Upstream | Downstream |
|---|---|---|---|---|---|
| A01 | core | scaffold owner | `package.json`<br>`pnpm-lock.yaml`<br>`pnpm-workspace.yaml`<br>`tsconfig.base.json`<br>`packages/*/package.json`<br>`apps/*/package.json`<br>`AGENTS.md`<br>`VISION.md`<br>`docs/execution/runtime.md`<br>`docs/execution/commands.json` | — | G00 |
| A02 | core | integration owner, sequential baton A02 -> A07 -> A08 | `apps/cli/src/cli.ts`<br>`apps/cli/src/command.ts`<br>`apps/cli/src/surfaces.ts`<br>`packages/core/src/dx/registry/`<br>`packages/core/src/dx/capabilities.ts`<br>`packages/core/src/dx/composition.ts`<br>`packages/core/src/dx/index.ts`<br>`packages/core/test/dx/integration/` | B01, B02, B03, B22, B23, B24, B25, B26, B27, B28, B29, B30, B34, B35, B36, B37, B38, B39, B40, G00 | C06, C08, C09, C13, G01 |
| A03 | core | contract steward | `packages/core/src/dx/contracts/`<br>`packages/core/src/dx/model/`<br>`docs/execution/contracts-v1.md` | — | A04, C01, G00 |
| A04 | core | native worker A04 | `packages/core/test/dx/fixtures/core/`<br>`packages/core/test/dx/fixtures/index.json` | A03 | C01, G00 |
| A05 | core | native worker A05 | `docs/execution/ownership.md`<br>`docs/execution/launch-policy.md` | — | G00 |
| A06 | core | native worker A06 | `docs/execution/capability-gates.md`<br>`docs/execution/source-probes.json` | — | C06, C09, G00 |
| B01 | core | native worker B01 | `packages/core/src/dx/storage/`<br>`packages/core/test/dx/b01.test.ts`<br>`packages/core/test/dx/fixtures/b01/` | G00 | A02, C02, C12 |
| B02 | core | native worker B02 | `packages/core/src/dx/collectors/git-identity/`<br>`packages/core/test/dx/b02.test.ts`<br>`packages/core/test/dx/fixtures/b02/` | G00 | A02, C03 |
| B03 | core | native worker B03 | `packages/core/src/dx/collectors/git-history/`<br>`packages/core/test/dx/b03.test.ts`<br>`packages/core/test/dx/fixtures/b03/` | G00 | A02 |
| B04 | optional | native worker B04 | `packages/core/src/dx/collectors/git-observation/`<br>`packages/core/test/dx/b04.test.ts`<br>`packages/core/test/dx/fixtures/b04/` | G00 | — |
| B05 | core-candidate | native worker B05 | `packages/core/src/dx/collectors/cursor-hooks/`<br>`packages/core/test/dx/b05.test.ts`<br>`packages/core/test/dx/fixtures/b05/` | G00 | — |
| B06 | optional | native worker B06 | `packages/core/src/dx/collectors/cursor-local-db/`<br>`packages/core/test/dx/b06.test.ts`<br>`packages/core/test/dx/fixtures/b06/` | G00 | — |
| B07 | core-candidate | native worker B07 | `packages/core/src/dx/collectors/cursor-transcripts/`<br>`packages/core/test/dx/b07.test.ts`<br>`packages/core/test/dx/fixtures/b07/` | G00 | — |
| B08 | core-candidate | native worker B08 | `packages/core/src/dx/collectors/cursor-usage-export/`<br>`packages/core/test/dx/b08.test.ts`<br>`packages/core/test/dx/fixtures/b08/` | G00 | — |
| B09 | optional | native worker B09 | `packages/core/src/dx/collectors/cursor-extension/`<br>`packages/core/test/dx/b09.test.ts`<br>`packages/core/test/dx/fixtures/b09/` | G00 | — |
| B10 | optional | native worker B10 | `packages/core/src/dx/collectors/cursor-cli/`<br>`packages/core/test/dx/b10.test.ts`<br>`packages/core/test/dx/fixtures/b10/` | G00 | — |
| B11 | optional | native worker B11 | `packages/core/src/dx/collectors/claude/`<br>`packages/core/test/dx/b11.test.ts`<br>`packages/core/test/dx/fixtures/b11/` | G00 | — |
| B12 | optional | native worker B12 | `packages/core/src/dx/collectors/codex/`<br>`packages/core/test/dx/b12.test.ts`<br>`packages/core/test/dx/fixtures/b12/` | G00 | — |
| B13 | optional | native worker B13 | `packages/core/src/dx/collectors/opencode/`<br>`packages/core/test/dx/b13.test.ts`<br>`packages/core/test/dx/fixtures/b13/` | G00 | — |
| B14 | optional | native worker B14 | `packages/core/src/dx/collectors/provider-usage/`<br>`packages/core/test/dx/b14.test.ts`<br>`packages/core/test/dx/fixtures/b14/` | G00 | — |
| B15 | core | native worker B15 | `packages/core/src/dx/collectors/github-runs/`<br>`packages/core/test/dx/b15.test.ts`<br>`packages/core/test/dx/fixtures/b15/`<br>`packages/core/src/dx/services/github-api/` | G00 | A07, C04, C11 |
| B16 | core | native worker B16 | `packages/core/src/dx/collectors/github-jobs/`<br>`packages/core/test/dx/b16.test.ts`<br>`packages/core/test/dx/fixtures/b16/` | G00 | A07, C04, C11 |
| B17 | core | native worker B17 | `packages/core/src/dx/collectors/github-pr/`<br>`packages/core/test/dx/b17.test.ts`<br>`packages/core/test/dx/fixtures/b17/` | G00 | A07, C11 |
| B18 | optional | native worker B18 | `packages/core/src/dx/collectors/github-review/`<br>`packages/core/test/dx/b18.test.ts`<br>`packages/core/test/dx/fixtures/b18/` | G00 | — |
| B19 | optional | native worker B19 | `packages/core/src/dx/collectors/github-checks/`<br>`packages/core/test/dx/b19.test.ts`<br>`packages/core/test/dx/fixtures/b19/` | G00 | — |
| B20 | optional | native worker B20 | `packages/core/src/dx/collectors/shell-command/`<br>`packages/core/test/dx/b20.test.ts`<br>`packages/core/test/dx/fixtures/b20/` | G00 | — |
| B21 | optional | native worker B21 | `packages/core/src/dx/collectors/local-test/`<br>`packages/core/test/dx/b21.test.ts`<br>`packages/core/test/dx/fixtures/b21/` | G00 | — |
| B22 | core | native worker B22 | `packages/core/src/dx/collectors/manual/`<br>`packages/core/test/dx/b22.test.ts`<br>`packages/core/test/dx/fixtures/b22/` | G00 | A02 |
| B23 | core | native worker B23 | `packages/core/src/dx/correlation/repo/`<br>`packages/core/test/dx/b23.test.ts`<br>`packages/core/test/dx/fixtures/b23/` | G00 | A02, C03 |
| B24 | core | native worker B24 | `packages/core/src/dx/correlation/flight/`<br>`packages/core/test/dx/b24.test.ts`<br>`packages/core/test/dx/fixtures/b24/` | G00 | A02, C03 |
| B25 | core | native worker B25 | `packages/core/src/dx/correlation/github/`<br>`packages/core/test/dx/b25.test.ts`<br>`packages/core/test/dx/fixtures/b25/` | G00 | A02 |
| B26 | core | native worker B26 | `packages/core/src/dx/correlation/ai/`<br>`packages/core/test/dx/b26.test.ts`<br>`packages/core/test/dx/fixtures/b26/` | G00 | A02, C05 |
| B27 | core | native worker B27 | `packages/core/src/dx/metrics/intervals/`<br>`packages/core/test/dx/b27.test.ts`<br>`packages/core/test/dx/fixtures/b27/` | G00 | A02, C04 |
| B28 | core | native worker B28 | `packages/core/src/dx/metrics/git/`<br>`packages/core/test/dx/b28.test.ts`<br>`packages/core/test/dx/fixtures/b28/` | G00 | A02 |
| B29 | core | native worker B29 | `packages/core/src/dx/metrics/ci/`<br>`packages/core/test/dx/b29.test.ts`<br>`packages/core/test/dx/fixtures/b29/` | G00 | A02, C04 |
| B30 | core | native worker B30 | `packages/core/src/dx/metrics/ai-usage/`<br>`packages/core/test/dx/b30.test.ts`<br>`packages/core/test/dx/fixtures/b30/` | G00 | A02, C05 |
| B31 | optional | native worker B31 | `packages/core/src/dx/metrics/cost/`<br>`packages/core/test/dx/b31.test.ts`<br>`packages/core/test/dx/fixtures/b31/` | G00 | — |
| B32 | optional | native worker B32 | `packages/core/src/dx/metrics/review/`<br>`packages/core/test/dx/b32.test.ts`<br>`packages/core/test/dx/fixtures/b32/` | G00 | — |
| B33 | optional | native worker B33 | `packages/core/src/dx/metrics/provenance/`<br>`packages/core/test/dx/b33.test.ts`<br>`packages/core/test/dx/fixtures/b33/` | G00 | — |
| B34 | core | native worker B34 | `packages/core/src/dx/metrics/friction/`<br>`packages/core/test/dx/b34.test.ts`<br>`packages/core/test/dx/fixtures/b34/` | G00 | A02 |
| B35 | core | native worker B35 | `packages/core/src/dx/reports/analyze/`<br>`packages/core/test/dx/b35.test.ts`<br>`packages/core/test/dx/fixtures/b35/` | G00 | A02, C07, C14 |
| B36 | core | native worker B36 | `packages/core/src/dx/reports/explain/`<br>`packages/core/test/dx/b36.test.ts`<br>`packages/core/test/dx/fixtures/b36/` | G00 | A02, C07, C14 |
| B37 | core | native worker B37 | `packages/core/src/dx/reports/evidence/`<br>`packages/core/test/dx/b37.test.ts`<br>`packages/core/test/dx/fixtures/b37/` | G00 | A02, C07, C10 |
| B38 | core | native worker B38 | `packages/core/src/dx/cli/commands/`<br>`packages/core/test/dx/b38.test.ts`<br>`packages/core/test/dx/fixtures/b38/` | G00 | A02, C12 |
| B39 | core | native worker B39 | `packages/core/src/dx/mcp/handlers/`<br>`packages/core/test/dx/b39.test.ts`<br>`packages/core/test/dx/fixtures/b39/` | G00 | A02, C08 |
| B40 | core | native worker B40 | `.cursor/skills/dx-analyze/`<br>`.cursor/skills/dx-explain/`<br>`packages/core/test/dx/b40.test.ts` | G00 | A02, C13 |
| B41 | optional | native worker B41 | `apps/web/src/features/dx/b41/`<br>`apps/web/test/dx/b41.test.ts` | G00 | — |
| B42 | optional | native worker B42 | `apps/web/src/features/dx/b42/`<br>`apps/web/test/dx/b42.test.ts` | G00 | — |
| B43 | optional | native worker B43 | `packages/core/src/dx/collectors/cursor-dashboard-response/`<br>`packages/core/test/dx/b43.test.ts`<br>`packages/core/test/dx/fixtures/b43/` | G00 | — |
| B44 | optional | native worker B44 | `packages/core/src/dx/collectors/cursor-sdk/`<br>`packages/core/test/dx/b44.test.ts`<br>`packages/core/test/dx/fixtures/b44/` | G00 | — |
| B45 | optional | native worker B45 | `packages/core/src/dx/collectors/git-ai/`<br>`packages/core/test/dx/b45.test.ts`<br>`packages/core/test/dx/fixtures/b45/` | G00 | — |
| B46 | optional | native worker B46 | `packages/core/src/dx/collectors/entire/`<br>`packages/core/test/dx/b46.test.ts`<br>`packages/core/test/dx/fixtures/b46/` | G00 | — |
| B47 | optional | native worker B47 | `packages/core/src/dx/collectors/github-content/`<br>`packages/core/test/dx/b47.test.ts`<br>`packages/core/test/dx/fixtures/b47/` | G00 | — |
| B48 | optional | native worker B48 | `packages/core/src/dx/collectors/local-feedback/`<br>`packages/core/test/dx/b48.test.ts`<br>`packages/core/test/dx/fixtures/b48/` | G00 | — |
| C01 | verification | native worker C01 | `packages/core/test/dx/audits/c01.test.ts`<br>`packages/core/test/dx/fixtures/c01/`<br>`docs/execution/c01/` | A03, A04 | G01 |
| C02 | verification | native worker C02 | `packages/core/test/dx/audits/c02.test.ts`<br>`packages/core/test/dx/fixtures/c02/`<br>`docs/execution/c02/` | B01 | G01 |
| C03 | verification | native worker C03 | `packages/core/test/dx/audits/c03.test.ts`<br>`packages/core/test/dx/fixtures/c03/`<br>`docs/execution/c03/` | B02, B23, B24 | G01 |
| C04 | verification | native worker C04 | `packages/core/test/dx/audits/c04.test.ts`<br>`packages/core/test/dx/fixtures/c04/`<br>`docs/execution/c04/` | B15, B16, B27, B29 | G02 |
| C05 | verification | native worker C05 | `packages/core/test/dx/audits/c05.test.ts`<br>`packages/core/test/dx/fixtures/c05/`<br>`docs/execution/c05/` | B26, B30 | G01 |
| C06 | verification | native worker C06 | `packages/core/test/dx/audits/c06.test.ts`<br>`packages/core/test/dx/fixtures/c06/`<br>`docs/execution/c06/` | A02, A06 | G01 |
| C07 | verification | native worker C07 | `packages/core/test/dx/audits/c07.test.ts`<br>`packages/core/test/dx/fixtures/c07/`<br>`docs/execution/c07/` | B35, B36, B37 | C15, G01 |
| C08 | verification | native worker C08 | `packages/core/test/dx/audits/c08.test.ts`<br>`packages/core/test/dx/fixtures/c08/`<br>`docs/execution/c08/` | A02, B39 | C09, G01 |
| C09 | verification | native worker C09 | `docs/execution/c09/`<br>`packages/core/test/dx/fixtures/c09/` | A02, A06, C08, C13 | C14, G01 |
| C10 | verification | native worker C10 | `packages/core/test/dx/audits/c10.test.ts`<br>`packages/core/test/dx/fixtures/c10/`<br>`docs/execution/c10/` | B37 | G01 |
| C11 | verification | native worker C11 | `packages/core/test/dx/audits/c11.test.ts`<br>`packages/core/test/dx/fixtures/c11/`<br>`docs/execution/c11/` | B15, B16, B17 | G02 |
| C12 | verification | native worker C12 | `packages/core/test/dx/audits/c12.test.ts`<br>`packages/core/test/dx/fixtures/c12/`<br>`docs/execution/c12/` | B01, B38 | G01 |
| C13 | verification | native worker C13 | `scripts/dx-install.ts`<br>`docs/install.md`<br>`packages/core/test/dx/c13.test.ts`<br>`docs/execution/install-config.json` | A02, B40 | C09, C16, C17, G01 |
| C14 | verification | native worker C14 | `docs/execution/c14/`<br>`packages/core/test/dx/fixtures/c14/` | B35, B36, C09 | C15, G01 |
| C15 | verification | native worker C15 | `docs/execution/c15/`<br>`packages/core/test/dx/fixtures/c15/` | C07, C14 | C16, G01 |
| C16 | verification | native worker C16 | `docs/execution/c16/`<br>`packages/core/test/dx/fixtures/c16/` | C13, C15, G03 | G04 |
| A07 | core | same integration owner as A02, baton after G01 | `apps/cli/src/cli.ts`<br>`apps/cli/src/command.ts`<br>`apps/cli/src/surfaces.ts`<br>`packages/core/src/dx/registry/`<br>`packages/core/src/dx/capabilities.ts`<br>`packages/core/src/dx/composition.ts`<br>`packages/core/src/dx/index.ts`<br>`packages/core/test/dx/integration/` | B15, B16, B17, G01 | A09, C17, G02 |
| A08 | optional | same integration owner as A02/A07, baton after G02 | `apps/cli/src/cli.ts`<br>`apps/cli/src/command.ts`<br>`apps/cli/src/surfaces.ts`<br>`packages/core/src/dx/registry/`<br>`packages/core/src/dx/capabilities.ts`<br>`packages/core/src/dx/composition.ts`<br>`packages/core/src/dx/index.ts`<br>`packages/core/test/dx/integration/` | G02 | — |
| A09 | core | source probe owner | `docs/execution/source-receipts/` | A07 | C17, G02 |
| C17 | verification | Cursor validation owner | `docs/execution/c17/` | A07, A09, C13 | G02 |
| G00 | gate | root phase authority | `docs/execution/phases/g00.json` | A01, A03, A04, A05, A06 | A02, B01, B02, B03, B04, B05, B06, B07, B08, B09, B10, B11, B12, B13, B14, B15, B16, B17, B18, B19, B20, B21, B22, B23, B24, B25, B26, B27, B28, B29, B30, B31, B32, B33, B34, B35, B36, B37, B38, B39, B40, B41, B42, B43, B44, B45, B46, B47, B48 |
| G01 | gate | root phase authority | `docs/execution/phases/g01.json` | A02, C01, C02, C03, C05, C06, C07, C08, C09, C10, C12, C13, C14, C15 | A07, G02 |
| G02 | gate | root phase authority | `docs/execution/phases/g02.json` | A07, A09, C04, C11, C17, G01 | A08, G03 |
| G03 | gate | root phase authority | `docs/execution/phases/g03.json` | G02 | C16, G04 |
| G04 | gate | root phase authority | `docs/execution/phases/g04.json` | C16, G03 | — |

## Shared-path exceptions

A02, A07 and A08 are one integration owner holding a sequential baton. They share every integration path; only the current baton holder writes. A07 starts after G01 passes, A08 after G02 passes. No other overlap exists.

Root extends S07 ownership to `packages/capability/src/to-command.ts` and `packages/capability/test/strict-command.test.ts` for opt-in strict JSON CLI decoding. The native strict projection worker is the sole writer of these paths; default upstream behavior remains compatible.

HarnessCursors lives in S01-owned `packages/core/src/dx/storage/harness-cursors.ts`. S01 exposes its compatible atomic cursor method from the event-store connection; S03/S05 own their existing caller paths. No harness-directory paths are transferred.

Root S07 owns the optional `VITEST_MAX_WORKERS` declaration in `.env.schema` and its exact test-task passthrough in `turbo.json`. This controls validation concurrency without changing test selection, assertions, deadlines, strict environment mode or dependency pins.
