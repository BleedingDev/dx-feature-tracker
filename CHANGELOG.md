# Changelog

Release notes for `dft` (dx-feature-tracker). Versions before 0.2.0 are described on the [GitHub releases page](https://github.com/BleedingDev/dx-feature-tracker/releases).

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
