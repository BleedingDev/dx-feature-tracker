# AI Engineering Cost Tracker

[![dft intro: every branch, what it cost](docs/assets/dft-intro.gif)](https://github.com/BleedingDev/dx-feature-tracker/raw/main/apps/cli/assets/intro/dft-intro.mp4)

AI Engineering Cost Tracker makes AI-assisted software development features measurable.

When an AI coding agent such as Claude Code, Codex or Cursor works on a feature, it can consume thousands or millions of tokens across dozens of requests. Today, it is difficult to answer a simple question:

**How much did this feature actually cost to build with AI?**

This tool connects AI usage with Git branches, commits, code changes, tests, and development activity to provide a complete picture of the cost and efficiency of AI-assisted development.

## Install and use

Requires macOS (Apple Silicon) or Linux (arm64 or x86_64), Node.js 24.18.0 or newer, and at least one supported tool: Cursor, Claude Code, Codex, OpenCode, Pi, OMP or DeepSeek Harness. Older Node versions are refused at install with upgrade steps.

```sh
npm i -g https://github.com/BleedingDev/dx-feature-tracker/releases/latest/download/dx-feature-tracker.tgz
cd your-repo
dft install            # local capture for every tool it finds, never committed
dft analyze            # cost of the current branch
dft usage --by tool    # every tool's tokens and cost, also --by model, branch or day
dft dashboard          # the same as a live page on 127.0.0.1
```

See the [usage guide](docs/USAGE.md) for every command, what the numbers mean and troubleshooting.

## What it tracks

- **AI cost:** an estimate at the model maker's public price, each tool's own cost figure and what you were billed, always shown apart
- **Tools and models:** which tool, model maker, gateway and model did the work, with reasoning level per turn
- **Token usage:** input, output, reasoning, and cached tokens
- **Git branches:** track AI usage per feature or branch, including subagents in other worktrees
- **Tool calls:** understand how the agent spent its time
- **Code changes:** files and lines changed
- **Tests:** test runs, failures, and iterations
- **Rework:** how much code had to be changed again
- **Development time:** measure agent activity over time

## The result

Instead of simply knowing how many tokens an AI agent used, you can understand the true engineering cost of delivering a feature.

**Feature: OAuth Authentication**

| Metric | Value |
| --- | --- |
| AI Cost | $3.82 |
| Tokens | 1.47M |
| Agent Time | 11m 42s |
| Tool Calls | 83 |
| Files Changed | 23 |
| Tests Run | 14 |
| Test Failures | 3 |
| Commits | 8 |
| Rework | 27% |

**$3.82 / shipped feature**

## The vision

AI coding should be treated as an engineering activity, not just an AI interaction.

The goal is to move from:

> How many tokens did the AI use?

to:

> What did it cost to successfully ship this feature?

AI Engineering Cost Tracker provides the observability layer needed to answer that question.
