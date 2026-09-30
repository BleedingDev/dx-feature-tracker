# GitHub telemetry: expanded collector map

Date: 2026-09-30. Scope: separate dx-feature-tracker. Ratstack transport/storage decision belongs to the architecture lane. No private repository requests, user-token inspection or data downloads were made. Evidence is current official documentation, not empirically verified payloads. No enterprise API is necessary for the core collection below.

## Decision

GitHub is considerably richer than run counts. Collect attempts, jobs, steps, checks, annotations, commit-status histories, PR transitions, reviews and both comment channels independently. Optional logs and test artifacts turn a chronological report into a failure report. Deployment and thread-state enrichments must never block the core report. The main correctness risk is pretending retrospective timestamps identify queue causes, developer blocked time or reviewer effort.

## Endpoint and permission contract

Notation: `R=/repos/{owner}/{repo}`. All listed REST requests are GET. Use immutable repository IDs internally. Suggested current GitHub.com API header: `X-GitHub-Api-Version: 2026-03-10`, as current official examples show; negotiate separately for GitHub Enterprise Server. Each module records denied, absent, truncated and complete separately.

| Independent module | Exact routes | Data / authorization / relevant limits |
|---|---|---|
| Actions runs | `R/actions/runs`; `R/actions/runs/{run_id}`; `R/actions/runs/{run_id}/attempts/{attempt_number}` | Actions read. Branch/SHA/event/date filtering, IDs, attempt number, status/conclusion, trigger context, workflow path, start. Filtered search cap 1,000; split date windows. Preserve every attempt, including cancelled attempts. [Runs](https://docs.github.com/en/rest/actions/workflow-runs) |
| Jobs and steps | `R/actions/runs/{run_id}/attempts/{attempt_number}/jobs`; `R/actions/jobs/{job_id}` | Actions read. Job and step names/numbers, started/completed times, statuses/conclusions, runner labels/IDs and check URL. Paginate max 100. Run jobs route defaults latest; use attempt route. Missing timestamps remain null. [Jobs](https://docs.github.com/en/rest/actions/workflow-jobs) |
| Checks and annotations | `R/commits/{sha}/check-runs?filter=all`; `R/check-runs/{id}`; `R/check-runs/{id}/annotations`; `R/check-suites/{id}/check-runs?filter=all` | Checks read. App/name, check suite, status, conclusion, start/end, output and annotation severity/path/lines. Max 100/page; default latest hides history. Empty PR associations on fork pushes are documented; never conclude no PR. [Checks](https://docs.github.com/en/rest/checks/runs) |
| External CI statuses | `R/commits/{sha}/statuses`; `R/commits/{sha}/status` | Commit statuses read. First route gives reverse chronological status history: context, state, timestamps, description, target URL, creator. Second is current combined view, not history. Pending can mean no statuses. 1,000 statuses per SHA/context is creation ceiling, not completeness assurance. [Statuses](https://docs.github.com/en/rest/commits/statuses) |
| PR identity and diff | `R/pulls?state=all&head={owner}:{branch}`; `R/pulls/{number}`; `R/pulls/{number}/commits`; `R/pulls/{number}/files` | Pull requests read. Head/base repo IDs/SHAs, lifecycle/draft/merge fields, file/change counts. Commits endpoint maximum 250, files maximum 3,000. For full local history use Git rather than silently accepting cap. [Pulls](https://docs.github.com/en/rest/pulls/pulls) |
| PR reviews | `R/pulls/{number}/reviews`; optionally `R/pulls/{number}/reviews/{review_id}/comments` | Pull requests read. ID, actor, submitted time, state, commit ID, body. Pending review lacks submitted time. Current state may become dismissed; preserve prior snapshots and dismissal events. Review submissions, not each inline comment, form proposed review rounds. [Reviews](https://docs.github.com/en/rest/pulls/reviews) |
| PR conversation comments | `R/issues/{number}/comments` | Issues read OR Pull requests read. Comment IDs, authors, created/updated time, body/URL. This is discussion, not inline code review. Body collection configurable; metadata alone enables response intervals. Max 100/page. [Issue comments](https://docs.github.com/en/rest/issues/comments) |
| Inline comments | `R/pulls/{number}/comments` | Pull requests read. Review ID, reply parent `in_reply_to_id`, file/line/side, original/current commit and location, body/timestamps. Group replies by parent; REST grouping does not certify resolved thread status. Max 100/page. [Review comments](https://docs.github.com/en/rest/pulls/comments) |
| PR transitions | `R/issues/{number}/timeline` | Issues read OR Pull requests read, max 100/page. Join/dedupe comments and review submissions with their object IDs; timeline payload shapes differ. [Timeline endpoint](https://docs.github.com/en/rest/issues/timeline) |
| Environment gates | `R/actions/runs/{run_id}/pending_deployments`; `R/actions/runs/{run_id}/approvals` | Actions read. Pending environments expose timer start/duration and required reviewers; approvals expose decision/user/comment/environments. Approval response example has no decision timestamp: do not substitute environment created_at. Live snapshots can bound transitions. [Runs](https://docs.github.com/en/rest/actions/workflow-runs) |
| Artifact metadata + content | `R/actions/runs/{run_id}/artifacts`; `R/actions/artifacts/{artifact_id}`; `R/actions/artifacts/{artifact_id}/zip` | Actions read. Name, size, expired/expires_at, digest where present, associated run/SHA. Archive download redirects expire after one minute. Max 100/page. Metadata default; bytes opt-in. [Artifacts](https://docs.github.com/en/rest/actions/artifacts) |
| Job/run logs | `R/actions/jobs/{job_id}/logs`; `R/actions/runs/{run_id}/logs`; `R/actions/runs/{run_id}/attempts/{attempt_number}/logs` | Actions read. Job plain-text download and run archives; redirect expires after one minute. Prefer selected failed jobs over full run archives. [Jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [Runs](https://docs.github.com/en/rest/actions/workflow-runs) |
| Deployment lifecycle | `R/deployments?sha={sha}`; `R/deployments/{id}/statuses` | Deployments read. Deployment SHA/ref/environment/creator/time, successive state/created time, environment/log/target URLs. Keep preview/staging/production separate; paginate 100/page. [Deployments](https://docs.github.com/en/rest/deployments/deployments), [Deployment statuses](https://docs.github.com/en/rest/deployments/statuses) |

Fine-grained personal tokens can grant these read permissions for selected repositories; metadata is the baseline. Organization policy, approval or SSO can still constrain access. A classic token's `repo` scope is broader and not truly read-only; prefer fine-grained permissions. GitHub Actions `GITHUB_TOKEN` is a workflow-scoped alternative for upload/import and has different permissions/rate limits. Public endpoint reads often work unauthenticated; verify download exceptions and return access-specific gaps. No installation administrator is required for local on-demand imports.

## PR transition and thread reconstruction

Import `convert_to_draft`, `ready_for_review`, `review_requested`, `review_request_removed`, `reviewed`, `review_dismissed`, `head_ref_force_pushed`, `base_ref_changed`, `closed`, `reopened`, `merged`, reference and deployment events. Changes-requested is a review state, not a standalone REST issue event named `changes_requested`. Events have event-specific actor/time/commit fields; do not force a single payload shape. [Event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)

Optional GraphQL `POST /graphql` read query: `repository(owner,name).pullRequest(number).reviewThreads(first:100,after:cursor)` returning thread `id`, `isResolved`, `isOutdated`, `resolvedBy`, `path`, and paginated `comments`. GraphQL POST is a read operation when it contains a query. Authenticate with repository read access and validate token/schema capability at runtime. Current official documentation moved from `/objects` to `/graphql/reference/pulls`. Thread flags are snapshots; there is no exposed resolution timestamp in those thread fields. Live state observations yield a bounded resolution interval, not exact historical time. [GraphQL pull-request types](https://docs.github.com/en/graphql/reference/pulls)

Proposed metrics: human-first-review latency after ready/request, changes-requested → next author push or submitted review, approval → merge, draft duration, review-round count and unresolved-thread count. Record denominator (eligible human reviews), team request ambiguity and bot policy. Actor `type=Bot` provides evidence; app/login heuristics are inferred and configurable. Do not classify every automated account as human because it uses a user account. Approval does not establish merge eligibility or causal blocking; other required checks and policies may apply.

## CI diagnosis: observed, reconstructed, unknown

| Claim | Honest result |
|---|---|
| Job/step duration | Imported completed-started interval when both timestamps valid; skipped/nonstarted null |
| CI compute | Sum job intervals; not billed cost, excludes platform rounding/rates |
| CI execution occupancy | Union job intervals; parallel jobs counted once |
| End-to-end feedback | Trigger/pending observation → completion evidence; label exact source and censored ongoing spans |
| Initial run pre-start latency | run start minus run creation; proxy, not pure runner queue |
| Attempt queue time | Requires attempt-specific enqueue observation; original run creation invalid for rerun |
| Approval wait | Live pending-deployment state/time evidence; historical approvals alone insufficient for exact duration |
| Concurrency cancellation | Cancelled status measured; cause inferred only with workflow/config/context evidence |
| Test flake | Same test fails then passes with controlled/no relevant change; otherwise candidate, not certified flake |
| Wasted human minutes | Unavailable unless developer explicitly marked blocked spans |
| Savings per feature | Experiment/hypothesis; no invented causal estimate from one flight |

Concurrency can create pending and cancellation behavior. Current docs additionally expose `queue: max` (up to 100 pending) versus default `single`, so an old assumption that every concurrency group can have only one pending run is incomplete. Runtime configuration expressions cannot always be resolved retrospectively from static YAML. Keep workflow-at-SHA evidence and label causes probable. [Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

## Bounded optional content import

Proposed defaults: metadata on; comments text user-selectable; logs/artifact bytes opt-in; selected flight/run/job only. Shared downloader has byte/member/decompression limits, no path traversal or XML external entity resolution, no credentials on redirected hosts, no execution of artifact content, local redaction and retention deletion. Signed URLs are ephemeral retrieval handles and excluded from reports. These are design recommendations, not GitHub requirements.

Parse JUnit/TRX/coverage only when a workflow uploaded such an artifact: GitHub does not universally expose a normalized per-test result API. Keep parser/version, artifact/run SHA, report checksum, test name/class/suite, duration, outcome and failure fingerprint. Match repeated test identity carefully across matrix variants. Raw log regex extraction is reconstructed evidence: show captured line and parser confidence, never equate unlogged work with absence. GitHub notes logs capture stdout, not all runner activity; configured retention and deletion can remove evidence. [Investigation limitations](https://docs.github.com/en/code-security/reference/security-incident-response/investigation-tools)

**Immediate retention change:** official documentation says from October 1, 2026 configured retention covers checks, workflow runs and commit statuses as well as artifacts/logs. Before then those first categories remain 400+ days. Defaults are 90 days; public range 1–90 and private range 1–400, policy constrained. Customization affects newly created objects. Preserve consented snapshots promptly and show earliest imported timestamp; do not promise permanent reconstruction. [Retention policy](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)

## Throughput and honest completeness

Authenticated user REST budget generally 5,000/hour; unauthenticated 60/hour; Actions GITHUB_TOKEN typically 1,000/hour/repository. Secondary limits include maximum 100 concurrent API requests shared REST/GraphQL and 900 REST points/minute. Fifty worker agents must not each poll independently: one bounded shared request queue/cache/ETag broker feeds collectors. [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

Follow `Link` pages, max 100; subdivide capped Actions windows; record exhausted budget, permission denial, history cap, removed payload and retention gap distinctly. [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) Conditional authenticated 304s preserve primary rate budget; inspect reset/retry headers and back off rather than guessing. On-demand sync is hackathon path; webhook plus reconciliation is later transport. [Best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

Preserve external key `(host,repo_id,kind,id,attempt?)`, observed_at, occurred_at where supplied, source URL, payload hash, parser version, raw/derived classification and coverage. Actions/check/status records may describe the same execution: join by supplied check URL/IDs, not name alone; never add all three durations together. Run-to-flight links remain many-to-many with evidence strength. Fork head IDs and synthetic PR merge SHAs require explicit PR associations; ambiguous branch matches stay provisional.

## Parallel ownership decomposition

Freeze `GitHubAdapterContext`, normalized event schema, coverage vocabulary and shared HTTP client first. Then assign independent files/modules:

1. runs/attempts collector + fixtures;
2. jobs/steps collector + fixtures;
3. checks/annotations collector + fixtures;
4. external statuses collector + fixtures;
5. PR identity/diff collector + cap tests;
6. timeline collector + state transition tests;
7. review submission collector + bot policy tests;
8. conversation comments collector;
9. inline comments/thread REST grouping collector;
10. optional GraphQL thread enrichment;
11. environment gate collector;
12. artifact inventory/downloader policy;
13. JUnit parser, separate from transport;
14. log parser, separate from transport;
15. deployment collector;
16. interval/feedback/review reducers;
17. cross-source join/dedup integration tests.

Shared client/schema are single-owner. Collectors emit events and coverage only; they do not write dashboard state or migrate shared schema independently. Start integration with synthetic fixtures while adapters are written. Core demonstrability requires runs/jobs/PR identity/timeline plus interval reducer; every other module can land independently without weakening those routes. Expansion must be capability-driven, not a giant permission request.

## Verdict and gaps

SUPPORTED: read-only personal-token collection covers much more than Enterprise analytics; rich chronology and step/check/test-artifact diagnosis are viable. WEAK: retrospective exact queue-cause attribution. INCONCLUSIVE: actual human waiting, reviewer effort, causal AI productivity. Runtime gaps: no real payload fixtures gathered; token policy, GraphQL access, log parser variability, cross-provider external CI and test artifact formats need explicit validation. No claim here makes Biomem a required dependency.
