# auto-usage: Cursor usage auto-import and automatic price catalog (D10, D11)

## What shipped
- `collector.cursor-usage-api` (`packages/core/src/dx/collectors/cursor-usage-api/`): reads the logged-in Cursor session at runtime, pages `POST https://cursor.com/api/dashboard/get-filtered-usage-events`, reuses the B43 parser, emits `ai.usage` events with `sourceKind: "dashboard-json"`, `acquisition: "api"`, `chargedUsd` (from `chargedCents`), `costUsd` (from `tokenUsage.totalCents`), cost ledger, tokens by category and `identity.sessionId = conversationId`.
- Incremental: cursor = newest row timestamp, stored as `{lastTimestampMs}` in `~/.dft/cursor-usage-api/state.json`; the next run starts one hour earlier. Event ids come from the row content, so re-fetching the overlap stores no duplicates. An empty window returns coverage `none` rather than a schema error.
- Account-level: events carry an empty FlightContext, so they never land under a repo or branch unless correlation joins them by conversationId.
- Registered in `allCollectors`. `autoSources` adds it only when the store is the per-user global store under `~/.dft`, so tests that use a temp store stay offline.
- Price catalog (`packages/core/src/dx/metrics/cost/price-catalog/`): fetches models.dev and falls back to LiteLLM. Caches to `~/.dft/price-catalog/<source>-<date>.json`, refreshes after 24 h, uses the last cache when offline and the bundled `cursor@2026-09` table after that. It builds a `PriceTable` with `id` = source and `version` = fetch date, and bundled Cursor rates win. Slug mapping strips effort, thinking and fast suffixes and bracket params, and handles `claude-4.5-sonnet` ordering. Auto (`default`) and unknown models stay `unavailable` with a reason and are never guessed.

## Live results (2026-09-30, last 7 days; counts and field names only)
- 149 events, coverage complete (149/149), 2026-09-28T21:57Z to 2026-09-30T13:04Z, 28 conversations.
- Models: `default` 26 (Auto, custom-subscription, charged), `grok-bot-default` 123 (free credit). Cursor does not report the real model behind Auto.
- Cost: list-equivalent `tokenUsage.totalCents` sums to $12.63. Actually charged (`chargedCents`) sums to $1.98.
- Rows have no `requestId`. They carry `conversationId`. The a07 cursor-agent `session_id` matched a dashboard `conversationId`. The a07 `request_id` did not appear.
- Second run: 26 rows in the overlap window, all with identical event ids.
- Price catalog live: models.dev fetched and cached, 233 keyed models, sample slugs resolved as expected.

## Security
- The token is read only at runtime from `cursorAuth/accessToken` through a node:sqlite backup into an mkdtemp dir, which is removed in `acquireUseRelease`. The token is never written to disk.
- It is sent only as a cookie to `https://cursor.com`; the client enforces an https + host allowlist (cursor.com, www.cursor.com, api2.cursor.sh).
- Errors pass through `redact()` (raw and URL-encoded token). Tests assert that the token never appears in events, coverage, the state file or errors.
- Only usage rows and a timestamp cursor are stored. `DFT_CURSOR_USAGE=off` disables the collector. With no session it reports `unavailable: not logged in`, and HTTP 401/403 maps to the same message.
- Endpoints used: only read-only query endpoints. No settings were mutated.

## For the integrator
- Wire `defaultPriceProvider()` and `expandForModels()` where `defaultCostOptions()` is built (apps/cli, P1-WIRE). The registry `costMetric` is static and synchronous, so the provider is not wired there.
- Reports: with `--all-repos` or a `dft usage` view, show the account-level (empty-context) usage rows that were not joined.
