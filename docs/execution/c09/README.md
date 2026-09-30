# C09 live Cursor smoke

Run (from repo root, needs a built CLI and a logged-in `cursor-agent`):

    /Users/satan/bin/owned-temp-dir --run c09-smoke -- bash docs/execution/c09/live-smoke.sh

The script makes a demo Git repo inside the owned temp dir, installs project-level `.cursor/hooks.json` + `.cursor/mcp.json` with `scripts/dx-install.ts` (never `~/.cursor`), runs real `cursor-agent` on branch `feature/c09-live`, commits, collects hooks spool + cursor-agent stream-json + Git, then runs `dx analyze` / `dx explain`, and finally has Cursor call the `rat-stack` MCP `dx_analyze` tool. Only aggregate results land in `run/`; the raw stream, spool and store are deleted with the temp dir. `C09_STORE=<path>` keeps the store for inspection.

Latest run (2026-09-30 14:55 CEST, cursor-agent 2026.09.28-64d2043): see `run/steps.log`, `run/analyze.json`, `run/explain.json`, `run/cursor-mcp-call-summary.json`, and `docs/execution/nodes/c09.md` for results and findings.
