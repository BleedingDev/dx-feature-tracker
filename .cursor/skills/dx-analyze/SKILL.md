---
name: dx-analyze
description: Report the local AI engineering cost of the current Git branch or feature (tokens, source-reported spend, agent/tool calls, branch time, commits, lines changed, local test runs, rework) from the DX Flight Recorder store. Use when the user asks what a branch or feature cost, how many tokens or dollars were spent, or wants a per-branch DX/cost summary.
---

# dx-analyze

Answers "what did this branch/feature cost?" from evidence already stored by the local DX Flight Recorder. Through MCP it never collects or syncs; the `dft` CLI first runs an incremental, idempotent sync of this repo's local sources.

## CLI (preferred)

Run `dft analyze --json [--branch <name>] [--since 7d] [--all-repos]` in the workspace. `dft` first syncs this repo's local sources (hook spool, git, transcripts) and then prints the report as JSON on stdout; sync diagnostics go to stderr. Add `--no-sync` to read only what is already stored. Related commands, all with `--json`: `dft status`, `dft history`, `dft chats` (per-turn model and reasoning level), `dft snapshot`. If `dft` is not on PATH, run `<recorder>/apps/cli/bin/dft analyze --json`.

## Routing

Call the MCP tool `dx_analyze` on the `rat-stack` MCP server (`node <repo>/apps/cli/dist/cli.js mcp`). If that server is not configured, report that and stop; do not guess numbers.

```json dx-routing
{
  "skill": "dx-analyze",
  "tool": "dx_analyze",
  "server": "rat-stack",
  "inputs": ["flight", "repo", "snapshotId", "asOf"],
  "readOnlyPreflight": "dx_status",
  "followUp": ["dx_explain", "dx_evidence"],
  "neverCalls": ["dx_collect", "dx_mark"]
}
```

## Steps

1. Optional preflight: call `dx_status` to see which source modules are enabled and which store is active.
2. Call `dx_analyze` with only the inputs you actually know:
   - `repo`: absolute path of the current workspace repository.
   - `flight`: a flight ID only if the user or an earlier result gave one.
   - `snapshotId` / `asOf`: only to reproduce an earlier report.
3. Present the `AnalyzeReport` (`dx.report.v1`) per branch/flight:
   - tokens: input, output, reasoning, cached, only where a metric reports them;
   - money: source-reported charges; a price-table value is an estimate and must be labelled as one, with its method;
   - agent/tool calls, branch time and active intervals, commits, files/lines changed, local test runs/failures, rework;
   - `coverage`: list every source that is unavailable, partial or disabled.
4. Quote the `snapshot.snapshotId` so the user can reproduce or explain it. Offer `dx-explain` for the timeline behind a number.

## Honesty rules

- Show values exactly as the report gives them. Do not recompute, sum or convert units yourself.
- Missing data stays "unavailable". Never invent tokens, cost, waiting time, savings or AI ownership, and never fill gaps from memory or estimates.
- Do not call `dx_collect` or `dx_mark` from this skill; recording is an explicit, separate user action.
- Do not paste raw prompts, transcripts or file contents into the answer.
- CI/CD, pull requests and GitHub API data are out of scope.
