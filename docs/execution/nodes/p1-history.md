# P1-HISTORY handoff: `dx_history` capability

Status: **ready, not wired**. The contract, handler and tests are done. Registry, `capabilities.ts`, `index.ts` and `apps/cli` were not touched; the Wire agent owns them.

## Files (all new)
- `packages/core/src/dx/history/contract.ts`: `dxHistoryContract` (`dx_history`, read-only, idempotent, failure `QueryFailureSchema`), `DxHistoryInput` `{since?, allRepos?, repo?}`, `DxHistoryOutput`, `FlightHistoryRowSchema`, `HISTORY_CONTRACT_VERSION = "dx.history.v1"`. It sits beside the frozen `dx.contracts.v1` and does not change it.
- `packages/core/src/dx/history/compute.ts`: pure `computeHistory(snapshot, options)`, `parseSince` (`7d`/`24h`/`30m`/`2w` or ISO), `unknownStatus`, `isoOf`.
- `packages/core/src/dx/history/git-status.ts`: `gitBranchStatus(repoCommonDir, branch)` reads local refs only.
- `packages/core/src/dx/history/capability.ts`: `makeDxHistoryCapability({defaultRepo, costOptions?, resolveContext?, resolveStatus?})`. It needs `EventStore`.
- `packages/core/test/dx/history.test.ts`: 6 tests, with inline fixtures labelled `origin: "fixture"`.

## Behaviour
- It takes one store snapshot (repo-scoped, or unscoped when `allRepos` is set), groups events by `repoCommonDir`, and splits each repo into branches with the ai-usage `assignedBranches`. That is the same attribution `costByBranch` and `accountAiUsageByBranch` use.
- Each (repo, branch) flight gets one row. Everything is computed by the existing metrics: `computeAiUsage` gives requests and tokens by category, `costByBranch` gives the money ledgers, `computeFlightTime` gives branch age, agent time and active time, and `computeGitChurn` gives commits. The history code does no arithmetic of its own.
- Each money ledger is its own field, never summed: `billed` (`dx.cost.charge.usd`), `metered`, `estimatedSource` and `estimatedPriceTable`. The two estimates carry method `estimated`.
- `chats` counts distinct `identity.sessionId` on `ai.*` events. It is unavailable, with a reason, when there are no AI events or no session ids, and partial when some events have no session id.
- `status` values:
  - `deleted`: the flight has no `refs/heads/<branch>`.
  - `merged`: the branch tip is reachable from the default branch.
  - `open`: the branch is not merged, its tip equals the default branch's tip, or it is the default branch itself.
  - `unknown`: the flight has no branch or no repo, or the repo cannot be read.
  Every status carries a reason. Squash and rebase merges show as `open`, and the reason says so.
- Evidence with no repo, such as usage-CSV charges, appears only with `allRepos`, as a (null repo, null branch) row. A note says this.
- `since` keeps a flight when its last `occurredAt` falls on or after the cutoff. Metrics still use the flight's whole history, so branch age stays correct.
- Every measure is either a value, or null with a reason. The test checks this on every row.

## Checks (14:52 CEST)
- `pnpm --filter @rat-stack/core exec vitest run test/dx/history.test.ts`: 6 passed. The git-status test builds a scratch repo that it owns and removes.
- `pnpm exec oxlint <5 files>`: exit 0. `pnpm exec oxfmt --check <5 files>`: clean.
- Core `tsc --noEmit`: 0 errors in history files. The one remaining error is in `test/dx/chats.test.ts:34`, which another agent owns.

## For the Wire agent
- Add `makeDxHistoryCapability({ defaultRepo, costOptions })` to the capability list. Pass the same `CostOptions` (price table) that `makeCostMetric` uses; without them the price-table estimate is unavailable and a note says why.
- CLI: `dft history [--since 7d] [--all-repos] [--repo <path>] [--json]`. Run the D1 incremental sync before calling it, unless `--no-sync` is given.

## Gaps
- In the fixture, `dx.ai-usage.tokens.input` and `output` for `feat/a` come back unavailable ("no selected source reported input tokens"): a keyed cursor-cli row sits next to unkeyed local-db and claude rows in the same sessions. History passes the metric's result through unchanged, and the test checks it matches `computeAiUsage`. B30 should confirm whether that is intended.
- Model and reasoning level per request (D6) are not in the rows yet. `dft chats` or a later field could add them.
- Status is read from local git only; there is no PR or remote merge knowledge.
