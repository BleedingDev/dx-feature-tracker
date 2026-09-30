# dx-feature-tracker (`dft`)

Local AI engineering cost tracker for Cursor and git. `dft` records what your Cursor agent does in a repository and reports, per branch, the time, tokens and every money ledger it can find. Everything stays on your machine.

## Install

Requires Node.js **24.18.0 or newer** (`node --version`).

```sh
npm i -g dx-feature-tracker
dft --help
```

## Set up a repository

```sh
cd your-repo
dft install              # adds dft to .cursor/hooks.json and copies two Cursor skills
dft install --git-hooks  # also records a snapshot on pre-commit and pre-push
```

`dft install` only writes inside the repository (`.cursor/hooks.json`, `.cursor/skills/`, and with `--git-hooks` the git hooks directory). It never writes `~/.cursor`, keeps any existing hooks, and running it again changes nothing. If the repo uses lefthook, it prints a snippet to add instead of editing hooks.

The installed hooks call the Node binary and the `dft` path that ran `dft install`. If you switch Node versions or reinstall into a different prefix, run `dft install` again.

Then use Cursor normally.

## Everyday commands

```sh
dft analyze                  # cost report for the current branch (add --json for machine output)
dft chats                    # chat tree for the branch, with the model and reasoning level per turn
dft history --since 30d      # every feature branch you worked on, with time, tokens and each money ledger
dft snapshot                 # save a report keyed to HEAD and print one line per money ledger
dft status                   # store location, enabled sources, readiness
```

Report commands take `--since`, `--branch`, `--repo`, `--all-repos`, `--json`, `--no-sync` and `--db`.

## What happens automatically

- **Cursor hooks** spool sanitized hook metadata while you use Cursor.
- **Local database**: a SQLite store at `~/.dft/dft.db` (or `$DFT_HOME/dft.db`).
- **Sync before every report**: git history of the current worktree, the hook spool and Cursor agent transcripts from `~/.cursor/projects/<project>/agent-transcripts` are imported incrementally. Sources that are missing are reported on stderr as `unavailable <source>: <reason>`.
- **Cursor usage import**: when you are logged in to Cursor on this machine, `dft` reads the Cursor login from the local Cursor state database at runtime and imports your usage from cursor.com.
- **Prices**: a bundled price catalog is used for estimates. Put your own table at `$DFT_HOME/prices.json` to override it.

Money is reported per ledger (billed, Cursor-metered, source estimate, price-table estimate). Estimates are labelled, ledgers are never summed, and anything `dft` cannot see is shown as `unavailable` with a reason rather than 0.

## Privacy

- All data stays local in `~/.dft` (or `$DFT_HOME`). Nothing is uploaded anywhere.
- The only network call is the Cursor usage import, which sends your Cursor login token to cursor.com and nowhere else. The token is read at runtime and not stored by `dft`.
- Turn the usage import off with `DFT_CURSOR_USAGE=off`.

## Limitations

- When Cursor runs in **Auto** mode, the model shows as `Auto`/`default`; Cursor does not report which model it picked.
- Branch history comes from git and the reflog, which git expires after 90 days by default.
- Transcripts are matched to a repository by path. Very long or temporary paths may not match, and `dft` reports them as unavailable.
- Appended git hooks do not run if your existing hook ends with `exit` or `exec`.

## License

MIT
