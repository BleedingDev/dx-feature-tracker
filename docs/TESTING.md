# Testing

| Command | What it runs |
| --- | --- |
| `pnpm test` | Builds and runs every package suite once. Lefthook runs it before each commit. |
| `pnpm --filter @rat-stack/core test` | The core suite, including the mock and fixture tiers of every harness. |
| `DFT_LIVE_HARNESSES=cursor,claude-code,codex,opencode,pi,omp,deepseek pnpm --filter @rat-stack/core test:live` | The harness suites plus the opt-in live tier for the listed tools, against this machine's real sessions. |

## Harness tiers

The tiers and checks are described in [architecture/harnesses.md](architecture/harnesses.md#test-tiers).

- Mock and fixture tiers always run. They never touch the real `~/.claude`, `~/.codex`, `~/.pi`, `~/.omp`, `~/.dsh` or `~/.cursor`; fixture tests point `HarnessHome.at(...)` at an owned temp folder.
- The live tier runs only for the ids in `DFT_LIVE_HARNESSES` (comma-separated, any of `cursor`, `claude-code`, `codex`, `opencode`, `pi`, `omp`, `deepseek`). It is read-only: SQLite files are copied before they are opened, session files are only read, and at most 25 sessions per tool are checked. It asserts invariants only, never exact numbers. A tool that is not installed passes with no sessions.

## Rules

- Tests never contact real accounts or networks. Both Vitest configs set `DFT_CURSOR_USAGE=off` (no Cursor account import) and `DFT_PRICE_CATALOG=off` (no price catalog fetch; the cache or the bundled snapshot prices instead), and tests that spawn the CLI pass their own `DFT_HOME`.
- D41 retention is checked end to end by `apps/cli/test/dft-retention.test.ts`: it syncs a redacted Claude Code, Codex, Pi, OMP and Cursor session in a temp `HOME`, deletes the session files, syncs again, and expects the same `dft usage --json` facts and no prompt text anywhere under `DFT_HOME`.
- Fixtures are redacted or synthetic: real field structure, replaced text. No prompt text, secrets, tokens or private session content.
- Use `@effect/vitest` (`it.effect`, `layer(...)`); `Effect.run*` in tests is a lint error.
