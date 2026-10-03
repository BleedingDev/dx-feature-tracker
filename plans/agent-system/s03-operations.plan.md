---
name: dft-agent-s03-operations
overview: "Implement reviewed tracker operations with durable execution and verification"
todos:
  - id: s03-control
    content: "Implement bounded plan/apply/get/cancel with scoped authority and preconditions"
    status: completed
  - id: s03-receipts
    content: "Verify committed, staged and interrupted effects with resumable receipts"
    status: completed
isProject: false
---

# dft-agent-s03-operations

## Execution notes

Start after S00 freezes ports; implement against fake storage/effects concurrently with S01/S02/S04. S05 verifies the real composition after producers finish. Own only operation/live/sync paths listed in the manifest, isolated s03 tests/fixtures and handoff. You are not alone. Read [agent control](../../docs/architecture/agent-control.md).

Add `operations/` as the domain coordinator. Reuse `registry/sync.ts::planSources`, `runPlannedStep`, harness cursors, `live/engine.ts` serialization and `live/store-admin.ts` delete/reset/restore. Do not create a second writer, transport or harness reader.

Plan normalized targets/effects/bounds, source-specific consent, plan digest and relevant preconditions. Apply validates the reviewed digest under serialized state, reserves an idempotency key and journals steps. Expired/stale/conflicting plans return typed recovery. Safe append acquisition tolerates unrelated new events; destructive/config changes bind their reviewed scope/content.

Retain lower-level spool refs, rejected rows, safe cursors and unavailable-source reasons. Commit progress before advancing committed cursors. Recovery probes indeterminate file effects before retrying. Cancellation preserves completed batches and names remaining work. Coalesce compatible acquisitions and share retry/backoff with the live engine.

Expose domain adapters for existing capture/config/export actions for S05 composition. Preserve typed destructive confirmation, backup, loopback/origin protections and exact selected paths. Planning and apply never execute an arbitrary command from evidence or learning.

## Completion criteria

- `pnpm --filter @rat-stack/core exec vitest run test/dx/s03.test.ts` covers duplicate concurrent apply, stale deletion/config plans, timeout recovery, cancellation, crash, source rotation and spool replay.
- Zero inserts distinguish unchanged/duplicate/unavailable/staged outcomes. Get returns an auditable receipt after restart.
- Resource caps, consent scope and preconditions are enforced before effects, including coalesced callers.
- Existing live-engine/restore behavior passes applicable verified owner checks. No process-level effect is claimed universally exactly-once.
- Handoff gives operation descriptors, implemented kinds, recovery guarantees and gaps for integration.
