# Non-Enterprise Cursor usage and cost collection

Research date: 2026-09-30. No user account, credentials, transcripts, or local Cursor installation inspected. Sources are official documentation, public OSS code, and published parser fixtures. Verdict: **Enterprise is not a prerequisite for meaningful token/cost collection.** Exact source accounting and exact branch attribution are separate questions.

## Collection matrix

| Route | What it can establish | Branch/session join | Evidence label and limits |
|---|---|---|---|
| User downloads personal usage CSV | Historical model requests, timestamps and token buckets; numeric cost when supplied | Timestamp correlation; cloud-agent IDs in some shapes; ordinary IDE conversation/branch generally absent | **Imported** source counts, **reconstructed** branch join; never silently assign ambiguous rows |
| Opt-in export of already-loaded dashboard response | Potential conversation ID, timestamp, token usage, metered and charged cost | Conversation ID can join consented local conversation/workspace evidence | **Imported**, undocumented schema, isolated adapter; no copied cookies or stored session credentials |
| Cursor SDK instrumentation | Prospective run usage and billed record | Own flight metadata + run/agent/request IDs and local cwd; cloud run git metadata | **Captured** source counts and optional settled cost; covers these runs only |
| CLI stream wrapper | Sessions, cwd/model, tool boundaries, API/wall duration | Wrapper captures branch/worktree + arrival timestamps | **Captured** activity, token/cost **unavailable** in documented output schema |
| Optional stop-hook token fields | Potential per-turn input/output/cache counts | Hook conversation/workspace metadata + recorder branch snapshots | **Captured only when fields present**, currently OSS-supported but not officially documented; test installed version |
| User-supplied provider usage exports/invoices | BYOK account/model totals and expenditure | Dedicated key/project plus interval is strongest; invoices alone have no branch causality | **Imported** totals; branch allocation **reconstructed** or **unavailable** |
| Explicitly routed own model traffic | Provider response usage, request IDs, timestamps, flight tags | Exact recorder tags, provided traffic actually takes this route | **Captured** counts; list-rate cost **estimated**, billed cost imported later |
| Tokenize consented visible transcripts | Visible text size | Conversation/workspace/time metadata | **Estimated lower-bound text tokens**, excludes hidden context/tools/reasoning/retries; cannot establish billed tokens |
| Status-bar extension alone | Editor events/context; own calls | Current workspace/branch snapshots | Not a magical observer of native Cursor model traffic |

## 1. Personal CSV is the default historical import

Cursor staff's May 2026 answer explicitly identifies personal dashboard usage CSV as available while saying no public individual usage API/CLI command exists. A later staff reply reiterates CSV export and explains that displayed dollar values can exceed plan price. This is direct product evidence for a manual, no-admin path, not a guarantee that every current export carries a numeric Cost column. [Individual usage route](https://forum.cursor.com/t/usage-api-cli-command/160967), [staff explanation](https://forum.cursor.com/t/usage-page-to-token-amount-what/167153/9)

