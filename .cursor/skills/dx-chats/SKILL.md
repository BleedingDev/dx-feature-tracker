---
name: dx-chats
description: Show which chats and subagents worked on a branch, from every coding tool (Cursor, Claude Code, Codex, OpenCode, Pi, OMP, DeepSeek Harness), with each chat's tool, cost estimate, the tool's own figure, tokens, time and the model and reasoning level used per turn. Use when the user asks which chats built a feature, which tools or models were used, why a branch was expensive, or wants to trace work back to a specific chat or subagent.
---

# dx-chats

Answers "which chats, tools and models worked on this branch?" with the local `dft` CLI.

## Run

```sh
dft chats [--branch <name> | --all-branches] [--since 7d] [--tool claude-code,codex] [--provider anthropic] [--model <name>]
```

- Default is the checked-out branch. Use `--branch` when the user names another one, `--all-branches` for the whole repo.
- `--tool`, `--provider`, `--via`, `--model` and `--effort` narrow the list the same way they narrow `dft usage`.
- The readable tree is fine to show as is in a code block. `--json` leaves chat titles out; add `--titles` only when the user wants them.

## Present

1. One line per chat: the tool in brackets, then the title or short id.
2. Its money and size: the estimate (tokens x the model maker's public price), the tool's own figure and billed amount when known, tokens, requests and time. These are separate figures; never add them together.
3. Models used, collapsed per chat, for example `claude-sonnet-5 medium x3, claude-haiku-4-5 x1`.
4. Subagents indented under their parent chat, with their agent type.
5. If a chat also ran on other branches, say which, and that only this branch's share is counted here.

## Rules

- Never show prompt text; dft does not store it.
- Cursor's Auto mode shows as Auto; the real model is unknown unless Cursor's usage data names it.
- A subagent stays under its parent chat even when its own tokens were counted on another branch or repo.
- Show numbers exactly as given; missing stays missing.
