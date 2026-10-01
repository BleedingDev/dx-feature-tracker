# Multi-harness support: research

Researched on 2026-10-01. Host checks are read-only and recorded field names only, never prompt content. "Host" means verified on the maintainer's Mac; "docs" means official docs or source.

## 1. What each harness leaves on disk

|  | Cursor (today) | Claude Code | Codex | Pi | OMP (Oh My Pi) | DeepSeek Harness |
| --- | --- | --- | --- | --- | --- | --- |
| Version checked | 3.22 / agent 2026.09.28 | 2.1.286 (host) | 0.159.2 (host) | 0.99.1 (host) | 18.0.0 (host) | 0.2.0-rc.2 (docs, not installed) |
| Session files | hooks spool, local DB, transcripts, usage API | `~/.claude/projects/<slug>/<session>.jsonl` plus `<session>/subagents/**/agent-*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `archived_sessions/`, `imported/`, `recovered/` | `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl` | `~/.omp/agent/sessions/<slug>/<ts>_<id>.jsonl` plus nested subagent files | `~/.dsh/sessions/--<cwd>--/<id>/session.vN.jsonl.zstd` |
| Home override |  | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `PI_CODING_AGENT_DIR` | `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` | `DSH_HOME` |
| Usage record | per request | `message.usage` on assistant rows | `token_usage_record.usage` per response (0.153+), `token_count` before | `usage` on assistant messages, `usage`/`compaction` entries | same as Pi plus `premiumRequests` | `usage` on `assistant/message`, `compaction/summary`, attempts |
| Dedupe key | request id | `(message.id, requestId)`, keep the largest row, across files | `response_id`, only `thread_id == self` | entry id, drop fork prefix | (header id, entry id) | skip events up to last `session/end-seed` |
| Input semantics |  | input excludes cache | input includes cache | disjoint buckets | disjoint buckets | disjoint buckets |
| Reasoning tokens |  | `thinking_tokens` inside output | `reasoning_output_tokens` inside output | inside output | inside output | inside output |
| Cost stored | Cursor charge and list price | no (`costUSD` gone; session `cost-state` often 0) | no | yes, USD per message (0 for local providers) | yes, API-equivalent | no |
| Model | per turn | `message.model` per row | `turn_context.model`, `thread_settings_applied` | per assistant message (`responseModel` is the server's) | per message, `provider/modelId` | `model/selection`, `source.model` |
| Effort | model suffix | `effort` / `perTurnEffort` per row | `turn_context.effort` | `thinkingLevel` | `thinkingLevel` (`configured: auto`) | `reasoningEffort` |
| Branch recorded | no (we infer) | yes, `gitBranch` on every row | only at session start (`session_meta.git`) | no, cwd only | no, cwd only | no, cwd only |
| Subagents | hooks fields | `isSidechain`, `agentId`, separate files | separate rollout files linked by `parent_thread_id` (87% of files) | none in core | nested files; parent `task` result sums them (count one, not both) | sibling sessions with `origin: subagent` |
| Live capture | project hooks | 33 hook events, none with tokens | hooks (stable), none with tokens | TS extensions, `message_end` carries usage | pi-compatible extensions plus hooks | Cordis plugin on `session/event` |

## 2. Bugs in today's importers (they only ever read one explicit file)

- Claude Code: misses all subagent usage (`subagents/**`, about 6.5k files on the host), keeps the first streaming row so output tokens are undercounted, has no fallback for gateway rows without `requestId` (45k rows on the host), and no cross-file dedupe.
- Codex: decodes `session_meta.source` as a string, but for subagent threads it is an object, so most files lose session id, start branch and version silently. No filter for replayed parent usage. Ignores mid-thread model changes.
- Nothing discovers Claude, Codex or OpenCode sessions automatically. Pi, OMP and DeepSeek Harness have no importer.

## 3. Cursor-specific code in generic modules

`metrics/ai-usage/normalize.ts` (stop-hook tokens), `metrics/cost/readings.ts` (`tokenUsage.totalCents`, `cursor-cli` alias), `metrics/cost/price-catalog/provider.ts` (Cursor price table as default), `chats/tree.ts` (`adapterId.includes("cursor-hooks")`), `chats/effort.ts` (suffix parsing), `live/engine.ts` and `live/config.ts` (usage poller and hook spool), `registry/sync.ts` (hard-coded Cursor paths, sync `fs`/`execFileSync`), `registry/runtime.ts` (`runCursorHook` is the only live entry). `AiSourceKindSchema` mixes Cursor channels, other harnesses and vendor billing in one list.

## 4. Proposed architecture (Effect 4.0.0-rc.117)

Effect v4 names, checked in the installed source: `Context.Service<Self, Shape>()("id", { make })`, `Layer.effect`, `Layer.succeed`, `Layer.mock` (missing members fail when called), `FileSystem.layerNoop`, `ChildProcessSpawner` from `effect/unstable/process`, `@effect/vitest` `it.layer` / `layer(…, { excludeTestServices })`, `TestClock` by default under `it.effect`.

Three separate concepts:

- Harness: the coding tool (`cursor`, `claude-code`, `codex`, `opencode`, `pi`, `omp`, `deepseek`).
- Channel: how evidence arrives inside a harness (`session-jsonl`, `hooks`, `local-db`, `usage-api`, `cli-stream`, `extension`).
- Model provider: who serves and bills the model (`anthropic`, `openai`, `deepseek`, `cursor`, gateways).

Per harness, two services:

```diff
+ <Harness>Store      I/O port: roots, list sessions, read text/rows, version
+   .layer            live: FileSystem, Path, ChildProcessSpawner, HarnessHome
+   .memory(files)    in-memory sessions for fast tests
+ <Harness>Harness    discover, locate(scope), read(ref) -> events, modelEffort, pricing semantics
+ HarnessRegistry     assembles all harnesses, replaces hard-coded discovery and global precedence
+ LocalSqlite         read-only node:sqlite port (Cursor, OpenCode, OMP), memory layer for tests
```

Every AI usage event carries a decoded attribution: harness, harness version, channel, provider, model, raw model, effort, cwd, parent session, and how the branch was known (`harness-recorded`, `git-at-time`, `cwd-inferred`, `unavailable`). Project, worktree and branch stay in the existing flight context.

One conformance suite per harness, run at three tiers:

| Tier | Layers | Speed | When |
| --- | --- | --- | --- |
| Mock | `Harness.layer` + `Store.memory` | milliseconds | always, lefthook and CI |
| Fixture | real store over committed redacted files | fast | always |
| Live | real store over this machine's data | seconds | opt-in, `DFT_LIVE_HARNESSES=claude-code,codex`, read-only, invariants only |

Checks: discovery never fails, every event decodes, reading twice gives the same event ids, missing tokens stay null, harnesses without a cost field never produce charge rows, no prompt text in payloads, branch source matches the harness capability.

## 5. Group-by and filtering

Prior art (ccusage, tokscale, agentsview, Langfuse, LiteLLM, Anthropic and OpenAI usage APIs) converges on: one fact per request, filters as value lists, one group-by plus time buckets, explicit "unattributed" rows, pinned timezone, the ledger always named.

Pitfalls: grouping sessions by a multi-valued dimension double counts; distinct counts (chats, agent time) do not sum across groups; account buckets must stay unattributed, never spread; billed, metered and estimated money never add up.

Gaps found in dft today: no harness dimension, model missing on money rows, the 7d/30d filter hides branches but still shows lifetime totals, and every dashboard request re-decodes every event.

Proposal: a derived `usage_facts` table (one row per deduped request: harness, provider, model, effort, repo, branch, worktree, session, time, token buckets, each money ledger in its own column, attribution label), rebuilt after sync. One query contract (`filters`, `groupBy`, `stackBy`, `metric`, `since/until`, `tz`) used by the CLI (`dft usage --by model --harness codex`), the dashboard (`/api/usage`) and MCP. Dashboard: filter chips, one group-by select, a time chart stacked by harness, a table with drilldown, all state in the URL.

## Sources

- Claude Code: [hooks](https://code.claude.com/docs/en/hooks), [statusline](https://code.claude.com/docs/en/statusline), [monitoring](https://code.claude.com/docs/en/monitoring-usage), [ccusage cost modes](https://ccusage.com/guide/cost-modes)
- Codex: [hooks](https://learn.chatgpt.com/docs/hooks), [config](https://learn.chatgpt.com/docs/config-file/config-advanced), [ccusage Codex](https://ccusage.com/guide/codex/), [rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)
- Pi: [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md), [ccusage Pi](https://ccusage.com/guide/pi/)
- OMP: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
- DeepSeek Harness: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`docs/persistence-catalog.md`, `docs/subsystems/persistence.md`)
- Trackers: [tokscale](https://github.com/junhoyeo/tokscale), [agentsview](https://github.com/kenn-io/agentsview), [splitrail](https://github.com/Piebald-AI/splitrail), [Langfuse metrics API](https://langfuse.com/docs/metrics/features/metrics-api), [LiteLLM spend](https://docs.litellm.ai/docs/proxy/cost_tracking)
