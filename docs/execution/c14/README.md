# C14 demo rehearsal: live flight + adversarial fixture flight

Two flights, kept apart on purpose. Each gets its own throwaway Git repo, branch and SQLite store inside an owned temp dir, so numbers from one can never leak into the other.

| Flight | Label | Branch | Inputs | Output folder |
|---|---|---|---|---|
| Live | `LIVE FLIGHT (real cursor-agent)` | `feature/c14-live` | Real `cursor-agent` run via the installed project hooks, plus its stream-json, the agent's own junit test report, Git | `live/` |
| Adversarial | `ADVERSARIAL FIXTURE FLIGHT (synthetic)`, origin `fixture/adversarial` | `fixture/c14-adversarial` | Hand-written inputs in `packages/core/test/dx/fixtures/c14/` fed through the real `dx hook` and `dx collect` | `adversarial/` |

The adversarial flight is **not** real Cursor activity. Treat it as a correctness check only, never as evidence of live capture.

## Rehearse

```bash
/Users/satan/bin/owned-temp-dir --run c14-rehearse -- bash docs/execution/c14/rehearse.sh all          # both
/Users/satan/bin/owned-temp-dir --run c14-adv -- bash docs/execution/c14/rehearse.sh adversarial      # offline, ~6 s
/Users/satan/bin/owned-temp-dir --run c14-live -- bash docs/execution/c14/rehearse.sh live            # needs logged-in cursor-agent
```

It needs the built CLI (`apps/cli/dist/cli.js`). The script exits non-zero if any checker assertion fails or if `~/.cursor/hooks.json` changes; `rehearsal-<mode>.json` records the before/after hash. Only the throwaway repo's `.cursor/` is written, and the live flight uninstalls it again at the end.

Demo commands for one branch (what the script runs):

```bash
dx collect --source collector.cursor-hooks --repo <repo>
dx collect --source collector/cursor-cli    --input <stream.jsonl> --repo <repo>
dx collect --source collector/local-test    --input <junit.xml>    --repo <repo>
dx collect --source collector.git-history   --input <repo> --repo <repo>
dx collect --source collector.git-observation --input <repo> --repo <repo>
dx analyze --repo <repo>                 # current branch; do NOT use --flight (C09 finding 1)
dx explain --snapshotId <snap> --limit 200
```

## What the adversarial flight tries to break

| Attack | Expected (asserted by the checker embedded in `rehearse.sh`) |
|---|---|
| Prompt, shell command, shell output and file edit carrying canaries `C14-PROMPT-CANARY` and a fake `sk-` key | No canary in the spool or in any collect/analyze/explain output |
| Malformed hook stdin | `dx hook` exits 0 (never breaks Cursor) and writes no spool file |
| Same stop hook payload twice | Stored once |
| Same cursor-agent `result` line twice | Tokens counted once (input 1000, not 2000) |
| Truncated result line with 99999 input tokens | Rejected and disclosed (`rejected-lines`, `run-without-result`), never counted |
| Result without usage | Disclosed as `result-without-usage`, tokens not invented |
| Re-collecting the same stream | 0 new rows |
| No money source | Every `dx.cost.*` and `dx.ai-usage.money.*` is null; reasoning tokens null, not 0 |
| junit with 1 of 3 failing | test runs 1, failures 1 |
| Two commits touching the same file | commits 2, files re-touched 1 |
