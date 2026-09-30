# Adversarial audit of DX Flight Recorder

Research date: 2026-09-30. Scope: a standalone Ratstack product, a four-hour hackathon, 49 possible workers plus a coordinator. This is a product and execution audit, not a runtime verification. Biomem is optional background context and has no required place in the architecture or demo. No private local data was inspected.

## Verdict

GO for a developer-owned flight evidence recorder with real local capture, GitHub import, explainable arithmetic, and Cursor reports. NO-GO for claims that one flight establishes AI productivity, actual personal time wasted, causal savings, or exhaustive retrospective authorship.

The useful output is an answer to a concrete debugging question: "Which feedback episodes repeated, which evidence connects them to this branch, and what can I test locally before my next push?" A timeline supports this answer. A giant event inventory without an answer is a data export tool.

Do not turn "brutal amount of agents" into 49 independent architectures. Use many adapters, independent fixture authors, independent failure-case reviewers, and bounded module owners against one contract. Concurrency is available. An actual four-hour completion guarantee is not established by this report.

## Evidence versus product inference

| Proposition | Verdict | Evidence | Consequence |
|---|---|---|---|
| Chatting with delivery analytics is new | REJECTED | LinearB publishes an MCP interface for reports, bottlenecks, and recommendations | Do not pitch MCP itself as the invention |
| Joining agent sessions to delivery output is new | REJECTED | DX documents sessions linked to repositories, branches, commits and PRs, plus friction drilldowns | The standalone implementation must win on installation, ownership, access and clarity |
| No Enterprise API means no useful Cursor telemetry | REJECTED | User/project hooks expose edit, tool, shell and session events | Capture locally; admin endpoints are one optional adapter |
| Exact native billing can be guaranteed on every account | UNSUPPORTED | Cursor gates Admin/Analytics/Code Tracking APIs to Enterprise; hook token context is not a billing ledger | Accept consented exports and validated local records; preserve unavailable and unallocated states |
| Surviving generated lines indicate productivity | REJECTED | SPACE describes productivity as multidimensional | Name survival as an observed text/provenance property |
| CI elapsed time proves developer time lost | REJECTED | Workflow/job timestamps describe a system, not the developer's attention | Report feedback latency and explicit blocking separately |
| Ratstack is automatically simple under many agents | CONTESTED | It offers shared capability contracts and removable bins, but uses prerelease dependencies | Pin once, keep a small subset, and forbid per-worker dependency redesign |
| A self-serve per-flight evidence bundle is valuable | PRODUCT HYPOTHESIS | Competitive overlap establishes precedent, not user demand for this exact tool | Test whether one report changes the next action |

