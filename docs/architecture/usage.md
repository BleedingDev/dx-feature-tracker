# Usage facts and the usage query

Decisions D31, D32 and D37. Code in `packages/core/src/dx/usage/`.

## usage_facts

A derived table (store migration 3) with one row per deduplicated AI request across every tool. It is rebuilt from the event store whenever the store changes (`usage:v<derivation version>:events:<count>:<max seq>`), and `dft sync` rebuilds it right away. Nothing in it is a source of truth: deleting it only costs a rebuild.

| Part | Content |
| --- | --- |
| Dimensions | `tool` (harness), `channel`, `provider` (model maker), `via` (gateway or local runtime), `model`, `effort`, `repo` (git common dir, or `(no repo)`), `branch`, `worktree`, `session`, `parentSession`, `agent`, `scope` (`request` or `account-bucket`), `attribution` (how the branch was found), `occurredAt` in UTC |
| Measures | token buckets (`null` is unknown, never 0), `requests`, `billed` (a real charge), the tool's own figure, and the request fields the estimate needs |
| Not stored | the estimate: it is priced at query time through the PriceBook (or the user's price table), so new prices need no rebuild |

### Deduplication and reconciliation (D37)

Events of one request are joined by request id, the usage block's request key, and session plus request or generation id; a request id seen without a session joins the one session that has it. Inside a request every field takes its most precise source by the harness's channel precedence (`harness/<tool>/meta.ts`): tokens come whole from the best channel that has them, the branch from the best branch source (D28 order). When channels disagree on the model, effort, branch or a token bucket, one row per field goes into `usage_disagreements`; `dx_usage` reports the counts per tool.

A report without any key that overlaps another channel of the same session is left out and counted as unresolved. A session-level figure (Claude Code's cumulative session cost) is kept once per session, at its latest value, as the tool's figure with zero requests. When its per-model costs add up to the total, it becomes one fact per model, each with the provider and gateway of its model. The figure covers the whole session, so a query counts it only where the whole session counts: it is left out of a time window or filter that cuts the session (with a note), it sits in `(unattributed)` when the session spans several values of a grouped placement dimension (branch, repo, worktree, model, provider, via, effort, agent, attribution, day, week, month; model, provider and via only when the figure does not already know them), and the series places it at the session's last request. Usage export rows without a request are `account-bucket` facts and are never added to requests unless asked for.

## dx_usage (CLI, MCP, HTTP)

One contract, `dx_usage` (`usage/contract.ts`), behind `dft usage`, `dft history --group-by`, the MCP tool and `GET /api/usage` on the live server.

| Input | Meaning |
| --- | --- |
| `tool`, `provider`, `via`, `model`, `effort`, `repo`, `branch`, `worktree`, `session`, `parentSession`, `agent`, `channel`, `scope`, `attribution` | value lists; any value matches, `(none)` matches a missing value |
| `since`, `until` | duration (`7d`), ISO time, or a date (midnight in `tz`); `until` is exclusive |
| `tz` | IANA zone for day, week (Monday) and month buckets; default the system zone |
| `groupBy`, `stackBy` | one dimension or `day`, `week`, `month`; `stackBy` splits each series bucket (default `tool`) |
| `metrics`, `sortBy` | `tokens`, `input`, `cacheRead`, `cacheWrite`, `output`, `reasoning`, `requests`, `sessions`, `estimate`, `billed`, `toolFigure` |
| `limit` | groups listed before the rest fold into one Other row (default 10) |

The answer has `groups`, `other`, `unattributed` (facts without the grouped value), `total`, `series`, `notes` and `coverage`. Every figure counts only facts inside the window. `total` is computed from the facts, never by adding groups, so distinct counts such as `sessions` stay right when a session spans several groups. Money ledgers stay in their own columns and are never added together.

HTTP takes the same names as query parameters, lists repeated or comma separated: `/api/usage?groupBy=model&tool=codex&since=30d&tz=Europe/Prague&metrics=tokens,estimate`. A bad value answers 400 with `{ "error": ... }`.

## Sync cursors

`harness_cursors` keeps, per located session, the file's size and mtime, the harness's own `FileCursor` and the last event id read. Sync skips a session whose size and mtime have not changed and hands the stored cursor to the harness when the file grew. A cursor whose last event is no longer in the store (after a reset or a repo delete) is ignored, so the session is read again in full. Cursor keys carry `CURSOR_GENERATION` (`storage/harness-cursors.ts`): bump it when a harness reader starts emitting different events for files that did not change, so every session is read again once.
