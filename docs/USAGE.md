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

It never writes `~/.cursor/hooks.json` or anything else under `~/.cursor`. Run it once per repository: running it again currently adds a second set of `dft hook` entries to `.cursor/hooks.json` (the skills and git hooks are left as they are).

To also record a snapshot on every commit and push:

```sh
dft install --git-hooks
```

This appends `dft snapshot` to the `pre-commit` and `pre-push` hooks. Existing hooks are kept, not replaced. If the repo uses lefthook, `dft` prints a snippet to add yourself instead of editing hooks.

Other flags: `--repo <path>` to install into another repository, `--json` for machine output.

## Daily use

Work in Cursor as usual. Then:

```sh
dft analyze               # cost report for the current branch
dft chats                 # chat tree for the branch, model and reasoning level per turn
dft history --since 30d   # every branch you worked on, with time, tokens and each money line
dft explain               # the evidence timeline behind the current branch's numbers
dft status                # store location, enabled sources, readiness
```

A good habit is `dft analyze` before you commit.

Report commands (`analyze`, `chats`, `history`, `explain`, `snapshot`, `status`) share these flags:

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

When Cursor runs in Auto mode, the model shows as `Auto`/`default`. Cursor does not report which model it picked, so `dft` does not guess, and there is no price estimate for those turns.

## What happens automatically

- **Cursor hooks** record sanitized hook metadata while you use Cursor.
- **Sync on every command**: before each report, `dft` imports new git history, hook data and Cursor agent transcripts for the current repository. Missing sources are reported on stderr as `unavailable <source>: <reason>`. Use `--no-sync` to skip this.
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
