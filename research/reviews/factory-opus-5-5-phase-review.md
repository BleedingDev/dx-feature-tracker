# dx-feature-tracker plan review: findings, corrections and a phase matrix

## Bottom line

The plan's honesty rules are good: missing is not zero, sum and union are kept apart, snapshots are never swapped silently, and one working AI route out of three is enough. The execution graph does not yet match the phases it describes, though:

- **The checkpoints are decisions, not phases.** No graph node produces what the T+45 or T+90 checkpoint asks to inspect.
- **Every plan has one todo.** So no plan can stop early with something to show.
- **One late node gates everything.** A02 and C16 are single nodes. C16 has hard edges on all 23 optional lanes.
- **Core checks wait on optional lanes.** Four core audits depend on optional adapters.
- **Some work has no owner.** Cursor wiring, input selection and running on real inputs are not owned. Neither is an end-to-end test.

The corrections below are plan edits. I only read files and inspected the graph data. I ran no runtime, install, build or test command. Every command below is still prospective until A01 verifies it.

---

## 1. High-confidence contradictions, in priority order

### H1. T+45 and T+90 have no deliverable, and A02 is a single node that both finishes too early and too late
**Evidence**
- `hackathon-execution.md` › Deadline policies: "T+45 Inspect actual fixture report spine and CLI/MCP boot" and "T+90 Choose demonstrated real inputs".
- Manifest: A02 depends only on A01/A03/A04/A05 and has three outgoing edges. Its deliverable is "end-to-end skeleton".
- The A02 plan says "Completion is an executable tested core report spine plus the current compatible registry".
- `hackathon-execution.md` › Admission: "Root retains responsibility for later integration admission".

**Problem**
- The only way C08 and C09 can run is after A02 is done. If A02 finishes at the skeleton stage, nobody owns wiring the real core modules into the app afterwards. If A02 stays open until everything is integrated, C08/C09 cannot start until the end. Either way, "root" ends up doing integration with no plan behind it.
- Nothing is scheduled to produce the "fixture report spine" by T+45.

**Correction.** Split A02 into three nodes and add gate nodes owned by root (see §6):
- **A02a, v0 skeleton.** Built CLI and MCP stdio serve `dx_status` and `dx_analyze` over the A04 golden store, using B01, B35, B38 and B39. The spine is minimal where needed.
- **A02b, v1 live core.** Real Git, GitHub and one AI route composed end to end.
- **A02c, v2 enablement.** Optional adapters enabled one commit at a time, closed at T+150.

### H2. The release barrier waits on every optional lane, and four core audits are held behind optional adapters
**Evidence (manifest edges)**
- C16 depends on all 48 B lanes, including the 23 optional ones.
- C05 depends on B31, B43 and B44 (optional). It is the accounting audit for core B08/B26/B30.
- C06 depends on B06, B10, B45 and B46 (optional). It is the version audit for core candidates B05/B07.
- C10 depends on B47 (optional). It is the privacy audit for core B37.
- C11 depends on B19 (optional). It is the API-failure audit for core B15–B17.

**Problem**
- The C16 plan says optional work is "disabled by a root-authored disposition" at T+150. But the graph cannot mark C16 ready until every optional node is marked complete.
- Privacy, accounting and API-failure audits on core code cannot start until the slowest optional adapter stops. That can be as late as T+150, which pushes core audits into the "fixes only" window.

**Correction**
1. Remove the optional edges from C05, C06, C10 and C11. Split each into a core part (which stays a C node) and an optional part. The optional part becomes that adapter's own enablement check inside A02c (see H9).
2. Replace C16's 23 optional edges with one edge on a root-owned **G3 optional disposition** node. G3 has **no** edges from optional lanes. At T+150, root reads whatever handoffs exist and records each lane as `enabled`, `disabled` or `reverted`. Anything that lands after T+150 is ignored.
3. Update the note in `final-plan-audit.md` about "the 50-node frontier" to match.

### H3. The real Cursor gate has no operator, no built-package requirement and no dependency on the installer
**Evidence**
- C09 depends only on A02, A06, B39 and B40. C13 (the installer) is not upstream of C09 or C14.
- The `hackathon-execution.md` T+210 checkpoint wants an "install rehearsal in actual Cursor".
- The spec and AGENTS forbid launching another agent CLI.
- Nobody owns `.cursor/mcp.json` or the hooks config (no manifest path matches).
- B40 owns `.cursor/skills/` only in the recorder repo. The demo flight is in "a real selected flight" repo.

