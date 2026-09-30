# C17: real Cursor flight receipt (2026-09-30 12:47Z)

Reproduce: `C17_OUT=$PWD/docs/execution/c17/out /Users/satan/bin/owned-temp-dir --run c17 -- bash docs/execution/c17/run.sh`

- **Operator:** the C17 Cursor validation agent (a role, not a person). **Clients:** cursor-agent 2026.09.28-64d2043, node v24.18.0, `rat-stack v0.1.0`, contract `dx.contracts.v1` (see `out/versions.txt`).
- **Candidate:** recorder HEAD 2e78dc98 plus a dirty tree (223 paths). Built `apps/cli/dist/cli.js` sha256 4c395494…; `scripts/dx-install.ts` sha256 4bc956fd….
- **Live vs. imported:** the flight is prospective and live. The branch was created, then `dx-install install` wrote the project `.cursor/` in an owned temp repo, then a real `cursor-agent` stream-json run happened (exit 0). The Cursor transcript of that run was copied and imported separately (`origin: imported`, `collect-transcripts-imported`). `~/.cursor/hooks.json` had the same sha256 before and after.
- **Snapshot reuse:** `analyze` created `snap_5713…`. Then `analyze --snapshotId`, `explain --snapshotId` (29 entries) and `evidence --snapshotId` (5 followed IDs) all used that snapshot. The two analyze outputs are identical except for `notes`.
- **Idempotence:** re-collecting the same cursor-cli stream gave inserted 0, duplicates 1.

Per-branch results for `feature/c17-real-flight` (`out/analyze1.out`):

| Metric | Value | Source |
|---|---|---|
| requests | 1 | cursor-cli |
| tokens input / output / cached-input / cache-write | 22150 / 1275 / 153984 / 0 | cursor-cli usage |
| tokens reasoning, total | unavailable | not reported |
| money (charge, metered, estimates) | unavailable | Cursor reports no charge |
| tool calls | 36 (14 evidence) | hooks + cli, see gaps |
| agent / active time | 30.8 s, 1 interval | hooks |
| branch age | 35.5 s | git reflog |
| commits / files / lines | 1 / 2 / +14 −0 | git |
| test runs / failures | 2 / 0 | JUnit (agent + operator) |
| reworked files | 0 | git |

All 16 steps exited 0 (`out/exits.txt`). Raw prompts, the stream and the spool stayed in the owned temp dir, which was deleted. A grep for prompt text in `out/` found no matches.
