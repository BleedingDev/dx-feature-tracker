# C12 runtime audit: degraded environments

Test: `packages/core/test/dx/audits/c12.test.ts` (6 tests). Fixtures: `packages/core/test/dx/fixtures/c12/` (`c12-offline-flight`, plus three corrupt spool files). Every case runs against the real B01 SQLite store and the B38 command handlers, in an owned temp dir that is removed afterwards.

| Scenario | What the test does | Observed behavior | Verdict |
|---|---|---|---|
| No GitHub | Runs collect, analyze, explain and status with `GITHUB_TOKEN`/`GH_TOKEN` empty | Full flow succeeds. The report file has no GitHub API references. No collector or metric needs GitHub. | pass |
| Offline | Stubs `fetch` to reject and points `HTTPS_PROXY` at a dead port | Same flow succeeds and `fetch` is never called | pass (fetch only, see gaps) |
| No repo | Runs `git-identity` on a scratch dir that is not a repo, with `GIT_CEILING_DIRECTORIES` set | `SourceUnavailable`: "selected input is not inside a Git working tree". With no selection it gives `InvalidInput`. Status on an empty store shows null snapshot and report. Nothing invents a branch. | pass |
| Store busy | A second `DatabaseSync` connection holds `BEGIN IMMEDIATE`, with the store's busy timeout at 50 ms | `runCollect` gets `StoreBusy` and writes the batch atomically to the spool. After the lock is released, `import` inserts 3 events, and a second import changes nothing. | pass |
| Corrupt spool | Puts garbage, truncated JSON and a wrong-shape batch next to one valid batch | The 3 bad files move to `rejected/`, the valid one imports (3 events), and a rerun changes nothing | pass |
| Corrupt store file | Writes text in place of `events.sqlite` | Typed `StoreError` (`operation: open`, "file is not a database"). No crash. | pass (no recovery path, see gaps) |
| Missing adapter/input | Uses no source, a blank source, `github-actions`, an unknown id, and a missing Cursor `state.vscdb` path | Results are `InvalidInput`, `InvalidInput`, `UnsupportedSource`, `UnsupportedSource` and `SourceUnavailable` ("Selected Cursor local DB does not exist"). The store stays empty. | pass |

## Findings / gaps (for other owners)

1. The offline check only covers `fetch`. Raw `node:net`/`https` sockets are not intercepted. A static review found no `fetch(` or `https://` calls in `packages/core/src/dx`.
2. A corrupt store fails cleanly but the CLI cannot recover from it. The user has to move the file themselves. A07/A02 could print the store path and a hint for `StoreError operation=open`.
3. These tests cover the handler level only. How the argv/MCP surface maps these typed failures to exit codes and messages belongs to A02/A07 and is not audited here.
4. Live Cursor capture is outside C12's scope.
