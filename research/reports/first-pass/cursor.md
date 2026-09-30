> Historical first-pass report. Product recommendations and access conclusions are superseded by [the revised synthesis](../../synthesis.md) and the reports/revision/ evidence. dx-feature-tracker is standalone or two-person/24-hour plan applies. Original source evidence remains below.

# Cursor integration feasibility for Biomem dx-feature-tracker

Date: 2026-09-30. Confidence: high for published contracts; target installed Cursor version and account entitlements untested. This report covers public primary sources only. Documentation was fetched and key schemas read, with focused searches for conflicting assumptions. No private account or repository was inspected.

## Decision

Ship a local Cursor hook collector plus a read-only MCP reporting server. Use two explicitly invoked skills, `/dx-analyze` and `/dx-explain`. Treat billed usage, exact branch spend, and code survival as conditional extensions. Cursor now has first-party enterprise APIs for these concerns, so positioning should explain the branch-level workflow and Biomem memory benefit instead of claiming nobody measures AI attribution.

## Capability and access matrix

| Capability | Verified contract and limitation | Hackathon consequence | Source |
|---|---|---|---|
| Agent and Tab activity | Separate agent, Tab, lifecycle hooks. JSON over subprocess stdio. | Hooks collect activity; MCP reports it. | [Hooks](https://cursor.com/docs/hooks) |
| Correlation | Hooks expose conversation_id, generation_id, cursor_version, workspace_roots; transcript_path can be null. | Resolve repository and current Git branch at event time; keep workspace selection explicit. | [Hooks](https://cursor.com/docs/hooks) |
| Agent edits | afterFileEdit provides absolute file_path and old_string/new_string edits. Tab has range and old_line/new_line fields. | An observed edit is provenance evidence, not proof of final retention. | [Hooks](https://cursor.com/docs/hooks) |
| Tool duration | postToolUse has milliseconds duration and tool_use_id. afterShellExecution excludes approval wait. | Local tool timing is available; do not label it developer waiting. | [Hooks](https://cursor.com/docs/hooks) |
| Hook token counters | Documented token fields are compaction context size. No documented billed input/output counters. | Never sum context_tokens as usage. | [Hooks](https://cursor.com/docs/hooks) |
| Native billing import | Admin usage events have optional conversationId, tokenUsage categories and chargedCents. Hourly aggregation; poll at most hourly. | Useful reconciliation, poor live stage demo source. | [Admin API](https://cursor.com/docs/account/teams/admin-api) |
| Admin access | Current overview lists Admin/Analytics/AI Code Tracking as Enterprise. Admin keys require admin:* scope. | Verify entitlement before committing to real usage. Personal/Pro access is not established. | [API overview](https://cursor.com/docs/api) |
| Code attribution | Enterprise-only Alpha, sales access. Commit/change APIs include line-range annotations with conversationId and model. | Optional enterprise adapter, not required MVP dependency. | [AI Code Tracking API](https://cursor.com/docs/account/teams/ai-code-tracking-api) |
| Live enterprise telemetry | Server-side OTLP export to public HTTPS collector; Enterprise only. | Suitable later hosted adapter; too much setup unless already available. | [OpenTelemetry export](https://cursor.com/docs/enterprise/opentelemetry-export) |
| Request token correlation | api.request logs contain input/output/cache counters and optional conversation ID. Aggregate metrics have no correlation IDs. | Use request logs to attribute sessions, not metric sums. | [Wire reference](https://prod.cursor.com/docs/enterprise/opentelemetry-export/wire) |
| Slash UX | Skills support explicit /skill-name invocation and disable-model-invocation: true. | Two skills call two reporting tools. `/dx analyze` is a skill prompt argument convention to test, not a documented subcommand API. | [Skills](https://cursor.com/docs/skills) |
| MCP reporting | Local stdio, remote transports, tools/prompts/resources/roots, MCP Apps supported. | Start with local stdio and Markdown response; Apps optional. | [MCP](https://cursor.com/docs/mcp) |
| Approval | MCP uses Cursor run modes. Allowlisted calls run immediately in Auto-review; other tools go to classifier. Help page specifies Cursor 3.6+. | Test actual account/version approval once before demo. | [MCP help](https://prod.cursor.com/help/customization/mcp) |
| Privacy | Privacy Mode prevents training use; AI prompts/code still go to providers. | Biomem must separately disclose its own collection/export. | [Privacy](https://prod.cursor.com/help/security-and-privacy/privacy) |

## Evidence versus inference

| Statement | Verdict | Reason |
|---|---|---|
| An MCP server automatically sees all Cursor prompts and tool calls. | Unsupported | The MCP contract exposes external tools/data to the host. Collection needs hooks or another documented exporter. |
| Billed tokens and session cost can be joined to Cursor conversation IDs. | Supported with access and coverage gates | Admin docs explicitly document the optional join key. Missing IDs remain unallocated. |
| A conversation corresponds to one feature branch. | Weak | Branch switching and multiple workspace roots require event-time binding. One conversation can contribute to several flights. |
| Agent edit hooks prove that generated code survived review. | Unsupported | They capture edits; later transformations and review must be tracked separately. |
| A deterministic recorder and cited report can ship in a short hackathon. | Engineering recommendation | Uses documented local integrations and independent GitHub inputs; requires a target-version smoke test. |
| This proves AI increases productivity or saves 20 minutes per feature. | Unsupported | Observational telemetry has no counterfactual or controlled comparison. |

## Billing semantics

Keep usage categories separate: input, output, cache write, cache read. Preserve original billing fields, currency and provenance. For Admin API reconciliation sum chargedCents, which includes the applicable Cursor Token Rate. It differs from model-only tokenUsage.totalCents. Some events are request-based and lack tokenUsage or conversationId. Deduplicate overlapping import windows and mark unmatched events unallocated. These details follow the [Admin API](https://cursor.com/docs/account/teams/admin-api).

For enterprise OTLP, deduplicate logs by cursor.event.id; use cursor.usage_event.id for request-level reconciliation. Corrections can retroactively mark a group unbilled. cursor.cost.usage is best-effort estimated cost, not an invoice; BYOK reports the Cursor Token Rate only, excluding provider spend. The [wire reference](https://prod.cursor.com/docs/enterprise/opentelemetry-export/wire) defines these distinctions.

Recommended allocation policy: join explicit IDs first. If one conversation touches several flights, retain session totals and report branch allocation as unknown unless a justified finer mapping exists. Never allocate a whole user's hourly bill to whichever branch happens to be open at import time. Timestamp-only allocation is an estimate and should be excluded from headline exact cost.

## Concrete MVP contract

Recommended modules:

```text
Cursor hook subprocess -> validated event spool -> SQLite event store
Git sampling -----------> flight bindings -------> report calculator
GitHub import ----------> CI/PR evidence --------> report calculator
Cursor explicit skill --> read-only MCP tool ----> Markdown + evidence IDs
Biomem adapter <-------- opt-in flight summary + recurring-friction memory
```

The hook process should append one minimal validated record and return immediately. Give each invocation a locally generated UUID, recorded_at timestamp, source/version and repository snapshot. Avoid synchronous network requests in hooks. SQLite consumer failures must not prevent development. This is an implementation recommendation, not a guarantee from Cursor.

Resolve root from the edited file or tool cwd. For ambiguous multi-root events ask the report caller to choose a workspace. Capture commit SHA and branch before accepting a flight binding; do not rely only on the branch label. Make `/dx-start` or equivalent explicit start optional but available when branch start cannot be reconstructed.

Report tools should return structured JSON with computed values, interval definitions, evidence IDs, coverage warnings, and a pre-rendered Markdown report. The skill should instruct the agent to preserve numeric results, avoid guessing missing metrics, and cite source events. A natural-language recommendation can sit above deterministic calculations but must identify its evidence.

## Hackathon gates and fallback ladder

1. First-hour integration spike: trigger prompt, file edit, local test, stop and Tab events on the actual Cursor build. Record source Cursor version. Confirm hook payloads and stdout behavior with a minimal recorder. Keep only the hooks actually exercised.
2. Confirm MCP connection and explicit skill invocation. If legacy `.cursor/commands` works on the installed build, it is an alternative packaging path. The old command docs URL now redirects to skills; do not plan against a stale screenshot.
3. Confirm Enterprise billing access before implementing Admin import. If absent, show AI turns, observed edits and model labels, with tokens/cost unavailable. A user-provided export can be a separately labeled import only after its schema and IDs have been examined. Do not scrape cookies/private dashboard endpoints.
4. If enterprise access exists, pre-import a completed flight for the demo because the documented billing feed is hourly. Keep a genuinely live Git/CI/hook flight alongside it.
5. Start code retention as unavailable. Add experimental exact-text survival only if edit coverage is known, revisions are saved, and excluded transformations are disclosed. Generated-line survival, rewritten lines and final AI share have different denominators. None is a semantic correctness measure.
6. If hooks fail on the target build, ship Git/GitHub reports and a clearly labeled recorded fixture. A replay demonstrates intended integration, not live capture.

## Privacy and distribution choices

Default to timestamps, identifiers, durations, counts and redacted paths. Do not collect raw prompts, tool arguments/results or transcripts just to draw a timeline. An optional local attribution experiment may need source text; isolate it and keep it off by default. Provide inspect/export/delete operations and an explicit opt-in before sending summaries to Biomem. Cursor's Privacy Mode cannot be interpreted as a promise covering custom integrations.

Enterprise conversation-content export is disabled by default and currently covers Cloud Agents and Grok Bot only, not IDE/CLI/desktop conversations. Its opt-in does not backfill prior content. This scope follows [OpenTelemetry export](https://cursor.com/docs/enterprise/opentelemetry-export).

For hackathon distribution, a small package with generated `.cursor/mcp.json`, `.cursor/hooks.json` and explicit skills is enough. Preserve existing configurations when installing. A one-click MCP install alone does not install the event collector. Review the full bundle before describing installation as complete.

## Coverage and limits

Ten primary source families were read: hooks, Admin API, API overview, AI code tracking, OTLP overview, OTLP wire, skills, MCP reference, MCP help, privacy. Research checked published schemas and access gates, not private entitlements or executable behavior. Hooks documentation has evolved considerably; minimum versions for every hook were not established, so the installed-build smoke test remains mandatory. API access and exact `/dx analyze` interaction remain unresolved until tested. No source supports reconstructing historical Cursor-generated edits that were never recorded.
