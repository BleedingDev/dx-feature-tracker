# dft phase 1 demo: local Cursor branch tracking

This is the demo script for the hackathon. Everything below was run on 2026-09-30 against a real `cursor-agent` run (Cursor free plan, model Auto). The outputs are real. Paths are shortened: `<demo>` is the throwaway repo, `<out>` holds the captured stream, and `<dft-checkout>` is this repo. Prompts are left out.

## 0. Setup

```sh
export DFT_HOME=<scratch>/dfthome
alias dft='node <dft-checkout>/apps/cli/bin/dft'
git init -b main <demo> && cd <demo>
printf '# demo\n' > README.md && git add . && git commit -m init
git checkout -b feature/dft-demo
```

## 1. Install (project hooks, skills, git hooks)

```sh
dft install --git-hooks
```

```text
created   <demo>/.cursor/hooks.json: added dft hook to sessionStart, sessionEnd, beforeSubmitPrompt, stop, postToolUse, postToolUseFailure, afterFileEdit, afterTabFileEdit, afterShellExecution, afterMCPExecution, afterAgentResponse
created   <demo>/.cursor/skills/dx-analyze/SKILL.md: dx-analyze
created   <demo>/.cursor/skills/dx-explain/SKILL.md: dx-explain
created   <demo>/.git/hooks/pre-commit: pre-commit
created   <demo>/.git/hooks/pre-push: pre-push
```

`~/.cursor` is never touched. The pre-commit hook is `<node> <dft-checkout>/apps/cli/bin/dft snapshot || true`.

## 2. A real Cursor agent run

```sh
cursor-agent -p --force --model auto --output-format stream-json "<small coding task>" > <out>/stream.jsonl
dft collect --source cursor-cli --input <out>/stream.jsonl
```

The stream's final `result` line reported:

```json
{
  "type": "result",
  "subtype": "success",
  "duration_ms": 10933,
  "usage": {
    "inputTokens": 24475,
    "outputTokens": 459,
    "cacheReadTokens": 35456,
    "cacheWriteTokens": 0
  }
}
```

`collect` printed `"inserted": 1, "duplicates": 0`, and a second `collect` of the same file printed `"inserted": 0, "duplicates": 1`. Its coverage gaps say what the CLI stream cannot tell us: `no-cost-in-cli-output`, `no-reasoning-tokens`, `no-branch-in-cli-output` and `may-overlap-hooks-stop`.

The project hooks fired during the run as well (15 hook events), and sync found the run's Cursor agent transcript.

Two earlier attempts with a named model (`gpt-5.3-codex-high`) were refused by Cursor because the account is on the free plan. The hooks still recorded those two sessions, and they show up in `dft chats` below.

## 3. Commit: the pre-commit hook takes a snapshot

```sh
git add . && git commit -m "add sum"
```

```text
dft sync: 6 source(s) read, 167 new event(s), 0 already stored
  unavailable collector.cursor-local-db: Cursor local DB is global (all workspaces); it is not auto-synced because its rows cannot be scoped to this repo yet. Run `dft collect --source cursor-local-db --input <state.vscdb>` explicitly.
dft snapshot snap_53583c086050… feature/dft-demo@ab844904d47f (dirty)
  billed (usage export):     unavailable (No billed charge in the selected sources; import a Cursor usage CSV or dashboard export. Not zero.)
  metered (Cursor-reported): unavailable (No source-reported metered amount in the selected sources.)
  estimate (source):         unavailable (No source-computed list-price estimate in the selected sources.)
  estimate (price table):    unavailable (method=price-table:cursor@2026-09; estimate from source-reported tokens, not a charge; unpriced readings: model-not-in-table=1.)
  requests:    1 requests
  tokens input        24475 tokens
  tokens cached-input 35456 tokens
  tokens cache-write  0 tokens
  tokens output       459 tokens
  tokens reasoning    unavailable (no selected source reported reasoning tokens)
  tokens total        unavailable (no selected source reported total tokens)
  tokens other        unavailable (ai-usage metric emitted no result for this category)
  agent time:  19141 ms
  active time: 31327 ms
[feature/dft-demo 00042a3] add sum
 5 files changed, 160 insertions(+)
```

Each money ledger gets its own line and they are never added together. The run used Auto, which has no fixed price in Cursor's list, so the price-table estimate is unavailable with the reason `model-not-in-table=1`. It does not show $0. Put a user table at `$DFT_HOME/prices.json`to price other models. The snapshot is appended to`$DFT_HOME/snapshots.jsonl` together with HEAD and the dirty flag. Because the hook runs before the commit exists, it records the HEAD from before the commit.

## 4. Running it again adds nothing

```sh
dft sync
```

```text
dft sync: 5 source(s) read, 0 new event(s), 19 already stored
  unavailable collector.cursor-usage-api: expected a Cursor dashboard usage response with a usageEventsDisplay array (or an array/pages list of them)
  unavailable collector.cursor-local-db: …
```

## 5. `dft analyze` (and `dft analyze --json`)

Both forms print the same JSON: 46 metrics, per-source coverage and notes. Here are the key metrics for `feature/dft-demo`:

