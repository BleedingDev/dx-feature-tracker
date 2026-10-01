# Using `dft`

`dft` records what your AI coding tools (Cursor, Claude Code, Codex, OpenCode, Pi, OMP and DeepSeek Harness) do in a git repository and reports, per branch, the time, tokens, models and every money figure it can find. Everything is stored on your machine.

Run `dft --help` or `dft <command> --help` for the full flag list.

## Requirements

- macOS (Apple Silicon) or Linux (Ubuntu, arm64 or x86_64)
- Node.js 24.18.0 or newer (`node --version`). On older versions dft refuses to run and shows upgrade instructions.
- At least one supported tool. Cursor, logged in, if you want its billed usage imported
- git

## Install

```sh
npm i -g https://github.com/BleedingDev/dx-feature-tracker/releases/latest/download/dx-feature-tracker.tgz
dft --help
```

## First run in a repository

```sh
cd your-repo
dft install
```

`dft install` writes only inside the repository:

- `.cursor/hooks.json`: adds `dft hook` entries next to any hooks already there.
- `.cursor/skills/`: copies the `dx-*` Cursor skills.
- Local capture for every other tool it finds on this machine: Claude Code hooks in `.claude/settings.local.json`, Codex hooks in `.codex/hooks.json`, the Pi and OMP extensions, the OpenCode plugin and the DeepSeek Harness hook bridge. These files are listed in this clone's `.git/info/exclude`, so teammates never see them. [Capture install](architecture/capture.md) lists each file.

It never writes your user settings (`~/.cursor`, `~/.claude`, `~/.codex` and so on) unless you add `--telemetry`, which shows the change, keeps a backup and is undone with `dft uninstall --telemetry`. Run it once per repository. Running it again is safe: it adds nothing that is already there, and it points existing dft hooks at the Node and `dft` that ran it. Even without hooks, every tool's session files are read on each sync.

To also record a snapshot on every commit and push:

```sh
dft install --git-hooks
```

This adds `dft snapshot` to the `pre-commit` and `pre-push` hooks. Existing hooks are kept, not replaced: the dft line goes right after the `#!` line, so your own checks still run last and still decide whether the commit or push goes ahead. A hook written in another language, such as Python, is left alone and `dft` prints the line to add yourself. If the repo uses lefthook, `dft` prints a snippet to add yourself instead of editing hooks.

