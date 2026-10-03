---
name: dft-agent-s00-contracts
overview: "Revalidate the baseline and freeze agent schemas, ownership and commands"
todos:
  - id: s00-baseline
    content: "Verify current interfaces, active ownership and executable check commands"
    status: completed
  - id: s00-freeze
    content: "Freeze versioned agent contracts, compile-only fakes and handoff digest"
    status: completed
isProject: false
---

# dft-agent-s00-contracts

## Execution notes

Read [the follow-up operating contract](README.md) and [manifest](manifest.json). First establish current HEAD/status, implementation versus proposal, active path owners and installed Effect/XState instructions. Preserve all existing work. This owner is the contract steward and command-catalog editor; exclusive paths are in the manifest. You are not alone in the codebase.

Map `contracts/capabilities.ts`, `model/snapshot.ts`, `model/report.ts`, `usage/contract.ts`, current handlers and sync/price effects. Event v2, contract v1 and usage v1 are separate version axes. Verify the late product additions instead of treating the original frozen contract doc as a complete inventory.

Freeze `AnalysisBasis`, response context, typed refs, read/work policies, comparison/error shapes, operation descriptors/plans/receipts, investigation/lesson/evaluation records and storage ports. Use Effect Schema; derive transport schemas. Specify legacy omission behavior and explicit agent-profile requirements. Existing v1 additions remain optional; version breaking shapes and semantic changes.

Publish compile-only fakes and a redacted fixture vocabulary with ambiguity, missing refs, stale handles and two price/attribution versions. Producers must compile independently against these ports. Keep the old fixture index intact. Assign all later usage/live/app paths explicitly; confirm legacy ownership is idle before activating transfer.

Revalidate existing command recipes and add exact app/audit recipes through `docs/execution/commands.json`. Any new recipe records argv, cwd, prerequisites, observed exit and scope. No install or dependency change is required by this design. A dependency proposal remains a gap until specifically authorized.

## Completion criteria

- Every design schema has a defining module, version/compatibility rule and fake consumer that compiles.
- Consent, operation success and verification states are distinct. A basis never promises semantics the store cannot reproduce.
- The manifest has no conflicting owner claims after activation, and every producer has exact source/test paths.
- Scoped typecheck/lint/format commands follow the verified catalog. Record fresh diagnostics before typecheck.
- The handoff gives the contract digest, baseline commit, command recipes and accepted schema/ownership decisions. Root may then admit S01.
