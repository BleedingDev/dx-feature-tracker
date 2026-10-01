---
name: dx-history
description: List the AI cost of every branch or feature the user worked on (billed cost, estimate, tokens, agent time, chats, commits, status, worktree), in this repo or across all repos, optionally for a time window. Use when the user asks what they spent across branches, which feature cost the most, what they worked on this week, or wants an overview of all features rather than one branch.
---

# dx-history

Answers "what did all my branches cost?" with the local `dft` CLI.

## Run

```sh
dft history --json [--since 7d] [--all-repos]
```

- Default scope is the current repo. Add `--all-repos` when the user asks about everything, several projects, or "all my work".
- Map time words to `--since`: "today" `24h`, "this week" `7d`, "this month" `30d`, a date like `2026-09-01`.
- `dft` first imports new local data (git, hook notes, every tool's session files, Cursor account usage). Add `--no-sync` only if the user asks for what is already stored.
- For a quick glance instead of JSON: `dft history --oneline`.
- If `dft` is not on PATH, tell the user to install it: `npm i -g https://github.com/BleedingDev/dx-feature-tracker/releases/latest/download/dx-feature-tracker.tgz`, then `dft install` in the repo.

## Present

1. A short table, newest activity first: branch, status, last active, agent time, tokens, billed, estimate, chats, commits. Add the repo column when `--all-repos` was used and the worktree when a branch lives in a linked worktree.
2. One sentence naming the most expensive branch in the window, using the numbers exactly as given.
3. If there is a "Not linked to a branch" row, mention it in one line: spend dft could not tie to a branch.

## Rules

- Billed, the tool's figure and the estimate are different things. Show them separately, never add them up.
- Show numbers exactly as `dft` returns them. Do not recompute or convert.
- A missing value stays missing. Never fill it in.
- For one branch in depth, use the `dx-analyze` skill. For its chats, use `dx-chats`.
