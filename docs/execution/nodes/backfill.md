# Backfill handoff: retroactive branch attribution (D8)

Status: **degraded**. The code is built and tested but not wired into the CLI yet, and this machine has no old Cursor data to test against.

## What exists
- `packages/core/src/dx/correlation/branch-at-time/`
  - `timeline.ts` (pure): parses `git log -g --date=iso-strict` reflog lines. Same-second entries keep git's order. It builds the checkout history of one worktree, including detached HEAD during a rebase. `branchAt(timeline, instant)` returns `{branch, method, confidence, attribution, detached, reason}`.
  - `git.ts`: `loadWorktreeTimeline(gitRunner, worktree)` builds that history from the worktree's HEAD reflog, each branch's reflog and branch-only commits. Git calls go through the B04 `GitRunner`. It also returns a map from commit SHA to branch.
  - `attribute.ts`: `attributeHistoricalBranches(events, {timelines, commitBranches})` gives each AI event its branch in this order:
    1. Live capture: hook events keep their branch.
    2. Scored commit: an `ai-code-tracking` commit hash that sits on exactly one branch.
    3. Worktree at time: `branchAt(worktreePath, occurredAt)`.
    4. Linked request: the same request, generation or session id as an event that already has a branch.
    5. Otherwise unassigned.
    
    It rewrites `context.branch` and labels every event with `payload.historicalBranch` `{method, basis, confidence, attribution, collectedBranch}`. This fixes the A07 gap where `ai-code-tracking.db` rows took the branch that was checked out at collect time. `summarizeAttribution` counts events per branch by method and by basis. `makeHistoricalBranchCorrelator` provides the same result as a `DxCorrelator`.
  - `pipeline.ts`: `reattributeHistoricalBranches(events, worktrees)` is the one step the pipeline calls. It needs `ChildProcessSpawner`.
- `packages/core/src/dx/metrics/episodes/metric.ts`: `episodesMetric`. This is secondary work and is **not registered**, because the product owner deferred episodes. It splits a branch's events at idle gaps (default 8 h, configurable). For each episode it reports start, end, commits and a current flag (set when the episode touches the last 24 h). It also reuses the flight-time agent time, the ai-usage requests and tokens, and the cost ledgers (charge, metered and estimates, each kept separate), relabelled `dx.episode.*` with checkpoint `episode:N[:current]`. To register it later: import `episodesMetric` and add it to `allMetrics`.
- No shared files were edited. `registry.ts` and B24 are unchanged.

## How to wire it for "this branch burned X" (A02 or the CLI owner)
In `analyze` and `history`, first run `reattributeHistoricalBranches(allEvents, [worktree])`. Then pick the branch, and feed the rewritten events to `costByBranch`, `accountAiUsageByBranch`, `correlateFlights` and the metrics. Pick the branch after re-attribution. If you filter first, past rows stored under the collect-time branch are dropped before they can move. B24 needs no change, because it reads `context.branch`.

## What Cursor data exists on this machine
Read-only. Counts only, from backup copies in an owned temp dir that was cleaned afterwards.

| Source | What is there | Date range (UTC) |
|---|---|---|
| globalStorage `state.vscdb` | 1 composer, 3 composerHeaders, 0 bubbles, 0 composers with usageData | 2026-09-30 10:46 |
| workspaceStorage | 1 workspace, no composer list | 2026-09-30 |
| `ai-code-tracking.db` | 38 ai_code_hashes, 0 scored_commits, 7 tracked files, 0 summaries. **0 rows reference this repo** (all come from scratch demo repos) | 2026-09-30 12:13–12:55 |
| `~/.cursor/projects` | 33 projects (2 real repos), 17 agent-transcript files | 2026-09-30 12:13–12:55 |
| `~/.cursor/chats` | 32 files (17 store.db) | 2026-09-30 12:13–12:55 |
| This repo's git history | 3 commits, 5 HEAD reflog entries, branch `main` only | 2026-09-30 13:43–14:03 CEST |

This machine has no Cursor history older than today. The retroactive path is proven on a scripted repo with fake dates. There is nothing real to backfill from a month ago.

## Limits
- Reflog retention is `gc.reflogExpire` 90 days by default (30 for unreachable entries). Older times use provisional commit-graph evidence, meaning branch-only commits or branch-reflog commits within 24 h. If there is none, the event stays unassigned.
- History shared between branches and deleted branches give no commit-graph evidence.
- Cursor Auto mode is recorded locally as `default`. Only the usage CSV or dashboard names the real model.
- Usage CSV rows have no workspace. They get a branch only through a local event with the same request or conversation id. Otherwise they are unassigned.
- Composers keep only their latest state (B06). A global row without a worktree path is never guessed.

## Checks
- `pnpm --filter @rat-stack/core exec vitest run test/dx/branch-at-time.test.ts test/dx/episodes.test.ts`: exit 0, 5 passed. The tests use a temp repo with scripted checkouts, `GIT_COMMITTER_DATE`, a `git reflog expire` to force the commit-graph fallback, AI events one month apart plus now, a scored commit, a linked CSV row, an orphan CSV row and a live hook event.
- `oxlint` and `oxfmt --check` on the 7 owned files: exit 0. Core `tsc --noEmit`: 0 errors in the owned files. The overall exit is 1 because of one error in `collectors/cursor-usage-api/session.ts`, which another owner added during this run.
- Live probe on this repo: `main` → detached (`pull --rebase`) → `main`. Now resolves to `main` via reflog at 0.95. 30 days ago resolves to `unknown`, because the repo did not exist yet.
- `node apps/cli/dist/cli.js dx analyze`: exit 0. It shows no `dx.episode.*` results, because episodes are not registered and re-attribution is not wired in.