Other flags: `--all-worktrees` to also set up every other git worktree of the repository (see [Many worktrees and subagents](#many-worktrees-and-subagents)), `--repo <path>` to install into another repository, `--json` for machine output.

## Daily use

Work with your tools as usual. Then:

```sh
dft analyze               # cost report for the current branch
dft usage --by tool       # tokens and each money figure per tool; also --by model, provider, branch, day
dft line                  # the same, on one line
dft chats                 # every tool's chats on the branch: tool, models per turn, subagents, cost
dft history --since 30d   # every branch you worked on, with time, tokens and each money line
dft history --all-repos   # every branch in every repository
dft dashboard             # every branch as a web page, opened in your browser
dft explain               # what happened on the current branch, by time
dft status                # store location, enabled sources, readiness
```

A good habit is `dft analyze` before you commit.

Report commands (`analyze`, `line`, `chats`, `history`, `explain`, `snapshot`, `status`) share these flags:

| Flag | Meaning |
| --- | --- |
| `--branch <name>` | Report another branch (default: current branch) |
| `--since <when>` | Lower time bound: `7d`, `24h`, `30m`, `2w` or an ISO timestamp |
| `--repo <path>` | Repository path (default: current directory) |
| `--all-repos` | Include every repository in the store |
| `--json` | Machine-readable JSON on stdout |
| `--no-sync` | Skip the automatic import of new local data |
| `--db <path>` | Use another SQLite store |

`dft analyse` is an alias of `dft analyze`.

## One-line output

```sh
dft line                  # the checked-out branch
dft analyze --oneline     # the same (short form: -1)
dft history --oneline     # one line per branch
```

```text
feature/x  $0.42 billed · $1.10 est · 230k tokens · 42m agent · 3 chats · 7 commits
```

Parts that are unknown or zero are left out. A branch with no AI usage reads `feature/x  no AI usage yet`. A branch in a linked git worktree gets the worktree folder after its name: `feature/x (worktree: feature-x)`. `--json` wins over `--oneline`, and the JSON is the same as without it.

The git hook line from `dft snapshot` uses the same format.

## Dashboard

```sh
dft dashboard                                   # live page on http://127.0.0.1:7420
dft dashboard --port 8080 --no-open
dft dashboard --one-time --all-repos --since 30d  # one static file instead
```

`dft dashboard` runs a local page that keeps syncing and updates in place. It opens on AI usage across every tool:

- **Filters.** A time range (7 days, 30 days, all time, or custom dates) and `+ Filter` chips for Tool, Model provider, Via, Model, Effort, Project, Branch, Worktree and Session. Each chip lists its values with their tokens and cost in the current window.
- **Group by and measure.** One Group by select (the same dimensions plus day and week) and a measure: Estimate, Tool's figure, Billed, Tokens or Requests. On a phone, tap a tile to switch the measure.
- **Tiles** show each money ledger on its own (Estimate, Tool's figure, Billed) with the tools that report it. They are never added together.
- **Chart** over time, stacked by tool (or by the top 6 groups plus Other). Hover a bar for its numbers, click it to open that day.
- **Table** with a share bar per group, Other and `(unattributed)` last. Click a row to drill down: tool, then model, then branch; project, then branch, then session. A branch name opens the branch screen with the whole branch in the chosen time range (usage filters do not carry over): its cost, models by tokens, chats and timeline.
- Everything lives in the address: copy it to share a view, use Back to undo a drilldown, and use the breadcrumbs to go up.
- **Setup** lists every tool (installed, sessions, capture, telemetry, last event), a Sources panel with how often a tool's sources disagreed, and the tracked repos and actions.

`--one-time` writes one HTML file instead and exits: the same ledgers, a chart by tool, tables by tool and by model, and one row per branch with its chats.

- The file is saved to `~/.dft/dashboard.html` (or `$DFT_HOME/dashboard.html`). `--out <file>` saves it somewhere else, `--no-open` skips the browser and `--json` prints where it was saved.
- Both pages load nothing from the internet and never contain your prompts. The live page shows chat titles, but a saved page leaves them out: add `--titles`, or tick "Include chat titles" next to Export on the live page, to keep them. Titles can quote your prompts, so treat a file saved with them like your chat history before you share it.

## Many worktrees and subagents

`dft` counts each git worktree's work on the branch checked out in that worktree. `dft history` and `dft dashboard` show every branch of the repository, whichever worktree it lives in, with a `WORKTREE` column when any branch is in a linked worktree.

**One agent that starts subagents in worktrees.** Run `dft install` once, in the main checkout, and start the agent there. Cursor reads hooks from `.cursor/hooks.json` in the folder the agent was started in, so its subagents are recorded too, even when they work in other worktrees. `dft` puts each subagent's edits and commands on the branch of the worktree they touched, and shows each subagent as its own chat under the parent in `dft chats` and the dashboard. A chat that worked on more than one branch gets an `Also on <branches>` line; its tokens stay on the branch where the chat ran.

**Worktrees you open on their own.** When you open a worktree in its own Cursor window, or start a separate `cursor-agent` in it, Cursor reads that worktree's own `.cursor/hooks.json`. A new worktree does not get that file, because `dft install` does not commit it. Set them all up at once:

```sh
dft install --all-worktrees
```

This adds the Cursor hooks and skills to every existing worktree of the repository. Run it again after you add worktrees. `dft install` without the flag lists the worktrees that are not set up yet. Git hooks from `--git-hooks` are shared by all worktrees, so they need no extra step.

**Token split.** Cursor reports usage per chat. When subagents run inside one parent chat, some of their tokens are reported under the parent chat and stay on the parent's branch. For a clean per-branch token count, run one agent per worktree, each started in its own worktree.

**Check the result:**

```sh
dft history --oneline     # one line per branch, with its worktree
dft chats --branch feature/w1
dft dashboard
```

## What the money lines mean

`dft` shows each money source on its own line:

- **estimate**: tokens multiplied by the model maker's public price, the same way for every tool, so tools compare. It names the price book and its version (the source and fetch date). A model routed through a gateway (OpenRouter, Copilot, a local router) is still priced at its maker's price; local models cost $0.
- **tool's figure**: the tool's own cost number when it stores one (Cursor, Claude Code, OpenCode, OMP, Pi). A session-level figure is counted once per session.
- **billed**: real charges, today from your Cursor usage imported from cursor.com.

These lines measure different things, so they are never added together. A total would count the same work twice. If `dft` cannot see a value, it shows `unavailable` with a reason instead of `0`.

## How time is measured

- **branch age**: time since the branch started.
- **active time**: time with recorded activity on the branch.
- **agent time**: time an AI agent was working.

## Past activity

`dft` can analyze work done before you installed it. Each past AI event is counted on the branch that was checked out when it happened. Each event keeps a label that says how its branch was found:

- `reflog`: from git's checkout history. This is the most reliable.
- `commit-graph`: from commits that only exist on one branch, near the event time. This is marked provisional.
- `unassigned`: no evidence found. The event is not counted on any branch.

git expires reflog entries after 90 days by default. Older events fall back to commit evidence or stay unassigned.

Usage that can't be matched to any repo or branch (Cursor account rows, or Claude Code and Codex sessions outside a repo) appears in `dft history --all-repos` as a separate "Not linked to a branch" line.

## Models and Auto mode

`dft chats` shows the model and reasoning level for each turn, read from the suffix of the model name (`minimal`, `low`, `medium`, `high`, `xhigh`, `thinking`). For example, `gpt-5-high` is shown as model `gpt-5` with reasoning level `high`. If Cursor reports the level in its own field, that value is used instead.

When Cursor runs in Auto mode, the model shows as `Auto` (Cursor records it as `default`). Cursor does not report which model it picked, so `dft` does not guess, and there is no price estimate for those turns.

## What happens automatically

- **Hooks and extensions** record sanitized hook metadata while you use a tool.
- **Sync on every command**: before each report, `dft` imports new git history, hook data and every tool's session files for the current repository. It reads only what changed since the last sync. Missing sources are reported on stderr as `unavailable <source>: <reason>`. Use `--no-sync` to skip this.
- **Dashboard**: `dft dashboard` also watches every tool's session folders and syncs a few seconds after a session writes, even when the tool's hooks are not loaded.
- **Cursor local database**: every sync also reads Cursor's local database. `dft` reads a backup copy in a scratch folder, never the live file, removes the copy afterwards, and keeps only the chats that ran in a worktree of this repository.
- **cursor-agent chats**: every sync also reads the chat stores `cursor-agent` keeps for this repository's worktrees. Each turn is recorded on the branch it ran on.
- **Cursor usage import**: if you are logged in to Cursor on this machine, `dft` reads the Cursor login from Cursor's local state database and imports your usage from cursor.com. The token stays on your machine and is only sent to cursor.com. `dft` does not store it. Turn this off with `DFT_CURSOR_USAGE=off`. `dft sync` and other commands import it only for the default store under `~/.dft`; with `DFT_HOME` set elsewhere, `dft status` shows "Cursor account: off because the store is outside ~/.dft" and only `dft dashboard` imports it. Where the import last stopped is kept in `cursor-usage-api/` next to the store.
- **Price catalog**: prices for estimates come from models.dev, with LiteLLM as a fallback. They are cached in `~/.dft/price-catalog` (or `$DFT_HOME/price-catalog`) and refreshed after 24 hours. Offline, `dft` uses the last cache, then a bundled snapshot. `DFT_PRICE_CATALOG=off` never fetches. To use your own prices, put a table at `$DFT_HOME/prices.json`.

## Where data lives

- Store: `~/.dft/dft.db` (SQLite).
- Set `DFT_HOME` to move the whole directory, for example `DFT_HOME=/path/to/dir dft analyze`. Commands other than `dft dashboard` then skip the Cursor usage import.
- `--db <path>` points a single command at another database file.

## Using `dft` from an agent

- **Cursor skills**: `dft install` adds `/dx-analyze` and `/dx-explain` to the repository, so the agent in Cursor can run the report and explain it.
- **JSON**: every report command takes `--json`.
- **MCP**: `dft mcp` serves the same capabilities as an MCP server over stdio. Add it to your agent's MCP config with the command `dft` and argument `mcp`.

## Snapshots and cost limits

```sh
dft snapshot
dft snapshot --max-cost 5
```

`dft snapshot` saves a report keyed to `HEAD` (and whether the tree is dirty) and prints one line per money source. With `--max-cost`, it exits with code 1 when any single money line is above the amount. Lines are checked one by one, never summed. `dft install --git-hooks` runs `dft snapshot` on pre-commit and pre-push.

## Troubleshooting

- **Hooks stopped working after switching Node versions**: the hooks call the Node binary and `dft` path that ran `dft install`, and `dft status` shows `project capture broken` when that path is gone. Run `dft install` again: it points every dft hook at the current Node and `dft`. A `.cursor/hooks.json` tracked by git is left alone, so fix its `dft hook` entries by hand.
- **Nothing shows up**: run `dft status`. It lists the store, which sources are enabled and which are unavailable, with reasons. Check that you are in the repository you worked on and on the right branch, or pass `--branch`.
- **Git hook does not run `dft snapshot`**: an appended hook does not run if the existing hook ends with `exit` or `exec`. Move the `dft snapshot` line above it.
- **Transcripts not found**: transcripts are matched to a repository by path. Very long or temporary paths may not match, and `dft` reports them as unavailable.

## Privacy

- All data stays in `~/.dft` (or `$DFT_HOME`). Nothing is uploaded.
- Only your user account can read it: `dft` keeps that folder at mode 700 and its store, backups, config and saved pages at 600, and tightens a folder an older version left open.
- Network calls: the Cursor usage import (to cursor.com only, turn off with `DFT_CURSOR_USAGE=off`) and the price catalog fetch (models.dev or LiteLLM, prices only, no usage data, turn off with `DFT_PRICE_CATALOG=off`).
- Hook data is sanitized before it is stored.