**Problem**
- C09 can "pass" against a dev-mode launch of a skeleton.
- Nobody is named to operate the Cursor IDE, for both the smoke test and for generating live hook events.
- The skills and MCP entry must be installed into the demo repo or user config, and nothing does that before C09.

**Correction**
- Split C09:
  - **C09a (v0):** MCP tool call in Cursor against the fixture store.
  - **C09b (v1):** installed and built package, real flight, `/dx-analyze` then `/dx-explain` reusing the same snapshotId.
- The restart check moves into G4/C14.
- C09b depends on C13 and A02b. C13 depends on A02a (entrypoint/bin) and B05 (hook command), and C13 owns writing the MCP entry, hooks entry and skills into the target location.
- State in C09 and the hackathon doc that a named operator performs Cursor actions. That is either the user or explicitly authorized GUI automation. The worker prepares the script and captures evidence.
- C09 must record:
  - Cursor version and the config file used;
  - the MCP protocol version negotiated;
  - `tools/list`;
  - the returned snapshotId;
  - whether slash-skill routing worked, with the fallback of a direct tool call.
- If no operator is available, the verdict stays "replay-only". The plan must not call that a Cursor demo.

### H4. No node runs a probe on real inputs, so "demonstrated real inputs" at T+90 cannot happen
**Evidence**
- A06 deliverable: "probe recipe with no personal-data reading during planning". A06 has only two outgoing edges (C09, C16).
- B05/B07/B08 test against fixtures.
- C16: "No installed source may be claimed solely because a parser fixture passes."
- `hackathon-execution.md`: "Select user-owned inputs explicitly".

**Problem.** The rule forbidding claims from fixtures is correct. But no node owns producing the real evidence, and no step collects the user's consent or input selection. Several of those inputs need a human:
- CSV export;
- transcript export;
- GitHub auth;
- choosing a repo with Actions/PR history.

**Correction**
- Split A06:
  - **A06a (T0):** version and presence facts only, reading no personal data. Examples: Cursor version, whether the hooks feature exists, Node version, whether `gh` is authenticated (without reading the token).
  - **A06b (after A02b):** runs the built CLI's `dx probe <source>` on each explicitly selected input. It writes a probe receipt: input hash, detected format and version, record counts, supported fields and reason. No content is stored.
- Add a **pre-T0 input step** owned by root, before the clock starts:
  - the target repo;
  - consented source paths;
  - GitHub read access;
  - an optional CSV file;
  - the Cursor operator.

  Anything missing here is known before T0 as "not attempted", not discovered at T+150.

### H5. Nobody owns an end-to-end test through the real composition
**Evidence**
- C07 is a golden test over B35–B37.
- C02 is a replay test over B01.
- C14 depends only on B35, B36 and C09.

**Problem.** No test runs collect → store → correlation → metrics → report through the composed app. C14 can finish without any live route or collector.

**Correction.** A02b owns the integration test:
- Create a temporary Git repo inside the test, with a commit, a branch and a worktree.
- Add recorded GitHub responses and one AI-route fixture.
- Run the **built** CLI: collect, then analyze twice. Assert identical metric JSON.
- Then rebuild a fresh store from the same inputs and assert the same metric hash.

Also add these C14 dependencies: A02b, A06b, C09b and C13.

### H6. Snapshots don't record which modules were enabled, and B01 has no snapshot requirement
**Evidence**
- The snapshotId rule appears in B35–B39 and C07.
- The B01 plan, which owns "snapshot queries", has no such clause.
- `implementation-spec.md` › Services: "Expired/unknown snapshots produce an explicit error". No expiry policy exists.
- Acceptance requires "same input replay produces the same metrics" and "clean restart works".

**Problem**
- If A02c enables an adapter or metric after an analyze, a later explain with the old snapshotId can recompute with different modules.
- "Expired" is undefined.
- Nothing says snapshots survive a restart.

**Correction.** Add to A03 contracts and B01:
- **Snapshot manifest contents:** snapshotId, store event watermark, flight/context selector, contract digest, enabled descriptor IDs with module versions, metric definition versions, origin mix (live/imported/synthetic) and created-at.
- **Stored durably.** Snapshots live in the durable store, so they survive restart.
- **No expiry in this run.** "Expired" is used only if the underlying events were removed.
- **Version mismatch.** If explain or evidence is asked for a snapshot whose recorded module versions differ from the current registry, return `incompatible_snapshot`. Never recompute with the current modules.
- **Fixture replay stays separate.** It uses a separate store file, so "live and fixture modes never merge silently" is enforced structurally.
- **Analyze writes one thing.** Note that `dx_analyze` writes snapshot metadata only. That is its one allowed mutation, which squares it with "report reads do not silently sync".

