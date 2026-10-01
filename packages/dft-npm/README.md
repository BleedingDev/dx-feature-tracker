# dx-feature-tracker (`dft`)

Local AI engineering cost tracker for git. `dft` records what your AI coding tools (Cursor, Claude Code, Codex, OpenCode, Pi, OMP and DeepSeek Harness) do in a repository and reports, per branch, the time, tokens, models and every money figure it can find. Everything stays on your machine.

Full guide: [docs/USAGE.md](https://github.com/BleedingDev/dx-feature-tracker/blob/main/docs/USAGE.md).

## Install

Requires macOS (Apple Silicon) or Linux (arm64 or x86_64) and Node.js **24.18.0 or newer** (`node --version`). Older Node versions are refused at install with upgrade steps.

```sh
npm i -g https://github.com/BleedingDev/dx-feature-tracker/releases/latest/download/dx-feature-tracker.tgz
dft --help
```

## Set up a repository

```sh
cd your-repo
dft install              # Cursor hooks and skills, plus local capture for every tool found
dft install --git-hooks  # also records a snapshot on pre-commit and pre-push
dft install --telemetry  # also sends Claude Code and Codex OpenTelemetry to dft dashboard
```

`dft install` writes only inside the repository:

- `.cursor/hooks.json` and the `dx-*` Cursor skills in `.cursor/skills/`.
- Local capture for every other tool it finds: Claude Code hooks in `.claude/settings.local.json`, Codex hooks in `.codex/hooks.json`, the OpenCode plugin in `.opencode/plugins`, the Pi and OMP extensions in `.pi/extensions` and `.omp/extensions`, and the DeepSeek Harness hook bridge in `.dsh`. Add a tool it did not find with `--tool <id>`.

These files are listed in this clone's `.git/info/exclude`, so teammates never see them. Existing hooks are kept. Running it again is safe: it adds nothing that is already there and points dft's own hooks at the Node and `dft` that ran it, which repairs them after a Node upgrade. `dft status` shows `project capture broken` when a hook calls a Node or `dft` that is gone.

`--telemetry` is the only option that changes user settings (`~/.claude/settings.json` and `~/.codex/config.toml`). It only adds, keeps a backup and skips a tool that is not set up. Preview it with `--dry-run`, which writes nothing at all.

`dft uninstall` removes only what `dft install` added in this repository, and `dft uninstall --telemetry` removes the user telemetry settings.

## Everyday commands

```sh
dft analyze               # cost report for the current branch (add --json for machine output)
dft usage --by tool       # tokens and each money figure per tool; also --by model, provider, branch, day
dft chats                 # every tool's chats on the branch, with the model and reasoning level per turn
dft history --since 30d   # every branch you worked on, with time, tokens and each money figure
dft dashboard             # live page on http://127.0.0.1:7420
dft snapshot              # save a report keyed to HEAD and print it on one line
dft status                # store location, sources and each tool's setup
```

Report commands take `--since`, `--branch`, `--repo`, `--all-repos`, `--json`, `--no-sync` and `--db`.

## What happens automatically

- **Hooks and extensions** record sanitized hook metadata while you use a tool.
- **Sync before every report**: new git history, hook data and every tool's session files for the current repository are imported incrementally. Missing sources are reported on stderr as `unavailable <source>: <reason>`. Even without hooks, session files are read on each sync.
- **Local database**: a SQLite store at `~/.dft/dft.db` (or `$DFT_HOME/dft.db`).
- **Cursor usage import**: when you are logged in to Cursor on this machine, `dft` reads the Cursor login from Cursor's local state database at runtime and imports your usage from cursor.com.
- **Prices**: estimates use the models.dev catalog (LiteLLM as a fallback), cached for 24 hours, with a bundled snapshot offline. Put your own table at `$DFT_HOME/prices.json` to override it.

Money is reported per ledger: the estimate at the model maker's public price, the tool's own cost figure and what you were billed. They are never added together, and anything `dft` cannot see is shown as `unavailable` with a reason rather than 0.

## Privacy

- All data stays local in `~/.dft` (or `$DFT_HOME`). Nothing is uploaded anywhere.
- Network calls: the Cursor usage import (your Cursor login goes to cursor.com only and is not stored; turn it off with `DFT_CURSOR_USAGE=off`) and the price catalog fetch (prices only, no usage data; turn it off with `DFT_PRICE_CATALOG=off`).

## Limitations

- When Cursor runs in **Auto** mode, the model shows as `Auto`; Cursor does not report which model it picked.
- Branch history comes from git and the reflog, which git expires after 90 days by default.
- Transcripts are matched to a repository by path. Very long or temporary paths may not match, and `dft` reports them as unavailable.
- Appended git hooks do not run if your existing hook ends with `exit` or `exec`.

## License

MIT