| metric | measurement | value | note |
| --- | --- | --- | --- |
| dx.ai-usage.tokens.input | measured | 24475 tokens | matches `usage.inputTokens` |
| dx.ai-usage.tokens.cached-input | measured | 35456 tokens | matches `usage.cacheReadTokens` |
| dx.ai-usage.tokens.cache-write | measured | 0 tokens | matches `usage.cacheWriteTokens` |
| dx.ai-usage.tokens.output | measured | 459 tokens | matches `usage.outputTokens` |
| dx.ai-usage.tokens.reasoning | unavailable | – | no selected source reported reasoning tokens |
| dx.ai-usage.requests | measured | 1 |  |
| dx.cost.charge.usd (billed) | unavailable | – | No billed charge in the selected sources … Not zero. |
| dx.cost.metered.usd | unavailable | – | No source-reported metered amount |
| dx.cost.list-price-estimate.source.usd | unavailable | – | No source-computed list-price estimate |
| dx.cost.list-price-estimate.price-table.usd | unavailable | – | price-table:cursor@2026-09; model-not-in-table=1 (Auto) |
| dx.cost.subscription-allocation.usd | unavailable | – | No subscription plan declared |
| dx.flight.branch-age.ms | partial | 217910 ms | start=reflog-branch-created; branch not merged; open until as-of |
| dx.flight.agent.ms | measured | 19141 ms | 14 source intervals merged into 3; overlap counted once |
| dx.flight.active.ms | measured | 39441 ms | 1 interval; idle gap 30 min |
| dx.flight.tool-calls | measured | 4 calls | 3 reports; 2 duplicate reports collapsed (matches the stream's 4 `tool_call`) |
| dx.flight.commits | measured | 1 |  |
| dx.git.lines-added | measured | 160 lines |  |
| dx.git.files-changed | measured | 5 files |  |

## 6. `dft explain` (and `--json`)

This prints an evidence-linked timeline, grouped into lanes (`git-history`, `cursor-hooks`, `cursor-cli`, `cursor-transcripts`). Every entry has an evidence id. Here are the first entries:

```text
13:03:25  git.observation via git-history reflogEntries=1
13:03:53  ai.session via cursor-hooks isBackgroundAgent=false toolCall=false
13:03:54  ai.session via cursor-hooks durationMs=3008
…
```

## 7. `dft chats` (and `--json`)

This shows one entry per chat session, with the model and reasoning level for each turn (condensed):

```json
{"session":"6f16d7ec","adapters":["cursor-hooks"],"modelTimeline":[{"model":"gpt-5.3-codex","rawModel":"gpt-5.3-codex-high","effort":"high","effortSource":"model-name-suffix","scope":"session-setting"}]}
{"session":"8ac0e307","adapters":["cursor-hooks"],"modelTimeline":[{"model":"gpt-5.3-codex","rawModel":"gpt-5.3-codex-high","effort":"high","effortSource":"model-name-suffix","scope":"session-setting"}]}
{"session":"f1afcb85","adapters":["cursor-cli","cursor-hooks","cursor-transcripts"],
 "modelTimeline":[{"model":"default","effort":null,"effortSource":"unavailable","scope":"session-setting"},
                  {"model":"Auto","effort":null,"effortSource":"unavailable","scope":"turn"}],
 "requests":1,"toolCalls":6,"agentTimeMs":10933,
 "tokens":{"input":24475,"cached-input":35456,"cache-write":0,"output":459},
 "money":"no local source reported money for this chat; import a usage CSV or dashboard export for billed figures"}
```

When the session is set to one model and a turn runs on another, both appear in the timeline. The reasoning level comes from the model-id suffix. For Auto it is unavailable, not guessed.

## 8. `dft history --since 1d` (and `--json`)

```text
feature/dft-demo [open] <demo>/.git last 2026-09-30T13:04:31.000Z
  billed (usage export):     unavailable (No billed charge in the selected sources; … Not zero.)
  metered (Cursor-reported): unavailable (No source-reported metered amount in the selected sources.)
  estimate (source):         unavailable (No source-computed list-price estimate in the selected sources.)
  estimate (price table):    unavailable (method=price-table:cursor@2026-09; …; unpriced readings: model-not-in-table=1.)
  requests:    1 requests
  tokens input        24475 tokens
  tokens cached-input 35456 tokens
  tokens cache-write  0 tokens
  tokens output       459 tokens
  agent time:  19141 ms
  active time: 39441 ms
(no branch) [unknown] <demo>/.git …
```

The `(no branch)` row holds the account-wide Cursor dashboard usage (149 rows) that the new `cursor-usage-api` auto-sync source brought in on the first sync. Those rows carry no repo or branch, but they were filed under this repo. **Do not present them as this repo's cost.** See the known issues below.

## Known issues seen in this run

- `analyze`, `explain`, `chats` and `status` print JSON even without `--json`. Only `history`, `snapshot`, `sync` and `install` have text output.
- `cursor-agent` stream captures have to be collected explicitly (`dft collect --source cursor-cli --input …`).
- The `cursor-usage-api` auto-sync source (work in progress) files account-wide usage under the current repo as `(no branch)`. On later runs it failed its response check and was reported as unavailable.
- `chats` counts 6 tool calls for the session: 4 `postToolUse` and 2 `postToolUseFailure` hook events. The branch time metric shows 4, taken from the cursor-cli stream, which has the highest precedence.
- No priced model could be run because the account is on the free plan (Auto only). The price-table estimate path is covered by the p1-prices tests, not by this live run.
