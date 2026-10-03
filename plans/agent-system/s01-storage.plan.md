---
name: dft-agent-s01-storage
overview: "Persist full analysis bases, operation journals and learning records"
todos:
  - id: s01-persistence
    content: "Implement single-writer durable basis, journal and learning storage ports"
    status: completed
  - id: s01-recovery
    content: "Verify migrations, historical binding, idempotency and restart recovery"
    status: completed
isProject: false
---

# dft-agent-s01-storage

## Execution notes

Depends on S00. Follow [README](README.md), frozen ports and exact manifest paths. You own storage and migrations only, plus isolated s01 tests/fixtures and your handoff. You are not alone; preserve others' edits. Retain Node 24.18.0 `node:sqlite` and the single writer.

Extend `storage/` from `SnapshotManifest` evidence selection to a durable full basis. Persist normalized selectors, coverage, interpretation inputs, definition/price/config digests and canonical results or sufficient bounded projections. Use atomic watermark/coverage/result binding. Legacy snapshots remain evidence-selection-only unless demonstrably upgradeable; preserve their original meaning.

Add store identity/generation, operation plans and per-step journals, idempotency reservations, revision checks, investigations, lessons and append-only evaluations. Keep normalized events immutable and derived views rebuildable. Operation/learning data must not be decoded as source events. Index scoped basis/ref/learning lookups and pending operation recovery.

Keep original immutable basis/result/evidence handles valid through ordinary migration and consistent restore when their contents survive. Reset or an incompatible data replacement changes generation; old handles reject safely. Every restore invalidates pending operation plans/reservations and mutable continuations, even when immutable evidence handles remain valid. Restored journals never revive consent or replay completed external effects. Missing evidence remains tombstoned, never redirected to another observation.

Define budgets and explicit retention for result projections, operation journals and learning. Budget-driven eviction must preserve verifiable summaries/metadata or produce explicit content-unavailable. Durable backups, evidence and investigations are not build artifacts.

## Completion criteria

- `pnpm --filter @rat-stack/core exec vitest run test/dx/s01.test.ts` proves append/reopen, basis consistency under concurrent append, migration, generation binding, receipt recovery and evaluation append.
- Repeated idempotency reservations and stale revisions behave under one serialized writer without duplicate effects.
- A pinned retained result survives restart and changed derivation code; missing historical detail produces the frozen typed limitation.
- Transactions are short and exclude scanning/network. Record peak retained projection size and indexed lookup work on the named fixture.
- Scoped typecheck/lint/format checks use the verified catalog; the handoff exposes storage implementations and any compatibility gaps.
