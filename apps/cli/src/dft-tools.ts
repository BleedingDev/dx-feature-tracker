// @effect-diagnostics nodeBuiltinImport:off -- dft install and dft status check tool folders, Codex project trust and the store's newest event per tool at the process boundary with synchronous node:fs and node:sqlite calls.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  HarnessHome,
  HarnessRegistry,
  harnessRegistryFor,
} from "@rat-stack/core/dx";
import type { Discovery } from "@rat-stack/core/dx";
import { Effect, Layer, Option, Schema } from "effect";

import {
  CAPTURE_TOOL_NAMES,
  hasCapture,
  isCaptureTool,
  missingCursorHookPaths,
  missingHookPaths,
} from "./dft-capture.js";
import type {
  CaptureInstall,
  CaptureStep,
  CaptureTool,
} from "./dft-capture.js";
import { hasDftHooks } from "./dft-install.js";
import type { TelemetryChange, TelemetryState } from "./dft-telemetry.js";

export interface DetectedTool {
  readonly installed: boolean;
  readonly name: string;
  readonly reason: string | null;
  readonly sessions: number;
  readonly tool: CaptureTool;
}

const isInstalled = (discovery: Discovery, toolDir: string): boolean =>
  discovery.present ||
  existsSync(toolDir) ||
  discovery.roots.some((root) => existsSync(root));

export const detectedFrom = (
  discoveries: readonly Discovery[],
  toolDirOf: (tool: CaptureTool) => string
): readonly DetectedTool[] =>
  discoveries.flatMap((discovery) => {
    const tool = discovery.harness;

    if (!isCaptureTool(tool)) {
      return [];
    }

    return [
      {
        installed: isInstalled(discovery, toolDirOf(tool)),
        name: CAPTURE_TOOL_NAMES[tool],
        reason: discovery.reason,
        sessions: discovery.sessions,
        tool,
      },
    ];
  });

export interface DetectedCursor {
  readonly installed: boolean;
  readonly sessions: number;
}

export const cursorFrom = (
  discoveries: readonly Discovery[],
  cursorDir: string
): DetectedCursor => {
  const discovery = discoveries.find((item) => item.harness === "cursor");

  return discovery === undefined
    ? { installed: existsSync(cursorDir), sessions: 0 }
    : {
        installed: isInstalled(discovery, cursorDir),
        sessions: discovery.sessions,
      };
};

export const discoverTools = (home: string) =>
  Effect.gen(function* discover() {
    const registry = yield* HarnessRegistry;
    const locations = yield* HarnessHome;
    const discoveries = yield* registry.discover;

    return {
      cursor: cursorFrom(discoveries, locations.rootOf("cursor")),
      tools: detectedFrom(discoveries, locations.rootOf),
    };
  }).pipe(
    Effect.provide(
      Layer.merge(harnessRegistryFor(home), HarnessHome.forHome(home))
    )
  );

export const detectTools = (home: string) =>
  discoverTools(home).pipe(Effect.map((found) => found.tools));

const projectPath = (value: string): string => value.replaceAll('"', '\\"');

