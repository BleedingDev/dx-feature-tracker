# Local DX telemetry without enterprise access

Date: 2026-09-30. Scope: standalone Ratstack recorder adapters; public documentation and synthetic schema only. No user commands, tests, installs, IDE history or private databases were inspected. Version-sensitive references: Node 26.10.0 documentation, npm CLI v11.20.0 documentation, Git documentation identifying 2.51.1 reflog revision; other documentation is current unpinned upstream and therefore must be matched to installed adapter versions before release.

## Decision

Enterprise APIs are unnecessary for a rich, honest local development timeline. The strongest first collector is an explicit command wrapper plus Git context; the strongest independent importer is structured test results. IDE diagnostics/terminal events, shell hooks, package-manager timing, and Vite HMR can run as separate adapters against the same append-only ingest contract. Broader capture is feasible through many agents only if adapters do not own shared report/schema files.

Do not promise universal retroactive reconstruction. Existing Git history, reflogs and retained test/npm artifacts are recoverable evidence. Unsaved edits, deleted logs, process durations not recorded, and user intent cannot be recovered reliably. No local event stream proves whether an edit was human or AI; it needs separate provenance.

## Route matrix

| Adapter / separate owner | Captured signals | Retroactive recovery | Principal limitation / evidence |
|---|---|---|---|
| `command-wrapper` | Start/end wall clock, monotonic duration, cwd, argv classification, exit code/signal, PID, start/end Git SHA, run ID | Only pre-existing process records/logs; ordinary history alone is incomplete | Node subprocess lifecycle distinguishes spawn, error, exit and close; inherited stdio is safest baseline. [Node child processes](https://nodejs.org/api/child_process.html) |
| `shell-zsh` | Interactive command preexec, prompt return, cwd transitions; elapsed prompt loop and captured prior status | Extended history can be imported if present, but adapter must distinguish command duration from shell-hook reconstruction | `preexec` provides typed/expanded command forms, `precmd` runs before prompts, `chpwd` on cwd change. Background jobs and pipelines complicate attribution. [zsh hooks](https://zsh.sourceforge.io/Doc/Release/Functions.html) |
| `ide-terminal` | Terminal execution start/end, command confidence, cwd, optional output stream, reported status | Future only for extension events; selected saved terminal logs can be separate imports | VS Code shell integration provides the APIs, but Cursor capability must be feature-tested; missing status stays unknown. [VS Code API](https://code.visualstudio.com/api/references/vscode-api) |
| `test-vitest` | JSON test identities, statuses, durations, suite timestamps, failures, coverage when enabled | Existing JSON/JUnit/blob outputs where retained | JSON is Jest-compatible; file output avoids interleaved stdout corruption. Watch runs and blob shards need separate run identities. [Vitest reporters](https://vitest.dev/guide/reporters) |
| `test-playwright` | Projects, tests, retries/attempts, results and durations via JSON/custom reporter; blob archive as source evidence | Retained JSON/JUnit/blob artifacts | Retain attempt detail, not only final pass/fail. Import input only; do not trigger merging or execution during analysis. [Playwright reporters](https://playwright.dev/docs/test-reporters) |
| `test-junit` | Suites/cases, failure/error/skipped state, available timestamps/durations | Any explicitly chosen retained JUnit result | JUnit is a family of dialects; validate producer metadata, preserve unknown fields. Pytest can emit JUnit and optional properties. [pytest output](https://docs.pytest.org/en/stable/how-to/output.html) |
| `git-snapshot` | Current branch/detached head, index/worktree status, dirty state, changed files, additions/deletions | Commits and their diffs survive; present dirty state is only current snapshot | Use NUL-delimited machine output; rename/copy records need parsing, binary line counts are unknown. [Git diff](https://git-scm.com/docs/git-diff) |
| `git-reflog` | Reference movement: checkout, commit, amend/rebase/reset and stash movements when present | Local reflogs are especially useful for branch/checkpoint reconstruction | Reflogs are local and expire; documented defaults are 90 days reachable, 30 unreachable, configurable. No claim of complete branch history. [Git reflog](https://git-scm.com/docs/git-reflog) |
| `git-worktrees` | Separate cwd/worktree identity, branch and HEAD; detached state | Current worktree topology; historical topology only if recorded elsewhere | Use `worktree list --porcelain -z`; canonical Git common directory identifies shared repo, worktree path identifies checkout. [Git worktree](https://git-scm.com/docs/git-worktree) |
| `git-stash` | Retained stash checkpoint/diff and stash reference history | Existing stash entries, not dropped/expired objects guaranteed | Treat stash creation as a checkpoint, not proof of interruption or abandoned feature. [Git stash](https://git-scm.com/docs/git-stash) |
| `diagnostics-ide` | Added/resolved diagnostics, severity/code/source/location, document version and diagnostic lifetime | Current diagnostics snapshot; past only if logs/records exist | Record diagnostics through `languages.onDidChangeDiagnostics` + `getDiagnostics`; text-edit events have undo/redo reason but no general author attribution. [VS Code API](https://code.visualstudio.com/api/references/vscode-api) |
| `compiler-typescript` | Compiler run duration/status, compiler phase timing if enabled | Saved build output only | `extendedDiagnostics` exposes compiler time breakdown to identify expensive phases; diagnostic counts are tool output, not productivity scores. [TypeScript option](https://www.typescriptlang.org/tsconfig/extendedDiagnostics.html) |
| `package-npm` | Install/process span plus phase timers, errors and changed lockfile digest | Existing selected debug/timing files | `--timing` creates process-specific timer JSON; npm warns built-in secret redaction is incomplete. Extract allowlisted timing fields without uploading raw logs. [npm logging](https://docs.npmjs.com/cli/v11/using-npm/logging/) |
| `devserver-vite` | Server startup span via wrapper, server file-update events, affected module counts, full reloads | Existing logs only; server event chronology otherwise future capture | `handleHotUpdate` provides file/timestamp/module context; new environments may require `hotUpdate` compatibility. [Vite plugin API](https://vite.dev/guide/api-plugin.html) |
| `hmr-browser` | Client before/after update, error, reload, WS connect/disconnect; per-tab completion | Future capture unless page/browser events already recorded | Client HMR events measure application update lifecycle, not visual correctness or human perception. [Vite HMR API](https://vite.dev/guide/api-hmr.html) |
| `ide-activity` | Edit/save/navigation events and focused window intervals; heartbeat proves collector liveness | Future capture; selected external activity exports could be import adapters | “No events” can mean thinking, terminal work, meetings, adapter failure or offline; never label inactivity as waiting. [VS Code API](https://code.visualstudio.com/api/references/vscode-api) |

## Inspectable common contract (recommendation, not an upstream standard)

```ts
type EvidenceMode = 'captured' | 'imported' | 'reconstructed' | 'estimated';
type Event = {
  schemaVersion: 1;
  eventId: string;             // stable dedupe identity
  source: string; sourceVersion: string; adapterVersion: string;
  kind: string;               // command.started, test.result, git.ref-moved...
  observedAt: string; occurredAt?: string;
  timestampQuality: 'source' | 'capture' | 'file-mtime' | 'unknown';
  evidenceMode: EvidenceMode;
  repoId: string; worktreeId?: string; branch?: string; headSha?: string;
  flightId?: string;          // explicit flight preferred; branch is mutable context
  runId?: string; parentRunId?: string; attempt?: number;
  durationMs?: number;        // monotonic clock for directly captured spans
  artifactId?: string;        // hash of opt-in input, origin/path kept local
  payload: Record<string, unknown>;
};
```

Signal-specific payloads:

```ts
command = { class: 'test'|'build'|'install'|'lint'|'other',
  executable: 'npm', argsRedacted: ['test'], exitCode: 1, signal: null,
  state: 'completed'|'interrupted'|'orphaned'|'spawn-failed',
  headStart: 'abc', headEnd: 'def' };
test = { producer: 'vitest', suiteId: '...', caseId: '...',
  status: 'passed'|'failed'|'skipped'|'unknown', attempt: 0,
  durationMs: 120, failureFingerprint: '...', shard: '1/4' };
diagnostic = { fileId: '...', documentVersion: 12, source: 'ts',
  code: 2322, severity: 'error', range: {startLine: 3, endLine: 3},
  fingerprint: '...', transition: 'added'|'resolved'|'present' };
git = { oldSha: 'abc', newSha: 'def', operation: 'commit',
  pathChanges: [{fileId: '...', additions: 10, deletions: 4}],
  dirty: true, contextConfidence: 'exact'|'inferred'|'unassigned' };
hmr = { updateId: '...', phase: 'server-change'|'client-before'|'client-after',
  browserSessionId: '...', affectedModules: 3, errorFingerprint: null };
```

Use local repository identity + explicit worktree + branch + commit + run ID, not branch alone. Same-name branches across clones, reused names, rebases and 50 agents' simultaneous worktrees otherwise conflate unrelated runs. Capture context at event time. A command whose HEAD/branch changes during execution is ambiguous and must expose both contexts. Dirty state means a SHA does not uniquely identify tested content; include an optional selected-file/content-tree digest. Snapshot full source only by explicit opt-in, never as default telemetry.

Imported artifacts without repo/run metadata must ask for an explicit import binding or remain unassigned. File mtime is an ingestion clue, not a reliable test completion timestamp. Dedupe artifact by content hash and test result by producer/run/case/attempt; never count wrapper, IDE terminal and reporter observations as three separate test runs. Keep all observations linked as evidence for one run.

## Computations that stay honest

- **Observed command wall time:** union intervals for elapsed exposure, sum durations only for aggregate machine work. Report both when parallel. Parent wrappers and nested child runs must not double-count.
- **Failed feedback loops:** group runs by command class and explicit target/test fingerprint; failure then later pass is observed recovery, not proof AI fixed it or a measured benefit caused by tool use.
- **Diagnostic lifetime:** first observed occurrence to first observed resolution with collector coverage; initial snapshot occurrences are left-censored, collector gaps uncertain.
- **HMR latency:** correlate update ID across server and client; prefer same clock domains or record clock offset. Client after-update does not certify paint, successful application behavior or developer attention.
- **Git churn:** sum observed commit diff counts and endpoint diff separately. Neither is AI rewrite rate. Rebase/amend duplicate histories, merges, generated files and renames need explicit policy.
- **Editor activity:** label focused/observed-edit intervals and unobserved gaps; user-declared blocked intervals are a separate event with reason. A running test and no editing never prove personal blocked time.
- **Flakiness:** retained attempts with same test identity are evidence of differing outcomes; environment or source changes prevent automatic classification as flaky.
- **Coverage:** publish adapter enabled periods, heartbeat gaps, files/test targets included, imported artifact count and unknown fields. Prefer “12 recorded local runs; 2 had no result artifact” over fabricated “all local tests.”

## Parallel implementation split and failure containment

Freeze the ingest types and synthetic fixture set centrally; every listed adapter can have its own file/package and fixture owner. Starter high-value lanes: command wrapper, Git snapshots/reflog/worktree, Vitest JSON, generic JUnit, IDE diagnostics/terminal, npm timings, Vite server/client instrumentation. Additional language/test format adapters can be assigned independently without entering the critical integration path.

Adapter acceptance gate: emits schema-valid fixture events; unsupported producer version returns a visible degraded state; duplicate import is idempotent; secrets/raw content absent from default payload; detached/worktree contexts tested; clocks/units explicit; missing exit status/duration stays unknown. A failed optional adapter must not stop report generation. Report recommendation rules consume normalized events and coverage only, never assume every adapter exists.

Command capture uses argv spawning and inherited stdio to preserve interactive behavior; avoid blanket shell parsing. Optional tee recording requires draining both pipes and signal propagation tests. Observer exceptions must not change child exit behavior. Durable started events with missing completion become orphaned spans, never inferred completed durations. Shell hooks should append safely, restore prior status and avoid overriding existing hooks. Never install or globally enable hooks without an explicit operator step.

## Evidence versus inference

| Verdict | Finding |
|---|---|
| SUPPORTED | Stable command lifecycle, structured test artifacts, Git machine formats and editor diagnostic events provide useful non-enterprise data routes, per linked official docs. |
| SUPPORTED | Retrospective local history has concrete gaps: reflog expiry, overwritten report outputs and absent event instrumentation. |
| INFERENCE | A shared adapter contract and run correlation are the simplest way to scale 50 independent agent tasks without shared-file conflicts. |
| CONTESTED / UNAVAILABLE | Universal developer active time, personal CI waiting, AI provenance from text edit events, and complete historical flow cannot be established by these local signals alone. |
| INCONCLUSIVE | Cursor compatibility with each VS Code stable extension event requires an installed-version smoke test; VS Code documentation is precedent, not proof of Cursor behavior. |

Remaining targeted evidence gaps: package-manager-specific pnpm/Bun/Yarn timing schemas; Rust/Go/JVM reporters; operating-system process telemetry; editor local-history formats. These are optional independent discovery/adapter lanes, not prerequisites to the local recorder core.
