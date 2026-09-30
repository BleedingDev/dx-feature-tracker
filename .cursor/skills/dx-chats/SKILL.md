---
name: dx-chats
description: Show which Cursor chats and subagents worked on a branch, with each chat's cost, tokens, time and the model and reasoning level used per turn. Use when the user asks which chats built a feature, which models were used, why a branch was expensive, or wants to trace work back to a specific chat or subagent.
---

# dx-chats

Answers "which chats and models worked on this branch?" with the local `dft` CLI.

## Run

```sh
dft chats --json [--branch <name>] [--since 7d]
```

- Default is the checked-out branch. Use `--branch` when the user names another one.
- Without `--json` it prints a readable tree, which is fine to show as is in a code block.

## Present

1. One line per chat: title or short id, cost, tokens, agent time, tool calls.
2. Models used, collapsed per chat, for example `grok-4.7 high+fast x12, auto x3`. The reasoning level comes from the model name; say so if the user asks.
3. Subagents indented under their parent chat.
4. If a chat also ran on other branches, say which, and that only this branch's share is counted here.

## Rules

- Never show prompt text; dft does not store it.
- Auto mode shows as Auto; the real model is unknown unless Cursor's usage data names it.
- Subagents inside one Cursor chat report tokens under the parent chat, so their tokens can stay on the parent branch, labelled. Explain this plainly if numbers look shifted.
- Show numbers exactly as given; missing stays missing.