### H7. The full check suite runs only once, at the very end, so no phase is a stoppable release
**Evidence**
- The C16 plan: "Required validation is pnpm turbo run check test build, run once".
- The spec: "run by one coordinator after integration".

**Problem**
- A failure found at the end cannot be fixed.
- A stop at T+45 or T+90 has no validated state to show.

**Correction.** Run the fence at every gate (G0–G4) through one shared validation queue owned by A01, then **tag** the passing tree (`v0`, `v1`, `v2`, `release`). "Preserve reviewable output" then means the last green tag. A01's `runtime.md` must define:
- the queue;
- the per-module test and typecheck commands;
- the build output and launch command Cursor uses.

### H8. Half-finished optional code can break the shared fence, including the UI that "never gates" the demo
**Evidence**
- B41/B42 edit `apps/web/`.
- `synthesis.md` says to omit web from the first executable composition.
- The fence builds the whole workspace.
- "Disabled descriptor" is a registry state. It doesn't stop files that fail to type-check.

**Correction.** Add a T+150 rule: a disabled optional lane leaves either
- code and tests that pass the fence, with its descriptor marked `unsupported`, or
- its files removed by the owner, with the removal recorded in the handoff.

No skipped or loosened tests. A01 decides at G0 whether `apps/web` stays in the build graph. If B41/B42 haven't passed by T+150, they are reverted.

### H9. Audit coverage for source capability and privacy has holes
**Evidence**
- C06 covers B05, B06, B07, B10, B45 and B46, but not B08 (a core candidate), B43, B44, B09, B11–B14, B20, B21 or B48.
- C10 covers B37 and B47, but not the collectors that carry raw content: B05 hooks, B07 transcripts, B06 DB.

**Correction**
- C10 core depends on B05, B07, B08 and B37.
- C06 core depends on B05, B07 and B08.
- Every optional adapter's enablement check in A02c requires:
  - its unit test;
  - a safe-rejection test for an unsupported layout;
  - a redaction test if it carries content;
  - an A06b probe receipt before it can be shown as live.

### H10. Plan and manifest path mismatches
- **C13:** the manifest owns `packages/core/test/dx/c13.test.ts`, but the plan scope and command use `packages/core/test/dx/audits/c13.test.ts`.
- **C09, C14, C15, C16:** the commands run `test/dx/audits/cNN.test.ts`, which none of them own.
- **A01–A06:** the commands name `aNN.test.ts`, which none of them own. The same plans also say not to create tautological tests.
- **Double slashes in ownership paths:** `storage//`, `correlation/repo//`, `reports/analyze//`, `cli/commands//`, `mcp/handlers//`.

**Fix.** Give doc and verification nodes an artifact check instead of a vitest command, or add the test file to their owned paths. Normalize the paths, then regenerate the graph. The hash `c8db9d2336` in `hackathon-execution.md` will change.

### H11. Integration work with no owner
Assign each item explicitly:

| Work | Proposed owner |
|---|---|
| Hook command entrypoint Cursor calls (writes the spool) | B05 writes the handler; A02 registers the `dx hook` subcommand |
| Spool/import → EventStore ingestion (`dx collect`) | B38 command, calling B01's writer only |
| Durable store path and config resolution | B01 |
| `packages/core` export for `dx` | A01 adds the export once at G0; A02 owns `packages/core/src/dx/index.ts` |
| Project/user `.cursor/mcp.json`, hooks config, skill install into the demo repo | C13 (the installer) |
| Shared validation queue | A01 |
| Pre-T0 input selection and consent record | Root |
| B29 reusing B27 interval functions | A03 freezes the interval-helper signature; B29 imports B27, with no second implementation |

### H12. Demo and pitch lines promise things the enabled scope may not provide
**Evidence**
- `hackathon-execution.md` › Cursor demonstration: "Inspect a failing/passing attempt, overlapping CI arithmetic". The report shape includes Cost "estimated allocation" and "AI survival".
- Synthesis pitch: "evidence for what slowed its feedback down".

**Problems and corrections**
- **Failures and overlap.** Show them on the real flight only if they actually happened. Otherwise point to the labelled replay.
- **Waiting.** Call the metric "CI feedback latency (trigger → completion)". "Developer blocked time" comes only from B22 markers; otherwise it reads "not recorded".
- **Cost.** "Estimated allocation" needs B31, which is optional. Without B31, show the supplied account-level charge as account-level, with flight allocation "not computed". Never show a flight-level charge from raw CSV.
- **AI survival.** This needs optional B04, B33 and prospective B05 with a named checkpoint. Its default line is "unavailable: no observed lineage". Keep it out of the pitch.
- **The word "retention".** It is used for AI survival, GitHub log retention and snapshots. Use "AI survival" and "source retention gap" instead.
- **Pitch.** The synthesis wording implies cause. Use the `hackathon-execution.md` pitch everywhere, and say "where feedback loops repeated or took longest".
- **Live data timing.** Hooks only capture activity after they are installed. Plan two flights:
  - a look-back flight (Git, GitHub and any exported CSV or transcripts);
  - a short live flight started once v1 is installed.

