# Prices

Every tool gets one estimate (D26, D30, D40): its tokens times the public price of the company that made the model. A gateway (cliproxy, OpenRouter, Copilot) never sets the price; it stays in `ai.via`. Everything lives in `packages/core/src/dx/metrics/cost/price-book/`.

## Three ledgers

| Ledger | Comes from | Example |
| --- | --- | --- |
| Estimate | `PriceBook.estimate(request)` over `ai` and `usage` | tokens x Anthropic's price for `claude-sonnet-5` |
| Tool's figure | `usage.toolFigure` with kind `api-equivalent` or `list-price` | Pi, OMP and OpenCode cost fields, Cursor list price |
| Billed | `usage.toolFigure` with kind `charge` | Cursor usage export |

`PriceBook.ledgers(request)` returns all three side by side; they are never added together.

## What the estimate covers

| Part | Rule |
| --- | --- |
| Fresh input, output | catalog rate; reasoning is inside output and never priced twice |
| Cache read | catalog rate, else input rate (noted) |
| Cache write 5 minutes | catalog rate; Anthropic without a listed rate is 1.25x input |
| Cache write 1 hour | Anthropic 2x input; others use the 5 minute rate |
| Long context | when the prompt (input, cache read and writes) is above a catalog tier, the whole request uses that tier |
| Fast and priority | Claude `speed: fast` (or a `-fast` model suffix) uses the published multiplier per model; Codex `service_tier` priority or fast is 2x, flex and batch 0.5x; an unpublished tier is priced at standard and marked incomplete |
| Claude web search | USD 10 per 1,000 searches (`usage.webSearchRequests`) |
| Copilot premium requests | USD 0.04 each, shown beside the estimate; used as the estimate only when no tokens can be priced |
| Local runtime | `provider: local` or a local `via` (Ollama, LM Studio, ...) costs 0, method `local` |
| Cursor Auto | no fixed model, so Cursor's per-request list price is used (method `cursor-list-price`) |
| Unknown model | `no-price`; tokens stay visible and nothing is guessed |

Model names from every tool go through `aliases.ts`: path prefixes (`factory/`, `cliproxy/antigravity/`, `opencode-go/`), Bedrock and Vertex forms, date and effort suffixes, dotted or reordered Claude names, and a small alias table (`gpt-5-codex` is `gpt-5`; `codex-auto-review`, `auto` and router profile names stay unpriced with a reason). Matching is exact on catalog keys, so `claude-sonnet-5` and `claude-sonnet-5-5` never collapse.

## Where prices come from

`PriceBook.layer` reads the public models.dev catalog (LiteLLM as fallback), caches one snapshot per day under `~/.dft/price-catalog/`, and turns all cached snapshots into date-versioned prices: a request is priced with the snapshot in force at its timestamp. Offline with no cache it uses the bundled snapshot (`bundled-catalog.ts`). `PriceBook.memory(sheets)` is the test layer, and `PriceBook.fromCatalog(deps)` runs the live loader over a given cache folder and fetch.

User-supplied prices (D40, later) plug in through `PriceOverrides`: sheets placed there are consulted before the catalog. No UI exists yet.

The cost metric uses the PriceBook when `CostOptions.priceBook` is set (the CLI passes the loaded book) and labels the estimate `method=price-book:<sheet>@<version>`.
