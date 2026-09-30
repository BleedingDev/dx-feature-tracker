---
name: dx-explain
description: Explain where a branch's AI cost and time came from as an evidence-linked timeline from the local dx-feature-tracker store (Cursor prompts, agent/tool calls, shell runs, commits, test runs, markers). Use when the user asks why a branch or feature cost what it did, what happened on a branch or feature, or wants the evidence behind a dx-analyze number.
---

# dx-explain

Turns a stored branch or feature into an ordered, evidence-linked timeline. It never writes markers. Through MCP it never collects or syncs; the `dft` CLI first runs an incremental, idempotent sync of this repo's local sources.

## CLI (preferred)

Run `dft explain --json [--branch <name>] [--since 7d]` in the workspace. `dft` first syncs this repo's local sources (hook spool, git, transcripts) and then prints the report as JSON on stdout; sync diagnostics go to stderr. Add `--no-sync` to read only what is already stored. Related commands, all with `--json`: `dft status`, `dft history`, `dft chats` (per-turn model and reasoning level), `dft snapshot`. If `dft` is not on PATH, run `<dx-feature-tracker checkout>/apps/cli/bin/dft explain --json`.

## Routing

Call the MCP tool `dx_explain` on the `rat-stack` MCP server (`node <repo>/apps/cli/dist/cli.js mcp`). If that server is not configured, report that and stop.

```json dx-routing
{
  "skill": "dx-explain",
  "tool": "dx_explain",
  "server": "rat-stack",
  "inputs": ["flight", "snapshotId", "asOf", "cursor", "limit"],
  "readOnlyPreflight": "dx_status",
  "followUp": ["dx_evidence", "dx_analyze"],
  "neverCalls": ["dx_collect", "dx_mark"]
}
```

## Steps

1. Prefer the `snapshotId` from a previous `dx_analyze` result so the timeline matches the numbers the user saw. Otherwise pass the `flight` input with a feature ID (or nothing, for the current branch).
2. Call `dx_explain` with `limit` (for example 50). While `nextCursor` is not null and the user wants more, call again with `cursor` set to it.
3. Present the `ExplainTimeline` grouped by `lanes`, in order. For each entry show `occurredAt`, `kind`, `summary` and `origin`. Mark entries with `orderingUncertain: true` or coarse `occurredAtPrecision` as approximate.
4. When the user asks for proof of an entry, call `dx_evidence` with its `evidenceIds` and show only the redacted, bounded excerpt returned.

## Honesty rules

- Explain only what the timeline contains. Missing lanes or sources stay "unavailable" (see `dx_status`); do not infer intent, waiting time, savings or AI ownership that no entry records.
- Never recompute totals from entries; point to `dx-analyze` for numbers.
- Do not call `dx_collect` or `dx_mark` from this skill.
- Do not reveal raw prompts, transcripts or file contents beyond what `dx_evidence` returns redacted.
- CI/CD, pull requests and GitHub API data are out of scope.
