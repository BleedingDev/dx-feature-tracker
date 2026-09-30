> Historical first-pass report. Product recommendations and access conclusions are superseded by [the revised synthesis](../../synthesis.md) and the reports/revision/ evidence. DX Flight Recorder is standalone or two-person/24-hour plan applies. Original source evidence remains below.

# OSS comparables for Biomem DX Flight Recorder

Research date: 2026-09-30. Confidence: high for the explicitly documented capabilities and API snapshots; medium for integration-effort estimates; no installed integrations were exercised. Scope: five deep comparables, plus transport and CI context. This is an evidence-backed family survey, not an exhaustive list of every repository.

## Decision summary

Git AI and Entire already cover much of the proposed recording layer. Biomem should consume compatible evidence where practical and make its differentiator the memory of recurring friction, evidence-linked explanations, and follow-up on interventions across flights. Git AI's current reference documentation contradicts a tempting retention interpretation: `ai_accepted` currently equals `ai_additions`, so their ratio does not measure generated-code survival.

Keep the hackathon dependency surface small: SQLite event storage, Cursor hooks, Git/GitHub ingestion, optional Git AI JSON adapter, and Biomem memory. Langfuse is useful architecture inspiration and an optional export target; deploying its complete platform is a substantial distraction for a Cursor-first demo. ccusage is a potential future CLI-agent adapter, not an established Cursor usage collector.

## Repository identity, license and activity

These values came from the GitHub API on the research date. `pushed_at` is repository activity across branches, not proof that a capability was released; default-branch commit time and release time are recorded separately. API open-issue counters include pull requests and should not be presented as unresolved bug counts. Stars and contributor pagination were deliberately excluded from recommendations.

