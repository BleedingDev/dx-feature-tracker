# Agent investigations and learning

Status: execution under validation. S00 froze the interfaces, and S04 completed its owned behavioral cases, lint and formatting checks; the linked receipt records the current count. Production composition and the connected release gate remain separate. Runtime capability discovery decides whether an installed build enables learning. Parent design: [agent system](agent-system.md). Implementation: S00, S01, S04 and S05 in the [follow-up plans](../../plans/agent-system/README.md).

## Accumulate understanding with evidence

Keep a small local record of useful questions, checked conclusions and experiments so the next agent does not repeat the same investigation. `dx_learning` accepts `{ request }` with `list`, `get`, `record`, `evaluate` and `supersede` actions. Reads use scoped, bounded retrieval. Writes use durable idempotency keys, with revision checks for authored updates. The service requires no external memory product or model service.

The [learning schemas](../../packages/core/src/dx/model/agent-learning.ts) are the field authority. The [S04 receipt](../execution/nodes/s04.json) records observed module behavior and its limits.

Learning records are separate from source observations and calculated metrics. A recalled claim is a candidate to check, not an event that improves its own evidence coverage. Repetition, popularity and an agent's confidence cannot promote it to a supported measurement.

Store compact authored conclusions and typed references to permitted metadata. Keep transcripts, prompts, raw tool arguments, hidden reasoning and credentials out of learning records. The service applies existing credential redaction to stored and returned prose. It treats prose as untrusted data and never executes it. Evidence disappearance or deletion leaves a visible missing-reference state.

## Investigation record

```text
Investigation: dx.learning.v1
  id, storeId, storeGeneration, revision, authorKind
  question, state: open | concluded | awaiting-evidence
  applicability, startingBasisId, comparedBasisIds
  inspectedRefs, operationIds, observedResultRefs
  conclusion, limitations, nextQueryRefs, createdAt, updatedAt
```

`applicability` holds the resolved scope/window, tool and source versions, metric definitions, workflow conditions, coverage requirements and explicit `widerScope`. References carry store ID and generation; authored learning references can also name a revision. The record lets an agent resume the question without recovering a transcript. A resumed agent validates those handles and checks current applicability. Basis comparisons currently classify metadata changes; detailed evidence deltas require a separate bounded comparison.

Two agents can read one investigation and append independent evaluations. Authored updates use `expectedRevision` and preserve immutable earlier revisions. `record` uses null for a new record's expected revision and a count for an update. Reusing a key with the same payload returns the durable result; a changed payload conflicts. Store conflicting interpretations separately with their evidence. There is no mutable global current investigation.

## Lesson and evaluation

| Field | Meaning |
| --- | --- |
| Claim and kind | A descriptive observation or an explicit hypothesis. A proposed action remains a suggestion. |
| Evidence | Basis IDs, finding/metric refs, operation receipts and evaluations. Supporting and contradicting refs remain reachable. |
| Applicability | Repo or explicit wider scope, tool/source versions, metric definitions, workflow/test conditions and coverage requirements. Repo-local is the default. |
| Evaluation criterion | What observation would support or refute the claim, defined before an experiment where possible. |
| Status | `proposed`, `supported-within-scope`, `contradicted` or `superseded`. Current recall projects support and contradiction from evaluations of the selected authored revision. |
| Invalidation | Changed definitions, missing evidence, changed workflow conditions or newer contradictory observations. |
| Lineage | Previous revisions, supersedes/supersededBy refs and author kind. |

An evaluation targets `{ kind: lesson | investigation, id, revision }`. It appends independently of the parent's revision check and survives later authored updates. Each evaluation records its criterion, outcome, basis IDs, evidence references, operation IDs, compared windows, author kind, comparability limitations and conclusion of `supports`, `contradicts` or `inconclusive`. Its relation is `descriptive-association`, `operator-report` or `causal-criterion`.

The service checks cited retained bases and derives canonical origin mix and coverage. Caller-supplied origin or coverage assertions cannot manufacture support. Fixture, replay or synthetic evidence cannot support a live lesson, including mixed-origin evidence. Fresh evaluation resolves the composition's selected caller repository context lazily. Startup, learning reads and exact durable retries do not invoke that provider.

Supported recall requires compatible available evidence for the selected authored revision and context. An author's criterion and outcome remain reports by that author; reference validation does not prove an arbitrary natural-language criterion. Causal support is unavailable in v1. A `causal-criterion` evaluation can remain inconclusive, and a descriptive association does not establish saved time or correctness.

