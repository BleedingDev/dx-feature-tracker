# P1-CHATS handoff: dx_chats capability

Status: **degraded**. It works and is tested on fixtures, but it is not yet registered in the CLI or MCP and has not run against a live store.

## What exists (new files, `packages/core/src/dx/chats/`)
- `contract.ts`: `dxChatsContract` (`dx_chats`, read-only, idempotent, `QueryFailureSchema`). Input `{branch?, repo?, since?}`. Output `ChatsReportSchema`: a flat `chats[]` list plus `rootSessionIds`. Each node has `childSessionIds` and `parentSessionId`, so the tree needs no recursive schema.
- `capability.ts`: `makeDxChatsCapability({resolveSelector?})` implements the contract through `EventStore.snapshot`. The `branch` input overrides the resolver's branch, which defaults to the current branch. `resolveSince` accepts `7d/12h/30m/2w` or ISO; anything else fails with `InvalidInput`.
- `tree.ts`: `buildChatTree(events, scope)` groups AI events and hook tool events by `identity.sessionId`. For each chat it returns:
  - **sourceIds**: `composerId` (local-db), `conversationId` (hooks) or `sessionId` (cli/transcripts).
  - **title**: `{value, source, exportable:false}`, or null with a reason.
  - **span**, **agentTimeMs**, **requests** and **toolCalls**: each is a value with its source and method, or unavailable with a reason. Precedence is hooks, then cli, then transcripts, then local-db.
  - **tokens** by category and **money** per ledger: these come from B30 `accountAiUsage` over the chat's events. Ledgers are never summed, and the list-price ledger is labelled `estimate`.
  - **modelTimeline**: one entry per turn or request, with `{rawModel, model, effort, effortSource, effortReason, maxMode, scope}`. `scope` is one of `turn`, `request`, `session-setting` or `aggregate`. `models` lists the distinct raw models.
  - AI events that have no session id are counted under `unattributed`.
- `effort.ts`: `parseModelEffort`. The effort comes from a source field (`reasoningEffort` or similar) when there is one; its `effortSource` is `source-field`. Otherwise trailing `-minimal|low|medium|high|xhigh|thinking` model-name suffixes are parsed, with `effortSource` `model-name-suffix` (for example `claude-4.5-opus-high-thinking` gives `high+thinking`). If neither applies, `effortSource` is `unavailable` with a reason. `-max` is not parsed as an effort, because it is part of some model ids. Max mode is a separate `maxMode` field.
- `payload.ts`: Schema-decoded payload field readers. No `typeof` checks and no unknown params.
- `index.ts`: a local barrel. The dx barrel, registry, `capabilities.ts` and the CLI were not touched.

## Collector extraction (cursor-local-db, minimal)
- `schemas.ts` and `map-state.ts` now read `modelConfig.maxMode` into the `ai.session` payload as `maxMode`, and the assistant bubble `modelInfo.modelName` into the `ai.turn` payload as `model`. That gives local-db a per-turn model.

## Where model and effort live today
| Source | Model | Effort |
|---|---|---|
| hooks | per hook event (`payload.model`, per generation) | none; name suffix only |
| local-db | composer `modelConfig.modelName`, bubble `modelInfo.modelName` (new), usage per model (aggregate) | name suffix; `maxMode` (new) |
| cli / transcripts | `payload.model` per request or turn | name suffix only |
| usage-export / dashboard | `payload.model` with `maxMode` | name suffix plus maxMode; rows usually have no session id and are counted as `unattributed` |

## Checks (all exit 0)
- `pnpm --filter @rat-stack/core exec vitest run test/dx/chats.test.ts test/dx/b06.test.ts`: 11 passed. `b30`, `b31` and `a07-live-cursor` also pass.
- `oxlint` and `oxfmt --check` on the 6 chats files, the test, and the 2 local-db files: clean.
- core `tsc --noEmit -p tsconfig.json`: 0 errors.

## Gaps
- **Chat title conflicts with a B06 test.** D6 allows a local title, but the B06 test treats the composer `name` as a prompt canary (`B06_SECRET_PROMPT_CANARY`). I tried extracting the title and reverted it, so every title is currently unavailable with a reason. The chats tree already renders `payload.title` from any source. Enabling it needs a product/B06 decision that stores `name` locally as `title` with `titleExportable:false`, plus an update to the B06 test.
- Local-db marks subagents only with `isSubagent` and does not name the parent, so such a chat is reported with `parentUnavailableReason`. The parent link currently comes only from transcripts (`parentSessionId`).
- No local source reports a reasoning effort as a field. Effort is inferred from model-name suffixes (labelled as such) or is unavailable.
- **Integration (A02/G01):** add `makeDxChatsCapability({resolveSelector: gitSelectorResolver(repo)})` to `makeDxCapabilities`, and add `CapabilityNames` and the `dft chats` verb. The contract digest will change.
- There is no price-table estimate per chat until B31 `makeCostMetric` is wired in. Money currently shows only the ledgers the sources report.
