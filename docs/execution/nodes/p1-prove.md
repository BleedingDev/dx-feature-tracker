# P1-PROVE handoff: end-to-end phase 1 demo with real Cursor activity

Status: **degraded**. The demo passed end to end. The fence failed on files this node did not touch, so nothing was committed or pushed.

## What was proven (real `cursor-agent` run, 2026-09-30)
- Built `dft` in a throwaway repo on branch `feature/dft-demo` with `DFT_HOME` in scratch. Ran `install --git-hooks`, one real `cursor-agent -p --force --model auto --output-format stream-json` run, then `dft collect --source cursor-cli --input stream.jsonl` (1 inserted; a re-run inserted 0 and found 1 duplicate), and `git commit` (the pre-commit `dft snapshot` fired). After that: analyze, explain, chats, `history --since 1d`, each with and without `--json`, plus sync, status and snapshot. Every command exited 0.
- Tokens match the stream's `result.usage`: input 24475, cached-input 35456, cache-write 0, output 459. Reasoning is unavailable, with a reason.
- Money: billed, metered, source estimate and price-table estimate each get their own line, and none is summed. The account is on the free plan, so only Auto can run, and Auto has no price-table rate. The estimate is therefore unavailable (`model-not-in-table=1`), not $0.
- Flight: branch age is partial (from reflog to as-of, open), agent time 19141 ms, active time 39441 ms, commits 1, tool calls 4 (matches the stream's 4 `tool_call`s).
- Chats: 3 sessions. The two refused named-model attempts show `gpt-5.3-codex` with effort `high` (from the model-name suffix). The real run shows `default` for the session setting and `Auto` for the turn, with effort unavailable.
- The re-run `dft sync` inserted 0 new events.
- Demo script with sanitized outputs: `docs/demo/phase1-demo.md`.

## Fix made
- `packages/core/src/dx/metrics/flight-time/signals.ts` `keysOf`: tool-call reports now also carry a `session:<id>` key. Before, cursor-cli (requestId, no turn), transcripts (`<session>:0` turn) and hooks (`<session>:<session>` turn) never shared a key, so the demo counted 14 tool calls (4+4+6). After the fix the count is 4 and the output says "2 duplicate report(s) collapsed". Within a session, the source with the highest precedence wins. flight-time tests: 7/7 passed. oxlint and oxfmt are clean.

## Fence
`pnpm turbo run check test build`: **failed** at `@rat-stack/core#build`, caused by other agents' in-flight, untracked files:
- `packages/core/src/dx/collectors/cursor-usage-api/{client,collector,session}.ts` (asyncFunction, globalDate, globalFetch)
- `packages/core/src/dx/metrics/cost/price-catalog/provider.ts` (globalDateInEffect, asyncFunction, globalFetch, Date.now)

Per the task rules, no commit or push was made.

## Gaps and issues for others
- **The cursor-usage-api auto-sync (added to `composition.ts#autoSources` around 15:02 by another agent)** pulled 149 account-wide dashboard rows ($3.38 billed, $0.32 metered) into this repo's store under `(no branch)`, stamped with this repo's `repoCommonDir`. That is account usage, not repo cost. It should not be auto-synced per repo, or it should stay unattributed to any repo. Later runs failed its response check and reported it as unavailable.
- `chats` reports 6 tool calls for the session (hook `postToolUse` 4 + `postToolUseFailure` 2), while the flight metric reports 4. The chats module does no cross-source collapse.
- `analyze`, `explain`, `chats` and `status` still print JSON without `--json`.
- No priced model was exercised live (free plan). Estimates have only been verified by the p1-prices tests.
- Cursor CLI project hooks do fire under `cursor-agent -p` (15 hook events were captured).
