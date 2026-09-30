# Install the DX Flight Recorder into a Cursor project

`scripts/dx-install.ts` wires the recorder into one project that you choose. It writes only to that project's `.cursor/` folder and never to `~/.cursor`.

## Prerequisites

- Node 24.18.0. Run the installer from the recorder repo root, so proto picks the pinned Node. The hook and MCP commands use the Node binary that ran the installer.
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
| `mcp.json` | Adds `mcpServers["rat-stack"]` = `node <recorder>/apps/cli/dist/cli.js mcp`, with `env.DX_REPO=<target>` (and `DX_STORE` if given). Other servers are kept. |
| `hooks.json` | Appends `node <recorder>/apps/cli/dist/cli.js dx hook` to `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop`, `postToolUse`, `postToolUseFailure`, `afterFileEdit`, `afterTabFileEdit`, `afterShellExecution`, `afterMCPExecution` and `afterAgentResponse`. Existing hooks are kept, and a re-install adds no duplicates. |
| `skills/dx-analyze`, `skills/dx-explain` | Copied from the recorder's `.cursor/skills`. |
| `dx-flight-recorder.install.json` | Ownership manifest. It records exactly what the installer added. |
| `<file>.dx-backup-<timestamp>` | A copy of each file taken before the installer modifies it. |

It also adds `.dx-flight-recorder/` to `<target>/.git/info/exclude`, so the hook spool is never committed.

The installer refuses to proceed, and changes nothing, when:

- a config file is not valid JSON;
- an `mcpServers["rat-stack"]` entry exists that it did not install;
- a skill folder with different content exists that it did not install.

## Capture and analyze

The hooks write sanitized metadata to `<target>/.dx-flight-recorder/cursor-hooks-spool/`. Prompts, responses and command text are dropped. Import the spool into the store, then analyze:

```sh
node apps/cli/dist/cli.js dx collect --source collector.cursor-hooks --input <target>/.dx-flight-recorder/cursor-hooks-spool --repo <target>
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

Uninstall removes only the entries listed in the manifest: the MCP server (if unchanged since install), the recorder hook command, the copied skills and the exclude line. Unrelated entries stay. Files the installer created are deleted once they are empty. A server entry you edited after install is left in place and reported. The hook spool and the event store are user data, so uninstall keeps them.
