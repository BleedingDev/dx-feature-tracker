# NPM-PACKAGE handoff: publishable `dx-feature-tracker` (`dft`)

Status: **ready to publish** (not published). Checked 15:19 CEST.

## What changed
- New `packages/dft-npm/`: `package.json` (name `dx-feature-tracker`, 0.1.0, MIT, bin `dft` -> `dist/dft.mjs`, `type: module`, engines node >=24.18.0, files `dist`, `README.md`, `LICENSE`, no dependencies), `scripts/bundle.sh`, `README.md`, `LICENSE` (copy of root).
- `scripts/bundle.sh` (`pnpm run bundle` inside `packages/dft-npm`): runs `pnpm turbo run build --filter=@rat-stack/cli...` (skip with `DFT_SKIP_WORKSPACE_BUILD=1`; set `PNPM_BIN` if `pnpm` on PATH is not 11.3.0), then the installed rolldown 1.2.9 CLI bundles `apps/cli/dist/dft-main.js` with every workspace package, effect and xstate into one ESM `dist/dft.mjs` (`--platform node`, shebang kept from the entry, chmod 755), and copies `.cursor/skills` to `dist/skills`. The only imports left in the bundle are `node:*` builtins, `node:sqlite` included. A shell script is used because type-aware oxlint rejects untyped `.mjs` scripts.
- `pnpm-workspace.yaml`: added `"!packages/dft-npm"` so the package is outside the workspace. Lockfile unchanged; `pnpm install --frozen-lockfile --offline` passes and `pnpm -r ls` lists only the four workspace packages, so `turbo run check test build` never sees it.
- `.gitignore`: `packages/dft-npm/dist/` and `*.tgz`.
- `apps/cli/src/dft-skills.ts`: `skillsSourceDir()` prefers `<dir of running file>/skills` when it exists (the npm bundle's `dist/skills`) and otherwise uses the repo's `.cursor/skills` as before. Without this the global install copied no skills.
- Hook paths: no code change needed. `dft install` writes `"<process.execPath> <path.resolve(argv[1])> hook"`; from a global install `argv[1]` is `<prefix>/bin/dft` (the npm symlink), which survives package upgrades. The absolute Node path is kept because Cursor on macOS starts hooks without the shell PATH. README tells users to re-run `dft install` after switching Node versions.

## Checks
- `npm pack`: `dx-feature-tracker-0.1.0.tgz`, **1,526,112 bytes (1.5 MB)**, unpacked 6.0 MB, 6 files (LICENSE, README.md, package.json, dist/dft.mjs, 2 SKILL.md).
- Owned temp prefix (`owned-temp-dir --run dft-pack`, `npm i -g --prefix <tmp>/prefix <tgz>`, `DFT_HOME` in temp, Node 26.10.0): `dft --help` exit 0 (`dft --version` = `dft v0.1.0`). In a scratch git repo on `feature/demo`: `dft install --git-hooks` exit 0 (hooks.json with 11 events, 2 skills, pre-commit and pre-push created); `dft hook` with a payload returned `{"continue":true}` exit 0; `dft status --json` exit 0 (60 KB); `dft analyze --json` exit 0 (111 KB); `dft history --json` exit 0 (6.3 KB, contract `dx.history.v1`); a `git commit` ran the installed pre-commit via the absolute prefix path and appended 1 line to `snapshots.jsonl`. Sync inserted 4 events then 0. Transcripts and Cursor local DB were unavailable with reasons (scratch repo). Temp dir cleaned by the wrapper.
- `apps/cli`: tsc 0 errors, `vitest run test/dft.test.ts` 6 passed. oxlint and `oxfmt --check` clean on changed files.

## To publish
```sh
cd packages/dft-npm
PNPM_BIN=/Users/satan/.proto/tools/pnpm/11.3.0/shims/pnpm sh scripts/bundle.sh
npm publish --access public
```
Rebuild right before publishing: the bundle is whatever `packages/core/dist` holds at bundle time (core was being edited concurrently for backfill and the price catalog).

## Gaps
- The bundle is 6 MB unminified; it embeds unused Effect HttpApi/Scalar assets pulled in by the CLI's `openapi`/`serve` code paths.
- README describes the Cursor usage import and price catalog as the other agent is wiring them; verify `dft status` shows the usage source before publishing.
- Hooks pin the absolute Node binary; a Node upgrade in a version manager needs `dft install` again.
