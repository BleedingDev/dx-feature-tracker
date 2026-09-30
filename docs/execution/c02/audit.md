# C02 replay and recovery audit

Target: B01 SQLite event store (`packages/core/src/dx/storage/`), run against the frozen `core/core-golden-flight.json` fixture (12 events, 5 batches). Plan file: `packages/core/test/dx/fixtures/c02/replay-audit-plan.json`.

| Scenario | Result |
| --- | --- |
| The whole fixture replayed twice into one replay store, with a restart in between and the second pass in reverse order | Pass. The second pass is 12 duplicates and 0 inserts. The events table holds 12 rows, and the snapshot ID, watermark and event list are identical. Re-putting the manifest keeps the snapshot count at 1, and adapter coverage is not multiplied. A fresh store gives the same snapshot ID. |
| Late, out-of-order events land inside an already frozen time window | Pass. The frozen early-window snapshot keeps its 2 events. A new snapshot of the same window has 4 events and a new ID. Putting the older manifest under the newer ID fails with `StoreError`. Persisting manifests in the order newer then older is idempotent. `latestSnapshotId` tracks each selector separately. Snapshot events are ordered by event time, not arrival order. |
| Failed attempts | Pass. A truncated spool file goes to `rejected/` with its bytes unchanged and is not picked up again. An append that fails with `StoreBusy` leaves 0 partial rows, and the retry inserts. A manifest rejected for `watermark_changed` is not stored (snapshot count 0). |
| Crash recovery | Pass. A child writer SIGKILLed inside `BEGIN IMMEDIATE` after 50 inserts leaves no rows, and the lock is released. The store reopens with an unchanged watermark. A spool file left pending by a crash after append re-drains as duplicates only. An orphan `.tmp` file from a crash before rename is ignored and left in place. |

Findings: no defects in B01 for these scenarios.

Notes and limits:
- Orphan `.batch.json.tmp` files are never cleaned or reported. This is harmless to correctness, but they accumulate in the spool directory. A candidate improvement for the spool owner, not a blocker.
- Coverage is checked by adapterId list equality, not by comparing the full coverage bodies.
- The golden fixture includes a `github-actions` batch. It is used here only as store data; nothing in this audit depends on CI or PR evidence.