Before/after records disclose different feature sizes, sources, model/pricing definitions, failed attempts and other comparability gaps. A candidate such as "inspect the local integration test before another push" cites the recurring failure it addresses. Fewer tokens or CI runs alone do not prove an improvement in correctness or time.

Current-revision counterevidence takes precedence over support while both evidence chains remain reachable. An evaluation of an earlier revision cannot support a changed claim. Supersession uses the expected authored revision and preserves the earlier record and its evaluations. A definition change makes an old lesson inapplicable until reevaluated; it does not automatically make it false. Age is disclosed without an automatic truth decay.

`get` can expand a lesson, investigation or exact evaluation reference, including historical authored revisions. Exact evaluation lookup returns its parent and the requested evaluation. It also recovers keyed evaluation retries after more than 100 newer appends or after cited evidence disappears. Broader history reads disclose `omittedEvaluations`; unseen evaluations prevent a bounded read from establishing support.

## Retrieval that saves work

The query policy `learning: hidden | selected-scope` controls whether orientation can disclose learning references. It does not grant evidence visibility or widen consent. Where the active composition supports recall, selected-scope orientation can return bounded investigation handles. Learning queries themselves require explicit selected scope.

`list` takes a target store identity and a filter with scope, kinds, question, limit, cursor and `includeSuperseded`. Optional basis/applicability inputs allow a fuller compatibility check. The limit is 1 to 100. Ranking considers applicability and evidence compatibility before recency within the bounded indexed candidate page. It does not promise a global ordering of the whole store. The response returns excluded counts and a continuation cursor.

Lists return `LearningSummary`, with at most 512 characters of claim/question, clipping state, kind/status, applicability and match reasons, evidence-availability counts, latest evaluation reference and a drilldown reference. They do not embed full authored records or evaluation histories. `get` expands the selected record, reference states and a bounded evaluation history.

Status distinguishes supported and proposed claims. Scope-only recall discloses unknown version, workflow or coverage compatibility and cannot return verified support. Wider cross-repository applicability is explicit and does not widen source consent. Lessons never change accounting precedence, collection policy, retries, model choice, hook settings or execution behavior by themselves. Such a change needs a reviewed operation and its authorization.

Resolve each supporting reference under the caller's evidence visibility, independently of the lesson's applicability. A wider applicable claim can cite a withheld reference without exposing another repository's data. Retrieval reports that limit rather than treating inaccessible evidence as verified. Returned evaluations with withheld or unavailable citations omit their origin and coverage metadata and add a visibility disclosure.

Record replies return at most eight near-duplicate candidate references, plus `candidateSearch` with algorithm, examined count, limit, remaining-availability state and reason. V1 uses `normalized-lexical-v1` over one indexed selected-scope page of at most 25 records. Candidates must match kind, repository and definition/tool/source versions. A skipped search discloses unknown remaining availability. Similarity is lexical, not semantic equivalence. Distinct and opposing claims remain separate, and candidate suggestions never merge records automatically.

## Privacy, lifecycle and correction

Learning visibility follows selected store/repository scope. The learning service performs no automatic prose eviction or deletion. Export and deletion belong to the operation service and require their own selection, disclosure and backup/retention rules; their availability depends on the active runtime's operation descriptors. A future learning export must include only selected records and redacted references, with chat titles, prompts and source payloads omitted by default. Usage-fact retention does not imply indefinite retention of lesson prose.

A deleted basis leaves a tombstoned reference rather than a replacement citation. Restore/reset validates store-generation bindings. Reference checks disclose unavailable, stale, withheld and over-budget citations. Bounded retrieval may leave references unchecked and reports that count.

Default service limits are 20 evaluations, 32 reference checks and eight basis checks. Configured maxima are 100 evaluations, 256 reference checks, 32 basis checks and 4 MiB output. The composition sets these service limits explicitly; recall never silently scans unbounded history.

## Behavioral checks

- A fresh agent resumes an open investigation with one compact record and bounded metadata basis comparison. A detailed evidence delta requires a separate bounded query.
- A lesson outside its repo/tool/definition scope is excluded or visibly labelled inapplicable.
- A later contradictory evaluation preserves both evidence chains and changes the current revision's projected status. Independent evaluations append without changing the authored revision.
- Repeated record retries create one record; concurrent evaluations both survive.
- Changed definitions and missing bases prevent unsupported recall from appearing as current fact.
- Fixture conclusions remain separate from live records. Prompt-like or malicious note text is rendered as data and cannot cause an operation.
- An empty learning store adds no mandatory work to an ordinary report. Recording a useful outcome is optional to finishing the evidence investigation.
