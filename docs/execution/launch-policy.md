# Launch policy (A05)

Dependency-aware admission for dx-feature-tracker build. Source of truth: `research/execution-manifest.json` (sha256 `edf6d82859a14264908703404829a285d66a5e014297004e762a4958b91b46ca`), `research/phase-gates.md`, `research/hackathon-execution.md`. Ownership: [ownership.md](ownership.md).

## Capacity

- Root plus at most 49 workers (configured threads 50). Reserve 4 worker slots for core validators and repairs.
- Admission priority: (1) milestone producers and the integration baton holder, (2) core C validators, (3) core-candidate sources B05/B07/B08, (4) optional routes. The ready frontier is not the priority order.
- Pause the lowest-priority optional worker when a core repair needs a slot.
- Workers never spawn children, never install dependencies (A01 only), never commit/push (gate nodes only), never run whole-tree formatters or whole-workspace suites.

## Deadline (compressed to 2 hours)

The run was compressed from 240 to 120 minutes. Hard stop 15:47 CEST, 2026-09-30.

| Time (CEST) | Decision |
|---|---|
| 13:57 | Freeze interfaces and ownership; attempt G00. On failure hold B fanout and fix bootstrap. |
| 14:12 | Fixture spine; attempt v0 (G01). If absent, stop optional admission, prioritize spine repairs. |
| 14:32 | Enable only demonstrated real AI/GitHub inputs; concentrate on nearest viable route. |
| 15:02 | Finish or disable optional work; record G03 disposition. Late optional landings stay excluded. |
| 15:17 | Correctness/release fixes only. |
| 15:32 | Actual Cursor restart and rehearsal of final candidate. |
| 15:47 | Stop; report highest passed artifact or no-go. |

Elapsed time never passes a gate. Optional nodes past 15:02 ship a tested disabled descriptor plus handoff and stop.

## Launch waves (longest-path depth over canonical edges)

A node is launchable when all its upstream nodes have a terminal handoff; a gate node (G00-G04) is additionally passable only with actual receipts (dependency completion is not gate pass). G02 also needs at least one ready real route among B05/B07/B08.

| Wave | Nodes (core first, optional last) |
|---|---|
| 0 | A01, A03, A05, A06 |
| 1 | A04 |
| 2 | G00, C01 (verification) |
| 3 | B01, B02, B03, B15, B16, B17, B22, B23, B24, B25, B26, B27, B28, B29, B30, B34, B35, B36, B37, B38, B39, B40, B05 (core-candidate), B07 (core-candidate), B08 (core-candidate), B04 (optional), B06 (optional), B09 (optional), B10 (optional), B11 (optional), B12 (optional), B13 (optional), B14 (optional), B18 (optional), B19 (optional), B20 (optional), B21 (optional), B31 (optional), B32 (optional), B33 (optional), B41 (optional), B42 (optional), B43 (optional), B44 (optional), B45 (optional), B46 (optional), B47 (optional), B48 (optional) |
| 4 | A02, C02 (verification), C03 (verification), C04 (verification), C05 (verification), C07 (verification), C10 (verification), C11 (verification), C12 (verification) |
| 5 | C06 (verification), C08 (verification), C13 (verification) |
| 6 | C09 (verification) |
| 7 | C14 (verification) |
| 8 | C15 (verification) |
| 9 | G01 |
| 10 | A07 |
| 11 | A09 |
| 12 | C17 (verification) |
| 13 | G02 |
| 14 | G03, A08 (optional) |
| 15 | C16 (verification) |
| 16 | G04 |

## Upstream per node

