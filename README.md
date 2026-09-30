# DX Feature Tracker

> Cursor helps developers write code. DX Flight Recorder tells them how their development actually went.

A hackathon project: a flight recorder for developing one feature branch in Cursor. It collects evidence from Git, Cursor AI usage, CI runs and GitHub PRs/reviews, and links them by repository and branch. It then answers one question: **where did the time go?**

- **`/dx analyze`** returns a flight report: duration, AI tokens and cost (when known), how much AI code survived, the biggest source of friction, and one recommendation backed by evidence.
- **`/dx explain`** shows the flight as a timeline, e.g. `branch → AI generation → tests → CI failure → AI fix → PR → review → merge`.

The original pitch is in [IDEA.md](IDEA.md).

## Status

**Planning is done. Implementation hasn't started.** This repo has the research and an executable plan. No product code exists yet, and no phase gate has been run.

## Approach

- A standalone local tool built on **Ratstack** (Effect). Each capability contract has one handler, exposed as both a CLI command and an MCP tool, with a SQLite event store.
- **Cursor is the main interface.** Every presentable phase must be demonstrated in a real Cursor install, not only a mock client.
- No Cursor Enterprise needed. It uses hooks, local Cursor data and transcripts, usage exports, Git, and the GitHub API with a personal token.
- **Honest numbers.** Missing tokens, cost or AI-survival data shows as *unavailable*. CI duration alone doesn't count as developer waiting time. No made-up savings.
- Built in **four hours** by a coordinating agent plus up to 49 parallel agents.

## Phases

Each phase ends with a gate. You can stop at any passed gate and still have something that works and can be presented.

| Phase | What you can show |
|---|---|
| **P0 foundation** | Ratstack boots, contracts are frozen, SQLite and real stdio MCP work. A technical checkpoint only. |
| **P1 v0** | Analyze/explain inside Cursor on real Git data, plus a clearly labelled replay for AI/CI. |
| **P2 v1** *(target)* | A real branch: Git, one validated AI-usage source, and real GitHub Actions/PR evidence. |
| **P3 v2** | Optional extras such as cost, AI survival, local test feedback or a dashboard. Each extra passes its own gate. |
| **P4 release** | A frozen artifact, installer and restart rehearsal, and a claims review. |

At the four-hour mark, present the highest phase that passed.

## Repository layout

```
IDEA.md                       original pitch (Czech)
plans/                        79 executable plan files, one per assignment
  dxfr-rat-a*                   foundation and integration
  dxfr-rat-b*                   modules: collectors, correlation, metrics, reports, CLI/MCP, UI
  dxfr-rat-c*                   verification, installer, demo, release
  dxfr-rat-g*                   phase gates G00–G04
research/
  README.md                     index of the research pack
  show-me-final-plan.md         visual walkthrough of the plan (start here)
  phase-gates.md                stoppable phases and required validation
  hackathon-execution.md        four-hour execution policy and deadline cuts
  implementation-spec.md        build contract
  synthesis.md                  research conclusions
  plan-index.md                 all 79 assignments
  execution-manifest.json       dependency manifest (145 edges)
  dag.mmd                       dependency graph (Mermaid)
  reports/revision/             current research: Cursor local data, usage exports,
                                provenance, GitHub, Ratstack, parallel execution, audit
  reports/first-pass/           earlier research, superseded where it conflicts
  reviews/                      independent plan review and how each point was handled
```

The plans use the `plan-graph` `.plan.md` format (`name`, `overview`, `todos`), so an agent orchestrator can schedule them as a dependency graph.
