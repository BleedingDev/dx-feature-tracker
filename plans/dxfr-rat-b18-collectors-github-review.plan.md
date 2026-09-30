---
name: dxfr-rat-b18-collectors-github-review
overview: "Review events/timeline and requested-review episodes"
todos:
  - id: b18-handoff
    content: "Deliver B18: Review events/timeline and requested-review episodes"
    status: pending
isProject: false
---

# dxfr-rat-b18-collectors-github-review

## Execution Notes

Authoritative direction: separate DX Flight Recorder; Ratstack; four-hour execution deadline; no assumed human team size. Research: research/synthesis.md. Implementation contract: research/implementation-spec.md. Exact node/dependency manifest: research/execution-manifest.json. Execution root is a new explicitly selected recorder repository; paths below are proposed product files, not existing upstream symbols.

Owner: native worker B18. Role: optional. Read the selected repo AGENTS.md and installed pinned Effect AGENTS.md. Reference SHA 753c7b07dcc516037dd1d455a8766bf112084844; A01 freezes actual pins/toolchain. Build/test against frozen canonical fixtures without waiting for a live producer. Adapters return normalized events and coverage; metrics consume immutable snapshots. Optional unsupported sources provide tested disabled descriptors and clear source gaps.

Exclusive write scope:

- `packages/core/src/dx/collectors/github-review/`
- `packages/core/test/dx/b18.test.ts`
- `packages/core/test/dx/fixtures/b18/`

Also own only docs/execution/nodes/b18.json and .md for your handoff. A03 contracts/model, B01 migrations, A01 package/lockfiles and A02/A07/A08 sequential integration registry/app composition are forbidden to every other owner. Do not edit shared barrels or fixture indexes. You are not alone in the codebase: preserve other edits and adapt to accepted contract changes.

## Constraints

No independent install/scaffold, dependency bump, full-tree formatter, cloud deployment, second transport, cross-host agent CLI or private-data scan. No automatic Git AI/Entire initialization, Git ref push, browser cookie extraction, raw transcript upload or code execution from evidence. Only explicitly selected source inputs. Missing/unsupported data stays visible; never invent tokens, charges, human waiting, causal savings or AI ownership. Four hours is a hard stop, not an effort estimate. Release cuts do not disable Ratstack checks.

## Operator Guidance

Upstream nodes: G00. Edges are stored in the canonical manifest and command arrays; do not use a bare glob without them. Native limit: root plus at most49 workers, reserve room for integration/reviewer repairs. Root schedules, node owners do not spawn children during execution unless explicitly reassigned.

Write a terminal handoff with frozen contract digest, owned files, descriptor export, fixture IDs, source/version probe, exact check command/result, supported fields and gaps. Terminal handoff ready, unsupported, or disabled; never equate disabled handoff with functioning code. Owner verification command: pnpm --filter @rat-stack/core exec vitest run test/dx/b18.test.ts. A01 verifies the actual config-compatible command before execution. Documentation/scaffold/interface owners verify their observable artifact and applicable type/boot checks; do not create tautological tests. No whole-workspace suite per worker.

Deadline policies: T+15 freeze interfaces/ownership; T+45 fixture spine; T+90 enable only demonstrated inputs; T+150 finish or explicitly disable optional work; T+180 correctness/release fixes only; T+210 restart rehearsal; T+240 stop. These are checkpoints, not predicted durations. Stop at a reviewable bounded artifact; do not expand to adjacent modules. Reviewers report findings in their owned folder and return fixes to implementation owners. Cleanup exact operation-owned scratch/build paths according to workspace rules; preserve durable user event data.

## Phase promotion policy

Follow research/phase-gates.md. Separate recorder, Ratstack, four-hour deadline, root plus at most49 workers. Read selected repo AGENTS.md. No independent install, shared-file edits, weakened checks, private-input scans or other agent hosts. You are not alone: preserve others’ changes. Paths are proposed product paths; root gates consume actual evidence.

Authoritative owner/deliverable: native worker B18; Review events/timeline and requested-review episodes. Canonical manifest scopes override earlier narrow lists. Terminal handoff ready, unsupported, or disabled; never equate disabled handoff with functioning code.