| ID | Role | Wave | Must wait for |
|---|---|---|---|
| A01 | core | 0 | — |
| A02 | core | 4 | B01, B02, B03, B22, B23, B24, B25, B26, B27, B28, B29, B30, B34, B35, B36, B37, B38, B39, B40, G00 |
| A03 | core | 0 | — |
| A04 | core | 1 | A03 |
| A05 | core | 0 | — |
| A06 | core | 0 | — |
| B01 | core | 3 | G00 |
| B02 | core | 3 | G00 |
| B03 | core | 3 | G00 |
| B04 | optional | 3 | G00 |
| B05 | core-candidate | 3 | G00 |
| B06 | optional | 3 | G00 |
| B07 | core-candidate | 3 | G00 |
| B08 | core-candidate | 3 | G00 |
| B09 | optional | 3 | G00 |
| B10 | optional | 3 | G00 |
| B11 | optional | 3 | G00 |
| B12 | optional | 3 | G00 |
| B13 | optional | 3 | G00 |
| B14 | optional | 3 | G00 |
| B15 | core | 3 | G00 |
| B16 | core | 3 | G00 |
| B17 | core | 3 | G00 |
| B18 | optional | 3 | G00 |
| B19 | optional | 3 | G00 |
| B20 | optional | 3 | G00 |
| B21 | optional | 3 | G00 |
| B22 | core | 3 | G00 |
| B23 | core | 3 | G00 |
| B24 | core | 3 | G00 |
| B25 | core | 3 | G00 |
| B26 | core | 3 | G00 |
| B27 | core | 3 | G00 |
| B28 | core | 3 | G00 |
| B29 | core | 3 | G00 |
| B30 | core | 3 | G00 |
| B31 | optional | 3 | G00 |
| B32 | optional | 3 | G00 |
| B33 | optional | 3 | G00 |
| B34 | core | 3 | G00 |
| B35 | core | 3 | G00 |
| B36 | core | 3 | G00 |
| B37 | core | 3 | G00 |
| B38 | core | 3 | G00 |
| B39 | core | 3 | G00 |
| B40 | core | 3 | G00 |
| B41 | optional | 3 | G00 |
| B42 | optional | 3 | G00 |
| B43 | optional | 3 | G00 |
| B44 | optional | 3 | G00 |
| B45 | optional | 3 | G00 |
| B46 | optional | 3 | G00 |
| B47 | optional | 3 | G00 |
| B48 | optional | 3 | G00 |
| C01 | verification | 2 | A03, A04 |
| C02 | verification | 4 | B01 |
| C03 | verification | 4 | B02, B23, B24 |
| C04 | verification | 4 | B15, B16, B27, B29 |
| C05 | verification | 4 | B26, B30 |
| C06 | verification | 5 | A02, A06 |
| C07 | verification | 4 | B35, B36, B37 |
| C08 | verification | 5 | A02, B39 |
| C09 | verification | 6 | A02, A06, C08, C13 |
| C10 | verification | 4 | B37 |
| C11 | verification | 4 | B15, B16, B17 |
| C12 | verification | 4 | B01, B38 |
| C13 | verification | 5 | A02, B40 |
| C14 | verification | 7 | B35, B36, C09 |
| C15 | verification | 8 | C07, C14 |
| C16 | verification | 15 | C13, C15, G03 |
| A07 | core | 10 | B15, B16, B17, G01 |
| A08 | optional | 14 | G02 |
| A09 | core | 11 | A07 |
| C17 | verification | 12 | A07, A09, C13 |
| G00 | gate | 2 | A01, A03, A04, A05, A06 |
| G01 | gate | 9 | A02, C01, C02, C03, C05, C06, C07, C08, C09, C10, C12, C13, C14, C15 |
| G02 | gate | 13 | A07, A09, C04, C11, C17, G01 |
| G03 | gate | 14 | G02 |
| G04 | gate | 16 | C16, G03 |

## Gate barriers

- **G00** waits for: A01, A03, A04, A05, A06. Receipt: `docs/execution/phases/g00.json` (root only).
- **G01** waits for: A02, C01, C02, C03, C05, C06, C07, C08, C09, C10, C12, C13, C14, C15. Receipt: `docs/execution/phases/g01.json` (root only).
- **G02** waits for: A07, A09, C04, C11, C17, G01. Receipt: `docs/execution/phases/g02.json` (root only).
- **G03** waits for: G02. Receipt: `docs/execution/phases/g03.json` (root only).
- **G04** waits for: C16, G03. Receipt: `docs/execution/phases/g04.json` (root only).

## Stall and cut handling

- Stalled optional worker: cancel through agent controls, collect its bounded handoff, mark its route disabled in the candidate manifest. A disabled receipt is never a completed implementation.
- Unfinished optional code must pass the full fence or stay out of the candidate compile/test graph.
- Core nodes that are not ready produce a no-go or degraded-release verdict, never a success claim from a disabled manifest.
- Preserve the last passed artifact before enabling new modules.
