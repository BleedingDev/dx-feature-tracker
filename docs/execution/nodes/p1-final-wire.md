# P1-FINAL-WIRE handoff: D8 retroactive attribution, D10/D11 live prices, account-row join, analyze text

Status: **ready**. Checked at 15:23 CEST.

## What changed
- **D8 retroactive** (new `correlation/branch-at-time/snapshot.ts`):
  - Analyze and explain (through `selectAnalyzeSnapshot`), history and chats now load the repo's events for every branch and run `reattributeHistoricalBranches` on them before choosing a branch. A past AI row is counted on the branch that was checked out when it happened.
  - Every event keeps its attribution method label. When `ChildProcessSpawner` is missing, reattribution is skipped (`applied: false`).
  - The analyze report gets a disclosure note, `Events re-attributed ... (D8): <branch> <n> [method=count, ...]`, with per-branch counts from `summarizeAttribution`. The report schema is unchanged. `SelectedSnapshot.attribution` has the same data as JSON.
- **D10/D11 prices**:
  - When there is no `$DFT_HOME/prices.json`, `dftSession` uses `defaultPriceProvider(home)`: a fresh models.dev/litellm catalog, else the cache under `~/.dft/price-catalog`, else the bundled Cursor table. Provider warnings go to stderr. A valid user `prices.json` still takes priority.
  - `metricsWithCost` and `dx_history` expand the table with the model slugs they see (`withObservedModels` → `expandForModels`, new `price-catalog/observed.ts`).
  - `defaultPriceProvider` is exported from the `@rat-stack/core/dx` barrel.
- **Fast-tier slug fix** (`price-catalog/slug.ts`): a slug ending in an effort suffix plus `-fast` now matches only `<base>-fast` IDs. If the catalog has no fast tier, the slug stays unpriced.
  - Before the fix, `grok-4.7-high-fast` was priced as base Grok 4.7 ($2/$6).
  - It now prices as Grok 4.7 Fast: input $4, cached-input $1, output $12 per 1M tokens, in both the catalog and the bundled table.
- **Account usage rows** (`joinAccountRows` / `accountAwareEvents`):
  - Repo-scoped reports also load the store's rows that have no repo.
  - An AI row with an empty FlightContext and an `identity.sessionId` takes the context (repo, worktree, branch) of the first local event with the same session id. B26's dashboard parser sets that session id to `conversationId`, or `composerId` if there is none.
  - D8 reattribution then runs on the joined row.
  - Rows that don't join stay out of every repo view. `dft history --all-repos` shows them as a separate `account (unattributed)` row (`dft-render.ts` `rowHeader`).
- **`dft analyze` / `analyse` text**: without `--json`, prints a compact summary: branch, branch age, agent time, active time, commits, requests, tokens by category, and each money ledger labelled separately, with estimates marked. Each unavailable value keeps its reason. `--json` prints the full report.

## Checks (all exit 0)
- oxlint and `oxfmt --check` on the 11 touched files.
- Core tsc: 0 errors. CLI tsc: 0 errors. Core and CLI builds pass.
- Core vitest, two targeted runs, all passed: 10 files with 68 tests (p1-final-wire, which is new with 3 tests, plus auto-usage, p1-prices, b31, b26, branch-at-time, c13, b40, history and chats), then 7 files with 54 tests (b35, b36, b38, b39, b40, c13, history).
- CLI vitest: 4 files, 20/20 passed. The `command.test.ts` count mismatch no longer fails.
- Real run against `~/.dft` from a throwaway git repo on `feature/p1-final`:
  - `dft analyze`: exit 0. Sync added 28 events. `price-table:models.dev@2026-09-30` was the active table (from cache). The D8 note was `no events` because the scratch branch has no AI rows. Branch age was 2m and commits 0. Money and tokens were unavailable, each with a reason.
  - `dft history --all-repos`: exit 0 with 2 rows, the scratch branch and `account (unattributed)`. The account row shows billed 3.53426 USD, 27 requests, input 802907, cached-input 3568128 and output 30633 tokens. Its price-table estimate is unavailable (`model-not-in-table=22`).
  - `dft chats`: exit 0 with 0 chats.

## Findings
- All 27 account rows in the real store have model `default`, which is Auto. They stay unpriced ("Auto/default has no fixed model"), as intended.
- None of their 22 conversationIds matches a local event in the store yet, because no cursor-agent or transcript sessions from real repos are synced into `~/.dft`. That is why the $3.53 shows as account (unattributed) and is not under any branch.
- Grok 4.7 has a price in the bundled table and in the catalog: base $2/$0.5/$6 and Fast $4/$1/$12.

## Gaps
- Analyze and chats now read all of the repo's branches plus the store's no-repo rows on every run. That is fine at the current store size, but a large store will need an indexed session-id lookup.
- The saved snapshot manifest keeps the selector, id and watermark from the wider read. Replaying a pinned `snapshotId` (`getSnapshot`) returns what the store filtered, without D8 or account joins.
- `surfaces.ts` (MCP, `rat-stack dx`) and the static `collect|mark|evidence` session still use the bundled table (`defaultCostOptions()`), because they are built synchronously at module load.
- `explain`, `chats` and `status` still print JSON without `--json`. Only analyze gained a text summary. The chats count is not in the analyze summary.
- A joined account row takes its branch from the first matching local event's context. D8 then moves it by time only when that context has a worktree.
