# Install dx-feature-tracker into a Cursor project

`scripts/dx-install.ts` wires dx-feature-tracker into one project that you choose. It writes only to that project's `.cursor/` folder and never to `~/.cursor`.

## Prerequisites

- Node 24.18.0. Run the installer from the dx-feature-tracker repo root, so proto picks the pinned Node. The hook and MCP commands use the Node binary that ran the installer.
- A built CLI: `pnpm exec turbo run build` produces `apps/cli/dist/cli.js`.

## Install

```sh
node scripts/dx-install.ts install --target /path/to/your/project
# optional: --store /path/events.sqlite   (sets DX_STORE for the MCP server)
# optional: --no-hooks                    (MCP + skills only)
# optional: --config-root <dir>           (write somewhere other than <target>/.cursor)
```

What it changes in `<target>/.cursor/`:

| File | Change |
| --- | --- |
| `mcp.json` | Adds `mcpServers["rat-stack"]` = `node <dx-feature-tracker>/apps/cli/dist/cli.js mcp`, with `env.DX_REPO=<target>` (and `DX_STORE` if given). Other servers are kept. |
| `hooks.json` | Appends `node <dx-feature-tracker>/apps/cli/dist/cli.js dx hook` to `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop`, `postToolUse`, `postToolUseFailure`, `afterFileEdit`, `afterTabFileEdit`, `afterShellExecution`, `afterMCPExecution` and `afterAgentResponse`. Existing hooks are kept, and a re-install adds no duplicates. |
| `skills/dx-analyze`, `skills/dx-explain` | Copied from the dx-feature-tracker checkout's `.cursor/skills`. |
| `dx-feature-tracker.install.json` | Ownership manifest. It records exactly what the installer added. A manifest from an older install under the previous name is still read, and replaced on the next install. |
| `<file>.dx-backup-<timestamp>` | A copy of each file taken before the installer modifies it. |

It also adds the old in-repo spool folder to `<target>/.git/info/exclude`, so leftovers from older versions are never committed. The hook spool itself now lives outside the project.

The installer refuses to proceed, and changes nothing, when:

- a config file is not valid JSON;
- an `mcpServers["rat-stack"]` entry exists that it did not install;
- a skill folder with different content exists that it did not install.

## Capture and analyze

The hooks write sanitized metadata to `~/.dft/spool/<worktree>/cursor-hooks/` (or under `$DFT_HOME`). Prompts, responses and command text are dropped. Import the spool into the store, then analyze:

```sh
node apps/cli/dist/cli.js dx collect --source collector.cursor-hooks --repo <target>
node apps/cli/dist/cli.js dx collect --source collector.git-history --input <target> --repo <target>
node apps/cli/dist/cli.js dx analyze --repo <target>
```

To get token counts from a headless `cursor-agent -p --output-format json` run, save its stdout to a file and collect it with `--source collector/cursor-cli --input <file>`.

In Cursor, ask "what did this branch cost?". The `dx-analyze` skill calls `dx_analyze` on the `rat-stack` MCP server.

## Uninstall

```sh
node scripts/dx-install.ts uninstall --target /path/to/your/project
node scripts/dx-install.ts status --target /path/to/your/project
```

Uninstall removes only the entries listed in the manifest: the MCP server (if unchanged since install), the dx-feature-tracker hook command, the copied skills and the exclude line. Unrelated entries stay. Files the installer created are deleted once they are empty. A server entry you edited after install is left in place and reported. The hook spool and the event store are user data, so uninstall keeps them.
