# Executable assignment index

Active follow-up: [nine agent-system plans](../plans/agent-system/README.md), with [exact selection and ownership](../plans/agent-system/manifest.json). [Execution state](../plans/agent-system/execution.json) records completed phases and accepted S07 artifact verification, with capability limits and publication tracked separately. They are separate from the table below.

Historical planning selection: 79 assignments, comprising 9 foundation/integration/probe, 48 module, 17 validation/package/release and 5 root-owned gates. Their original todos remain a planning snapshot, not a current implementation inventory. [Manifest](execution-manifest.json) and [phase gates](phase-gates.md) preserve that dependency/promotion policy; [runtime receipts](../docs/execution/phases/g04.json) record actual scoped outcomes. The original integration baton was A02/A07/A08.

| ID | Plan | Role | Deliverable |
|---|---|---|---|
| A01 | [dxfr-rat-a01-scaffold](/plans/dxfr-rat-a01-scaffold.plan.md) | core | Verified Ratstack scaffold, pinned install, app starts, runtime/MCP viability probe |
| A02 | [dxfr-rat-a02-integration](/plans/dxfr-rat-a02-integration.plan.md) | core | v0 built CLI/MCP composition, real Git plus labelled replay analyze/explain spine |
| A03 | [dxfr-rat-a03-contracts](/plans/dxfr-rat-a03-contracts.plan.md) | core | Frozen interfaces and compile-only fake implementations |
| A04 | [dxfr-rat-a04-fixtures](/plans/dxfr-rat-a04-fixtures.plan.md) | core | Redacted fixture vocabulary and common golden report inputs |
| A05 | [dxfr-rat-a05-ownership](/plans/dxfr-rat-a05-ownership.plan.md) | core | Exact ownership manifest and dependency-aware launch instructions |
| A06 | [dxfr-rat-a06-capability-probes](/plans/dxfr-rat-a06-capability-probes.plan.md) | core | Actual non-content version/presence facts and safe probe protocol |
| B01 | [dxfr-rat-b01-storage](/plans/dxfr-rat-b01-storage.plan.md) | core | Single-writer store, schema, migrations, snapshot queries, replay idempotence |
| B02 | [dxfr-rat-b02-collectors-git-identity](/plans/dxfr-rat-b02-collectors-git-identity.plan.md) | core | Repo common-dir, worktree, branch, HEAD, base-SHA context |
| B03 | [dxfr-rat-b03-collectors-git-history](/plans/dxfr-rat-b03-collectors-git-history.plan.md) | core | Commit times, numstat/diff metadata, explicit first-observed distinction |
| B04 | [dxfr-rat-b04-collectors-git-observation](/plans/dxfr-rat-b04-collectors-git-observation.plan.md) | optional | Opt-in future branch/edit observation; no claim of complete historical activity |
| B05 | [dxfr-rat-b05-collectors-cursor-hooks](/plans/dxfr-rat-b05-collectors-cursor-hooks.plan.md) | core-candidate | Decode supported Agent/Tab/tool hooks, atomic event spool and optional raw stop-token fields with version/presence/dedup checks. |
| B06 | [dxfr-rat-b06-collectors-cursor-local-db](/plans/dxfr-rat-b06-collectors-cursor-local-db.plan.md) | optional | Read only consistent opt-in IDE DB snapshots for recognized ItemTable/cursorDiskKV/composerHeaders and AI-tracking schemas; context meters stay separate from spend. |
| B07 | [dxfr-rat-b07-collectors-cursor-transcripts](/plans/dxfr-rat-b07-collectors-cursor-transcripts.plan.md) | core-candidate | Local exported transcript/chat parser with mapped/unmapped usage |
| B08 | [dxfr-rat-b08-collectors-cursor-usage-export](/plans/dxfr-rat-b08-collectors-cursor-usage-export.plan.md) | core-candidate | Import user-provided personal CSV variants with raw category/cost semantics, rejected/unassigned rows, batch identity and truthful coverage. |
| B09 | [dxfr-rat-b09-collectors-cursor-extension](/plans/dxfr-rat-b09-collectors-cursor-extension.plan.md) | optional | Supported VS Code/Cursor extension activity route feasibility and minimal descriptor |
| B10 | [dxfr-rat-b10-collectors-cursor-cli](/plans/dxfr-rat-b10-collectors-cursor-cli.plan.md) | optional | Decode recognized Cursor CLI output and opt-in legacy/new lowercase CLI database inputs; unsupported protobuf layouts return visible gaps. |
| B11 | [dxfr-rat-b11-collectors-claude](/plans/dxfr-rat-b11-collectors-claude.plan.md) | optional | Consented Claude JSONL usage import for cross-agent development flights |
| B12 | [dxfr-rat-b12-collectors-codex](/plans/dxfr-rat-b12-collectors-codex.plan.md) | optional | Consented Codex session usage import with session allocation uncertainty |
| B13 | [dxfr-rat-b13-collectors-opencode](/plans/dxfr-rat-b13-collectors-opencode.plan.md) | optional | OpenCode exported session/token import |
| B14 | [dxfr-rat-b14-collectors-provider-usage](/plans/dxfr-rat-b14-collectors-provider-usage.plan.md) | optional | Explicit supplied provider receipt/usage file import; no account-wide auto-fetch |
| B15 | [dxfr-rat-b15-collectors-github-runs](/plans/dxfr-rat-b15-collectors-github-runs.plan.md) | core | Actions runs and attempts with pagination/ETag/partial states; sole shared GitHub API broker/cache/auth service owner |
| B16 | [dxfr-rat-b16-collectors-github-jobs](/plans/dxfr-rat-b16-collectors-github-jobs.plan.md) | core | Attempt-specific jobs, start/end/status and missing timestamps |
| B17 | [dxfr-rat-b17-collectors-github-pr](/plans/dxfr-rat-b17-collectors-github-pr.plan.md) | core | PR metadata, head/base repository IDs and commit links |
| B18 | [dxfr-rat-b18-collectors-github-review](/plans/dxfr-rat-b18-collectors-github-review.plan.md) | optional | Review events/timeline and requested-review episodes |
| B19 | [dxfr-rat-b19-collectors-github-checks](/plans/dxfr-rat-b19-collectors-github-checks.plan.md) | optional | Check runs/statuses outside Actions; conservative duplication handling |
| B20 | [dxfr-rat-b20-collectors-shell-command](/plans/dxfr-rat-b20-collectors-shell-command.plan.md) | optional | Capture argv command lifecycle and optional selected shell history as reconstructed evidence; preserve exit/signal behavior and context. |
| B21 | [dxfr-rat-b21-collectors-local-test](/plans/dxfr-rat-b21-collectors-local-test.plan.md) | optional | JUnit/structured test import and command-session joins |
| B22 | [dxfr-rat-b22-collectors-manual](/plans/dxfr-rat-b22-collectors-manual.plan.md) | core | Explicit start/stop/wait markers and labelled user claims |
| B23 | [dxfr-rat-b23-correlation-repo](/plans/dxfr-rat-b23-correlation-repo.plan.md) | core | Canonical repo/worktree mapping and path containment |
| B24 | [dxfr-rat-b24-correlation-flight](/plans/dxfr-rat-b24-correlation-flight.plan.md) | core | Immutable flight ID, aliases, explicit start, branch reuse and detached state |
| B25 | [dxfr-rat-b25-correlation-github](/plans/dxfr-rat-b25-correlation-github.plan.md) | core | PR/head-SHA/attempt joins, unassigned ambiguous events |
| B26 | [dxfr-rat-b26-correlation-ai](/plans/dxfr-rat-b26-correlation-ai.plan.md) | core | Conversation/branch event joins and allocated/unallocated fractions |
| B27 | [dxfr-rat-b27-metrics-intervals](/plans/dxfr-rat-b27-metrics-intervals.plan.md) | core | Interval union and sum, censoring, clock errors |
| B28 | [dxfr-rat-b28-metrics-git](/plans/dxfr-rat-b28-metrics-git.plan.md) | core | Commit/file/churn summary with base-SHA definition |
| B29 | [dxfr-rat-b29-metrics-ci](/plans/dxfr-rat-b29-metrics-ci.plan.md) | core | Feedback latency, job sum, overlap, failed attempts and retries |
| B30 | [dxfr-rat-b30-metrics-ai-usage](/plans/dxfr-rat-b30-metrics-ai-usage.plan.md) | core | Measured usage categories, duplicate detection, uncovered usage |
| B31 | [dxfr-rat-b31-metrics-cost](/plans/dxfr-rat-b31-metrics-cost.plan.md) | optional | Charges versus versioned price estimates versus subscription allocation |
| B32 | [dxfr-rat-b32-metrics-review](/plans/dxfr-rat-b32-metrics-review.plan.md) | optional | Time-to-first-review/review episodes with missing boundaries |
| B33 | [dxfr-rat-b33-metrics-provenance](/plans/dxfr-rat-b33-metrics-provenance.plan.md) | optional | Project observed strict line-instance survival from canonical ordered edit/preimage evidence; keep unknown, heuristic and source-attributed values distinct. |
| B34 | [dxfr-rat-b34-metrics-friction](/plans/dxfr-rat-b34-metrics-friction.plan.md) | core | Ranked evidenced findings, thresholds and null-safe recommendation templates |
| B35 | [dxfr-rat-b35-reports-analyze](/plans/dxfr-rat-b35-reports-analyze.plan.md) | core | Deterministic analyze report from typed metric outputs |
| B36 | [dxfr-rat-b36-reports-explain](/plans/dxfr-rat-b36-reports-explain.plan.md) | core | Stable timeline, source lanes, uncertain ordering and pagination |
| B37 | [dxfr-rat-b37-reports-evidence](/plans/dxfr-rat-b37-reports-evidence.plan.md) | core | Redaction and bounded original source links/refs |
| B38 | [dxfr-rat-b38-cli-commands](/plans/dxfr-rat-b38-cli-commands.plan.md) | core | start, collect/import, analyze, explain, status with cached report path |
| B39 | [dxfr-rat-b39-mcp-handlers](/plans/dxfr-rat-b39-mcp-handlers.plan.md) | core | MCP analyze/explain/status/evidence handlers, stdout protocol isolation |
| B40 | [dxfr-rat-b40-cursor-skills-dx-analyze-cursor-skills-dx-explain](/plans/dxfr-rat-b40-cursor-skills-dx-analyze-cursor-skills-dx-explain.plan.md) | core | Cursor skill files and static routing checks; actual client invocation belongs to C09/C17 |
| B41 | [dxfr-rat-b41-ui-flight](/plans/dxfr-rat-b41-ui-flight.plan.md) | optional | Ratstack flight page using report JSON and capability table Use the report contract only; no cloud/auth/deployment baseline and no shared app wiring edits. |
| B42 | [dxfr-rat-b42-ui-timeline](/plans/dxfr-rat-b42-ui-timeline.plan.md) | optional | Timeline/evidence drill-down from frozen report JSON Use the report contract only; no cloud/auth/deployment baseline and no shared app wiring edits. |
| B43 | [dxfr-rat-b43-collectors-cursor-dashboard-response](/plans/dxfr-rat-b43-collectors-cursor-dashboard-response.plan.md) | optional | Validate explicit user-owned dashboard-response JSON exports, request/conversation keys, cost fields and pagination completeness; no cookie/HAR credentials. |
| B44 | [dxfr-rat-b44-collectors-cursor-sdk](/plans/dxfr-rat-b44-collectors-cursor-sdk.plan.md) | optional | Normalize prospective SDK run/turn usage and settlement records with explicit flight tags; instrumented traffic scope only, no new assistant UI. |
| B45 | [dxfr-rat-b45-collectors-git-ai](/plans/dxfr-rat-b45-collectors-git-ai.plan.md) | optional | Import versioned stats and authorship-note attestations without initialization/pushing; unknown additions remain unknown and stats ratio is not retention. |
| B46 | [dxfr-rat-b46-collectors-entire](/plans/dxfr-rat-b46-collectors-entire.plan.md) | optional | Import checkpoint/session metadata and delta transcript windows without double-counting root/session/cumulative usage; attribution remains source heuristic. |
| B47 | [dxfr-rat-b47-collectors-github-content](/plans/dxfr-rat-b47-collectors-github-content.plan.md) | optional | Import opt-in bounded failed-job logs, artifact/JUnit references, PR discussion/thread and environment/deployment metadata; enforce download/parse/redaction policies. |
| B48 | [dxfr-rat-b48-collectors-local-feedback](/plans/dxfr-rat-b48-collectors-local-feedback.plan.md) | optional | Normalize selected IDE diagnostic/terminal, npm timing, compiler and Vite/HMR evidence through a small versioned adapter registry; unsupported subroutes report individually. |
| C01 | [dxfr-rat-c01-contract-audit](/plans/dxfr-rat-c01-contract-audit.plan.md) | verification | Reject invalid envelopes, unknown versions, metric null/coverage rules |
| C02 | [dxfr-rat-c02-replay-audit](/plans/dxfr-rat-c02-replay-audit.plan.md) | verification | Replay twice, out-of-order snapshots, retained failed attempts, crash recovery |
| C03 | [dxfr-rat-c03-identity-audit](/plans/dxfr-rat-c03-identity-audit.plan.md) | verification | Worktrees, branch reuse/rename, rebase, forks, detached/unborn HEAD |
| C04 | [dxfr-rat-c04-ci-audit](/plans/dxfr-rat-c04-ci-audit.plan.md) | verification | Overlap, null/end clocks, reruns, cancellation and independent hand-calculated goldens |
| C05 | [dxfr-rat-c05-accounting-audit](/plans/dxfr-rat-c05-accounting-audit.plan.md) | verification | Cache categories, duplicate imports, mixed branches, absent costs and tokens |
| C06 | [dxfr-rat-c06-source-version-audit](/plans/dxfr-rat-c06-source-version-audit.plan.md) | verification | Unsupported layout/version rejects safely; read-only snapshot evidence |
| C07 | [dxfr-rat-c07-report-audit](/plans/dxfr-rat-c07-report-audit.plan.md) | verification | Golden analyze/explain, unavailable fields visible, evidence joins |
| C08 | [dxfr-rat-c08-mcp-audit](/plans/dxfr-rat-c08-mcp-audit.plan.md) | verification | Launch process, protocol-only stdout, cancellation, bounded pagination |
| C09 | [dxfr-rat-c09-cursor-live-smoke](/plans/dxfr-rat-c09-cursor-live-smoke.plan.md) | verification | v0 actual Cursor invocation of installed built package, replay/Git analyze and explain |
| C10 | [dxfr-rat-c10-privacy-audit](/plans/dxfr-rat-c10-privacy-audit.plan.md) | verification | Synthetic secrets/prompts/tool instructions redact and never execute |
| C11 | [dxfr-rat-c11-api-failure-audit](/plans/dxfr-rat-c11-api-failure-audit.plan.md) | verification | No auth, expired auth, partial pages, 403/429/5xx and cache behavior |
| C12 | [dxfr-rat-c12-runtime-audit](/plans/dxfr-rat-c12-runtime-audit.plan.md) | verification | No repo, no GitHub, offline, store busy, corrupt spool, missing adapter |
| C13 | [dxfr-rat-c13-installer](/plans/dxfr-rat-c13-installer.plan.md) | verification | Installer owns MCP/hooks/skills merge into selected target, backup/uninstall, v0 MCP wiring and conditional v1 hook wiring |
| C14 | [dxfr-rat-c14-demo](/plans/dxfr-rat-c14-demo.plan.md) | verification | Rehearsable live flight plus separately labelled adversarial fixture flight |
| C15 | [dxfr-rat-c15-claims](/plans/dxfr-rat-c15-claims.plan.md) | verification | Evidence-backed claims, product separation, no fabricated productivity causality |
| C16 | [dxfr-rat-c16-release](/plans/dxfr-rat-c16-release.plan.md) | verification | Final frozen enabled-artifact verdict after optional disposition; no optional producer wait |
| A07 | [dxfr-rat-a07-live-integration](/plans/dxfr-rat-a07-live-integration.plan.md) | core | v1 real-source composition and built-CLI collect/store/correlate/metric/report end-to-end test |
| A08 | [dxfr-rat-a08-extension-integration](/plans/dxfr-rat-a08-extension-integration.plan.md) | optional | v2 incremental enabled-adapter admission and freeze handoff |
| A09 | [dxfr-rat-a09-real-source-probes](/plans/dxfr-rat-a09-real-source-probes.plan.md) | core | Run built collector capabilities on selected real inputs and publish redacted probe receipts |
| C17 | [dxfr-rat-c17-cursor-real-flight](/plans/dxfr-rat-c17-cursor-real-flight.plan.md) | verification | Actual Cursor v1 built/install invocation on real flight; snapshot reuse and source links |
| G00 | [dxfr-rat-g00-foundation](/plans/dxfr-rat-g00-foundation.plan.md) | gate | P0 validated foundation and contract freeze |
| G01 | [dxfr-rat-g01-v0](/plans/dxfr-rat-g01-v0.plan.md) | gate | P1 built v0 replay/Git in actual Cursor |
| G02 | [dxfr-rat-g02-v1](/plans/dxfr-rat-g02-v1.plan.md) | gate | P2 real flight with validated AI route and honest CI/PR coverage |
| G03 | [dxfr-rat-g03-optional-disposition](/plans/dxfr-rat-g03-optional-disposition.plan.md) | gate | P3 bounded disposition with no optional completion wait |
| G04 | [dxfr-rat-g04-release](/plans/dxfr-rat-g04-release.plan.md) | gate | P4 final restart/rehearsal and last-green release verdict |
