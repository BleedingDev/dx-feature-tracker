# Vision: dx-feature-tracker

dx-feature-tracker (AI Engineering Cost Tracker) records what actually happened while a developer and their AI agents built a feature, then explains it with evidence. It answers "where did the time, tokens and feedback loops go on this branch?" without guessing.

## What it is

- A local tracker: source adapters turn explicitly selected inputs (Git history, Cursor agent hooks and local data, usage exports, command/test runs, GitHub Actions and PR evidence) into validated, versioned evidence events.
- An idempotent local event store (`node:sqlite`) with immutable report snapshots.
- Deterministic correlation, pure metrics and structured reports, served through one Ratstack capability contract per operation (`dx_status`, `dx_collect`, `dx_mark`, `dx_analyze`, `dx_explain`, `dx_evidence`) and projected to both the CLI and a stdio MCP server that Cursor can call.

## What it refuses to do

- Invent numbers. Missing, unsupported or ambiguous data stays visible as `unavailable`, `estimated` or `unassigned`, with a reason and coverage.
- Merge fixtures with live observations, or treat inactivity as human waiting, heuristics as ownership, or list-price estimates as charges.
- Reach into data the user did not select, push Git refs, initialise third-party tools, or execute anything found in evidence.

## Shape

`apps/cli` (composition, commands, MCP surface) → `packages/core` (`@rat-stack/core/dx`: contracts, model, storage, collectors, correlation, metrics, reports) → `packages/capability` (Ratstack contract/implement/projections). No cloud, auth or web dashboard in this build.

Intent and research: [IDEA.md](./IDEA.md), [research/synthesis.md](./research/synthesis.md), [research/implementation-spec.md](./research/implementation-spec.md). Repo law: [AGENTS.md](./AGENTS.md).