| Repository | Main implementation | License verified from text | Created | Latest default-branch commit observed | Latest release observed |
|---|---|---|---|---|---|
| [git-ai-project/git-ai](https://github.com/git-ai-project/git-ai) | Rust | [Apache-2.0](https://github.com/git-ai-project/git-ai/blob/main/LICENSE) | 2025-07-02 16:09:26 UTC | [0670e7e](https://github.com/git-ai-project/git-ai/commit/0670e7ef27590af0e8ff5409267f3f4b09b8fcb4), 2026-09-09 20:33:27 UTC | v1.7.5, 2026-09-09 20:30:05 UTC |
| [entireio/cli](https://github.com/entireio/cli) | Go | [MIT](https://github.com/entireio/cli/blob/main/LICENSE) | 2026-01-02 17:13:58 UTC | [bc287bb](https://github.com/entireio/cli/commit/bc287bbc6635960275ab04a7bafb3265da576956), 2026-09-29 15:42:49 UTC | v0.11.4-nightly.202609290627.187338d9d, 2026-09-29 06:36:06 UTC; nightly, not stable |
| [ccusage/ccusage](https://github.com/ccusage/ccusage) | Rust core plus TS packaging/docs | [MIT](https://github.com/ccusage/ccusage/blob/main/LICENSE) | 2025-05-29 16:56:50 UTC | [ca95b1d](https://github.com/ccusage/ccusage/commit/ca95b1dac558c4cfe78303d01981f35a7edd7611), 2026-09-30 00:49:44 UTC | v20.0.26, 2026-09-27 16:26:00 UTC |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | TypeScript | [MIT outside explicitly excluded enterprise directories; those have separate terms](https://github.com/langfuse/langfuse/blob/main/LICENSE) | 2023-05-18 17:47:09 UTC | [09a1b84](https://github.com/langfuse/langfuse/commit/09a1b8484b66c4c4cbaf4ba972fc11bd699d4784), 2026-09-29 22:32:57 UTC | v4.47.0, 2026-09-29 08:25:01 UTC |
| [trunk-io/analytics-cli](https://github.com/trunk-io/analytics-cli) | Rust | [MIT](https://github.com/trunk-io/analytics-cli/blob/main/LICENSE); inspect component licenses if reusing individual crates | 2024-01-17 13:50:10 UTC | [209c229](https://github.com/trunk-io/analytics-cli/commit/209c2291a7f1125a17bc7bc063065a448d9b19ff), 2026-09-28 19:49:46 UTC | 0.16.0, 2026-09-29 20:55:58 UTC |

The legacy `ryoppippi/ccusage` API request redirected to `ccusage/ccusage`. GitHub returns `NOASSERTION` for ccusage and Langfuse because license identification is imperfect; license files, not the API classification, determined the table. License observations are not legal advice or permission to omit attribution notices.

## 1. Git AI: strongest attribution precedent, and a direct competitive overlap

The [README](https://github.com/git-ai-project/git-ai) describes explicit agent checkpoints, line-level authorship attached to commits, and a Teams product joining spend, PRs, rework and downstream incidents. It supports Cursor and worktrees. It explicitly lists `git mv`, bulk history rewrites and object replacements as unsupported. SCM-side squash/rebase merges need extra CI integration or Teams. These are documented vendor capabilities, not independent accuracy benchmarks.

The [authorship standard](https://github.com/git-ai-project/git-ai/blob/main/specs/git_ai_standard_v3.0.0.md) uses `refs/notes/ai`, commit-scoped line maps, and versioned JSON metadata. Known human edits and untracked/unknown edits are separate categories. Rebase, squash, stash and amend need attribution remapping; blindly equating a commit SHA or branch name with a permanent flight identity loses evidence. The standard is a reusable interoperability pattern, but writing an independent complete implementation is too much for a hackathon.

Crucial qualification: the [current stats reference](https://usegitai.com/docs/get-started/commit-stats) exposes `human_additions`, `unknown_additions`, `ai_additions`, `ai_accepted`, diff counts and model breakdown. It states `ai_accepted` currently equals `ai_additions`. These are committed authorship counts, not the denominator of everything the model generated. PR cost and prompt analysis require additional telemetry and server-side computation. Therefore `ai_accepted / ai_additions` would produce a misleading 100% retention, and this command alone cannot substantiate “31% of generated code was rewritten.”

Recent edge-case evidence: [open PR #2390](https://github.com/git-ai-project/git-ai/pull/2390), created 2026-09-29, addresses attribution lost when GitLab performs server-side rebases; its history also discusses forks and pagination. This is evidence of an unresolved integration surface, not a released guarantee. Transfer the design lesson: preserve old-to-new commit relationships, mark missing provenance, and make backfills idempotent.

**Hackathon choice, inference:** optional subprocess adapter `git ai stats <base>..<head> --json`, pinned and schema-checked, to show “AI-attributed committed lines.” Do not build a Rust dependency into the Node app or promise true survival until checkpoint denominators and end-state mapping have been validated. Missing notes should yield “unknown,” never “human.” Use the feature as compatible provenance rather than claiming invention of AI attribution.

## 2. Entire: sessions and checkpoints as a commit-linked recording layer

The [README](https://github.com/entireio/cli) explicitly supports Cursor IDE and Agent CLI alongside other agents. It captures session context and creates checkpoints when a code commit is made; current checkpoint IDs are ULIDs, and older identifiers remain readable. A commit trailer links the code to the checkpoint. Agents retain their native session IDs. New repositories use independent refs, while older repositories can use a shared checkpoint branch. Importantly, this project already frames itself as searchable history of how code was written, so a generic recorder pitch is not unique.

The [security document](https://github.com/entireio/cli/blob/main/docs/security-and-privacy.md) explains that transcript refs live in the repository and can be fetched by others with repository access. Public repositories can expose prompts, tool results and MCP contents. Local shadow branches can contain raw source snapshots. Redaction is best-effort and text-oriented; refs outside normal branch listings are not a privacy boundary.

**Hackathon choice, inference:** learn the checkpoint/session/commit separation and preserve an external `session_id` plus recorder-owned `flight_id`. An optional Entire importer is plausible if the team already uses it, but implementing a robust multi-backend parser is not necessary for the first demo. Never silently enable it, change hooks, or publish transcripts to make the DX report work. Biomem should receive compact redacted observations and selected lessons, not an unrestricted copy of entire conversations.

**Uncertainty:** generic README claims of token capture do not prove complete billable Cursor token/cost availability for every Cursor version, model and subscription. Inspect one real Cursor checkpoint before treating Entire as a usage source. Entire is also a functional substitute for substantial parts of the timeline layer, not merely an SDK to embed.

## 3. ccusage: adapters, cache-aware pricing and the limits of aggregates

The [README](https://github.com/ccusage/ccusage) lists local usage parsers for multiple coding CLIs, JSON reports, model breakdowns, separate cache token accounting, offline pricing and overrides. Cursor IDE is not in the supported-source list. Daily/monthly/session JSON reports are attractive for a later adapter, but project/session aggregation does not establish branch-level allocation when one session changes branches.

A precise blocker appears in [issue #1811](https://github.com/ccusage/ccusage/issues/1811), created 2026-09-28 and closed with maintenance-scope labels: a downstream author requested normalized deduplicated timestamped Codex token events because existing aggregate JSON loses event timestamps. The issue describes replay and repeated token-count records as sources of severe overcounting; closure does not prove the requested event API exists. Thus piping an aggregate session cost into every flight containing that session duplicates spend.

The observed [pricing update commit](https://github.com/ccusage/ccusage/commit/ca95b1dac558c4cfe78303d01981f35a7edd7611) pins a changing LiteLLM snapshot. The transferable pattern is to version pricing evidence and preserve the measurement source separately from a price estimate.

**Hackathon choice, inference:** future external JSON adapter for explicitly supported CLIs. First demo should not depend on ccusage to collect Cursor usage or on a nonexistent event command. Represent cost basis (`provider-reported`, `estimated API-equivalent`, `subscription allocation`, `unknown`) explicitly; input, output, cache read/write and reasoning counters must not be collapsed before price calculation. Unknown cost stays null, never zero.

## 4. Langfuse: mature observability patterns, high deployment cost

[Langfuse's repository](https://github.com/langfuse/langfuse) offers tracing, evaluations and prompt management. Its [usage/cost reference](https://langfuse.com/docs/observability/features/token-and-cost-tracking) accepts separate usage and cost fields, supports provider-reported values and inferred pricing, and states that reasoning-model cost cannot reliably be inferred without actual usage. This provides a strong model for Biomem's metric provenance and nullable data, but an MCP server call does not automatically instrument Cursor's private model requests.

The [checked-in Compose file](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml) contains web/worker, ClickHouse, PostgreSQL, Redis and object storage services. This is materially different from a SQLite local recorder. Hosted export avoids deployment work but adds account/network/data-transfer requirements. The [license](https://github.com/langfuse/langfuse/blob/main/LICENSE) excludes enterprise directories from its MIT grant; do not describe every line in the repository as MIT.

[Issue #18053](https://github.com/langfuse/langfuse/issues/18053), opened 2026-09-29, reports a Codex Stop-hook importer exhausting memory on large JSONL sessions. Its requested remedies include bounded parsing, deterministic turn identifiers, and marking exports complete only after confirmation. The report is a user-reported failure, not a benchmark of all installations.

**Hackathon choice, inference:** copy the data concepts, not platform code: immutable event IDs, source-aware counters, span links, error categories and explicit export state. Stream or cap imports, and isolate hook collection from expensive explanation. Optional OTLP/Langfuse export is a later lane, especially if the team wants a trace UI without maintaining one.

## 5. Trunk Analytics CLI: structured test evidence, not an open analytics backend

The [CLI README](https://github.com/trunk-io/analytics-cli) defines a Rust uploader for Trunk's hosted Flaky Tests product, often invoked through its GitHub Action. Its tree separates CI context, bundling, report formats and API transport. An open MIT uploader is not evidence that Trunk's flake detection engine or platform is self-hostable OSS.

The [official Robot Framework integration](https://github.com/trunk-io/docs/blob/main/flaky-tests/get-started/frameworks/robot-framework.md) shows JUnit XML report generation, local validation and upload. The useful lesson is stable structured artifacts rather than regex over console logs. Its guidance also explains that retries can obscure flakiness. The [Trunk organization description](https://github.com/trunk-io) describes branch-aware analysis: inconsistent outcomes on the same commit are stronger flakiness evidence than failures across changing feature commits. Do not call a test flaky merely because it failed once then passed after a fix.

The [2026-09-25 commit](https://github.com/trunk-io/analytics-cli/commit/7864bdc85cb2793e1ee211f2c2414c209f8cf6ac) adds fork-repository URL to bundle metadata. This concrete history reinforces that repository identity includes fork ownership, not just a branch string.

**Hackathon choice, inference:** GitHub run/job timing first. Optional JUnit importer only after the timeline works, with `(test identity, head SHA, attempt, outcome)` records. Never write quarantine policies or override test exits in an observability MVP. Commercial [BuildPulse](https://github.com/marketplace/buildpulse) is adjacent inspiration for flaky-test impact; its marketplace listing is not an OSS backend or a component to embed.

## Comparative implementation choices

These effort estimates are planning judgment, not vendor claims or measured build times.

| Choice | Benefit | Cost / limitation | Recommended disposition |
|---|---|---|---|
| Own hook + SQLite event ledger | Direct Cursor UX, narrow implementation | Need versioned hook fixtures and coverage labels | Core MVP |
| Git AI subprocess JSON | Existing explicit line provenance | Installer/hook dependency, eventual consistency, denominator caveat | Optional attribution lane |
| Entire checkpoint importer | Rich session and commit linkage | Format/backend drift, raw transcript privacy, cost gaps | Optional if already installed |
| ccusage aggregate JSON | Fast CLI-agent spend reports | No listed Cursor IDE adapter; branch split and timestamp loss | Later, supported agents only |
| Langfuse hosted trace export | Existing trace inspection UI | External service, SDK/export schema and consent | Later optional export |
| Full Langfuse self-host | Mature evaluations and observability | Multi-service operational footprint | Exclude hackathon critical path |
| Trunk uploader/service integration | Reliable test-artifact ingestion | Hosted analysis, not local backend | Inspiration; native JUnit import later |
| Independent full attribution engine | Complete control | Rebase, formatting, rename, staging and merge complexity | Exclude MVP |

## Evidence versus inference and verdicts

| Claim | Verdict | Basis / limit |
|---|---|---|
| Explicit AI provenance can be preserved as Git metadata | SUPPORTED | Git AI standard and reference implementation; tested support scope still matters |
| Git AI alone provides a reliable generation-retention denominator through its current stats JSON | CONTESTED | README breadth versus current stats definition; `ai_accepted == ai_additions` |
| Entire provides a Cursor-compatible session recorder | SUPPORTED | Current official README, not a tested local integration |
| ccusage is a drop-in Cursor cost collector | WEAK | Cursor absent from source list |
| Tokens can be joined to branch with no instrumented timestamps or session branch history | WEAK | Aggregate-only data destroys needed allocation evidence |
| Biomem recurring-friction memory is a promising differentiation | INCONCLUSIVE | Competitive overlap is clear; user demand and Biomem API feasibility need separate validation |
| One failed CI test followed by success proves flakiness | WEAK | Code may have changed; compare identical SHA/identity/attempt context |
| A thin local ledger is less risky for this hackathon than a full observability deployment | INCONCLUSIVE | Smaller operational surface; depends on existing team infrastructure |

## Chronological evidence, not an invented adoption timeline

- 2023-05-18: Langfuse repository created, per GitHub API.
- 2024-01-17: Trunk Analytics CLI repository created, per API.
- 2025-05-29: ccusage repository created; now redirected to the ccusage organization.
- 2025-07-02: Git AI repository created.
- 2026-01-02: Entire CLI repository created.
- 2026-09-09: Git AI v1.7.5 released; default branch observed at later version-bump commit.
- 2026-09-25: Trunk fork URL metadata commit.
- 2026-09-28: ccusage timestamped-event request filed and subsequently closed.
- 2026-09-29: Git AI server-rebase repair PR and Langfuse large-rollout import issue show ongoing edge-case work.

## Methodology and gaps

Executed the requested GitHub skill's `github_api.py summary/readme/tree` directly with `python3` for five repositories; `python` is unavailable. Followed with GitHub REST default-branch commits, issues and license text, broad discovery searches and focused official documentation/specification reads. No clones, installs, code reuse or project mutation. Later API requests hit the unauthenticated rate limit; completed documentation inspection through official/raw pages and retained only activity values already observed. Trunk issues were not obtained before that limit, so no issue-based stability conclusion is claimed for it.

The primary evidence spans the five repository READMEs, five license files, Git AI standard/reference/repair PR, Entire security docs, ccusage downstream API request, Langfuse cost docs/Compose/import issue, and Trunk structured-report docs/metadata commit. Current documentation can change; pin integration versions and run fixture checks before the demo. No retention algorithm, Cursor billing accuracy, flake-detection precision or provider cost calculation was independently benchmarked. Full line-provenance correctness and realistic branch-spanning token allocation remain post-MVP research.
