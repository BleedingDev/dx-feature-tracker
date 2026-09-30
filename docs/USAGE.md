# Using `dft`

`dft` records what your Cursor agent does in a git repository and reports, per branch, the time, tokens and every money figure it can find. Everything is stored on your machine.

Run `dft --help` or `dft <command> --help` for the full flag list.

## Requirements

- macOS (Apple Silicon) or Linux (Ubuntu, arm64 or x86_64)
- Node.js 24.18.0 or newer (`node --version`). Older versions are refused at install with upgrade instructions.
- Cursor, logged in, if you want billed usage imported
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
- `.cursor/skills/`: copies the `dx-analyze` and `dx-explain` Cursor skills.

It never writes `~/.cursor/hooks.json` or anything else under `~/.cursor`. Run it once per repository. Running it again is safe: it adds nothing that is already there.

To also record a snapshot on every commit and push:

```sh
dft install --git-hooks
```

This appends `dft snapshot` to the `pre-commit` and `pre-push` hooks. Existing hooks are kept, not replaced. If the repo uses lefthook, `dft` prints a snippet to add yourself instead of editing hooks.

Other flags: `--all-worktrees` to also set up every other git worktree of the repository (see [Many worktrees and subagents](#many-worktrees-and-subagents)), `--repo <path>` to install into another repository, `--json` for machine output.

## Daily use

Work in Cursor as usual. Then:

```sh
dft analyze               # cost report for the current branch
dft line                  # the same, on one line
dft chats                 # chat tree for the branch, model and reasoning level per turn
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
dft dashboard                          # this repository
dft dashboard --all-repos --since 30d  # every repository, last 30 days
dft dashboard --out costs.html --no-open
```

`dft dashboard` saves one HTML page and opens it in your browser (`open` on macOS, `xdg-open` on Linux). The page shows totals at the top and one row per branch: worktree, status, last active, agent time, tokens, billed, estimate and a cost bar. Click a column to sort, type to filter, and click a branch to see its chats, the models they used and their subagents.

- The page is saved to `~/.dft/dashboard.html` (or `$DFT_HOME/dashboard.html`). `--out <file>` saves it somewhere else.
- `--no-open` saves it without opening the browser. `--json` prints where it was saved.
- It is one local file. It loads nothing from the internet and never contains your prompts. Chat titles are included, so treat the file like your chat history before you share it.
- Run it again to refresh it. It does not update by itself.

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

- **billed**: real charges from your Cursor usage, imported from cursor.com.
- **metered**: Cursor's own cost figure for a request, when Cursor reports one.
- **estimated**: tokens multiplied by public list prices. The line names the price table and its version (the source and fetch date), so you know which prices were used.

These lines measure different things, so they are never added together. A total would count the same work twice. If `dft` cannot see a value, it shows `unavailable` with a reason instead of `0`.

## How time is measured

- **branch age**: time since the branch started.
- **active time**: time with recorded activity on the branch.
- **agent time**: time the Cursor agent was working.

## Past activity

`dft` can analyze work done before you installed it. Each past AI event is counted on the branch that was checked out when it happened. Each event keeps a label that says how its branch was found:

- `reflog`: from git's checkout history. This is the most reliable.
- `commit-graph`: from commits that only exist on one branch, near the event time. This is marked provisional.
- `unassigned`: no evidence found. The event is not counted on any branch.

git expires reflog entries after 90 days by default. Older events fall back to commit evidence or stay unassigned.

Cursor usage rows that can't be matched to any local event appear in `dft history --all-repos` as a separate `account (unattributed)` row.

## Models and Auto mode

`dft chats` shows the model and reasoning level for each turn, read from the suffix of the model name (`minimal`, `low`, `medium`, `high`, `xhigh`, `thinking`). For example, `gpt-5-high` is shown as model `gpt-5` with reasoning level `high`. If Cursor reports the level in its own field, that value is used instead.

When Cursor runs in Auto mode, the model shows as `Auto` (Cursor records it as `default`). Cursor does not report which model it picked, so `dft` does not guess, and there is no price estimate for those turns.

## What happens automatically

- **Cursor hooks** record sanitized hook metadata while you use Cursor.
- **Sync on every command**: before each report, `dft` imports new git history, hook data and Cursor agent transcripts for the current repository. Missing sources are reported on stderr as `unavailable <source>: <reason>`. Use `--no-sync` to skip this.
- **Cursor local database**: every sync also reads Cursor's local database. `dft` reads a backup copy in a scratch folder, never the live file, removes the copy afterwards, and keeps only the chats that ran in a worktree of this repository.
- **cursor-agent chats**: every sync also reads the chat stores `cursor-agent` keeps for this repository's worktrees. Each turn is recorded on the branch it ran on.
- **Cursor usage import**: if you are logged in to Cursor on this machine, `dft` reads the Cursor login from Cursor's local state database and imports your usage from cursor.com. The token stays on your machine and is only sent to cursor.com. `dft` does not store it. Turn this off with `DFT_CURSOR_USAGE=off`.
- **Price catalog**: prices for estimates come from models.dev, with LiteLLM as a fallback. They are cached in `~/.dft` and refreshed after 24 hours. Offline, `dft` uses the last cache, then a bundled table. To use your own prices, put a table at `$DFT_HOME/prices.json`.

## Where data lives

- Store: `~/.dft/dft.db` (SQLite).
- Set `DFT_HOME` to move the whole directory, for example `DFT_HOME=/path/to/dir dft analyze`.
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

- **Hooks stopped working after switching Node versions**: the hooks call the Node binary and `dft` path that ran `dft install`. Delete the old `dft hook` entries from `.cursor/hooks.json`, then run `dft install` again.
- **Nothing shows up**: run `dft status`. It lists the store, which sources are enabled and which are unavailable, with reasons. Check that you are in the repository you worked on and on the right branch, or pass `--branch`.
- **Git hook does not run `dft snapshot`**: an appended hook does not run if the existing hook ends with `exit` or `exec`. Move the `dft snapshot` line above it.
- **Transcripts not found**: transcripts are matched to a repository by path. Very long or temporary paths may not match, and `dft` reports them as unavailable.

## Privacy

- All data stays in `~/.dft` (or `$DFT_HOME`). Nothing is uploaded.
- Network calls: the Cursor usage import (to cursor.com only, turn off with `DFT_CURSOR_USAGE=off`) and the price catalog fetch (models.dev or LiteLLM, prices only, no usage data).
- Hook data is sanitized before it is stored.
