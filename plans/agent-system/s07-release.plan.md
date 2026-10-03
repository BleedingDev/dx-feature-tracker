---
name: dft-agent-s07-release
overview: "Freeze and verify the enabled agent-system artifact with a truthful release receipt"
todos:
  - id: s07-gate
    content: "Run the required fence and restart/install/client rehearsal on one frozen artifact"
    status: completed
isProject: false
---

# dft-agent-s07-release

## Execution notes

Depends on S06. Root owns this gate and its new receipt, plus active-design/plan status updates. You are not alone; preserve all producers' work and historical receipts. User authorization covers implementation and local verification. Publishing requires a separate instruction.

Freeze candidate commit/content digest, contract/schema set, enabled operation kinds and supported host observations. Run the catalog's `pnpm exec turbo run check test build` through the one shared queue. Targeted owner checks precede this gate. Do not weaken hooks, diagnostics, dependencies or tests to pass.

Rehearse install beside unrelated config, query/operation/learning through the installed artifact, interrupted receipt recovery, basis/investigation resume after restart and uninstall preserving user edits. Use owned fixture stores for destructive paths. Record actual current-host stdio MCP observation separately from synthetic protocol tests and source-data probes.

Preserve a last-passed artifact before enabling broader source/control/learning support. A disabled required module cannot pass the full-design predicate. Reserved operation kinds are schema choices with explicit unavailable descriptors, not implemented modules; the release receipt lists them separately from enabled behavior. Report the useful read milestone separately if only that milestone passed. Remaining client, live-source, redaction or historical-detail limits stay visible.

## Completion criteria

- The full fence exits zero and every required task and test report completes successfully on the same frozen source and compiled artifact used for rehearsal. Record skips separately. Cancellation, missing reports or interrupted tasks leave acceptance unverified even when the wrapper exits zero.
- All enabled contracts advertise actual effects/versions and pass their behavior evidence. Source fixtures never masquerade as live observations.
- `docs/execution/phases/s07.json` records candidate/contract digests, exact commands/results, host/source versions, basis/operation/investigation handles, resource verdict and gaps.
- Active docs distinguish implemented requirements from pending ones. Original G00-G04 receipts and 79-node validation remain untouched.
- Operation-owned generated outputs are registered/released; durable user stores and other sessions' files remain intact. Publishing is a separate authorized step.
