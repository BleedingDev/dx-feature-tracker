# Runtime manifest (A01)

Verified 2026-09-30 13:50-13:57 CEST on the hackathon host (darwin arm64). Exact argv/cwd: [commands.json](commands.json).

## Toolchain

| Item | Value | Evidence |
|---|---|---|
| Upstream | `joelhooks/rat-stack@753c7b07dcc516037dd1d455a8766bf112084844` | shallow fetch of that SHA, tree copied (no `.git`) |
| Node | `v24.18.0` via proto (`.nvmrc`, `.prototools`) | `node -v` in repo root |
| pnpm | lockfile from `11.3.0`; host shell resolves `12.4.2`, so `devEngines.packageManager.onFail` is `warn` (prints one `[WARN]` line on stderr) | install exit 0 in 2m01s |
| Effect | `4.0.0-rc.117` (+ `@effect/platform-node`, `@effect/vitest`) | pinned in manifests |
| TypeScript | `7.0.2` patched by `@effect/tsgo 0.45.0` (`prepare`) | prepare log: typescript patched |
| Vitest | `5.0.1` | test run |
| node:sqlite | `DatabaseSync`, WAL, prepared statements, `backup` available; no ExperimentalWarning | probe exit 0 |

## Workspace decision

In tree: `apps/cli` (`@rat-stack/cli`), `packages/core`, `packages/capability`, `packages/devtools`. Removed before fanout: `apps/web`, `apps/infra`, `apps/mischief`, `packages/auth`, `packages/database`, `packages/lore` (and `.brain`). **apps/web is not in the workspace.** Root scripts for dev/infra/mischief/alchemy removed; `turbo.json` `//#lint` no longer depends on mischief generation. Three `boundaries-rule` lint cases that fixture-linted removed packages (`@rat-stack/infra`, `apps/web`, `packages/auth`) were deleted; the rules themselves stay.

Core export frozen for DX: `@rat-stack/core/dx` → `packages/core/src/dx/index.ts` (types) / `dist/dx/index.js` (runtime). The barrel file is owned by the integration owner (A02/A07/A08).

`oxfmt.config.ts` ignores planning prose (`plans/`, `research/`, `docs/execution/`, `IDEA.md`, `README.md`); code and config stay under the formatter.

## Boot and MCP viability (pre-DX baseline)

- `pnpm exec turbo run typecheck build` → 8/8 tasks ok.
- `node apps/cli/dist/cli.js --help` → exit 0, lists `inspectFile`, `catalog`, `openapi`, `serve`, `mcp`.
- stdio MCP probe (`node apps/cli/dist/cli.js mcp`): initialize → protocol `2025-06-18`, server `rat-stack 0.1.0`; tools/list → `inspectFile`; tools/call → ok with structuredContent; 0 non-JSON stdout lines; 0 stderr bytes. Declared protocols: `2025-06-18`, `2025-03-26`, `2024-11-05`. Cursor itself not yet tested (C09/C17).
- Baseline tests: capability 72, devtools 19, cli 14, core 76 pass.

## Launch

- Built CLI: `apps/cli/dist/cli.js` (build: `pnpm exec turbo run build`).
- Cursor/MCP launcher (protocol-only): `node <repo>/apps/cli/dist/cli.js mcp`. Never `pnpm cli` (build output and pnpm warnings on stdout).

## Hooks

`lefthook install` ran in `prepare`; `.git/hooks/pre-commit` runs the upstream lefthook pre-commit. Gate nodes that commit will run it.

## Gaps

- Fence receipt: `pnpm exec turbo run check test build` → 18/18 successful, exit 0 at 13:55:51 (tree included A03's in-progress contracts/model at that moment).
- `pnpm` 11.3.0 is not the default binary on PATH; use the absolute path in commands.json for installs.
