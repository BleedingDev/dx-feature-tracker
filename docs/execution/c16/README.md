# C16 release verdict (checked 15:05–15:09 CEST)

**Verdict: NO-GO for the current working tree.** The final fence fails. By the product evidence, the last demonstrated state is **degraded-live**, but that tree was never fenced. The only passed gate receipt is G00, at commit `2e78dc9`. It contains only the scaffold and the frozen contracts. The G01, G02 and G03 receipts do not exist (`docs/execution/phases/` holds only `g00.json`). No later tree may be called released.

## Final fence (current tree, HEAD 2e78dc9 + ~258 dirty paths, still being edited)

| Check | Exit | Result |
|---|---|---|
| `pnpm exec turbo run check test build` (15:05:55) | 2 | stops at `@rat-stack/core#build` |
| same with `--continue` (15:06:03) | 2 | failed: `//#lint`, core build/check/test/typecheck, cli test (`command.test.ts` expects `capabilities.length + 4`, got +5) |
| `final-fence.sh` receipt (15:08:31) | 1 | failed: `//#lint` and core build/check/test/typecheck. The cli test now passes. Tree digest changed during the run (`4c0cad93…` → `55dbe92f…`), so other agents were still writing. See `fence-receipt.json`. |
| C15 claims audit | 0 | 26 pass, 0 fail |
| C14 adversarial replay (`rehearse.sh adversarial`, 15:06:24) | 0 | check-adversarial passed: canaries redacted, duplicates collapsed, truncated tokens rejected, and every missing money value stays null |
| `~/.cursor/hooks.json` sha256 before and after all runs | same | `162231fe…` |

The core failures come from files first created at 15:01–15:04, after the optional cut. They are all untracked, and no G03 disposition names them:
- `packages/core/src/dx/collectors/cursor-usage-api/{client,collector,session}.ts` break the Effect tsgo rules: async functions, the global `fetch`, and `new Date()`.
- `packages/core/src/dx/metrics/cost/price-catalog/{provider,catalog,slug}.ts` break the same tsgo rules and have oxlint errors.
- `packages/core/test/dx/auto-usage.test.ts` imports node `fs`/`path` and uses async functions. It accounts for 44 lint findings.

Release fix: the owners fix those files. If they cannot, root disables them before the 15:17 correctness cut by removing them from the tree or keeping them out of the candidate. Then rerun `owned-temp-dir --run c16-fence -- bash docs/execution/c16/final-fence.sh` and require exit 0 with `treeStable: true`.

## Route matrix (AI-route group rule: at least one ready, validated real route in B05/B07/B08)

| Route | Node | Evidence class | Notes |
|---|---|---|---|
| Cursor project hooks | B05 (degraded), A07 (degraded) | **real** | C14 live at 15:02, C17 at 14:47, and C16 at 15:07: 16 spool files from a real cursor-agent session. The rule does not count "degraded" as "ready", so the group rule is **not met**. |
| Cursor transcripts | B07 (degraded) | **imported** (real local copy) | The C17 and C16 runs both imported the transcript of the run they had just done. |
| Cursor usage CSV | B08 (degraded) | fixture | No real export was checked. |
| cursor-agent stream-json | B10 (degraded) | **real**, but stored as `origin: imported` | Tokens in/out/cached are exact: 25599/1381/122880 (C14 live). |
| Git history and observation | core | **real** | Commits, files and lines are supported. |
| Local JUnit tests | B21 (degraded) | **real** (a file the user selects) | |
| Cost ledgers | B31 (degraded) | real → **unavailable** | Cursor reports no charge. The estimate is labelled and is unavailable for `Auto`. |
| Optional B09, B33, B41–B45 | — | disabled | They have tested descriptors. A disabled route is not working code. |
| Optional B11–B14, B46, B48 | — | fixture | Not live. |
| CI/PR/GitHub | — | not attempted | Out of scope for this product. |

## C16 live rerun (`live/`, 15:06:52): real capture, but the agent was blocked
The C17 script ran with `C17_OUT=docs/execution/c16/live`. cursor-agent exited 1 on both attempts with `ActionRequiredError: You've hit your usage limit`. That is a Cursor account limit, not a recorder bug. The recorder still behaved honestly:
- It stored the 16 real hook events.
- It reported requests 0 and tokens, money and tests as `unavailable`. Nothing was invented.
- It measured agent and active time (37.3 s / 38.4 s).
- `analyze --snapshotId` in a fresh process reopened the store and reproduced the snapshot. explain and evidence both exited 0.

All 14 recorder steps exited 0. Only `collect-test-operator` exited 1, because the agent produced no test file. Grepping `live/` for the prompt text and for key patterns found nothing.

**Demo caveat:** this run reports `dx.flight.tool-calls = 16` although the agent was blocked before it did any work. That is further evidence of the C15 tool-call overcount. Do not quote tool calls.

## Open findings for other owners
1. The core build, typecheck and lint are red because of the new `cursor-usage-api`, `price-catalog` and `auto-usage.test.ts` files (their owners, or root disposition).
2. The G01, G02 and G03 receipts are missing. Root has to write them, or report that P1 and P2 were never gated.
3. Tool calls are overcounted (flight-time/C09).
4. cursor-cli events are stored as `imported` (B10).
5. `--flight <branch>` resolves to empty metrics (A02, from the C13 finding).
6. The cursor-hooks coverage gap still says `live-capture-not-demonstrated`, even though live capture has now been shown (B05 copy).

Note: rerunning C14's `rehearse.sh adversarial` regenerated `docs/execution/c14/adversarial/*`, which C14 owns. The inputs are the same deterministic fixture; only the snapshot and timestamps differ.
