# P1-PRICES handoff: bundled price table for the estimated ledger (D3)

Status: **ready** (working and tested; not wired into the registry because this task was not allowed to touch it).

## Added (new files only)
- `packages/core/src/dx/metrics/cost/price-tables/cursor-2026-09.ts` exports `cursorPriceTable202609`, with id `cursor`, version `2026-09`, and effectiveFrom `2026-09-01T00:00:00Z`. Its method label is `price-table:cursor@2026-09`. It covers 53 listed models, each stored under its display name (`Claude 4.5 Sonnet`), a slug (`claude-4.5-sonnet`), a `-thinking` slug for Claude models, and the Anthropic-style or reasoning-effort aliases (`claude-sonnet-4-5`, `gpt-5-high`, ...). Rates are USD per million tokens: input, cached-input (cache read), cache-write, output, and reasoning.
- `packages/core/src/dx/metrics/cost/price-tables/defaults.ts` exports:
  - `defaultPriceTables()`, which returns `[cursorPriceTable202609]`.
  - `userPricesPath(dftHome)` and `loadUserPriceTable(dftHome)`. The loader is an `Effect<UserPriceTableLoad, never, FileSystem>` that reads `<dftHome>/prices.json`, one `PriceTableSchema` JSON object, and returns `absent`, `invalid` (with a reason) or `loaded`. `parseUserPriceTable(path, text)` does the same without IO.
  - `selectPriceTable(load)`, which picks the user table when it loaded, otherwise the bundled one. When the user file was invalid it also returns a `warning` the CLI should print.
  - `defaultCostOptions(load?, subscription?)`, which returns `CostOptions` with the selected table.
- `packages/core/test/dx/p1-prices.test.ts`: 7 tests.

## For the integrator (A02 / registry owner)
Register `makeCostMetric(defaultCostOptions(yield* loadUserPriceTable(dftHome)))` in place of `costMetric`, where `dftHome` is `~/.dft` per D7. Print `selectPriceTable(load).warning` to stderr when it is not null. Now that a table ships, the `no-default-price-table` gap in `costDescriptor` and the reason text "the recorder ships no default prices" in `metric.ts` are stale. B31 owns that file; I did not edit it.

## Honesty choices
- **Auto is not priced.** Cursor bills Auto at the list price of whichever model it routes to, and nothing records that model locally. The live A07 capture (`model: "Auto"`) therefore reports the estimate as unavailable, with reason `method=price-table:cursor@2026-09; ... unpriced readings: model-not-in-table=1`. A test checks this. The same token counts re-labelled as `Claude 4.5 Sonnet` give the labelled estimate $0.133693 (`measurement=estimated`, numerator 1 of denominator 1).
- **Cache-write is null where Cursor lists no rate** (all OpenAI except GPT-5.6, plus Gemini, Grok, Composer, GLM, Kimi and Muse). A reading with more than 0 cache-write tokens on those models goes unpriced (`missing-rate`) rather than being counted at $0.
- **Reasoning rate is 0.** Reasoning tokens are a subset of output tokens (see the cursor-sdk gap `reasoning-subset-of-output` and the codex parser), so output already bills them. A non-zero rate would double count.
- Left out: Gemini 3 Pro Image Preview (image output), Claude 4 Sonnet 1M, Grok 500k and Claude Opus 4.7 fast mode (long-context or fast tiers that the token counts cannot tell apart).
- Not modelled: long-context multipliers (above 200k / 256k / 1M), fast-mode multipliers, the 10% regional or data-residency uplift, and the Teams/Enterprise Cursor Token Rate ($0.25/M on third-party models). The estimate is a list-price estimate, never a charge.
- effectiveFrom `2026-09-01` assumes the prices read on 2026-09-30 held for all of September. Readings before that date go unpriced (`before-effective-date`). GPT-5.6 Sol is at promotional pricing until 2026-11-21, so the next table version must re-check it.
- Alias assumptions: `-thinking` slugs and `gpt-5-high` / `gpt-5.2-high` / `gpt-5.3-codex-high` / `gpt-5-*-fast` take the rates of their base (or Fast) model. Cursor's page names these variants but shows only the base price.

## Sources (read 2026-09-30)
- https://cursor.com/docs/models: the model pricing table (Cursor pool and third-party pool).
- https://cursor.com/docs/account/pricing: Auto has no separate rate, plus the Cursor Token Rate and Max Mode notes.

## Checks (exit 0)
- `pnpm --filter @rat-stack/core exec vitest run test/dx/p1-prices.test.ts test/dx/b31.test.ts`: 13/13 passed.
- `pnpm exec oxlint` and `pnpm exec oxfmt --check` on the 3 files.
- Core `tsc --noEmit`: 0 errors in my files. The package still exits 1 because of other agents' files (`opencode/collector.ts`, `audits/c10.test.ts`).
