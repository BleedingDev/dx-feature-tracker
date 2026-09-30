> Historical first-pass report. Product recommendations and access conclusions are superseded by [the revised synthesis](../../synthesis.md) and the reports/revision/ evidence. DX Flight Recorder is standalone or two-person/24-hour plan applies. Original source evidence remains below.

# DX flight recorder ecosystem and measurement research

Date: 2026-09-30. Scope: commercial analogues, productivity frameworks, attribution and adoption. Confidence: high for documented capabilities, medium for comparison and design inference. No installations, account trials, or product benchmark were performed. This report is a broad decision-oriented comparison, not an exhaustive inventory of every DX tool.

## Decision

Proceed with a developer-owned branch recorder if the demo proves an evidence-backed learning loop through Biomem. Do not pitch conversational engineering analytics, AI survival tracking, or MCP access as inventions. Established tools already provide closely related capabilities. The defensible hackathon distinction is a small local setup that explains one developer's actual branch, preserves the useful lesson, and recalls it before the next similar failure. This positioning is an inference, not a verified market gap.

## Strong analogues and what to borrow

| Family / product | Verified overlap | UX and inspiration | Applicability limit |
|---|---|---|---|
| DX | File-change observability classifies human typing versus AI batch writes and links attribution to commit, user, repository and branch. Its current reports also analyze agent-session friction and linked output. [Implementation](https://getdx.com/blog/how-to-implement-ai-measurement-framework/), [AI effectiveness](https://docs.getdx.com/reports/ai-effectiveness/) | Borrow explicit data requirements, missing-data states, session evidence, and separate adoption/impact/cost. | A vendor's attribution claim is not independent accuracy validation. This is the strongest direct commercial overlap. |
| LinearB | MCP provides natural-language questions over engineering metrics and bottlenecks. Its 2025 launch combines AI insights, surveys, Git metrics and automations. [MCP](https://linearb.io/platform/mcp-server), [Launch](https://linearb.io/blog/introducing-the-next-chapter-AI-productivity) | Borrow reports that connect findings to a concrete workflow change. The documented framing emphasizes organizational decisions and team trends. | Chat-in-editor access alone is already available. The launch's Git integration detects AI activity; it does not establish exhaustive provenance for every local generated line. |
| Swarmia | AI impact compares tool use against PR metrics. Custom integrations support Git identities and daily per-user API records including cost, model and token fields. Swarmia also offers AI/MCP. [Custom tools](https://www.swarmia.com/changelog/2026-08-19-custom-ai-tools/), [Impact](https://www.swarmia.com/product/ai-impact/), [AI](https://www.swarmia.com/product/swarmia-ai/) | Borrow confidence-qualified attribution and distinguish local changes, cloud agents and review agents. [Review agents](https://www.swarmia.com/changelog/2026-05-29-ai-review-agent-metrics/) | Daily aggregate data cannot by itself recover exact branch-level costs. Bot identity covers only identifiable bot work. |
| Jellyfish | AI Impact associates AI usage cohorts with delivery metrics. Its 2025 analysis includes 2,160,981 merged PRs across 259 companies and 21,209 engineers, limited to Copilot. [Study](https://jellyfish.co/blog/ai-impact-data-june-2025/) | Borrow clear cohort and time-window definitions. | PRs are tagged by author usage frequency, not proof that each PR or line used AI. Its first/last-commit intervals are elapsed proxies. |
| GitClear | Commit Cruncher follows lines through edits, moves and find/replace. Current charts segment by LLM fingerprints and report short-term churn and throwaway rates. [Methodology](https://gitkraken.gitclear.com/industry_stats/ai_code_quality_signal_graphs) | Borrow a defined survival window and move-aware lineage. | Fingerprint heuristics can miss or misattribute authorship; human-or-unattributed is not confirmed human. Churn is a rework proxy, not a defect diagnosis. |
| WakaTime | IDE heartbeats track coding activity. Current FAQ includes AI token/model API-price estimates, explicitly distinguished from subscription bills. [FAQ](https://wakatime.com/faq), [API](https://wakatime.com/developers) | Borrow personal opt-in, export, privacy controls, heartbeat categories and price-version tracking. | Duration depends on heartbeat timeout. Editor activity does not measure total effort or business value. Existing AI cost/activity makes the personal analytics space crowded too. |
| Qodo / AI review agents | Qodo's Findings Page aggregates critical findings, resolution percentage and findings per PR, with repository/owner/type filters and PR drilldown. [Findings](https://www.qodo.ai/blog/introducing-findings-page/) | Borrow links from a repeated issue to original review evidence. Treat review agents as event sources. | Finding counts and resolution rates are not equivalent to true defects prevented. Building another reviewer would dilute this MVP. |

CodeRabbit is a relevant review-event source, but detailed current API/analytics capability was not verified in this pass. Do not claim an integration until the available API and permissions are checked. Qodo's documented findings are sufficient precedent for the review-event family.

## Research frameworks constrain the report

[SPACE](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/) argues that productivity cannot be measured by activity or one dimension alone. Its five dimensions are satisfaction/well-being, performance, activity, communication/collaboration, and efficiency/flow. The original publication explains that individual metrics miss collaboration and invisible work. Use tokens, commits and elapsed intervals as diagnostic facts, never as a developer productivity score. A developer should be able to use their own data to improve their day.

[DevEx](https://www.michaelagreiler.com/wp-content/uploads/2024/06/DevEx-WhatDrivesProductivity.pdf) identifies feedback loops, cognitive load and flow state. It recommends pairing system telemetry with developer feedback. CI and review timelines measure parts of feedback loops. They cannot reveal cognitive load or felt interruption on their own. A small optional debrief question such as "Were you blocked by this CI run, or working on something else?" can complement instrumentation without inventing a psychological score.

[DORA's current official guide](https://dora.dev/guides/dora-metrics/) describes five software delivery metrics: change lead time, deployment frequency, failed deployment recovery time, change fail rate, and deployment rework rate. They apply to an application/service and its production delivery. A failed CI run is not a failed production deployment. Branch lifetime is not DORA change lead time. Avoid historical four-key claims in current documentation and keep hackathon friction metrics separate from deployment metrics.

DX's [Agent Experience Score](https://docs.getdx.com/reports/agent-experience-score/) uses a separate model to rate captured sessions on requirements, steering and scope. DX explicitly limits it to interaction quality, not code quality, employee ranking, satisfaction or ROI. This is precedent for post-session assessment, but deterministic facts should remain the source of numeric report values. Generated explanations should cite event IDs and allow inspection.

## Contradictory AI impact evidence

| Evidence | What it establishes | What it cannot establish |
|---|---|---|
| [METR early-2025 RCT](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) | 16 experienced developers completed 246 real tasks in familiar mature repositories. Allowing early-2025 tools increased completion time by 19%; participants believed they were faster. | It does not show that AI slows all developers, newer tools, unfamiliar projects or greenfield tasks. |
| [METR February 2026 update](https://metr.org/blog/2026-02-24-uplift-update/) | The later experiment has 57 developers and 800+ tasks. Raw estimates suggest speedup, but METR calls the signal unreliable because of developer/task selection and concurrent-agent time measurement. | Its estimates are not a reliable universal current speedup. The two confidence intervals reported cross zero. |
| [METR May 2026 survey](https://metr.org/blog/2026-05-11-ai-usage-survey/) | 349 technical workers self-report median value uplift of 1.4–2x and speed uplift of 3x. METR distinguishes value from speed and cautions that perceptions can be wrong. | Survey answers do not establish causal uplift or justify a numerical savings promise in a one-branch demo. |
| Jellyfish 2025 observational study, linked above | Higher author AI-use cohorts had shorter average PR intervals in that dataset. | Cohort association does not isolate AI's effect; code mix, selection, PR batching and skill can differ. Bug-issue proportions are a narrow quality proxy. |

These studies measure different populations, tools, outcomes and periods. Do not average their percentages. The product should help investigate a specific workflow, rather than claim to settle universal AI productivity.

## Attribution and retention options

DX's public [data schema](https://app.getdx.com/datacloud/schema) separates original AI lines, modified AI lines, remaining lines including modifications, unchanged lines and deleted lines before commit. It also links commit files to contributing sessions. Borrow the distinction and the many-to-many session relation, not any asserted proprietary detection accuracy.

| Method | What can be claimed | Cost and failure mode | Hackathon verdict |
|---|---|---|---|
| Manual AI-assisted flight or PR label | The developer declares that AI assisted this work. | Low cost; inconsistent memory, no line retention. LinearB documents manual labels and gitStream automation. [Labels](https://linearb.io/blog/AI-metrics-how-to-measure-gen-ai-code) | Valid fallback. Never display line survival from it. |
| Co-author or bot identity | A commit/review contains a known AI identity. | Low cost; rewritten history, omitted trailers and mixed human edits. Swarmia uses contributor linking. | Useful evidence, incomplete coverage. |
| Pre/post snapshots around observed agent edits | A recorded agent event introduced these candidate lines; later snapshots show exact survivors. | Moderate cost; concurrent edits, formatter output, moves and repeated snippets confuse mapping. | Best ambitious demo option if collector events exist. Restrict scope and show confidence. |
| Filesystem burst heuristics | A detector estimates authorship from edit patterns. | Needs validation against ground truth; paste, code generators and formatters resemble AI writes. | Avoid implementing a claimed universal detector during the hackathon. |
| Commit fingerprint heuristics | A model/tool fingerprint appears in commit metadata. | GitClear explicitly uses fingerprinting and an unattributed baseline. | Diagnostic tag only. |
| Longitudinal line/AST lineage | Known AI additions survive to merge or a defined later date. | Highest complexity, especially rebase/squash, rename and semantic rewrites. | Later work; AST survival is distinct from exact textual survival. |

Recommended MVP definitions are design inferences:

- `unchanged_retention = unchanged_recorded_AI_added_lines_at_checkpoint / recorded_AI_added_lines`. Checkpoint must be explicit, such as current HEAD or merge commit.
- `modified_retention` requires a separately documented matching algorithm. Do not silently count rewritten text as unchanged.
- Unknown edits remain unknown; never classify them as human by default.
- Deleted code can be a successful simplification. Survival says nothing about correctness, security or value.
- Show coverage, such as observed sessions versus known sessions, before a percentage. If lineage is absent, show "AI retention unavailable".
- The proposed 31% rewritten and 72% retained can coexist only if their denominators/states differ. Explain those states or replace them with mutually exclusive unchanged/modified/deleted totals.

## Honest time and cost semantics

These are proposed product semantics, based on the measurement limits above, not universal research standards.

1. Display "Recorded flight span" between explicit start/end observations. State that pre-recorder work may be missing. Branch creation is not globally stored as a reliable timestamp.
2. Display "CI feedback pending" as the union of correlated run intervals, plus queue and execution subintervals. Do not sum overlapping jobs into personal wait time.
3. Use "confirmed blocked time" only with a developer marker or other explicit evidence of blocking. Someone can implement another task while CI runs.
4. Separate measured provider charges, model API-price estimates, subscription allocation and unavailable cost. A token count without model/cache/input/output categories does not establish $7.84.
5. Say "Try running the failing integration test locally" when failures support it. State "potential reduction in CI feedback latency" as a hypothesis. Do not promise 20 minutes saved per feature without a measured intervention and repeated comparable work.
6. A flight is an event graph with intervals, not a single rigid sequence. Human edits and multiple agents/CI workflows may overlap.

## Biomem differentiation and distribution hypotheses

The Biomem API, memory behavior and public product claims are outside this report's verified scope. The parent research must confirm the integration before making them demo requirements.

| Proposed tactic | Why it may help | Hackathon implementation / success test |
|---|---|---|
| Preserve an evidence-linked lesson after a flight | Makes memory relevant to development friction instead of branding an analytics report. | Store a structured lesson with repository, failure signature, remedy, evidence references and timestamp. In a second fixture flight, retrieve the lesson and link the original evidence. |
| Recall a prior remedy before another CI attempt | Demonstrates a useful cross-session behavior. | A deterministic trigger looks up the prior failure signature and offers a local test command. User confirms whether the advice helped. |
| One-command local onboarding plus Cursor commands | Reduces the effort before first value for an individual developer. | Target less than five minutes to a real report, with explicit permissions and a fixture route if credentials are absent. This target is a product choice, not measured demand. |
| Shareable sanitized flight report | Gives other developers an understandable artifact they can try. | Export Markdown with Biomem link and reproduction/install instructions. Strip prompts, absolute paths, secrets and private repository details by default. Require explicit publishing intent. |
| Small open-source connector or schema | Lets users inspect collected fields and contributors add another host. | Publish schema, collector and sample fixture under a chosen license after review. Evaluate first-run completion and repeat use, not star counts as product success. |
| Hackathon demo as an evidence case study | A real failure and improvement are more credible than invented counters. | Record two runs, explain the actual failure, recall the remedy, and show measured feedback intervals. Label any simulated data in the report. |

Avoid individual rankings, a universal AI score, enterprise admin integrations as mandatory onboarding, and building a dashboard before the in-Cursor evidence flow works. These are scope recommendations, not claims that all competitors have those defects.

## Evidence versus inference verdicts

| Finding | Verdict | Reason |
|---|---|---|
| Existing commercial tools combine AI and SDLC metrics | SUPPORTED | DX, LinearB, Swarmia and Jellyfish primary pages. |
| MCP/conversation is a unique distribution channel | CONTESTED | LinearB MCP and Swarmia AI/MCP are documented. |
| Exact AI authorship and retention can be reconstructed from Git alone | WEAK | Git identity/labels are incomplete; real provenance needs collection or heuristics. |
| Token volume measures productivity | CONTESTED | SPACE and value/speed distinction require broader outcome evidence. |
| CI pending duration equals developer time lost | INCONCLUSIVE without blocking evidence | It measures system latency; concurrent work can occur. |
| A memory-based prevention demo will attract Biomem users | INCONCLUSIVE | A reasonable differentiator hypothesis; requires onboarding and repeat-use observation. |
| One branch can prove causal AI savings | WEAK | No valid counterfactual or sufficient comparison design. |

## Coverage and gaps

This pass fetched full substantive primary pages for DX, LinearB, Swarmia, Jellyfish, GitClear, WakaTime, DORA, METR, Qodo and the author-hosted DevEx paper. Search covered multiple product/measurement angles. Some direct URL fetches failed; opening indexed result references resolved key pages. SPACE's publisher full text was unavailable via fetch, so its original-author publication summary supports the central claim; the indexed publisher text supplied dimension details. No vendor detector was tested. No price comparison or market-size estimate was made. Still needed before implementation: Cursor collector capability, exact GitHub event joins, Biomem memory contract, privacy defaults, and a measured fixture with overlap/unknown-attribution cases.