---

## 2. Suggestions (lower confidence, or design choices)

- **S1. Scheduler priority.** All 25 core and candidate lanes, A02 and the 23 optional lanes exactly fill 49 slots. The starvation happens later: C lanes and fix-backs find no free slot. Proposed policy, a rule and not an estimate:
  - Admit A02, all core and candidate lanes, and C01 first.
  - Admit optional lanes in value order: B47, B21, B20, B18, B06, B43, then the rest, with B41/B42 last.
  - Keep a fixed repair reserve of a few slots. Root picks the number at G0.
  - When a core C node or a core fix-back is ready, pause or close the lowest-priority optional lane.
  - The validation queue runs core first, then audits, then optional.
- **S2. Remove A05 as a prerequisite of all B lanes,** or require it at G0. The manifest already carries ownership, so this edge only adds a serial step.
- **S3. Decide the storage fallback before T0.** If the `node:sqlite` probe fails at G0, say what happens: an Effect-scoped append-only JSONL store behind the same EventStore interface, or no-go. Right now a failure has no pre-set decision.
- **S4. Per-lane typecheck.** 49 writers share one package. Vitest per file won't catch type errors from other lanes. A01 should publish a scoped typecheck command, or the plan should use per-lane worktrees with A02 merging.
- **S5. Root reading load.** Root should read only handoffs that claim `ready`. Disabled optional handoffs go straight to G3 without root review.
- **S6. Split B40's deliverable.** It says "Actual Cursor command invocation", but B40 can only write skill files and test them. Rename it to "skill files + static routing test". The actual invocation belongs to C09.

---

## 3. Controls that already work (keep them)

- **Single ownership** of lockfile, scaffold, contracts, fixture index, registry, migrations and the GitHub broker, plus the A03 write barrier after the A01 scaffold signal.
- **Capacity:** at most 49 workers plus root, and graph commands run as argv arrays so edges are preserved.
- **The C16 AI-route rule:** `count(ready real B05/B07/B08) ≥ 1`, together with "no installed source claimed from a parser fixture".
- **The snapshotId rule:** never swap in the latest snapshot silently, with the C07 test (collect → explain with the old ID).
- **Arithmetic rules:** sum ≠ union, missing ≠ 0, unknown ≠ human, account spend ≠ branch spend, plus the dedupe rules in B26/B30/C05.
- **Deadline rules:** the T+150 disposition, "a stuck node cannot extend T+240", "do not weaken checks", and "core failure → degraded/no-go".
- **Privacy rules:** no cookies/HAR, prompt and log text treated as untrusted, bounded opt-in content, and disclosure that the report goes to the model provider when inserted into chat.
- **Report shape:** the demo report template, with "unavailable / not recorded" wording.

---

## 4. Phase matrix

Work still fans out wide at once after G0. Phases are what gets integrated, validated and tagged, in priority order. Checkpoint times are latest decision points, not estimates.

