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

## Phase 2: multiple tools (settled 2026-10-01)

Research: [multi-harness-research.md](multi-harness-research.md).

| # | Topic | Decision |
| --- | --- | --- |
| D24 | Dimensions | Two separate dimensions: Tool (harness: Cursor, Claude Code, Codex, OpenCode, Pi, OMP, DeepSeek Harness) and Model provider (who made the model). Both can be filtered and grouped. |
| D25 | Order | Claude Code, Codex, OpenCode, Pi, OMP, DeepSeek Harness. One tool per release. |
| D26 | Money | One consistent approach for every tool so totals compare: the headline is our estimate (tokens x the model maker's public price). A tool's own cost figure (Pi, OMP, Cursor) is shown separately as "tool's figure". Only real bills are called billed. |
| D27 | Precision | Maximum precision: combine session-file watching with each tool's hooks or extensions, compare the sources and correct from the most precise one. |
| D28 | Branch precedence | Branch recorded by the tool on that row, then a hook's branch for the turn, then checkout history at that time, then the folder alone, then unassigned. Every event is labelled with the method used. |
| D29 | Subagents | A subagent's tokens go to its own folder and branch, else its parent's. In chats it stays under the parent. Refine later. |
| D30 | Gateways | Model provider is the model's maker. The gateway (cliproxy, OpenRouter, Copilot) is a separate "via" dimension that can be filtered, grouped and combined with provider. Priced at the maker's public price. |
| D31 | Storage for group-by | A derived `usage_facts` table, one row per deduplicated request, rebuilt after sync and used by CLI, dashboard and MCP. Time filters clip totals to the window. |
| D32 | Dashboard | Filter chips, one group-by select, metric toggle, chart over time stacked by tool, table with drilldown, all state in the URL. CLI: `dft usage --by <dim> --tool <t> --since 30d`. |
| D33 | Tests | Each tool is an Effect Store service (live and in-memory layers) plus a Harness service. One conformance suite runs mock and fixture tiers always, and a read-only live tier only when opted in with `DFT_LIVE_HARNESSES`. |
| D34 | Event model | No backwards compatibility: go straight to a typed `dx.event.v2` envelope with an `ai` attribution block. |
| D35 | DeepSeek Harness | Install it on the maintainer's machine for a live test tier. Live tests run through the local model router (Luna model) and are skipped when the router is down. |
| D36 | Orchestrator outside a repo | Per turn, use the repo its own tool calls touched when that is exactly one; otherwise split across its subagents' repos by their tokens, marked inferred; "(no repo)" only when nothing points anywhere. |
| D37 | Reconciling sources | Each field takes its most precise source (tokens: session file's final record; branch: D28; model: what the server reported). Other sources cross-check; disagreements are stored and shown per tool in a Sources panel. |
| D38 | User-level settings | Only with `dft install --telemetry`: shows the change, keeps a backup, only adds, reversible with `dft uninstall --telemetry`. Enables Claude Code and Codex OpenTelemetry to 127.0.0.1. |
| D39 | Project hooks | Written to untracked local files (`.claude/settings.local.json` and the local equivalents for Codex, Pi, OMP); teammates never affected. |
| D40 | Prices | Cover cache tiers, fast/priority tiers, Copilot premium requests; local models cost $0 marked local; unknown models show tokens with "no price". User-supplied prices later. |
| D41 | Retention | Keep extracted usage facts forever in `~/.dft`, never prompt text, even after a tool deletes its transcripts. |
| D42 | Chats | One sessions list across all tools with titles, per-turn model and effort, subagent tree, same filters. |
| D43 | Naming | "Tool" in UI and CLI flags (`--tool`), "harness" in code. |
| D44 | README | Edit it directly to cover all tools; approved. |
| D45 | Release | One fully tested and validated release, 0.2.0, containing all of the above. |
