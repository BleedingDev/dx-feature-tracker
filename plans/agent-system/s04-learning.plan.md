---
name: dft-agent-s04-learning
overview: "Retain scoped investigations and evidence-linked lesson evaluations"
todos:
  - id: s04-records
    content: "Implement resumable investigations and revisioned lesson/evaluation records"
    status: completed
  - id: s04-retrieval
    content: "Verify bounded applicability-aware recall, contradiction and supersession"
    status: completed
isProject: false
---

# dft-agent-s04-learning

## Execution notes

Start after S00 freezes ports; implement against fake storage concurrently with S01/S02/S03. S05 verifies the real composition after producers finish. Own only `learning/`, isolated s04 tests/fixtures and handoff. You are not alone. Read [agent learning](../../docs/architecture/agent-learning.md).

Implement list/get/record/evaluate/supersede through one domain service, using the storage ports rather than opening the database. Use typed basis/finding/metric/operation refs; remain independent of S02/S03 implementations through their frozen interfaces. Reject stale record updates; append concurrent independent evaluations without lost results.

Keep observations, hypotheses, suggested actions and evaluated support distinct. Scope matches repo/tool/source/definition/workflow conditions and coverage. Changed definitions mark applicability limits; contradiction and supersession preserve lineage. Unavailable citations never become fabricated replacement evidence.

Retrieve compact records with match reason, support status, evidence availability and next refs. Separate proposed from supported-within-scope results. An empty store is cheap. Avoid whole-store decoding or replaying evaluations into every status response.

Store authored conclusions only, without prompt/response text, hidden reasoning or raw commands. Render record text as untrusted data. Learning cannot mutate collection consent or accounting policy; wider reuse/export/delete uses explicit scope and operation policy.

## Completion criteria

- `pnpm --filter @rat-stack/core exec vitest run test/dx/s04.test.ts` covers interrupted investigation resume, duplicate record retry, concurrent evaluations, inapplicable scope, missing basis, definition drift and supersession.
- Fixture lessons cannot support live conclusions, and before/after associations do not become causal savings claims.
- Bounded retrieval reports limits and proves indexed scope filtering. Malicious note text causes no effects.
- Scoped catalog checks pass; handoff lists service exports, supported states, retention/disclosure behavior and gaps.
