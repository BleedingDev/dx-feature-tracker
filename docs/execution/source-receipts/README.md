# Source receipts (A09)

Live probe of the built CLI against real Cursor activity, 2026-09-30 14:41-14:42 CEST. Full receipt: [cursor-live-probe.json](cursor-live-probe.json). Re-run: `A09_OUT=<dir> /Users/satan/bin/owned-temp-dir --run a09-probe -- docs/execution/source-receipts/probe.sh` (needs the built CLI and a logged-in `cursor-agent`).

## What ran

1. The script made a fresh demo repo in an owned temp dir, on branch `feature/a09-cost-probe`, with a project `.cursor/hooks.json` for 14 events, each running `node <repo>/apps/cli/dist/cli.js dx hook`. `~/.cursor/hooks.json` was not touched.
2. A real `cursor-agent -p --output-format stream-json` run added `mul` and a node:test file, then ran the tests with JUnit output. It exited 0. An earlier attempt exited 1 with a transient `WritableIterable is closed` error and left no result event.
3. The script then ran the built `dx collect` against each source, into a scratch `DX_STORE`. It ran `dx analyze` twice, then `dx explain`.

## Receipts

| Source | Exit | Inserted | Re-collect | State |
|---|---|---|---|---|
| cursor-hooks (live spool, 35 files) | 0 | 31 | 0 new, 31 dup | ready |
| cursor-cli (stream-json, 73 lines) | 0 | 1 ai.usage | 0 new, 1 dup | ready (tokens, no cost) |
| cursor-transcripts (read-only copy) | 0 | 1 | - | degraded (no tokens) |
| git-history | 0 | 3 | - | ready |
| git-observation | 0 | 3 | - | ready |
| local-test (agent JUnit + operator JUnit) | 0, 0 | 2 | - | ready |
| cursor-local-db (backup copy) | **1** | 0 | - | CLI cannot pass `scratchDir` |
| usage CSV / dashboard (money) | - | - | - | not attempted: no export exists |

## Per-branch analyze (`feature/a09-cost-probe`)

Both runs exited 0 and returned the same snapshot `snap_a81dd198…`, watermark `events:41:…`.

| Metric | Value |
|---|---|
| Requests | 1 |
| Input tokens | 139 |
| Cached-input tokens | 20864 |
| Cache-write tokens | 0 |
| Output tokens | 25 |
| Reasoning tokens | unavailable |
| Charge / metered / price-table estimate (USD) | unavailable (null, not 0) |
| Test runs / failures | 2 / 0 |
| Tool-call failure rate | 0 |
| Commits / files / lines added | 1 / 2 / 16 |

`DX_REPO=<demo> dx explain` exited 0 with 41 entries in 6 lanes: cursor-cli, cursor-hooks, cursor-transcripts, git-history, git-observation and local-test.

## Findings for other owners

- **cursor-local-db (A02 or its owner):** `dx collect --source cursor-local-db` exits 1 with `requires scratchDir`, and the CLI has no flag for it.
- **explain (B39/A02):** `dx explain --flight <branch>` returns 0 entries, because `--flight` takes a flight ID. Branch explain works through cwd or `DX_REPO`.
- **intervals (branch time):** the descriptor is ready, but analyze emits no interval metric ids, so branch time is not shown.
- **cursor-hooks (B05):** the coverage gap `live-capture-not-demonstrated` is stale. This run shows live capture working.
- **Redaction:** CLI outputs were grepped for prompt substrings and none matched. Inputs are referenced by sha256 only, and were deleted with the temp dir.
