---
name: dx-line
description: Give a one-line cost summary of the current branch (billed, estimate, tokens, agent time, chats, commits). Use when the user asks "how much so far", "quick cost", "what did I burn", wants a status line, or before a commit or push to know the cost.
---

# dx-line

Answers "how much has this branch cost so far?" in one line.

## Run

```sh
dft line [--branch <name>]
```

Reply with the line exactly as printed, in a code block. Example shape (numbers made up):

```
feature/checkout  $12.40 billed · $14.02 est · 26.7M tokens · 2h 45m agent · 4 chats · 1 commit
```

- `no AI usage yet` means dft has no AI activity from any tool for this branch yet.
- For every branch at once: `dft history --oneline`.
- For the full report, use `dx-analyze`. For the chats behind it, `dx-chats`.

## Rules

- Billed and estimate are different numbers; never add them.
- Do not reformat or round the numbers.
