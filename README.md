# AI Engineering Cost Tracker

AI Engineering Cost Tracker makes AI-assisted software development features measurable.

When an AI coding agent such as Grok or Cursor works on a feature, it can consume thousands or millions of tokens across dozens of requests. Today, it is difficult to answer a simple question:

**How much did this feature actually cost to build with AI?**

This tool connects AI usage with Git branches, commits, code changes, tests, and development activity to provide a complete picture of the cost and efficiency of AI-assisted development.

## Install and use

Requires macOS (Apple Silicon) or Linux (arm64 or x86_64), Node.js 24.18.0 or newer, and Cursor. Older Node versions are refused at install with upgrade steps.

```sh
npm i -g https://github.com/BleedingDev/dx-feature-tracker/releases/latest/download/dx-feature-tracker.tgz
cd your-repo
dft install
dft analyze
```

See the [usage guide](docs/USAGE.md) for every command, what the numbers mean and troubleshooting.

## What it tracks

- **AI cost** — actual API spending
- **Token usage** — input, output, reasoning, and cached tokens
- **Git branches** — track AI usage per feature or branch
- **Tool calls** — understand how the agent spent its time
- **Code changes** — files and lines changed
- **Tests** — test runs, failures, and iterations
- **Rework** — how much code had to be changed again
- **Development time** — measure agent activity over time

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
