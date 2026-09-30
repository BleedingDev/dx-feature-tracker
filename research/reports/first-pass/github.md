> Historical first-pass report. Product recommendations and access conclusions are superseded by [the revised synthesis](../../synthesis.md) and the reports/revision/ evidence. dx-feature-tracker is standalone or two-person/24-hour plan applies. Original source evidence remains below.

# Git, GitHub Actions, and PR correlation for Biomem dx-feature-tracker

Research date: 2026-09-30. Confidence: high for documented interfaces, medium for proposed derived metrics, low for human-time and causal claims. Scope: official Git/GitHub docs, no repository mutation or installs. Read key API pages beyond search snippets; the OSS agent owns GitHub repository chronology and package research.

## Decision

Build this collector. Git + Actions + PR telemetry can produce a convincing, auditable flight timeline. Change the promise from “41 minutes lost waiting” to “41 minutes of CI feedback latency” unless a developer explicitly records blocked periods. Repository + branch is a useful display filter but insufficient as a durable identity. Use an immutable flight UUID with repository IDs, observed branch aliases, head-SHA history, and optional PR identity.

## Documented collection contract

| Source | Read endpoint | Persist | Permission / boundary |
|---|---|---|---|
| Repository | `GET /repos/{owner}/{repo}` | numeric ID, node ID, owner/name, URL, fork relationship | Resolves GitHub identity independently of local paths. [Repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository) |
| Actions runs | `GET /repos/{owner}/{repo}/actions/runs` | ID, workflow ID/path, head SHA/branch, head repository, event, PR associations, status/conclusion, created/start timestamps, attempt, URL | Actions read. Filter branch, head SHA, created range; max page 100; filtered searches capped at 1,000 results. [Runs API](https://docs.github.com/en/rest/actions/workflow-runs) |
| Run attempt | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}` | attempt snapshot, status, start, reference context | Same run can have multiple attempts; never overwrite old attempt evidence. [Runs API](https://docs.github.com/en/rest/actions/workflow-runs) |
| Jobs | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs` | job ID/name, status/conclusion, started/completed timestamps, step times, check URL | Actions read. Ordinary `/runs/{id}/jobs` defaults to latest execution; `filter=all` includes old executions. Attempt-specific route is safer. [Jobs API](https://docs.github.com/en/rest/actions/workflow-jobs) |
| PR lookup | `GET /repos/{owner}/{repo}/pulls?state=all&head={owner}:{branch}` then `/pulls/{number}` | PR node ID/number, base and head repos/refs/SHAs, draft, lifecycle timestamps, merge SHA, URL | Pull requests read. Inspect head repo ID to distinguish forks. PR commits endpoint caps at 250; files at 3,000. [Pulls API](https://docs.github.com/en/rest/pulls/pulls) |
| Reviews | `GET /repos/{owner}/{repo}/pulls/{number}/reviews` | review ID, actor, state, submitted_at, commit_id, URL | Pull requests read. Pending reviews have no submitted timestamp. [Reviews API](https://docs.github.com/en/rest/pulls/reviews) |
| PR timeline | `GET /repos/{owner}/{repo}/issues/{number}/timeline` | event ID/type/time plus payload and URL | Issues read OR Pull requests read. Include ready-for-review, review requests, changes requested/dismissals, force pushes, merge/close/reopen when available. [Timeline API](https://docs.github.com/en/rest/issues/timeline) |

Use a selected-repository fine-grained token for the hackathon; no write permission is needed. Public resources often permit unauthenticated reads, but rate headroom is much lower. A GitHub App is the later distribution path; webhooks require a reachable receiver and installation setup, which adds demo risk.

## Collector protocol and completeness

Follow response `Link` pagination rather than assuming one page. Page size 100 minimizes requests; recursively divide created-date windows when an Actions filtered query would exceed 1,000. Record `complete=false` for access denial, endpoint caps, deleted history, or exhausted pagination; zero records must never imply zero failures. [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

Use stable requests with saved ETags and conditional GET. Correctly authorized 304 responses do not consume the primary limit. Serialize or tightly bound request concurrency, cache completed attempts, refresh mutable runs, and back off on retry-after/reset headers. GitHub recommends webhooks over polling; use on-demand sync for MVP and webhook plus periodic reconciliation later. [REST practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

Authenticated user requests ordinarily share 5,000/hour; GitHub App installations start at 5,000/hour with scaling and enterprise exceptions. Actions GITHUB_TOKEN ordinarily has 1,000/hour/repository. Secondary limits include concurrency and endpoint points; do not treat available primary budget as permission to burst. Show cached-report age and partial-data reasons. [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

For later streaming ingest subscribe to `workflow_run`, `workflow_job`, `pull_request`, and `pull_request_review`; preserve delivery/event identity and refresh the affected object. Actions webhook subscription requires Actions read. This is a transport extension, not another analytics model. [Webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

## Local Git and identity

Use child-process argument arrays rather than interpolated shell commands. At every local event collect cwd, `git rev-parse --show-toplevel`, `git rev-parse --path-format=absolute --git-common-dir`, per-worktree git dir, symbolic branch if available, and HEAD. Git supports common-dir and gitfile resolution; linked worktrees should share repository identity while retaining independent context IDs. [rev-parse](https://git-scm.com/docs/git-rev-parse)

Proposed rules, not Git guarantees:

1. Start a flight explicitly with `dx start` or first observed eligible event. Save UTC start, base ref and base SHA, local context ID, and UUID. “First observed” is not “branch created.”
2. Bind GitHub repository IDs once remote resolution succeeds; keep local identity until then. Resolve fetch versus push remote explicitly; origin is not guaranteed to be the PR base.
3. A branch label change appends an alias after explicit binding/confirmation; branch deletion and recreation creates a new flight unless linked to the same PR. Two flights may legitimately share a label.
4. Bind a PR by base repo ID + number/node ID and head repo ID/ref. Never match two forks through branch name alone.
5. Preserve every observed SHA with timestamp. After rebase or force push, current DAG reachability cannot reproduce the historical flight; do not delete obsolete observations.
6. Detached HEAD events remain context/SHA-scoped and unassigned until explicit linking; multi-root editor workspaces need cwd per event, never a global current branch.

For commit counts and changed files, define a frozen base snapshot plus current head; report both current diff and historical event count. `git merge-base` identifies a common ancestor, not feature start time. `--fork-point` uses reflog information and can fail if that history expired. [merge-base](https://git-scm.com/docs/git-merge-base)

Reflogs can aid local retrospective reconstruction, but are local reference-update history with expiration; they cannot certify universal branch creation times or active work. [reflog](https://git-scm.com/docs/git-reflog/2.51.1)

For final changed-file/addition/deletion totals use explicit base/head diffs with machine-readable NUL-separated paths; separate uncommitted observations from final committed diff. Rename handling, binary files, generated files and formatting changes affect interpretation, so Git churn is not AI provenance or wasted work. [diff](https://git-scm.com/docs/git-diff)

## CI association traps

A PR workflow typically checks `refs/pull/N/merge`, with GITHUB_SHA referring to the synthetic merge result, not necessarily the authored head SHA. `pull_request_target` operates in base default-branch context. Fork PR events occur on the base repository. `merge_group` has a separate group ref/SHA and may concern multiple PRs. These are different event contexts; do not rewrite all of them as feature-branch commits. [Workflow triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

Proposed association precedence:

- Strong: explicit PR identity in run/event payload, with base/head repository IDs.
- Strong: exact run head SHA and head repository match to an observed flight SHA.
- Medium: same repository/ref during observed flight interval; display provisional association.
- Unknown: branch label alone, merge-group runs without membership evidence, or ambiguous shared commit; preserve unassigned and offer explicit linking.

Runs may associate with multiple flights/PRs; use a join table. Distinguish “feature-related” and “exclusive-to-feature.” For a hackathon use one ordinary same-repository branch and one PR; test fork and synthetic-SHA fixtures offline.

## Metrics: measured, proxy, unknown

| Metric | Definition | Verdict |
|---|---|---|
| Flight elapsed | Explicit start to explicit end/merge, labeled wall-clock | SUPPORTED measurement; not hours worked |
| PR cycle | created_at to merged_at | SUPPORTED; split draft and ready states if timeline complete |
| Review response | request/ready event to next submitted review, actor-filtered | SUPPORTED elapsed interval; not reviewer effort |
| Job runtime | completed_at - started_at for started terminal jobs | SUPPORTED; null for skipped/nonstarted jobs |
| CI compute sum | Sum job runtimes across chosen attempts | SUPPORTED arithmetic; parallel jobs inflate wall-clock |
| CI execution coverage | Duration of union of job execution intervals | SUPPORTED observed execution; excludes queue/dependency gaps |
| Run pending-to-start | run_started_at - created_at | Proxy for initial pre-start latency; not pure runner queue, especially reruns |
| CI feedback latency | attempt trigger/observed pending to terminal completion event or max completed job time, with source label | Proxy if REST lacks authoritative completion timestamp; updated_at is not a guaranteed completion field |
| Human blocked time | Union of explicitly marked “blocked on CI” intervals, intersect relevant CI intervals | Measured only with explicit markers; inactivity is insufficient |
| Saved minutes / causal productivity | Counterfactual from changed workflow | INCONCLUSIVE without comparison experiment |

For reruns, original created_at does not establish the rerun queue entrance. Persist streamed pending events or manual trigger observation if precise attempt queue time is required. Jobs REST examples expose started/completed, not a dependable enqueue timestamp. Avoid “job started minus run created” as runner queue because dependencies, approvals, concurrency and matrix scheduling all contribute.

Union algorithm: sort valid [start,end] intervals, merge when next.start <= current.end, sum merged lengths. Example: three parallel 10-minute jobs yield 30 job-minutes and 10 minutes execution coverage. Separate CI episodes: combining intervals across several commits is valid occupancy, but feedback for the latest relevant commit is another metric. An ongoing interval contributes a censored duration as-of report time, not a completed observation.

## Proposed SQLite contract

These are implementation recommendations:

```text
repositories(local_id, github_id?, host, remote_aliases_json)
contexts(id, repository_id, worktree_git_dir, cwd)
flights(uuid, repository_id, start_at, end_at?, boundary_source)
flight_refs(flight_id, context_id, ref, first_seen_at, last_seen_at)
head_observations(id, flight_id, sha, observed_at, source)
prs(base_repository_id, number, node_id, head_repository_id, lifecycle_json)
run_attempts(repository_id, run_id, attempt, workflow_id, event, sha,
             created_at, started_at?, status, conclusion?, html_url)
jobs(repository_id, job_id, run_id, attempt, started_at?, completed_at?, state)
flight_links(flight_id, entity_kind, entity_key, evidence_kind, confidence)
events(id, source, external_key, occurred_at?, observed_at, schema_version,
       payload_hash, payload_json, origin_url?)
sync_state(endpoint_key, etag?, last_success_at, complete, gap_reason?)
```

Unique source keys prevent duplicate polling/webhook ingestion. Preserve payload snapshots because API resources are mutable; projections can be recomputed. Reject impossible negative intervals; track UTC and local observation separately. Only send minimum derived events to remote memory; keep tokens and raw sensitive payloads out of durable reports.

## Required tests / demo fallback

1. Three parallel jobs: 30 compute-minutes, 10 coverage-minutes.
2. Failed attempt then successful rerun: failure survives and both attempts count exactly once.
3. Default-latest job API fixture: importer deliberately fetches earlier attempts.
4. Branch renamed / deleted / recreated: UUID history preserved; recreation distinct.
5. Two forks both feature/payment: separate head repos, one base repo.
6. Synthetic PR merge SHA: association by PR evidence despite head-SHA mismatch.
7. Rebase / squash merge: historical observed SHAs remain; merged_at closes the PR-bound flight.
8. Two worktrees / multi-root cwd: events land on correct flight.
9. Pagination 101 jobs + 304 refresh + 403 missing permission: complete state and errors truthful.
10. Cancelled, skipped, queued and ongoing runs: no fake zero-runtime success and censored intervals labeled.
11. Draft -> ready -> changes requested -> dismissal -> merge: chronology survives mutable current review state.
12. Empty/deleted/missing historical data: metric unavailable, never invented.

Demo success: one real branch + PR + failed CI + repair + passing CI, with each finding linking to the source run/review. Prepare a visibly labeled recorded fixture for network/API failure. The winning insight is an explainable sequence and actionable feedback latency; a fake precision claim about human time weakens the product.

## Evidence versus inference and gaps

SUPPORTED: accessible run/job/review/timeline data, attempt-specific routes, documented permissions/pagination, local Git snapshot inspection. CONTESTED: defining first commit as start of work; treating summed CI jobs as waiting. WEAK: branch-only attribution under forks/reuse/history rewrites. INCONCLUSIVE: AI ownership from Git churn; productivity or expected time savings from one feature.

No API calls against a specific user's private repository were made. No empirical payload fixtures were collected; contract tests must precede the demo. Pure REST retrospective queue timing and full rebase reconstruction remain gaps. Exact GitHub API capabilities were reviewed against current official docs, not inferred from memory; pin a documented API version in implementation rather than copying an old header.
