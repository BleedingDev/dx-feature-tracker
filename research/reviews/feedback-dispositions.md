# Factory Opus 5.5 feedback dispositions

Requested reviewer executed successfully with model argument factory/claude-opus-5-5, read-only ephemeral Codex session. [Original feedback](factory-opus-5-5-phase-review.md) is retained. It reviewed plan artifacts, not runtime behavior. No product checks were executed.

| Item | Disposition | Applied change |
|---|---|---|
| H1 missing phase deliverables / integration ownership | Applied | G00–G04 gates; A02 v0, A07 v1, A08 extensions share one sequential owner |
| H2 optional audit/release barriers | Applied | Core C05/C06/C10/C11 dependencies unblocked; G03 has no optional producer dependency; C16 consumes disposition |
| H3 actual Cursor operator/install/build gate | Applied | C09 v0, C17 real v1; C13 upstream; built package/config/protocol/snapshot/routing observations required |
| H4 real input probes | Applied with correction | A06 actual non-content presence facts; A09 selected real input probes. Root selection occurs during P0 or is supplied beforehand, without moving implementation outside the deadline |
| H5 composed end-to-end test | Applied | A07 owns integration test through built collect/store/correlation/metrics/reports and fresh-store deterministic replay |
| H6 durable versioned snapshots | Applied | A03 schema, B01 persistence, registry mismatch error, no timed expiry, separate live/replay stores; analyze may write snapshot metadata only |
| H7 full checks per milestone | Applied | Full fence at every promotion through one queue, last-green artifact preserved |
| H8 unfinished optional code breaks fence | Applied | Candidate excludes quarantined/unaccepted code; enabled code must pass full fence, disabled descriptor alone is insufficient |
| H9 privacy/version gaps | Applied with correction | Core audits run early and are rerun on each enabled candidate; selected AI source gets real receipt/privacy checks. Optional enablement checks do not require all other source workers to finish |
| H10 test/path mismatches | Applied | Normalized paths; C13 test scope fixed; documentation/operator nodes no longer use invented Vitest filenames; owner behavioral tests use verified commands |
| H11 unowned work | Applied | A01 commands/queue/exports; A02/A07 registry/hooks entrypoint; B01 store/ingestion; B38 commands; C13 target configs; root input/gates; B29 consumes B27 API |
| H12 demo overclaims | Applied | Real failures/overlap shown only if observed; labelled replay otherwise; account charge and branch cost distinct; survival unavailable without lineage; historical/prospective flight distinction |
| S1 scheduler priority/reserve | Applied | Four worker slots reserved for core validators/repairs; core first, optional fill, max49 workers |
| S2 A05 fanout edge | Applied | G00 is common production barrier instead of four repeated foundation dependencies |
| S3 SQLite contingency | Applied with correction | Retry with compatible supported Node, otherwise P0 no-go. No unresearched alternate store rushed into scope |
| S4 scoped typecheck / integration isolation | Applied with correction | A01 verified scoped commands, full frozen candidate fence, no required per-agent installs/worktrees |
| S5 root reading load | Applied | Deep-review ready descriptor receipts; disabled/not-attempted routes retained in disposition, no live claim |
| S6 B40 scope | Applied | Static skill deliverable; C09/C17 actual invocation |

The reviewer proposed a narrower v0 with analyze only. The revised v0 preserves analyze and explain plus real Git, matching the requested two-command presentation. Five gates are root-owned executable assignments, not effort estimates. Runtime source support and all gate verdicts remain pending.
