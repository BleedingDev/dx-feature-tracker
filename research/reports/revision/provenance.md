# No-Enterprise AI provenance: Cursor, Git AI, Entire, snapshots

Research date: 2026-09-30. Scope: separate dx-feature-tracker, optional upstream adapters. Evidence gathered from official docs, GitHub APIs and pinned source; no installation, clone, execution of collectors, or personal data inspection.

## Verdict

**A blanket “AI attribution and tokens are unavailable without Enterprise” is wrong.** Cursor edit hooks give live evidence, current Entire code consumes optional per-turn tokens from Cursor stop hooks, and published Cursor JSONL fixtures contain file-writing tool calls. Historical gaps remain, but direct hooks plus snapshot tracking can produce useful, honest retention evidence. Ship capability detection and coverage rather than an all-or-nothing integration.

**Recommended mandatory path:** project hooks → immutable raw events + before/after blobs → deterministic line ownership projector → survival at an explicitly named commit. In parallel, implement independent optional import adapters for Cursor JSONL, Git AI stats/authorship notes, Entire checkpoint metadata and VS Code local history. They must not block the live demo or redefine the common event contract.

## Evidence pins and sources

1. [Cursor hook reference](https://prod.cursor.com/docs/hooks): common fields, project hooks, direct Agent/Tab edit events, generic pre/post tool hooks; read 2026-09-30. Docs are rolling, record cursor_version per event.
2. [Entire Cursor types at 3fc8c2](https://github.com/entireio/cli/blob/3fc8c2a7bbcc7891e3745b863b35175d5794e1a9/cmd/entire/cli/agent/cursor/types.go): exact optional stop-token input fields; transcript tool names.
3. [Entire Cursor lifecycle at same pin](https://github.com/entireio/cli/blob/3fc8c2a7bbcc7891e3745b863b35175d5794e1a9/cmd/entire/cli/agent/cursor/lifecycle.go): null token semantics and input/cache normalization.
4. [Entire Cursor integration evidence](https://github.com/entireio/cli/blob/3fc8c2a7bbcc7891e3745b863b35175d5794e1a9/cmd/entire/cli/agent/cursor/AGENT.md): IDE nested versus CLI flat transcripts; published probe limitations; actual tool blocks verified 2026-08-24.
5. [Entire checkpoint metadata types](https://github.com/entireio/cli/blob/3fc8c2a7bbcc7891e3745b863b35175d5794e1a9/api/checkpoint/metadata.go): optional usage, attribution metric_version, transcript offsets, session metrics.
6. [Entire sessions/checkpoints architecture](https://github.com/entireio/cli/blob/3fc8c2a7bbcc7891e3745b863b35175d5794e1a9/docs/architecture/sessions-and-checkpoints.md): storage/backends, full versus compact transcript boundaries.
7. [Entire attribution architecture](https://github.com/entireio/cli/blob/3fc8c2a7bbcc7891e3745b863b35175d5794e1a9/docs/architecture/attribution.md): explicitly inferred attribution using per-file pools, not exact keystroke/line authorship.
8. [Git AI Cursor collector at 0670e7e](https://github.com/git-ai-project/git-ai/blob/0670e7ef27590af0e8ff5409267f3f4b09b8fcb4/src/commands/checkpoint_agent/presets/cursor.rs): pre/post tool hooks, files and shell classification, path normalization.
9. [Git AI authorship serialization](https://github.com/git-ai-project/git-ai/blob/0670e7ef27590af0e8ff5409267f3f4b09b8fcb4/src/authorship/authorship_log_serialization.rs) and [records](https://github.com/git-ai-project/git-ai/blob/0670e7ef27590af0e8ff5409267f3f4b09b8fcb4/src/authorship/authorship_log.rs): authorship/3.0.0 and prompt records.
10. [Git AI commit stats](https://usegitai.com/docs/get-started/commit-stats): machine-readable per-commit/range counts; ai_accepted currently equals ai_additions.
11. [Cursor checkpoints](https://prod.cursor.com/docs/agent/overview): local snapshots separate from Git; official documentation gives no external schema contract.
12. [VS Code history implementation at 56db16e](https://github.com/microsoft/vscode/blob/56db16eecfd750776f3a6f40e21658953c35d510/src/vs/workbench/services/workingCopy/common/workingCopyHistoryService.ts): entries.json schema, saved blobs, replacement within merge window, capped entries. Upstream VS Code evidence; Cursor compatibility needs adapter probe.

## Routes, readiness and meaning

| Route | Concrete captured/imported data | Readiness | Honest use |
|---|---|---|---|
| Direct Cursor project Agent hooks | conversation/generation/model/version, file edits, tool start/end, duration | Core adapter; verify installed version with probe fixture | Agent activity, edit provenance, observed feedback timing |
| Cursor Tab hooks | afterTabFileEdit detailed range and old/new line | Core separate adapter | Accepted inline edit provenance; not shown/rejected completions |
| Cursor stop tokens | Optional input_tokens/output_tokens/cache_read_tokens/cache_write_tokens seen by Entire | Opportunistic supported-by-upstream implementation; official docs currently omit them | Observed subset tokens; exact bill not implied |
| Cursor JSONL | roles/text, Write/StrReplace inputs, paths, prompts | Import adapter with version/sample detector | Recover generated/applied candidate contents; snapshot replay if preimages known |
| Git AI stats + notes | Committed human/unknown/AI additions, agent/model, attested ranges | Optional existing-install/import adapter | Commit AI share; follow attested lines to later head |
| Entire checkpoints | session IDs, files, timestamps, optional usage, full/compact transcript, inferred attribution | Optional existing-install/import adapter | Session history and imported observations with estimator label |
| VS Code local history | saved file bytes + timestamps + resource URI | Experimental Cursor-compatibility importer | Reconstruct edit sequence; timestamps alone do not establish AI authorship |
| Cursor built-in checkpoint store | Agent-generated snapshots exist locally | Experimental discovery only until published schema/sample validated | Potential pre/post content; not critical path |

No collector must automatically initialize Git AI/Entire, install hooks, or push refs as a side effect of `analyze`. Import what exists, describe missing coverage, offer an explicit future setup step.

## Exact source inputs and proposed normalized fields

The snippets below are synthetic minimal valid shapes derived from the cited contracts; preserve raw payloads and unknown keys.

### Cursor hooks

All session hook payloads supply common fields such as conversation_id, generation_id, hook_event_name, cursor_version, workspace_roots, model; model_id/model_params can exist; transcript_path can be null. Do not persist user_email by default. Direct Agent edit input:

```json
{"conversation_id":"c1","generation_id":"g1","hook_event_name":"afterFileEdit","cursor_version":"detected","workspace_roots":["/repo"],"file_path":"/repo/src/a.ts","edits":[{"old_string":"return 1;","new_string":"return 2;"}]}
```

Tab input additionally carries each edit's range `{start_line_number,start_column,end_line_number,end_column}`, old_line and new_line. Keep coordinate units/source explicit; fixture-probe index base and Unicode behavior rather than guessing. Generic preToolUse and postToolUse supply tool_name, tool_input, tool_use_id; post has tool_output and duration. `duration` is tool milliseconds, not full model latency. Preserve tool_use_id as data, including possible newline, not a filename.

Use generic pre-tool snapshot plus post-tool snapshot for Write/StrReplace/Delete/ApplyPatch. afterFileEdit is useful confirmation and fallback; avoid counting both as two generations. Agent file-edit strings alone do not locate repeated text unambiguously. Cache a preimage and capture the postimage; if missing, label range reconstruction ambiguous instead of choosing the first match. Tab hooks have stronger range evidence.

### Optional stop tokens

Entire's current parser accepts:

```json
{"conversation_id":"c1","generation_id":"g1","hook_event_name":"stop","status":"completed","loop_count":0,"input_tokens":5000,"output_tokens":200,"cache_read_tokens":4000,"cache_write_tokens":800}
```

Upstream treats total input as inclusive of the cache portions; fresh input = total input − cache read − cache write (example: 200). It returns nil when no usable input/output fields exist. Our adapter should preserve presence separately from zero, retain raw totals and anomalies, and mark inconsistent cache counts rather than silently presenting a valid bill. Missing ≠ 0. Official current Cursor docs describe stop status/loop fields but do not promise these token fields; capability detection is mandatory. Entire tests demonstrate parser behavior, not guaranteed availability on the user's installed Cursor. Record source `cursor.stop.optional-usage`, cursor_version, conversation/generation identity and dedup key. Dedup repeated stop emissions; don't assume every loop is an independent billed request. Context_tokens from preCompact is window size/current occupancy, NOT cumulative billed tokens.

### Cursor transcript JSONL

Published Entire fixture/code parses:

```jsonl
{"role":"user","message":{"content":[{"type":"text","text":"<user_query>make a file</user_query>"}]}}
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"path":"/repo/src/a.ts","contents":"export const a = 1;\n"}}]}}
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"StrReplace","input":{"path":"/repo/src/a.ts","old_string":"1","new_string":"2"}}]}}
```

File locations observed upstream: `~/.cursor/projects/<sanitized-repo-path>/agent-transcripts/<conversation-id>.jsonl` for flat CLI, `<conversation-id>/<conversation-id>.jsonl` for nested IDE. Prefer hook-provided path, scope imports to an explicitly selected repo/session, validate containment. Entire sanitizer replaces non-alphanumeric repo-path chars with hyphens and strips initial slash; do not treat that lossy path mapping as unique repo identity.

Transcript content blocks lack guaranteed IDs/timestamps/usage. Byte-offset watermark and content hash + line index identify records; wait for complete newline, handle truncation/rotation. A recorded tool_use can be an attempted call, so mark applied only with successful hook/output or validated postimage. Shell commands may change files without explicit path/content; capture repo diffs around a scoped shell execution as inferred agent-window edits, flag concurrent edits. Do not parse arbitrary shell into supposedly complete write sets.

### Entire checkpoint import

Read both current per-checkpoint refs `refs/entire/checkpoints/<last-two-id-chars>/<id>` and legacy `entire/checkpoints/v1` layouts. Use checkpoint CLI JSON when present/version-tested; direct read-only Git tree import avoids installation dependency. Current IDs are ULIDs, legacy IDs 12-hex. Root metadata sessions[] points to session metadata/full/compact files; session Metadata includes `session_id`, `created_at`, `branch`, optional `commit_sha`, `model`, `checkpoint_transcript_start`, nullable `compact_transcript_start`, optional `token_usage`, `session_metrics`, `initial_attribution`. Root `combined_attribution` and token_usage aggregate sessions; NEVER add root totals and session totals together.

Usage metadata keys: input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, api_call_count. These normalized input_tokens can mean fresh input unlike raw Cursor stop inclusive input. Preserve input_semantics. Checkpoints_count means aggregate prompt-window steps, not necessarily number of checkpoint records. Imported commit_sha can be only a display anchor; not evidence a turn wrote that commit.

Full transcripts are cumulative per checkpoint. Slice using checkpoint_transcript_start for raw full.jsonl. Compact transcript has its own compact_transcript_start; absent marker means legacy delta, and one merged message overlap can repeat across boundaries. Dedup sessions/checkpoint windows; do not sum every cumulative transcript's tokens. Oversized compact generation may be absent; full remains authoritative.

Attribution keys include agent_lines, agent_removed, human_added, human_modified, human_removed, total_committed, total_lines_changed, agent_percentage and optional metric_version. Version 2 percentage uses `(agent_lines + agent_removed)/total_lines_changed`; absent/0 is legacy additions-focused. Entire uses aggregate/per-file user-edit pool heuristics; expose this as `estimated_commit_attribution`, NEVER `exact_ai_retention`.

### Git AI import

Prefer `git ai stats <base>..<head> --json` read-only adapter where installed. Stable documented keys: human_additions, unknown_additions, ai_additions, ai_accepted, git_diff_deleted_lines, git_diff_added_lines, tool_model_breakdown. Unknown additions are a first-class category.

Current authored-note serialization has line attestation prefix (file names then author hashes plus ranges), separator `---`, then JSON metadata with schema_version=`authorship/3.0.0`, git_ai_version, base_commit_sha, prompts and optional humans/sessions. It is NOT plain JSON. PromptRecord carries agent_id, human_author?, messages_url?, total_additions, total_deletions, accepted_lines, overriden_lines (source spelling), custom_attributes?. Agent identity and ranges can seed our ledger at the source commit. Never fetch messages_url automatically or assume notes come with normal code fetch.

Current Git AI Cursor preset supports preToolUse/postToolUse and explicitly rejects legacy beforeSubmitPrompt/afterFileEdit wiring for its collector. It supports file-edit and shell classes; path aliases file_path/path/filePath, ApplyPatch extraction, and Windows path normalization. Copying old hook setup is a known breakage risk.

### Local history/checkpoint experiment

VS Code entries.json shape: `{version:1,resource:"file:///repo/src/a.ts",entries:[{id:"abcd.ts",timestamp:1700000000000,source?:"...",sourceDescription?:"..."}]}`; each id names a adjacent full-content blob. Saves in the configured merge window can replace prior entries; max entries prune old versions. Thus saved snapshots are incomplete, not a keystroke log, and ordinary default saves are not human provenance. Match timestamps to independently captured agent events only as inferred correlation. The Cursor built-in checkpoint docs establish snapshots but no public exact on-disk schema. Give an independent explorer agent a synthetic exported sample/version contract, not a promise that every Cursor version exposes a known file layout.

## Deterministic survival contract: parallelizable implementation

Define immutable edit units: source_event_id, repository_id, worktree_id, flight_id, session_id?, generation_id?, tool_use_id?, path_before/path_after, before_blob_sha, after_blob_sha, actor (`agent|human|unknown`), actor_evidence, captured_at, source_timestamp?, source_version, confidence, gaps[]. Store blobs locally with retention/opt-in; avoid uploading code.

1. Compute Myers/patience line diffs between ordered before/after snapshots; map unchanged line IDs forward and introduce fresh IDs for additions. Line ID binds file lineage + origin event + insertion ordinal, never content hash alone.
2. Removed AI IDs become removed; human replacement inserts human IDs only when actor evidence is explicit. Uninstrumented changes become unknown, not automatically human. Agent rewrites remain AI edits and separately count replacement/churn.
3. At final head/review/merge snapshot, surviving origin IDs are retained. Record target SHA and comparison baseline. File rename/move detection needs confidence; line move support is a separate matcher and cannot silently change strict retention.
4. Expose two separate metrics: `observed_ai_inserted_line_survival = surviving_observed_AI_origin_lines / observed_AI_inserted_line_instances`; `committed_ai_share = AI_attributed_added_lines / all_commit_added_lines`. First counts line instances; repeated regeneration creates new instances, so churn lowers survival. Second is composition, not acceptance.
5. `human_rewritten_observed_AI_lines` requires an observed human edit replacing AI-origin lines. No human edit attribution? report `observed_AI_lines_changed_or_removed`, not human rewrite. Retention + rewrite need not sum to 100% because removed, AI-regenerated, ambiguous, unknown and surviving cases differ.
6. Coverage accompanies every number: observed start/end, capture enabled since, sessions covered, generated lines covered, unknown changed lines, missing preimages and unsupported tools. Zero denominator yields null/“not enough observed generation”, never 0% or 100%.

A pure exact-line projector is feasible to assign independently once edit-unit schema freezes. Fuzzy AST/normalized-text similarity is another optional projector, explicitly `estimated_semantic_survival`; do not mix whitespace-tolerant and exact metrics or suggest quality/productivity causality.

## Independent agent ownership

- Agent A direct generic Agent hooks and before/after snapshot producer; consumes frozen event schema.
- Agent B Tab afterTabFileEdit adapter and coordinate fixtures.
- Agent C optional stop usage parser, dedup and coverage; never edits ingestion/schema.
- Agent D Cursor JSONL importer and partial-line/rotation handling.
- Agent E Git AI stats importer plus versioned notes parser; works on synthetic files.
- Agent F Entire checkpoint importer and cumulative-window dedup.
- Agent G deterministic line-ID survival projector (pure module).
- Agent H rename/move/formatting matcher experiment (separate output).
- Agent I adversarial provenance fixtures and expected metrics.
- Agent J optional local history importer/version detector.
- Agent K capture capability doctor: confirms supported hook events from synthetic live session and prints coverage.
- Agent L attribution semantics reviewer: rejects denominator/cost/rewritten claims inconsistent with source evidence.

Contract freeze is a dependency, not an excuse for sequential implementation. A/B/C/D/E/F/J all normalize into source events independently; G uses synthetic canonical edit events before collectors exist; I can test G immediately; UI/MCP consumes synthetic report JSON. No shared-file edits except contract owner.

## Fixtures required to unlock honest demo

Single AI insert→unchanged commit; AI insert→human rewrite; AI insert→AI rewrite; identical braces/blank lines repeated; repeated old_string occurrence; missing preimage; edit hook + generic post duplication; two concurrent agents same file; two branches/worktrees one repo; format-only rewrite; rename; delete/recreate; rollback; shell write with unrelated human save; rejected/failed tool call; nested/flat transcripts; partial JSONL line and file truncation; missing tokens vs explicit zero; inclusive cached tokens; inconsistent negative/count totals; duplicate stop event; Entire cumulative transcript repeated checkpoints and compact overlap; absent Entire metric_version; Git AI unknown additions; absent attribution notes; local-history merge-window overwrite.

## Most damaging traps

Claiming enterprise absence blocks all capture; claiming source support guarantees installed-version behavior; deriving 100% retention from ai_accepted/ai_additions; calling Entire heuristic exact; counting proposed tool calls as applied; counting every hook twice; correlating by branch name alone; assigning all unobserved edits to humans; hashing `}` as a unique line identity; attributing all filesystem changes during parallel agent activity to one agent; treating context occupancy as token spend; adding cached tokens twice; claiming provider list-price estimate equals Cursor bill; omitting uncovered sessions/lines; importing all personal chats; pushing Entire/Git AI metadata automatically.

## Evidence versus inference

| Finding | Verdict | Boundary |
|---|---|---|
| Cursor offers project Agent and Tab edit hooks without enterprise hook distribution | SUPPORTED | Installed version/trusted workspace still needs runtime check |
| Current Entire code consumes optional Cursor stop token fields | SUPPORTED | Undocumented by current official hook page; availability varies |
| Published Cursor JSONL contains file-writing tool calls | SUPPORTED | Historical transcript/version retention may differ; success evidence separate |
| Entire attribution is inferred with aggregate/per-file heuristics | SUPPORTED | Not suitable as exact retention |
| Snapshot line-ID projector enables observed strict survival without Enterprise | SUPPORTED as implementable design / INFERENCE on actual coverage | Only captured edits; concurrent ambiguity remains |
| Cursor local history matches upstream VS Code schema | INCONCLUSIVE until version/sample tested | Upstream schema is known; Cursor fork compatibility not guaranteed |
| Built-in Cursor checkpoints offer a stable external schema | INCONCLUSIVE | Documentation establishes feature, not adapter contract |

No runtime claim in this report has been verified against the user's Cursor installation. The capability-probe agent and synthetic adapter fixtures are explicit plan requirements, not hidden user prerequisites.
