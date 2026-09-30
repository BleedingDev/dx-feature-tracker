# Product decisions (phase 1)

Settled with the product owner on 2026-09-30. Phase 1 is local tracking of Cursor in one Git branch or worktree. Later phases build on it.

| # | Topic | Decision |
| --- | --- | --- |
| D1 | Data intake | Hooks capture always. Every report command first runs an incremental import of the pull sources (Cursor local DB, transcripts, CLI streams, usage CSV); `--no-sync` skips it. A background daemon may come later. |
| D2 | Feature | A feature is one (repo, branch) pair, with its worktree recorded. It can be analysed at any point in its life, open or merged. Jira/PR linkage, trunk-based development and agent fleets are out of scope for now. |
| D3 | Money | Show every ledger separately and never sum them: Cursor-reported (metered), billed (usage CSV/dashboard), and estimated (tokens x versioned price table). The estimate is available immediately; billed figures replace nothing but are shown alongside once imported. |
| D4 | Git hooks | Pre-commit/pre-push runs `dft` to persist a snapshot of all current data and results, and prints the cost lines from D3. It never blocks by default. |
| D5 | CLI | Binary `dft`. Verbs: `install`, `status`, `analyze` (alias `analyse`), `explain`, `history`, `chats`, and possibly `mark` (under review). Time filters follow `--since 7d`. Every command supports `--json` for agents. |
| D6 | Chat traceability | Locally show chat title, model, subagent tree, and per-chat cost/tokens/time. Models can change within one chat and differ per subagent, so model and reasoning level are recorded per request/turn, not per chat. Exports strip titles unless asked. No prompt text. |
| D8 | Retroactive analysis | Everything works backwards from data already on disk, with no manual marks: past AI activity is attributed to the branch that was checked out in that worktree at that moment (HEAD reflog, then commit history). The headline is the branch total ("this branch burned XYZ"). Backfill covers everything on disk, and every event is labelled by how it was attributed: reflog (exact), commit history (inferred) or unassigned. Splitting into episodes comes in a later phase. No manual marks: `mark` is dropped. |
| D9 | Snapshot storage | Pre-commit snapshots live in `~/.dft`. Git notes (`refs/notes/dft`) are opt-in. |
| D10 | Money headline | The headline is real API money: tokens x the model's public per-token price. Plan-share or limit-percentage figures are out of scope, since later phases add Claude Code, Codex, Pi and others. |
| D11 | Prices and usage import | Model prices come automatically from a public price catalog, cached and versioned. Cursor usage (the data behind the dashboard CSV) is imported automatically; nothing manual. If the real model behind Auto can't be inferred, show "Auto" or "Default". |
| D12 | Installing hooks | `dft install` adds only project Cursor hooks and the skill. Git hooks need `--git-hooks` and never overwrite or mutate existing hooks. |
| D13 | History view | `dft history` defaults to the last 30 days in the current repo, one row per branch. |
| D7 | Storage | One global database per user (`~/.dft/`). Commands default to the current repo; `--all-repos` widens. |
| D14 | Dashboard app | `dft dashboard` is the long-running app: it keeps syncing and serves a live local page. `dft dashboard --one-time` writes the static HTML file instead. |
| D15 | Sync | Fully automatic, no "sync now" button unless polling has to be reduced. Hooks and git are picked up within seconds, Cursor account usage every few minutes, cursor-agent output and the Cursor local database automatically too. |
| D16 | Network | The dashboard listens on 127.0.0.1 only (default port 7420). |
| D17 | Control | The page can run safe actions (track or untrack repos, install hooks into a repo, turn the Cursor usage import on or off, export) and destructive ones (delete a repo's data, reset the store). Destructive actions show exactly what will be removed, need a typed confirmation and keep a backup that can be restored. |
| D18 | Screens | Three: Branches (totals and all branches), Branch (cost, tokens, time, commits, chats with models and subagents, timeline), Setup (sources, tracked repos, actions). |
| D19 | Refresh | The server pushes new data and the page updates in place. A small, unobtrusive "updated" indicator only. |
| D20 | Running | Foreground now (Ctrl+C to stop). A login service (launchd, systemd) comes later. |
| D21 | API | No public JSON API for now. A later paid enterprise tier may add one with SSO. |
| D22 | Wording | Plain, unslopped text everywhere. No em dashes. |
| D23 | Dashboard navigation | Later: clearer navigation (back, breadcrumbs, direct links to a branch). |