| Phase | Deliverable (stop output) | Prerequisites | Automated validation (prospective until A01 verifies) | Real demo validation | Stop / cut rule |
|---|---|---|---|---|---|
| **P-1 Inputs (before T0)** | Consent record: target repo, source paths, GitHub read access, optional CSV/transcripts, Cursor operator | User availability | None | None | Missing items marked "not attempted" before the clock starts |
| **P0 Bootstrap / freeze (G0, decide by T+15)** | Pinned scaffold, single install, `runtime.md` (commands, queue, build/launch path), contracts-v1 with snapshot manifest and broker, A05 ownership including the H11 owners, A06a facts | Recorder repo selected | Frozen-lockfile install once; fence baseline on the unmodified scaffold; `node:sqlite` open/transaction/backup probe; built CLI starts; MCP stdio `initialize` + `tools/list` on the built output with protocol version logged; contracts compile | Terminal capture of built CLI and `tools/list` | Scaffold or fence baseline broken and not fixable by A01 → no-go "bootstrap". SQLite fails → pre-set S3 fallback. No B dispatch until contracts frozen |
| **P1 v0 Replay product (G1, decide by T+45)** | Tag `v0`: built CLI + MCP `dx_status`/`dx_analyze` over the A04 golden store, labelled synthetic, coverage table shows every source "not enabled" | G0; A04, B01, B35, B38, B39, B40, A02a | Module tests; built-CLI analyze twice gives identical JSON; stdout is protocol-only on built artifact (C08a); fence | C09a: MCP tool call in Cursor on the fixture store, evidence captured | Missing at T+45 → stop new optional admission, move slots and root attention to the spine. Verdict at worst "replay-only" |
| **P2 v1 Live core (G2; inputs by T+90, done by T+150)** | Tag `v1`: real flight report from live Git, GitHub import (or an explicit access-failure row) and at least one real AI route | G1; B02, B03, B22–B30, B34, B36, B37, B15–B17, one of B05/B07/B08, A02b, A06b; core C02–C07, C10, C11, C12 | Core module tests; core audits; A02b end-to-end test; rebuilding from the same inputs gives the same metric hash; fence | C09b in Cursor on the installed build: `/dx-analyze` then `/dx-explain` with the same snapshotId, source links, coverage | No AI probe receipt at T+90 → back the closest route, disable the others. None by T+150 → "degraded: no AI route". No GitHub access → live row "unavailable"; recorded data only in the labelled replay |
| **P3 v2 Breadth (G3, freeze at T+150)** | Each optional adapter enabled in its own A02c commit; G3 disposition file | G2 green; each adapter's own checks | Per adapter: unit test, unsupported-layout rejection, redaction test where content is carried, probe receipt, registry/snapshot compatibility; fence after each enable | New coverage rows; optional reviews and local feedback shown only if enabled | At T+150: ready → enabled; otherwise disabled-and-passing or reverted (H8). Later landings ignored |
| **P4 Release (G4; fixes only from T+180, rehearsal by T+210, stop at T+240)** | Tag `release`, or a no-go verdict file | G3; C13, C14, C15, C16 | Fence once on the frozen tree; installer dry-run and uninstall in a temporary HOME keep unrelated entries; C02/C12 restart and replay | Restart Cursor/MCP, then explain with a snapshotId from before the restart shows the same facts; labelled adversarial replay; claims check (C15) | At T+240, root writes the verdict with the last green tag, even if C16 hasn't run |

**Verdict file** (C16, or root as fallback):
- **verdict:** one of `live-core`, `degraded-live`, `replay-only` or `no-go`;
- **per gate:** pass/fail with command output paths;
- **route matrix:** each route is `live-verified`, `imported-verified`, `fixture-only`, `unsupported`, `disabled` or `not-attempted`;
- **demo artifacts:** each labelled live or replay.

`fixture-only` exists so nobody can present a parser test as live access.

---

## 5. Graph edit list

1. **Add root-owned gate nodes G0–G4**, each with its phase's minimum dependencies:
   - G0: A01, A03, A05, A06a.
   - G1: G0, A04, A02a, B01, B35, B38, B39, B40, C08a, C09a.
   - G2: G1, the P2 set, and A06b.
   - G3: G2, with **no** optional edges.
   - G4: G3, C13, C14, C15, C16.
2. **Split nodes:** A02 into a/b/c; A06 into a/b; C09 into a/b; C05, C06, C10 and C11 into core parts, with the optional parts moving into A02c checks.
3. **C16:** remove its 23 optional-lane edges and depend on G3.
4. **Add edges:**
   - C13 ← A02a, B05.
   - C09b ← C13, A02b.
   - C14 ← A02b, A06b, C09b, C13.
   - C10 ← B05, B07, B08.
   - C06 ← B08.
5. **Plan text:**
   - B01 gets the snapshot manifest and durable storage rules (H6).
   - The C16 plan says "fence at each gate" instead of "once".
   - Hackathon demo and pitch edits (H12).
   - The Cursor operator statement (H3).
   - H11 owners go into A05 ownership.
   - Test paths are fixed (H10).
6. **Regenerate the graph** and update the ID, hash and edge count in `hackathon-execution.md`, `README.md` and `final-plan-audit.md`.

**What I checked:** I read in full `hackathon-execution.md`, `implementation-spec.md`, `synthesis.md`, and the small docs: README, plan-index, final and research audit, revision ledger, `validate.json`. I read every node and edge in the manifest and the frontier structure. From the plans I read A01–A03 in full and the unique sections of A04–A06, B01, B05, B15, B35–B40, C07–C09 and C12–C16. I extracted the "Final audit requirement" section from every plan that has one.

I did not open the per-lane bodies of every B plan beyond confirming the shared boilerplate, and I read no revision reports. I executed nothing beyond reading files and parsing the JSON.