export const codexTrusts = (configText: string, folder: string): boolean => {
  const header = `[projects."${projectPath(folder)}"]`;
  const lines = configText.split("\n").map((line) => line.trim());
  const start = lines.indexOf(header);

  if (start === -1) {
    return false;
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("["));
  const body = end === -1 ? rest : rest.slice(0, end);

  return body.some((line) =>
    /^trust_level\s*=\s*["']trusted["']\s*$/u.test(line)
  );
};

export const codexTrusted = (
  codexDir: string,
  folders: readonly string[]
): boolean => {
  const file = path.join(codexDir, "config.toml");

  if (!existsSync(file)) {
    return false;
  }

  const text = readFileSync(file, "utf-8");

  return folders.some((folder) => codexTrusts(text, folder));
};

const LastEventSchema = Schema.Struct({
  harness: Schema.String,
  last: Schema.NullOr(Schema.String),
});

const decodeLastEvents = Schema.decodeUnknownOption(
  Schema.Array(LastEventSchema)
);

const LAST_EVENT_SQL =
  "SELECT json_extract(body, '$.ai.harness') AS harness, max(coalesce(occurred_at, observed_at)) AS last FROM events WHERE json_extract(body, '$.ai.harness') IS NOT NULL GROUP BY 1";

export const lastEventTimes = (
  storePath: string
): ReadonlyMap<string, string> => {
  if (!existsSync(storePath)) {
    return new Map();
  }

  try {
    const db = new DatabaseSync(storePath, { readOnly: true });

    try {
      const rows = decodeLastEvents(db.prepare(LAST_EVENT_SQL).all());

      return Option.match(rows, {
        onNone: () => new Map<string, string>(),
        onSome: (list) =>
          new Map(
            list.flatMap((row) =>
              row.last === null ? [] : [[row.harness, row.last] as const]
            )
          ),
      });
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
};

export interface ToolStatus {
  readonly installed: boolean;
  readonly lastEvent: string | null;
  readonly missingHookPaths: readonly string[];
  readonly name: string;
  readonly projectCapture: boolean;
  readonly sessions: number;
  readonly tool: CaptureTool | "cursor";
  readonly userTelemetry: boolean | null;
}

const telemetryFor = (
  tool: CaptureTool,
  telemetry: TelemetryState
): boolean | null => {
  switch (tool) {
    case "claude-code": {
      return telemetry.claudeCode;
    }

    case "codex": {
      return telemetry.codex;
    }

    case "deepseek":
    case "omp":
    case "opencode":
    case "pi": {
      return null;
    }

    default: {
      return null;
    }
  }
};

export const cursorStatus = (
  cursor: DetectedCursor,
  worktree: string,
  lastEvents: ReadonlyMap<string, string>
): ToolStatus => ({
  installed: cursor.installed,
  lastEvent: lastEvents.get("cursor") ?? null,
  missingHookPaths: missingCursorHookPaths(worktree),
  name: "Cursor",
  projectCapture: hasDftHooks(worktree),
  sessions: cursor.sessions,
  tool: "cursor",
  userTelemetry: null,
});

export const toolStatuses = (
  detected: readonly DetectedTool[],
  worktree: string,
  telemetry: TelemetryState,
  lastEvents: ReadonlyMap<string, string>,
  cursor: DetectedCursor | null = null
): readonly ToolStatus[] => [
  ...(cursor === null ? [] : [cursorStatus(cursor, worktree, lastEvents)]),
  ...detected.map((item) => ({
    installed: item.installed,
    lastEvent: lastEvents.get(item.tool) ?? null,
    missingHookPaths: missingHookPaths(item.tool, worktree),
    name: item.name,
    projectCapture: hasCapture(item.tool, worktree),
    sessions: item.sessions,
    tool: item.tool,
    userTelemetry: telemetryFor(item.tool, telemetry),
  })),
];

const yesNo = (value: boolean): string => (value ? "yes" : "no");

export const toolsText = (statuses: readonly ToolStatus[]): string => {
  const width = Math.max(...statuses.map((status) => status.name.length), 4);

  const lines = statuses.map((status) => {
    const parts = [
      status.installed ? "installed" : "not found",
      `${String(status.sessions)} sessions`,
      status.missingHookPaths.length === 0
        ? `project capture ${yesNo(status.projectCapture)}`
        : `project capture broken (its hooks call missing ${status.missingHookPaths.join(", ")}; run dft install again)`,
      ...(status.userTelemetry === null
        ? []
        : [`telemetry ${yesNo(status.userTelemetry)}`]),
      `last event ${status.lastEvent ?? "never"}`,
    ];

    return `  ${status.name.padEnd(width)}  ${parts.join(", ")}`;
  });

  return ["Tools", ...lines].join("\n");
};

const rel = (worktree: string, file: string): string => {
  const relative = path.relative(worktree, file);

  return relative.startsWith("..") || path.isAbsolute(relative)
    ? file
    : relative;
};

const stepLine = (worktree: string, item: CaptureStep): string => {
  const where = rel(worktree, item.path);

  switch (item.action) {
    case "unchanged": {
      return `  ✓ ${where} (already there)`;
    }

    case "skipped": {
      return `  - ${where}: ${item.detail}`;
    }

    case "created":
    case "removed":
    case "updated": {
      return `  ✓ ${where} ${item.action}: ${item.detail}`;
    }

    default: {
      return `  ✓ ${where}: ${item.detail}`;
    }
  }
};

export interface CaptureNotes {
  readonly codexTrusted: boolean;
}

const toolNote = (tool: CaptureTool, notes: CaptureNotes): string | null => {
  switch (tool) {
    case "codex": {
      return notes.codexTrusted
        ? "Codex runs new hooks only after you review them once: start Codex here and approve them in /hooks."
        : "Codex reads .codex/hooks.json only in trusted folders, and this one is not trusted yet: trust it when Codex asks on start, then approve the hooks in /hooks. dft did not change ~/.codex.";
    }

    case "deepseek": {
      return "dsh has no project config: start it with dsh --patch .dsh/dft.patch.yml so it calls dft. dft did not change ~/.dsh.";
    }

    case "omp": {
      return "OMP loads .omp/extensions on its next start.";
    }

    case "opencode": {
      return "OpenCode loads .opencode/plugins on its next start.";
    }

    case "pi": {
      return "Pi asks once to trust this folder before it loads .pi/extensions.";
    }

    case "claude-code": {
      return null;
    }

    default: {
      return null;
    }
  }
};

export const captureText = (
  worktree: string,
  detected: readonly DetectedTool[],
  install: CaptureInstall,
  notes: CaptureNotes
): string => {
  const done = new Set(install.tools.map((capture) => capture.tool));

  const blocks = install.tools.map((capture) => {
    const name = CAPTURE_TOOL_NAMES[capture.tool];
    const live = capture.steps.some((item) => item.action !== "skipped");

    const note = live
      ? toolNote(capture.tool, notes)
      : `Live capture is off for ${name} in this folder because dft wrote nothing here; dft still reads its session files on each sync.`;

    return [
      name,
      ...capture.steps.map((item) => stepLine(worktree, item)),
      ...(note === null ? [] : [`  ${note}`]),
    ].join("\n");
  });

  const missing = detected.flatMap((item) =>
    done.has(item.tool) ? [] : [item.name]
  );

  const ignore = install.ignore.map((item) => `  ✓ ${item.detail}`);

  return [
    "Tool capture (this folder only, never committed)",
    ...blocks,
    ...(ignore.length === 0 ? [] : [["Git", ...ignore].join("\n")]),
    ...(missing.length === 0
      ? []
      : [
          `Not found on this machine, so skipped: ${missing.join(", ")}. Add one anyway with --tool <id>.`,
        ]),
  ].join("\n\n");
};

export const uninstallText = (
  worktree: string,
  steps: readonly CaptureStep[]
): string =>
  steps.length === 0
    ? "Nothing to remove: dft found none of its capture files in this folder."
    : [
        "Removed what dft added (everything else kept)",
        ...steps.map((item) => stepLine(worktree, item)),
      ].join("\n");

const TELEMETRY_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
} as const;

export const telemetryText = (
  changes: readonly TelemetryChange[],
  footer: string
): string => {
  const blocks = changes.map((change) => {
    const head = `${TELEMETRY_NAMES[change.tool]}: ${change.path}`;

    return [
      head,
      `  ${change.action}: ${change.message}`,
      ...change.lines.map((line) => `    ${line}`),
      ...(change.backup === null ? [] : [`  backup: ${change.backup}`]),
    ].join("\n");
  });

  return [
    "User telemetry (OpenTelemetry to this machine only)",
    ...blocks,
    footer,
  ].join("\n\n");
};
