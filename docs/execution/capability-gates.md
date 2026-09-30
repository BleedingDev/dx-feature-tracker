# Capability gates (A06)

Host facts observed 2026-09-30T11:49Z on Darwin 25.6.0 arm64. Machine-readable record: `source-probes.json`. These facts are presence/version only. They do not mean a source is supported live. A source becomes live-ready only after A09 probes an explicitly selected input through the built composition.

## Safe probe protocol

1. Allowed before source selection: `--version`, `command -v`, `stat`/`ls` presence, file size, and SQLite `sqlite_master` table names through a `readOnly: true` `node:sqlite` connection.
2. Forbidden before selection: reading rows, transcript bodies, hook file contents, usage exports, cookies, HAR files, tokens or keychain entries. `gh auth status` is recorded as an exit code only, with the account redacted.
3. The recorder never initializes Git AI or Entire, never pushes Git refs, and never writes to Cursor user files (`~/.cursor/hooks.json` belongs to the user; C13 owns any merge).
4. After selection, snapshot the Cursor DB through the SQLite backup API into operation-owned scratch. Do not open live files with `immutable=true`, and never run VACUUM, checkpoint or schema changes.
5. Every probe records `state` as one of `present`, `present-empty`, `absent`, `not-attempted` or `unsupported`, together with the exact command and exit code. Missing data stays `unavailable` downstream.

## Gate table

| Capability | Host fact | Gate state | Consumer |
|---|---|---|---|
| Runtime: Node + `node:sqlite` | Node v26.10.0, SQLite 3.53.4, `DatabaseSync` and `backup` present | ready for EventStore (A01/B01 verify append/reopen) | EventStore |
| pnpm | 12.4.2 (corepack absent) | ready (A01 pins) | A01 |
| Git snapshots/history | git 2.56.0, repo on `main`, 0 notes refs | candidate live | Git collectors |
| GitHub API | gh 2.102.0, authenticated (keyring), public repo id 1397735636 | candidate live through the B15 broker | Actions/PR collectors |
| GitHub Actions evidence | API reachable, **0 workflow runs** | unavailable until a run exists | Actions collector (fixture-only for now) |
| Cursor IDE | 3.22.12 installed | candidate | C09/C17 client validation |
| Cursor CLI (`cursor-agent`) | 2026.09.28-64d2043 | candidate | optional |
| Cursor local state DB | `state.vscdb` present with `ItemTable`, `cursorDiskKV`, `composerHeaders` | candidate live AI route; needs explicit selection + backup snapshot | Cursor DB importer |
| Cursor ai-tracking DB | `~/.cursor/ai-tracking/ai-code-tracking.db` present, not opened | not-attempted (outside spec priority) | none |
| Cursor project hooks | no repo `.cursor/`; user-level `hooks.json` exists | not installed; needs C13 | hook spool |
| Cursor agent transcripts (JSONL) | 0 transcript dirs | unavailable | JSONL importer (fixture-only) |
| Lowercase CLI cursor root | absent | unavailable | none |
| Usage CSV / dashboard JSON | no user export selected | not-attempted | CSV/dashboard importers (fixture-only) |
| SDK telemetry | no API access proven | not-attempted (optional) | none |
| Git AI | binary and `~/.git-ai` absent | unsupported on host | Git AI adapter (fixture-only) |
| Entire | binary, `~/.entire` and entire branches absent | unsupported on host | Entire adapter (fixture-only) |
| Enterprise admin APIs | not required | unsupported | none |

## Release implication

The live AI routes demonstrable on this host are the Cursor state DB (after explicit selection) and, once C13 installs them, project hooks. Git and the GitHub API are live candidates. Actions evidence is honestly empty until a workflow run exists. The P2 criterion "real imported Actions/PR evidence" is therefore at risk unless someone creates a run or PR. Every other route runs fixture-only and must report `unavailable`/`unsupported` in status. Fixture support must never be advertised as live support.

## Re-run

Re-run the commands in `source-probes.json` (`probes[].command`). All of them are read-only and print no content.
