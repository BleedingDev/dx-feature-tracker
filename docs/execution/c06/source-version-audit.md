# C06 source/version audit (Cursor sources)

Test: `packages/core/test/dx/audits/c06.test.ts` (15 tests, all passing). Fixtures: `packages/core/test/dx/fixtures/c06/` (synthetic; see `README.json`). Run at repo HEAD `2e78dc9` plus a dirty working tree, 2026-09-30 14:40 CEST.

## Result per source

| Source | Unknown layout/version input | Outcome | Selected input unchanged | Scratch cleaned |
| --- | --- | --- | --- | --- |
| cursor-local-db | SQLite with only `future_layout_v9` | `UnsupportedSource`, message lists table names only (no row content) | yes (sha256, size, mtime) | yes (backup copy removed) |
| cursor-local-db | non-SQLite file selected | `SourceUnavailable`/`UnsupportedSource`, no events | yes | yes |
| cursor-local-db | recognised `ItemTable`+`cursorDiskKV`, empty | 0 events, gap `no-billed-charge` | yes | yes |
| cursor-local-db | no selection / no scratchDir | `InvalidInput` (never reads a default path) | n/a | n/a |
| cursor-usage-export | header without Date or token/cost columns | `UnsupportedSource`; probe says `layout: null`, `itemCount: null` | yes | n/a |
| cursor-transcripts | JSONL without role lines; `.txt` without `user:`/`assistant:` | batch with 0 events, coverage `unsupported` + gaps; probe `layout: "unrecognized"` | yes | n/a |
| cursor-hooks | spool record with `spoolVersion` v2 | rejected; gap `spool-record-rejected`; coverage `partial`, `expectedItems 3 / observedItems 2` | yes (spool files untouched) | n/a |
| cursor-hooks | `hookEvent: futureHookEvent`, `cursorVersion 99.0.0` | kept as kind `other`, `supportedHookEvent: false`, gap `unknown-hook-event` | yes | n/a |
| cursor-hooks | spool directory missing | `SourceUnavailable` (not an empty success) | n/a | n/a |

Registry: all four Cursor descriptors decode and carry fixture ids (all `degraded`). `admitDescriptors` rejects a `dx.contracts.v9` descriptor as `contract-mismatch` and lists but never admits `unsupported`/`disabled` descriptors; `snapshotCompatible` returns false when a snapshot's adapter version differs from the current one.

## Host probe (A06, presence only)

`docs/execution/source-probes.json`: Cursor IDE 3.22.12; `state.vscdb` has `ItemTable`, `cursorDiskKV`, `composerHeaders` (a layout the adapter recognises); `~/.cursor/ai-tracking` present but schema not probed; no agent-transcripts dirs. C06 did not open any live Cursor data.

## Findings (for owners; not fixed here)

1. No adapter gates on source version. `UnsupportedSource.sourceVersion` is always `null`; hooks record `cursorVersion` but accept any value (only unknown hook names get flagged). Owners B05/B06: record the observed version when known.
2. Coverage inconsistency: an empty recognised local DB reports `complete` with 0 items, while an empty hook spool reports `none`. Owner B06, minor.
3. Asymmetry, acceptable: transcripts return an `unsupported` coverage batch, while CSV and DB fail with `UnsupportedSource`. Both are visible and neither produces events.
