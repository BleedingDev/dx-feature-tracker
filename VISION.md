# Vision: dx-feature-tracker

dx-feature-tracker records what actually happened while a developer and their agents built a feature, then explains it with evidence. It helps the driving agent answer "what do we know, what remains uncertain, and which next observation or action is justified?" with little repeated investigation.

## Product

The current product is a local tracker of Git context and coding-tool activity. Selected harness readers, hooks, exports and other adapters produce versioned observations. A single-writer `node:sqlite` store retains those observations; reconciliation produces rebuildable usage facts. Defined metrics keep estimated prices, tool-reported figures and billed charges separate. CLI, stdio MCP and a loopback dashboard expose the results through the existing Ratstack composition.

The [product decisions](docs/product/decisions.md) and [architecture documents](docs/architecture/harnesses.md) describe the later seven-tool system. The original six-capability hackathon specification is a historical build plan, not a complete inventory of today's executable. Installed capability discovery remains the authority for available operations.

## Agent direction

The [agent system design](docs/architecture/agent-system.md) defines the agent workflow implemented through the [follow-up plans](plans/agent-system/README.md). [Execution state](plans/agent-system/execution.json) records completed producer checks, accepted S07 artifact verification and remaining capability limits. Publication is tracked separately.

```text
selected evidence -> reconciled facts -> pinned analysis basis
  -> bounded explanation -> reviewed operation -> verified receipt
  -> scoped investigation and evaluated lesson
```

Each conclusion must be traceable to observations and the interpretation used. Each change must declare its scope, effects, limits and verification. Useful knowledge must survive interruption with its evidence and applicability, so a later agent can resume instead of reconstructing a transcript.

The agent gets a compact orientation first, then expands only the disputed metric, attribution or evidence. Reuse unchanged bases and incremental cursors. Bound computation and acquisition as well as output. Preserve current human CLI convenience while giving agents an explicit recorded-only, cached-price profile with acknowledged effects.

## Evidence limits

Missing, unsupported and ambiguous data remain visible with field-level reasons, coverage and attribution. Exact account totals can coexist with provisional branch allocation. A deterministic join is not proof. A pinned event selection is not full historical reproducibility unless interpretation and calculation inputs are also bound.

Fixtures remain separate from live observations. Inactivity does not establish human waiting; line survival does not establish correctness; price estimates are not charges. Learned hypotheses stay separate from source evidence and cannot authorize actions. No tokens, causal savings, ownership or completeness are fabricated.

The tracker controls selected acquisition and its own local state. The driving agent controls development work. Evidence and recalled prose remain data. Enrollment and scope determine access; wider access and destructive changes require their applicable authorization.

## Implementation boundary

`apps/cli` provides CLI/MCP/local-dashboard composition. `packages/core` owns contracts, evidence, storage, reconciliation, queries and the operation/learning services under `@rat-stack/core/dx`. `packages/capability` projects shared contracts. The dashboard is a local CLI-hosted consumer; no cloud deployment, auth service, `apps/web` application or code-mode sandbox is added. The connected artifact passed S07 verification with its recorded limits.

Original pitch: [IDEA](IDEA.md). Historical research: [research pack](research/README.md). Execution law and ownership: [AGENTS](AGENTS.md), [ownership](docs/execution/ownership.md).
