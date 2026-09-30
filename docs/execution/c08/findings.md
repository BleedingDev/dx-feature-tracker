# C08 MCP launch audit: findings

Scope: the real stdio MCP server, launched exactly as `node apps/cli/dist/cli.js mcp`. Each test spawns the built CLI with an owned temp Git repo on `feature/c08-audit`, an owned `DX_STORE` and `HOME`, and scripted JSON-RPC over stdin. It checks the launch handshake, protocol-only stdout, cancellation, and bounded pagination.

## Verified behaviour
- **Launch:** `initialize` negotiates `2025-06-18`. `tools/list` returns all six `dx_*` tools (plus `inspectFile`), each with an `inputSchema`. The `dx_status` output decodes with the frozen `StatusReportSchema`.
- **Protocol-only stdout:** every stdout line across the sessions is a JSON-RPC 2.0 frame. That covers `dx_collect` (git-history), `dx_mark`, `dx_analyze`, an unknown snapshot, an unknown tool and a malformed `tools/call` (`name: 42`). Errors come back as `isError` results or JSON-RPC errors, never as stray text.
- **Cancellation:** `notifications/cancelled` for an in-flight `dx_analyze`, and for an id that never existed, does not crash the server. `ping` and `dx_status` sent afterwards are still answered. The test does not assert whether the cancelled call was actually aborted, because the spec allows either outcome.
- **Bounded pagination:** `dx_explain` with `limit: 1` returns 1 entry, a `total` above 1 and a `nextCursor`. Following that cursor in a new process returns a different single entry, so the cursor is durable across restarts. The server rejects `limit` 0, -1, 501 and 1.5, a forged cursor, 101 `evidenceIds`, and an empty `evidenceIds`. Explain and analyze outputs decode with the frozen `ExplainTimelineSchema` and `AnalyzeReportSchema`.

## Findings
1. **(low, owner A02 / capability stdio layer)** When stdin reaches EOF, the main fiber is interrupted: the process exits with **130**, not 0, and **drops requests that are still in flight**. Probe: sending `initialize` + `dx_status` + `ping` and then closing stdin at once answered id 1 and id 3 but never id 2 (`dx_status`). Clients that keep stdin open, which all normal MCP hosts do, are unaffected. The audit keeps stdin open 4 s per session and asserts exit 130 with no signal.
2. **(info)** The server sends `notifications/tools/list_changed` right after the handshake. This is harmless, and it is a valid frame.
3. **(info)** `tools/list` returns no `nextCursor`, so it is unpaginated. That is fine for 7 tools.

## Gate note
Turbo `test` depends only on the same package's `build`, so the core test task does not wait for `apps/cli` `build`. If `apps/cli/dist/cli.js` is missing, the suite **skips** (`describe.skipIf`) rather than failing. A gate must build before running c08 to get real coverage. `commands.json` `build` then `test` does this.
