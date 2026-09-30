# BRANCH-SWITCH-FIX handoff: one Cursor chat, two branches

Status: **ready**. Checked 2026-09-30.

## Report
A teammate kept one Cursor chat, ran `git checkout -b` to a new branch and kept working. `dft analyze` on the new branch showed the same numbers as the old one.

## Root cause
- `joinAccountRows` gave each account-level row (cursor-usage-api / dashboard, `identity.sessionId` = conversationId) the whole context, branch included, of the **first** local event with that session id.
- In `attributeHistoricalBranches`, the session-id link fallback took the highest-confidence linked event. Every live hook event has confidence 1, so the first one always won.
- Result: an event with no worktree timeline of its own, or with no timestamp, landed on the chat's first branch.

## Fix (rule: a session id gives only repo and worktree; the branch comes from the event's own time)
- `correlation/branch-at-time/snapshot.ts`
  - `joinAccountRows` now gives an account row repo, worktree and flightId from the **nearest-in-time** same-session local event, using `occurredAt ?? observedAt`. It also takes a provisional branch from that event and records `payload.sessionJoin = { attribution: "provisional", method: "nearest-session-event", branchFrom }`.
  - After that, D8 (`branchAt(worktree, occurredAt)`: HEAD reflog, then commit graph, then provisional) replaces the branch whenever the row has a time and a worktree.
  - `joinWithinRepo` drops duplicate eventIds.
- `correlation/branch-at-time/attribute.ts`
  - Request-id and generation-id links work as before.
  - A session-id link now uses the nearest-in-time directly-resolved event of the same conversation (for example a live hook with its own captured branch). It is labelled `provisional` / `request-link` and gives the reason.
  - Untimed events use `observedAt` to find the nearest event.
- These two paths feed analyze/explain (`select.ts`, including a pinned `snapshotId` replay), `dx_history`, `dx_chats` and flight-time, because flight-time runs on the branch-narrowed snapshot. All of them now split a chat at the checkout.
- Chats:
  - `ChatNode.branches` (new, required) lists every branch the chat touched, in first-seen order. It is computed from the repo-wide reattributed events, while the node's totals cover only the selected branch.
  - `buildChatTree` takes an optional third argument, `allBranches`.
- Git metrics (documented, not changed): `dx.git.commits` now says in its definition that `baseSha` is the merge-base with the default branch (origin/HEAD, main or master). A branch created from another feature branch therefore also counts the parent branch's unmerged commits. The `base-sha-definition` gap says that dft does not yet use the reflog `branch: Created from X` parent or the closest ancestor branch as the base. Fixing that needs `git-history` `resolveBase` to prefer the created-from parent, plus a CLI `--base` option; dft has none today.

## Tests
New `packages/core/test/dx/branch-switch.test.ts`:
- Scripted temp git repo with dated reflog: `feature/a`, hooks and dashboard rows for conversation C at t1..t3, `checkout -b feature/b` at t4, rows only at t5..t6.
- Analyze A has hook-1..3 and row-1..3. Analyze B has row-5 and row-6.
- History has rows for both branches, with chats = 1 on each.
- `dx_chats` shows C under both branches, with `branches` [a, b] and only that branch's share: 6 vs 2 events, output tokens 6 vs 11.
- Replay by pinned `snapshotId` matches the live B result (same events and attribution summary).
- Unit tests:
  - Joining uses the nearest event in time.
  - A session link without a worktree goes to the nearest live event, and an untimed row goes to the nearest event by `observedAt` (provisional).
- Checked against the old code: the join test fails there (row lands on `feature/a`).

## Checks (all exit 0)
- Core tsc: 0 errors.
- oxlint and `oxfmt --check` on the 8 touched files.
- Targeted vitest: 8 files, 49 tests (branch-switch, p1-final-wire, branch-at-time, chats, history, flight-time, b26, auto-usage).
- `pnpm check`: exit 0.
- `pnpm test`: exit 0. Core 73 files, 575 passed + 3 expected fail. CLI 25, capability 72, devtools 19.

## Follow-ups
- `apps/cli/src/dft-render.ts` (another agent owns it) does not render `ChatNode.branches` yet. The chat tree should show it, for example `feature/a → feature/b`.
- Stacked-branch commit counting (above).
- `correlation/ai/branch-join.ts` (B26 claims) does not use the first branch either. A conversation that spans more than one branch is left unassigned with the reason `spans branches a,b`, and there is no fallback to `byTimeWindow` for that claim. A possible improvement is to try the time window first for multi-branch conversations. It was not changed here.
