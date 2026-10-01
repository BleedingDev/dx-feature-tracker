# Capture install

How `dft install`, `dft install --telemetry`, `dft uninstall` and the OTLP receiver wire each tool to dft (D12, D27, D38, D39). Code: `apps/cli/src/dft-capture.ts`, `dft-telemetry.ts`, `dft-otlp.ts`, `dft-otlp-receiver.ts`, `dft-tools.ts`.

## Project capture (`dft install`)

`dft install` asks `HarnessRegistry.discover` which tools exist (sessions found, or the tool's folder exists) and writes local capture for each. `--tool a,b` adds tools that were not found. Cursor keeps its phase 1 files (`.cursor/hooks.json`, skills, optional git hooks).

| Tool | File written in the project | Calls |
| --- | --- | --- |
| Claude Code | `.claude/settings.local.json` (merged) | `dft hook claude-code <Event>` on SessionStart, SessionEnd, Stop, SubagentStop, PostToolUse; `async: true` |
| Codex | `.codex/hooks.json` (merged) | same events; SessionEnd runs synchronously with a 3 s limit, as Codex requires |
| OpenCode | `.opencode/plugins/dft-usage.js` | `opencodePluginSource` from the tool folder |
| Pi | `.pi/extensions/dft-observer.ts` | `piExtensionSource` |
| OMP | `.omp/extensions/dft-telemetry.ts` | `ompExtensionSource` |
| DeepSeek Harness | `.dsh/dft-hooks.json` and `.dsh/dft.patch.yml` | the patch mounts `@deepseek-ai/dsh-hooks-claude-code` over the hooks file; start dsh with `--patch .dsh/dft.patch.yml` |

Rules:

- Hook files are merged: dft adds one matcher group per event only when no dft command is there yet and never edits other entries. Key order is kept.
- A file tracked by git is never written (teammates would see it). A same-named file without dft's marker is left alone.
- Paths git does not already ignore go into a marked block in this clone's `.git/info/exclude`, never into `.gitignore`.
- Running it again reports every file as unchanged.

What each tool still needs from the user, printed by `dft install`:

- Codex reads `.codex/hooks.json` only in a trusted folder and runs new hooks only after they are approved once in `/hooks`. dft reads `~/.codex/config.toml` to say whether the folder is trusted and never changes it.
- Pi asks once to trust the folder before it loads `.pi/extensions`.
- dsh has no project config, so it needs the `--patch` flag.

## User telemetry (`dft install --telemetry`)

Opt-in and user level. `--dry-run` prints the change without writing. Before writing, each file is copied to `~/.dft/backups/telemetry/<time>/`.

| Tool | Change |
| --- | --- |
| Claude Code | adds `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<port>/v1/logs` to the `env` block of `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) |
| Codex | appends a marked `[otel]` block with `log_user_prompt = false` and an `otlp-http` JSON exporter to `~/.codex/config.toml` (or `$CODEX_HOME`) |

dft only adds. When Claude Code already exports logs (settings or shell `OTEL_LOGS_EXPORTER` with another endpoint) or Codex already has `[otel]`, it refuses and suggests an OpenTelemetry Collector that forwards to both. `~/.dft/telemetry.json` records which keys and files dft added, so `dft uninstall --telemetry` removes exactly those and deletes a file only when dft created it.

## OTLP receiver

`dft dashboard` accepts `POST /v1/logs` (and answers `/v1/metrics`, `/v1/traces` with 200) on its 127.0.0.1 port. Bodies may be OTLP JSON or protobuf, optionally gzip. Requests with an `Origin` header are refused, so a web page cannot post into it.

| Record | Event |
| --- | --- |
| `claude_code.api_request` | `ai.request`, channel `otel`, tokens from `input_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `output_tokens`; `cost_usd` as tool figure `list-price`; request key and `identity.requestId` = `request_id` |
| `codex.sse_event` with `event.kind=response.completed` | `ai.request`, channel `otel`; `input_token_count` includes cached tokens, so fresh input is input minus cached and cache write; request key `codex:<conversation.id>:<event.timestamp>` |

Prompt and response text in the records is never read. Event ids hash the request key, so a resend is a duplicate. The events carry no folder, so their branch comes from correlation (a hook turn of the same session, D28).

## `dft status`

Lists each tool: installed, sessions found, project capture present, user telemetry present (Claude Code and Codex) and the newest stored event for that tool.