Primary sources: [LinearB MCP](https://linearb.io/platform/mcp-server), [DX AI effectiveness](https://docs.getdx.com/reports/ai-effectiveness/), [Cursor hooks](https://cursor.com/docs/hooks), [Cursor API overview](https://cursor.com/docs/api), [SPACE](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/), [GitHub workflow API](https://docs.github.com/en/rest/actions/workflow-runs), [Ratstack](https://ratstack.sh/).

## Differentiation without invented novelty

Current DX documentation already describes agent friction and inspectable session evidence. LinearB already describes conversational delivery analysis. A "flight recorder" metaphor does not create a new technical category. Nor does adding Biomem create required product differentiation.

Choose this narrower proposition: "One install, one branch, inspectable local evidence, no org analytics purchase required." This is a design target, not a verified competitive exclusivity claim. Its non-novel value is saving the developer from correlating chat history, shell failures, CI attempts and reviews manually. Build evidence navigation and trustworthy data coverage into the report because that is what makes the aggregate usable.

Hard demo question: can someone point to a repeated failing test, open the originating local and GitHub evidence, and run the relevant test next time? If the output stops at tokens, LOC and colorful phases, the product has failed this test even if collection works.

## Maximal data collection with bounded conclusions

Investigate every credible route. Require each adapter to state a useful question, record granularity, IDs, timestamps, source version, opt-in level, observed coverage and known gaps. An adapter that adds no new join, metric or evidence link is background research until those benefits become concrete.

| Route | What it can add | Hard limitation | Product choice |
|---|---|---|---|
| Cursor user/project hooks | New-session activity, tool timings, shell outcomes, edits and Tab events on supported builds | Events before install remain absent; hook types and fields depend on runtime | First-class forward capture |
| User-owned Cursor databases/transcripts | Historical sessions, model labels, paths or events if a published schema and version probe support them | Undocumented formats can drift; records may omit tokens, final state or timestamps | Isolated read-only snapshot adapter, opt-in, fixture-tested |
| User-provided account usage/export records | Native recorded usage or charges where present | Account windows may lack branch/session join IDs | Import source totals and branch-unallocated remainder |
| Editor extension/API | Editor change and activity context beyond Agent hooks | Changes alone do not prove human authorship; activity is not attention | Optional bounded adapter |
| Git and worktree snapshots | Commit identity, paths, rebases, branch transitions and changed text | Old commits do not establish first work time or original authorship | Core correlation evidence |
| GitHub Actions and PR/reviews | Attempts, queue/run/job windows, review events and merge | API access and pagination; synthetic merge refs; overwritten mutable run summaries | Core importer preserving attempts and raw evidence IDs |
| Shell/test wrappers and structured reports | Local command elapsed time, exit status, test identity and failures | Unwrapped commands are invisible; terminal text can contain secrets | First-class local feedback evidence |
| Controlled model proxy or SDK | Exact request telemetry for traffic through that collector | Does not observe native Cursor traffic automatically | Optional separately labelled traffic source |
| Explicit developer markers | Confirmed blocked reason or context switch | Friction and recall burden; incomplete self-report | Tiny optional affordance, never compulsory every turn |

Undocumented local access is a reliability issue, not a blanket ban. It must not depend on stealing cookies, dumping credentials, mutating a live database, or pretending unsupported schemas are stable. Source discovery and collection consent must precede reading raw history. This research authorizes published-schema analysis only.

Preserve several axes separately. Origin says captured, imported or synthetic. Acquisition says live hook, snapshot, export or API. Measurement says measured, reconstructed, estimated or unavailable. Attribution says strong join, provisional join or unassigned. One overloaded confidence flag cannot carry these distinctions.

## The exact claims that fail under hostile questioning

1. "Feature took 3h 42m" conflates recorded wall-clock span with active work. Say "Recorded flight span: 3h 42m; start was first observed event" or give the explicit start marker. Offline design and pre-branch work are outside coverage.
2. "41 minutes wasted on CI" requires developer blocking evidence. Two overlapping 25-minute CI runs can produce 50 compute minutes but much less elapsed pending time. Neither equals human time lost. Retain sum of compute, union of pending feedback, and confirmed blocking as different metrics.
3. "4.2M tokens / $7.84" needs category-level source records and billing basis. Cached/context/output token categories differ. Subscription allocation, API list-price estimates and actual charged usage differ. A per-account charge joined by timestamp proximity is still a tentative feature allocation.
4. "31% rewritten" and "72% retained" require the same origin population and checkpoint if presented together. They may overlap if modified lines count as retained, or leave unknown categories. Explicitly define unchanged, modified, removed and unresolved populations rather than imply complementary percentages.
5. "Human rework" cannot be inferred by subtracting AI attribution from final diff. Another AI tool, terminal script, formatter or missing hook can produce those changes. Name unknown authorship.
6. "AI fix caused passing CI" is unsupported by event sequence alone. A run may use a different commit, retries may pass flakily, or configuration may change. Show associated commit and test signature without causal assertion.
7. "Estimated savings: 20 minutes per feature" has no counterfactual from one flight. A defensible finding is "This failure repeated in two CI attempts and matched the local test signature. Try this existing local test before pushing." Record the subsequent result without converting it into general ROI.

[SPACE](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/) is the reason to avoid a single productivity score. [METR's randomized study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) illustrates why felt speed and measured outcomes can diverge. Its early-2025 results are context-specific, not a prediction for this hackathon or current tools.

## An honest demo report

The following is a synthetic acceptance fixture. Every number derives from the listed fixture records, not an observed user session.

```text
DX Flight Report — synthetic fixture
Recorded flight span: 60 min, explicit start to stop
Cursor coverage: 45/60 min of recording availability
CI compute: 28 job-minutes
CI execution intervals: [10,22], [14,24], [35,41] min
CI execution union: 20 min
Confirmed CI blocking: 8 min, manual [16,20] + [36,40]
AI activity: 5 captured turns; earlier activity unknown
Native tokens: unavailable
Native charge: unavailable
AI unchanged-line survival: 12/20 = 60% at final head
  Scope: controlled attribution fixture only
Repeated evidence: integration test X failed on attempts A and B
Next experiment: run existing local test X before next push
```

The 75% recording-availability ratio is not 75% of AI actions observed. Action count during the gap is unknown. The 60% exact-line result says nothing about quality. Real demo mode must display real available source fields and omit this fixture's unsupported metrics.

## Privacy and observer effects

Hook output can contain terminal secrets, code, prompts and reasoning. Collect bounded metadata first; raw text should require a separate opt-in. Local storage does not prevent disclosure when a report is inserted into Cursor chat. Export needs a deterministic redact/preview step, and raw content should not enter cloud storage solely because Ratstack supports deployment.

The observer can change the flight. Synchronous hooks add latency. Extra commits for provenance change Git history. Manual stop/start markers change workflow. Excessive questionnaires change developer behavior. Record collector duration, failures and dropped events. Compare a controlled local command with capture enabled and disabled before claiming negligible overhead; no unsupported millisecond target is asserted here. Reporting tools must be filtered out of self-generated activity where possible so asking for analysis does not inflate development-turn counts.

## Parallel execution economics and decisive constraints

The scarce dependency is shared agreement, not typing throughput. The plan should assign one owner each for event/schema contract, dependency lockfile, storage migrations and integration composition. Other workers can independently implement adapters, fixture cases, reports, CLI projections, docs or adversarial acceptance tests. Many workers may remain useful as reviewers without editing shared files.

Ratstack documents shared capability contracts across interfaces and removable bins. It also advertises Effect RC, XState alpha, TypeScript prerelease and Alchemy beta. Adopt the exact tested pins and the necessary capability/service patterns. Do not let each collector scaffold its own stack, database or transport. Do not add auth, hosted infrastructure or dashboard merely to demonstrate all available bins. A local collector remains necessary for local Git and Cursor data even if an optional cloud presentation exists. [Ratstack reference](https://ratstack.sh/)

Give workers immutable typed inputs and expected outputs before parallel execution. Require independent parser fixtures for malformed records, schema-version mismatch, branch ambiguity, duplicate imports and source gaps. Make optional adapters deliver manifests and fixtures even when live support cannot be demonstrated. That work remains reviewable without blocking core reporting.

Measure actual orchestration cost through tool-call counts, generated input/output tokens when available, retries and integration failures. Do not presume 49 agents provide a 49-fold speedup. Avoid per-worker dependency installation and full-suite execution. Use one integration checkpoint, targeted module checks, and a bounded shared validation queue.

## Go/no-go acceptance gates

| Gate | GO condition | NO-GO response |
|---|---|---|
| Minimal useful report | One actual flight combines local and GitHub evidence, with at least one useful next experiment | Ship evidence export/replay and name missing live capability |
| Cursor command | Target Cursor build invokes the actual report handler | Show working MCP invocation; do not claim untested slash syntax |
| Ratstack compatibility | Selected bins compile at one pin set and report tools use the shared contract | Stop architecture expansion; keep compatible selected bins |
| Native no-admin capture | A supported hook or validated user-data import produces inspectable activity | AI activity unavailable; Git/CI recorder can still ship |
| Correlation | Same branch name in two repos/worktrees does not silently merge flights; ambiguous runs stay unassigned | Suppress branch-specific conclusions for unresolved data |
| Replay determinism | Identical input twice yields identical projections and metrics; earlier failed attempts remain | Fail analytics release, preserve importer debugging artifact |
| CI arithmetic | Overlap, cancellation and missing timestamp fixtures pass independently | Hide incorrect metric, retain source events |
| Billing | Actual charge source, basis and allocation coverage are present | Show source account total or unavailable, no invented branch bill |
| Retention | Known-line controlled fixture verifies denominator and checkpoint | Mark experimental/unavailable |
| Disclosure | No secret or unapproved raw transcript reaches report/export/chat | Disable offending adapter/output before demo |
| Recommendation | Finding cites specific test/failure evidence and one bounded experiment | Replace generated recommendation with inspect-evidence action |

Prioritized cuts if gates fail: cloud presentation, account billing allocation, semantic retention, unsupported private schema adapters and dashboard. Preserve GitHub attempts, local feedback evidence, source coverage, deterministic calculations and the two report actions. Do not trade honest labeling for spectacle.

## Recommended product decision

Build DX Flight Recorder as an independent Ratstack application. Its first success criterion is that one developer can reconstruct a real feedback loop without org-admin access and verify the report's arithmetic. Catalogue all credible telemetry routes and let independent agents implement gated adapters against one contract. Make the demo about evidence that changes the next action. Offer Biomem separately only if it supports promotion context, without making storage or recall a prerequisite.

## Sources and confidence

Eight primary pages were read in this audit. Published product overlap and documented hook/API fields have high confidence. Local private-schema extraction details belong to the dedicated adapter research and are deliberately not claimed as verified here. Product demand, four-hour execution feasibility, capture overhead, installed-build behavior and causal savings remain unverified.

- [Ratstack current reference](https://ratstack.sh/)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cursor API availability](https://cursor.com/docs/api)
- [GitHub workflow run API](https://docs.github.com/en/rest/actions/workflow-runs)
- [DX AI effectiveness](https://docs.getdx.com/reports/ai-effectiveness/)
- [LinearB MCP](https://linearb.io/platform/mcp-server)
- [SPACE productivity framework](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/)
- [METR randomized productivity study and scope caveats](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