Preloop documents request rows with Date, Kind, Model, Max Mode, input/cache/output/total columns and Cost; its importer handles newer User columns with order-independent matching and explicit rejected-row reporting. Adopt the robustness pattern, not a third-party upload dependency. [Import contract](https://docs.preloop.ai/cost/importing-cursor-usage/)

OSS fixtures show variants: v1 has Cost to you; v2 adds Kind/Max Mode; v3 adds Cloud Agent ID and Automation ID. They include ISO timestamps, dollar strings, numeric zero and Included cost cells. Current tokmesh maps cache-write and uncached-input columns as independent buckets, contrary to the tempting interpretation that “w/ Cache Write” is cumulative. Its dashboard JSON parser preserves conversationId, timestamp, chargedCents and tokenUsage fields including totalCents. These are published parser observations, not Cursor's guaranteed API contract. Pin parser evidence to [tokmesh-core 0.1.5 source](https://docs.rs/tokmesh-core/0.1.5/src/tokmesh_core/sessions/cursor.rs.html). **Do not blindly subtract the two input columns.** Validate totals against the selected shape and retain raw values on disagreement.

Implementation recommendation: real CSV parser; header map; optional unknown columns; raw-row hash and import-batch ID; retain timezone/precision; report total/imported/rejected/duplicate/unattributed rows. Preserve numeric zero; Included, dash and absent are not numeric zero. Reject negative or non-finite costs. Store metered inference value separately from customer charge. No assumption that subscription spend equals the sum of token list-price values.

## 2. Dashboard response export can recover session IDs without cookie extraction

The MIT browser extension [circa94](https://github.com/circa94/cursor-token-prices-chrome-extension/blob/9c052828aa5d2dbc8348be29c5f770dee1a4d167/inject.js) intercepts fetch/XHR responses already requested by the usage page. It recognizes usage-event URLs and reads usageEventsDisplay/events, totalUsageEventsCount and tokenUsage.totalCents. This is a concrete response-observation pattern, not browser-login bypass. It does not prove today's exact schema, complete pagination, or availability of charged cost.

Recommended optional adapter: user initiates “export observed usage JSON” while viewing their own authenticated dashboard; serialize only allowlisted response fields locally. Never export headers, cookies, keys, prompts or complete HAR files. Include page filters/date range, capture time, expected event count, observed pages and truncation state. Keep browser authorization in the browser. Session-ID availability should be detected, never fabricated. This is an independently owned optional lane, not a dependency of basic recording.

## 3. New official SDK provides strong prospective telemetry

Current [TypeScript SDK](https://cursor.com/docs/sdk/typescript) accepts personal user API keys; user keys bill to the user's plan. TokenUsage exposes inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens and optional reasoningTokens. Runs expose IDs, requestId, createdAt/duration and optional git branch/repo/PR metadata. agent.getUsage() returns per-run cloud or per-turn local records, with optional rawCostCents and chargedCents. Cost can settle later; chargedCents is zero for included, BYOK and credit-grant usage. Node minimum is 22.13. This is **not evidence of a supported universal IDE-history API**. Use only for recorder-launched or deliberately SDK-based agent work; attach flight metadata and capture branch before each send. Personal key support does not guarantee every account/model/runtime entitlement; capability-test installed SDK version and account before relying on it. Distinguish live run counts from billed records. Avoid doubling these with the corresponding CSV rows.

## 4. CLI and stop-hook accounting must be distinguished

The [official CLI output contract](https://cursor.com/docs/cli/reference/output-format) supplies session ID, cwd/model on init, tool start/completion events and terminal duration/API duration/request ID. It documents no usage object. A wrapper can record real activity without claiming tokens. CLI failure can end without a terminal JSON event; capture stderr/exit state and incomplete duration separately.

[Official hooks](https://cursor.com/docs/hooks) expose agent-loop observation and stop hooks, but a search of the current page finds no input_tokens schema. [SebberSky's pinned implementation](https://github.com/SebberSky/cursor-token-usage/blob/9379e191c3d1caa80315cf7814146127833a492e/hooks/token-usage-logger.py) reads snake/camel input/output/cache fields, tracks whether any token field is present and falls back to bucket sums when total is absent. Its README claims current builds emit them and warns older chats cannot backfill. Verdict: **credible undocumented capability, runtime verification required**, not “impossible without Enterprise.” Do not copy its missing-value-to-zero behavior into the canonical event schema; preserve null/presence flags. Prospective installation covers only subsequent observed turns. Whether optional stop counts represent per-turn increments or cumulative conversation totals is not guaranteed by these sources; compare two consecutive controlled turns before summing, including subagent overlap.

## 5. BYOK/provider evidence broadens coverage

[Cursor BYOK documentation](https://cursor.com/help/models-and-usage/api-keys) says individual-plan provider requests are billed by the provider and do not draw included usage; Tab remains Cursor-hosted. Requests still pass Cursor servers for final prompt construction. Thus localhost interception of Cursor's entire native traffic is not established merely by configuring BYOK. Teams/Enterprise may additionally incur Cursor Token Rate; keep fees separate.

[OpenAI usage/export documentation](https://help.openai.com/en/articles/10478918-reviewing-api-usage-and-costs) supports dashboard exports, project reporting and token-category details. A user-owned dedicated provider project/key improves attribution, but shared aggregate buckets are still not request-level branch evidence. [Anthropic Usage/Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) explicitly excludes individual accounts from the Admin API; do not replace one admin dependency with another. User-provided Console exports/invoices and captured response usage remain distinct routes.

[Anthropic caching reference](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md) treats uncached input, cache creation and cache read as separate prompt components. Price schedules must preserve model/version, effective date, currency, service tier, cache-write TTL, regional uplift, batch/discounts and extra tool charges. Unknown Auto model or absent cache detail means estimated interval/unpriced usage, not invented exact dollars.

## 6. Instrumented own traffic and extensions

[LiteLLM logging](https://docs.litellm.ai/docs/proxy/logging) can track spend metadata while disabling message logging. Its [spend documentation](https://docs.litellm.ai/docs/proxy/cost_tracking) supports spend records but identifies custom spend-log metadata as Enterprise; do not make that gated feature necessary. A tiny owned gateway or SDK callback can persist recorder tags in its own ledger. This captures only traffic deliberately routed through it. Cursor custom-base-URL compatibility, especially reachable localhost behind Cursor-hosted prompt construction, was not established here; it requires a capability test.

The [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) lets an extension make its own model requests. That is not evidence that an extension can globally snoop Cursor's native requests. An extension remains useful for branch/workspace/editor activity, launching SDK/wrapped commands, and displaying coverage.

## Accounting contract (recommended)

Keep acquisition and certainty independent: acquisition = captured/imported/reconstructed; certainty = source-reported/estimated/unavailable. Per field store source, source-record ID, capture/import time, event time and precision, raw value, semantic mapping version and confidence. Separately track token coverage, numeric-cost coverage and attribution coverage. For each row maintain candidate flights and join reason; do not force ambiguous time-window joins. Promote reconstructed allocation only with unique session/workspace evidence or explicit user annotation.

Prefer exact request/session/run identity for deduplication. CSV hash deduplication is batch-level only: two legitimate requests can share timestamp/model/token counts. Show evidence overlap instead of subtracting presumed duplicates. Unknown inputs should never turn into $0, 0 tokens or 100% coverage.

## Independent implementation lanes

1. CSV import + synthetic fixtures for all supported column variants and malformed rows.
2. Dashboard response import + schema/capture-coverage validator.
3. SDK adapter + run-to-flight metadata + settlement reconciliation.
4. Conditional stop-token collector + field-presence/version checks.
5. CLI activity wrapper + interrupted-run state.
6. Provider export/import ledger + dedicated-key attribution.
7. Price registry + category-aware estimator, independently testable.
8. Dedup/join/coverage tests shared across all sources.

CSV plus hooks/CLI activity is the accessible baseline. Optional collectors enrich it without blocking a truthful report. All routes need a fixture-based contract test; SDK/hook/dashboard routes additionally need a small real capability probe during implementation. No dependency on Biomem, enterprise analytics, copied browser credentials or a new coding assistant.
