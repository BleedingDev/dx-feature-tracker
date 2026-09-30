# flight-time metric: ready

Closes the A02 gap "no metric covers branch time or agent time, and none counts tool calls".

## What exists
- `packages/core/src/dx/metrics/flight-time/metric.ts` exports `flightTimeMetric` (`DxMetric`, descriptor `dx.metric.flight-time`, ready). `signals.ts` extracts per-branch signals (pure, Effect Schema payload decode).
- Registered in `allMetrics` (`packages/core/src/dx/registry/registry.ts`). `dx analyze` renders the results generically in `metrics[]`; `dx explain` resolves their evidence IDs.
- Branch: selector branch, else the latest `git.context` branch; other-branch events are excluded and counted in the reason.

## Metrics (nullable value, unit, method, reason, evidence IDs; missing data is `unavailable`, never 0)
- `dx.flight.branch-age.ms`: start = reflog creation entry (`observed`), else the earliest of first branch commit, oldest reflog entry, first observed activity (`derived`, `partial`, lower bound). End = `pr.metadata.mergedAt`, else snapshot as-of (`closeOpenIntervalAt`). The reason names the method, e.g. `start=reflog-oldest-entry@...; end=as-of@...`.
- `dx.flight.commits`, `dx.flight.first-commit-at`, `dx.flight.last-commit-at` (epoch-ms): distinct SHAs, author date then committer date. When git-history coverage is complete with no commits, commits = 0 measured.
- `dx.flight.active.ms` / `dx.flight.active.intervals`: activity bursts (commits, AI events, markers, commands, tests; split at 30 min idle), merged with agent intervals by `intervalHelpers.union`.
- `dx.flight.agent.ms`: union of explicit durations (`startedAt/completedAt`, `durationMs`, `agentDurationMs`: hooks sessionEnd/stop, cursor-cli, codex turns, sdk) and per-session event spans (hooks, transcripts, claude jsonl). Overlaps count once. The reason reports the ms of overlap removed.
- `dx.flight.tool-calls`: hooks `payload.toolCall === true` per event, numeric `payload.toolCalls` per row (cursor-cli, claude, transcripts, opencode, codex turns). Reports are grouped by B30 `matchKeysOf` plus the session+turn key (union-find). Per group the highest `AI_SOURCE_PRECEDENCE` source wins. Session totals are used only for sessions with no per-turn data. B30 does not count tool calls, so nothing is duplicated.

## Checks
- `pnpm --filter @rat-stack/core exec vitest run test/dx/flight-time.test.ts`: exit 0, 7 passed (golden flight, reflog + merge, b05 hooks: agent 90000 ms and 2 tool calls, b10 cli with a transcript duplicate collapsed, reflog-oldest on base branch, empty snapshot).
- a02-spine and a07-rebuild integration tests: exit 0.
- oxlint and `oxfmt --check` on the touched files: exit 0.
- core tsc: 0 errors in the touched files (overall exit 1 from `test/dx/c13.test.ts` and `scripts/dx-install.ts`, owned by others).
- `pnpm exec turbo run build --filter=@rat-stack/cli...`: exit 0. After running `dx collect --source git-identity` and `--source git-history`, `node apps/cli/dist/cli.js dx analyze` exited 0 on `main`: branch-age 3707001 ms (partial, reflog-oldest-entry), commits 0 (measured). Agent and tool-calls are unavailable because this repo has no AI evidence on `main`.
- Live Claude subagent transcript for this repo (`gitBranch=HEAD`, imported with `--source claude-jsonl`), computed directly: agent 184318 ms, tool calls 28, active 184318 ms.

## Gaps
- No collector emits `mergedAt` yet, so live branches stay open until as-of.
- `dx analyze` has no `--branch` flag. Evidence recorded on other branches (e.g. `HEAD`) is not in the current-branch snapshot.
- Cross-source tool-call dedup needs shared request or turn keys. Clock skew is not corrected (B27).
- The `@rat-stack/core/dx` barrel does not re-export `flightTimeMetric`. That is for the barrel owner (A02).
