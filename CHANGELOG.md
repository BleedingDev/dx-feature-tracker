# Changelog

Release notes for `dft` (dx-feature-tracker). Versions before 0.2.0 are described on the [GitHub releases page](https://github.com/BleedingDev/dx-feature-tracker/releases).

## 0.2.1

A fix release: numbers that were counted twice or put on the wrong branch, and secrets that could slip past redaction.

### Fixed

- **Requests counted once.** A DeepSeek Harness request read three or more times now counts once, as its newest reading. An OpenCode orchestrator message split again by a later sync replaces its earlier split instead of adding to it. With Codex OpenTelemetry on (`dft install --telemetry`), a session with no session file no longer shows one extra request from the warmup Codex sends when it starts.
- **`dft analyze` and `dft history` agree with `dft usage`.** Codex cached input is no longer counted as fresh input there, and a DeepSeek Harness request that a later read replaced is no longer counted twice.
- **Detached HEAD is not a branch.** Requests made after `git checkout origin/main`, a tag or `git checkout --detach main` no longer land on a branch named `origin/main` or `main`. They count toward the branch around them, also when a rebase left that checkout or `git fetch --prune` later removed the remote branch.
- **Removed Claude Code worktrees.** Sessions from a worktree that was removed before dft first synced are kept when they show a commit the repo knows or name the repo's worktree folder, and they land on the branch Claude Code recorded. Requests that then move into the main worktree with `cd` stay in the repo instead of falling under "(no repo)".
- **Crashed Codex turns.** A last turn that never finished is closed as unfinished after 30 quiet minutes, and a turn still waiting for its first model reply is no longer cut off by a long quiet spell.
- **Secret redaction.** dft redacts more secrets in what it keeps: long setting names such as `spring.datasource.password=`, `AWS_SECRET_ACCESS_KEY=` and other names ending in `_KEY`, `_TOKEN`, `_PAT` or `_PASSWORD`, `password: value` with the value on the next line, `password => 'value'`, `--password value` and `--token value` (also after a line continuation or a non-breaking space), `mysql -p`, `sshpass -p`, `curl -u user:pass`, `user:pass@host` in links and Google API keys. Whole values are hidden now, not just the part before a `;` or `,`. Ordinary words such as `token_count`, `token_type` and `PWD` paths are left alone. A command run through `sudo -u root gh` is recorded as `gh`.
- **Prices.** OpenAI Batch cache reads are priced at the Batch input rate for models where OpenAI lists no Batch cached rate (gpt-4.1, gpt-4o and their minis, gpt-4.1-nano, o1, o3, o3-mini, o4-mini), dated ids such as `gpt-4.1-2025-04-14` included. A dated OpenAI id such as `o3-2025-04-16` uses its model's Fast rate instead of 2x, unless OpenAI lists that snapshot itself.
- **Tool versions.** Pi and DeepSeek Harness rows now carry the installed tool version instead of none.
- **`dft mcp`.** The MCP server reports its name as `dft`. `dft usage --help` lists every `--by` choice, including `parentSession` and `agent`.

### Upgrading

Nothing to do. Your next `dft sync` derives stored usage again with the fixes above, so branch and request totals of older chats can change.

### Known limits

The points still open are listed in [harnesses.md](docs/architecture/harnesses.md#known-limits).

## 0.2.0

dft now tracks seven AI coding tools, not just Cursor: Cursor, Claude Code, Codex, OpenCode, Pi, OMP and DeepSeek Harness.

### New

- **Every tool, one store.** `dft sync` reads each tool's own session files (and Cursor's databases) read-only, and `dft install` adds capture for every tool it finds in this repo only: Claude Code and Codex hooks, an OpenCode plugin, Pi and OMP extensions, and DeepSeek Harness hooks. These files are kept out of git and never touch your teammates or your home folder. `dft install --telemetry` also turns on Claude Code and Codex OpenTelemetry to 127.0.0.1, shows the change first and keeps a backup.
- **`dft usage`.** Tokens, requests and cost grouped by tool, model maker, gateway (`via`), model, effort, repo, branch, worktree, session or day, week or month, with filters for each and a time window. The same numbers reach the dashboard and the MCP server.
- **Three money figures, never added.** The estimate is tokens times the model maker's public price, including cache tiers and fast or priority tiers. A tool's own cost figure (Claude Code, OMP, OpenCode, Cursor) is shown next to it as "tool's figure". Only real bills are called billed. Models without a known price show their tokens with "no price".
- **Branches per request.** Each request lands on the branch it ran on: the branch the tool recorded, then a hook's branch, then the checkout history at that time, then the folder. A chat that switches branch is split at the switch. Subagents count on their own worktree's branch and stay under their parent in chat lists.
- **Chats from every tool.** `dft chats` and the dashboard list chats across tools with titles, models and effort per turn, and subagent trees.
- **Dashboard.** Filter chips, a group-by choice, a chart over time stacked by tool and a table with drilldown, all kept in the address. It also watches each tool's session folders, so a chat shows up without waiting for the next poll, even when the tool's hooks are not loaded.
- **Kept forever.** Usage facts stay in `~/.dft` after a tool deletes its transcripts. dft never stores prompt text.

### Changed

- `dft status` lists every tool with its sessions, project capture and last event.
- `dft history --all-repos` names same-named repos by their parent folder.
- `dft status` run outside a git repo says so instead of "detached HEAD".

### Known limits

The open points are listed in [harnesses.md](docs/architecture/harnesses.md#known-limits). The checks behind this release are in [0.2.0 validation](docs/execution/0.2.0-validation.md).

### Upgrading

Node.js 24.18.0 or newer is still required. `dft uninstall` from this version also removes the Cursor skills that earlier versions copied.
