// @effect-diagnostics nodeBuiltinImport:off -- dft install --telemetry edits the user's Claude Code settings and Codex config at the process boundary, with a backup, using synchronous node:fs calls.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  copyPrivateFile,
  ensurePrivateDir,
  writePrivateFile,
} from "@rat-stack/core/dx";
import { Result, Schema, Struct } from "effect";

export const otlpLogsEndpoint = (port: number): string =>
  `http://127.0.0.1:${String(port)}/v1/logs`;

export const claudeTelemetryEnv = (port: number) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: otlpLogsEndpoint(port),
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
  OTEL_LOGS_EXPORTER: "otlp",
});

export const CODEX_BLOCK_START =
  "# >>> dft telemetry (dft uninstall --telemetry removes this block)";

export const CODEX_BLOCK_END = "# <<< dft telemetry";

export const codexTelemetryBlock = (port: number): string =>
  [
    CODEX_BLOCK_START,
    "[otel]",
    "log_user_prompt = false",
    `exporter = { otlp-http = { endpoint = ${JSON.stringify(otlpLogsEndpoint(port))}, protocol = "json" } }`,
    CODEX_BLOCK_END,
  ].join("\n");

export type TelemetryAction =
  | "added"
  | "updated"
  | "unchanged"
  | "refused"
  | "removed"
  | "missing"
  | "skipped";

export interface TelemetryChange {
  readonly action: TelemetryAction;
  readonly backup: string | null;
  readonly lines: readonly string[];
  readonly message: string;
  readonly path: string;
  readonly tool: "claude-code" | "codex";
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

const SettingsSchema = Schema.StructWithRest(
  Schema.Struct({ env: Schema.optional(JsonObjectSchema) }),
  [JsonObjectSchema]
);

type Settings = typeof SettingsSchema.Type;

const decodeJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Json)
);

const isSettings = Schema.is(SettingsSchema);

const parseSettings = (text: string): Settings | null => {
  const decoded = decodeJson(text);

  return Result.isSuccess(decoded) && isSettings(decoded.success)
    ? decoded.success
    : null;
};

const LOG_EXPORT_KEYS = [
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

const stringValue = (value: Schema.Json | undefined): string | null =>
  Schema.is(Schema.String)(value) ? value : null;

const present = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

export type ShellEnv = Readonly<Record<string, string | undefined>>;

const exportConflict = (
  settingsEnv: Readonly<Record<string, Schema.Json>>,
  shell: ShellEnv,
  ours: Readonly<Record<string, string>>
): string | null => {
  const effective = (key: string): string | null =>
    present(stringValue(settingsEnv[key])) ?? present(shell[key]);

  const exporter = effective("OTEL_LOGS_EXPORTER");

  if (exporter === null) {
    return null;
  }

  const endpoint =
    effective("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") ??
    effective("OTEL_EXPORTER_OTLP_ENDPOINT");

  if (
    exporter === ours.OTEL_LOGS_EXPORTER &&
    endpoint === ours.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  ) {
    return null;
  }

  const where = LOG_EXPORT_KEYS.some(
    (key) => present(stringValue(settingsEnv[key])) !== null
  )
    ? "your Claude Code settings"
    : "your shell environment";

  return `Claude Code already exports OpenTelemetry logs (OTEL_LOGS_EXPORTER=${exporter}${endpoint === null ? "" : `, endpoint ${endpoint}`}) from ${where}. dft does not replace it. To keep it and add dft, send it through an OpenTelemetry Collector that forwards logs to both, with dft's receiver at ${ours.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? ""}.`;
};

const stamp = (now: Date): string =>
  now
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/u, "Z");

const backupFile = (
  file: string,
  backupDir: string,
  name: string
): string | null => {
  if (!existsSync(file)) {
    return null;
  }

  ensurePrivateDir(backupDir);

  const target = path.join(backupDir, name);
  copyPrivateFile(file, target);

  return target;
};

export interface TelemetryOptions {
  readonly backupRoot: string;
  readonly claudeDir: string;
  readonly codexDir: string;
  readonly dryRun: boolean;
  readonly now: Date;
  readonly port: number;
  readonly shell: ShellEnv;
  readonly stateFile: string;
}

const TelemetryRecordSchema = Schema.Struct({
  claudeKeys: Schema.Array(Schema.String),
  claudeValues: Schema.Record(Schema.String, Schema.String),
  created: Schema.Array(Schema.String),
});

type TelemetryRecord = typeof TelemetryRecordSchema.Type;

const decodeRecord = Schema.decodeUnknownResult(
  Schema.fromJsonString(TelemetryRecordSchema)
);

const emptyRecord: TelemetryRecord = {
  claudeKeys: [],
  claudeValues: {},
  created: [],
};

const readRecord = (file: string): TelemetryRecord => {
  if (!existsSync(file)) {
    return emptyRecord;
  }

  const decoded = decodeRecord(readFileSync(file, "utf-8"));

  return Result.isSuccess(decoded) ? decoded.success : emptyRecord;
};

const writeRecord = (file: string, record: TelemetryRecord): void => {
  ensurePrivateDir(path.dirname(file));
  writePrivateFile(file, `${JSON.stringify(record, null, 2)}\n`);
};

const withCreated = (
  record: TelemetryRecord,
  file: string,
  created: boolean
): readonly string[] =>
  created
    ? [...new Set([...record.created, file])]
    : record.created.filter((item) => item !== file);

const backupDirOf = (options: TelemetryOptions): string =>
  path.join(options.backupRoot, stamp(options.now));

export const claudeSettingsPath = (claudeDir: string): string =>
  path.join(claudeDir, "settings.json");

export const codexConfigPath = (codexDir: string): string =>
  path.join(codexDir, "config.toml");

const writeJson = (file: string, value: Settings): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const notSetUp = (name: string, dir: string): string =>
  `${name} is not set up on this machine (no ${dir}), so dft left it alone. Start ${name} once, then run dft install --telemetry again.`;

export const installClaudeTelemetry = (
  options: TelemetryOptions
): TelemetryChange => {
  const file = claudeSettingsPath(options.claudeDir);
  const ours = claudeTelemetryEnv(options.port);
  const exists = existsSync(file);
  const settings = exists ? parseSettings(readFileSync(file, "utf-8")) : {};

  const base = {
    backup: null,
    path: file,
    tool: "claude-code" as const,
  };

  if (!existsSync(options.claudeDir)) {
    return {
      ...base,
      action: "skipped",
      lines: [],
      message: notSetUp("Claude Code", options.claudeDir),
    };
  }

  if (settings === null) {
    return {
      ...base,
      action: "skipped",
      lines: [],
      message:
        "settings.json is not valid JSON, so dft left it alone. Fix it, then run dft install --telemetry again.",
    };
  }

  const env = settings.env ?? {};
  const record = readRecord(options.stateFile);

  const owned = new Set(
    record.claudeKeys.filter((key) => {
      const value = record.claudeValues[key];

      return value !== undefined && stringValue(env[key]) === value;
    })
  );

  const planned = {
    ...env,
    ...Object.fromEntries(
      Object.entries(ours).filter(([key]) => owned.has(key))
    ),
  };

  const conflict = exportConflict(planned, options.shell, ours);

  if (conflict !== null) {
    return { ...base, action: "refused", lines: [], message: conflict };
  }

  const clashes = Object.entries(ours).filter(([key, value]) => {
    const current = stringValue(planned[key]);

    const enabled =
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" &&
      ["1", "true"].includes((current ?? "").toLowerCase());

    return planned[key] !== undefined && current !== value && !enabled;
  });

  if (clashes.length > 0) {
    return {
      ...base,
      action: "refused",
      lines: [],
      message: `Claude Code settings already set ${clashes.map(([key]) => key).join(", ")} to other values. dft does not replace them.`,
    };
  }

  const changes = Object.entries(ours).filter(
    ([key, value]) =>
      env[key] === undefined ||
      (owned.has(key) && stringValue(env[key]) !== value)
  );

  if (changes.length === 0) {
    return {
      ...base,
      action: "unchanged",
      lines: [],
      message: "Claude Code already sends telemetry to dft",
    };
  }

  const updating = changes.some(([key]) => env[key] !== undefined);

  const lines = changes.map(
    ([key, value]) =>
      `${env[key] === undefined ? "+" : "~"} env.${key} = ${JSON.stringify(value)}`
  );

  if (options.dryRun) {
    return {
      ...base,
      action: updating ? "updated" : "added",
      lines,
      message: updating ? "would update (dry run)" : "would add (dry run)",
    };
  }

  const backup = backupFile(file, backupDirOf(options), "claude-settings.json");
  const written = Object.fromEntries(changes);

  writeJson(file, { ...settings, env: { ...env, ...written } });

  writeRecord(options.stateFile, {
    claudeKeys: [...new Set([...record.claudeKeys, ...Object.keys(written)])],
    claudeValues: { ...record.claudeValues, ...written },
    created: exists ? record.created : withCreated(record, file, true),
  });

  return {
    ...base,
    action: updating ? "updated" : "added",
    backup,
    lines,
    message: updating
      ? "pointed the settings dft added at this port"
      : "added to the env block",
  };
};

export const uninstallClaudeTelemetry = (
  options: TelemetryOptions
): TelemetryChange => {
  const file = claudeSettingsPath(options.claudeDir);
  const record = readRecord(options.stateFile);

  const base = {
    backup: null,
    path: file,
    tool: "claude-code" as const,
  };

  if (!existsSync(file)) {
    return {
      ...base,
      action: "missing",
      lines: [],
      message: "no settings file",
    };
  }

  const settings = parseSettings(readFileSync(file, "utf-8"));

  if (settings === null) {
    return {
      ...base,
      action: "skipped",
      lines: [],
      message: "settings.json is not valid JSON; left alone",
    };
  }

  const env = settings.env ?? {};

  const removable = record.claudeKeys.flatMap((key) => {
    const value = record.claudeValues[key];

    return value !== undefined && stringValue(env[key]) === value
      ? [[key, value] as const]
      : [];
  });

  if (removable.length === 0) {
    return {
      ...base,
      action: "missing",
      lines: [],
      message: "no dft telemetry settings found",
    };
  }

  const keys = new Set(removable.map(([key]) => key));

  const lines = removable.map(
    ([key, value]) => `- env.${key} = ${JSON.stringify(value)}`
  );

  if (options.dryRun) {
    return {
      ...base,
      action: "removed",
      lines,
      message: "would remove (dry run)",
    };
  }

  const backup = backupFile(file, backupDirOf(options), "claude-settings.json");

  const rest = Object.fromEntries(
    Object.entries(env).filter(([key]) => !keys.has(key))
  );

  const next =
    Object.keys(rest).length === 0
      ? Struct.omit(settings, ["env"])
      : { ...settings, env: rest };

  if (Object.keys(next).length === 0 && record.created.includes(file)) {
    rmSync(file);
  } else {
    writeJson(file, next);
  }

  writeRecord(options.stateFile, {
    claudeKeys: [],
    claudeValues: {},
    created: withCreated(record, file, false),
  });

  return {
    ...base,
    action: "removed",
    backup,
    lines,
    message: "removed what dft added",
  };
};

const OTEL_TABLE = /^\s*\[\s*otel\s*[\].]/mu;

const OTEL_DOTTED = /^\s*otel\s*[.=]/mu;

const TABLE_HEADER = /^\s*\[/u;

interface CodexParts {
  readonly after: string;
  readonly before: string;
  readonly found: boolean;
  readonly kept: string;
  readonly owned: string;
}

const trimBlankLines = (lines: readonly string[]): readonly string[] => {
  const first = lines.findIndex((line) => line.trim() !== "");

  if (first === -1) {
    return [];
  }

  const last = lines.findLastIndex((line) => line.trim() !== "");

  return lines.slice(first, last + 1);
};

const codexParts = (text: string): CodexParts => {
  const start = text.indexOf(CODEX_BLOCK_START);
  const end = start === -1 ? -1 : text.indexOf(CODEX_BLOCK_END, start);

  if (start === -1 || end === -1) {
    return { after: "", before: text, found: false, kept: "", owned: "" };
  }

  const inside = text.slice(start, end).replace(/\n$/u, "").split("\n");

  const foreign = inside.findIndex(
    (line) => TABLE_HEADER.test(line) && !OTEL_TABLE.test(line)
  );

  const split = foreign === -1 ? inside.length : foreign;

  return {
    after: text.slice(end + CODEX_BLOCK_END.length).replace(/^\n/u, ""),
    before: text.slice(0, start),
    found: true,
    kept: trimBlankLines(inside.slice(split)).join("\n"),
    owned: [...trimBlankLines(inside.slice(0, split)), CODEX_BLOCK_END].join(
      "\n"
    ),
  };
};

const keptNote = (kept: string): string => {
  if (kept === "") {
    return "";
  }

  const count = kept.split("\n").length;

  return `; kept ${count} ${count === 1 ? "line" : "lines"} that Codex added inside it`;
};

const separatorAfter = (text: string): string => {
  if (text === "" || text.endsWith("\n\n")) {
    return "";
  }

  return text.endsWith("\n") ? "\n" : "\n\n";
};

export const userToolDirs = (home: string, env: ShellEnv) => ({
  claudeDir: env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
  codexDir: env.CODEX_HOME ?? path.join(home, ".codex"),
});

const refreshCodexBlock = (
  options: TelemetryOptions,
  parts: CodexParts,
  base: Pick<TelemetryChange, "backup" | "path" | "tool">
): TelemetryChange => {
  const block = codexTelemetryBlock(options.port);

  if (parts.owned === block) {
    return {
      ...base,
      action: "unchanged",
      lines: [],
      message: "Codex already sends telemetry to dft",
    };
  }

  const lines = [
    ...parts.owned.split("\n").map((line) => `- ${line}`),
    ...block.split("\n").map((line) => `+ ${line}`),
  ];

  if (options.dryRun) {
    return {
      ...base,
      action: "updated",
      lines,
      message: `would replace the dft block (dry run)${keptNote(parts.kept)}`,
    };
  }

  const backup = backupFile(
    base.path,
    backupDirOf(options),
    "codex-config.toml"
  );

  const kept = parts.kept === "" ? "" : `\n${parts.kept}\n`;

  writeFileSync(base.path, `${parts.before}${block}\n${kept}${parts.after}`);

  return {
    ...base,
    action: "updated",
    backup,
    lines,
    message: `pointed the dft block at this port${keptNote(parts.kept)}`,
  };
};

export const installCodexTelemetry = (
  options: TelemetryOptions
): TelemetryChange => {
  const file = codexConfigPath(options.codexDir);
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const block = codexTelemetryBlock(options.port);

  const base = {
    backup: null,
    path: file,
    tool: "codex" as const,
  };

  if (!existsSync(options.codexDir)) {
    return {
      ...base,
      action: "skipped",
      lines: [],
      message: notSetUp("Codex", options.codexDir),
    };
  }

  const parts = codexParts(text);

  if (parts.found) {
    return refreshCodexBlock(options, parts, base);
  }

  if (OTEL_TABLE.test(text) || OTEL_DOTTED.test(text)) {
    return {
      ...base,
      action: "refused",
      lines: [],
      message:
        "Codex config.toml already has an [otel] section. dft does not replace it. To keep it and add dft, send it through an OpenTelemetry Collector that forwards logs to both.",
    };
  }

  const lines = block.split("\n").map((line) => `+ ${line}`);

  if (options.dryRun) {
    return {
      ...base,
      action: "added",
      lines,
      message: "would append (dry run)",
    };
  }

  const backup = backupFile(file, backupDirOf(options), "codex-config.toml");
  const separator = separatorAfter(text);
  const record = readRecord(options.stateFile);
  const existed = existsSync(file);

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${text}${separator}${block}\n`);

  if (!existed) {
    writeRecord(options.stateFile, {
      ...record,
      created: withCreated(record, file, true),
    });
  }

  return {
    ...base,
    action: "added",
    backup,
    lines,
    message: "appended at the end",
  };
};

export const uninstallCodexTelemetry = (
  options: TelemetryOptions
): TelemetryChange => {
  const file = codexConfigPath(options.codexDir);

  const base = {
    backup: null,
    path: file,
    tool: "codex" as const,
  };

  if (!existsSync(file)) {
    return { ...base, action: "missing", lines: [], message: "no config.toml" };
  }

  const text = readFileSync(file, "utf-8");
  const parts = codexParts(text);

  if (!parts.found) {
    return {
      ...base,
      action: "missing",
      lines: [],
      message: "no dft telemetry block found",
    };
  }

  const lines = parts.owned.split("\n").map((line) => `- ${line}`);

  if (options.dryRun) {
    return {
      ...base,
      action: "removed",
      lines,
      message: `would remove (dry run)${keptNote(parts.kept)}`,
    };
  }

  const backup = backupFile(file, backupDirOf(options), "codex-config.toml");

  const rest =
    parts.kept === ""
      ? `${parts.before.replace(/\n\n$/u, "\n")}${parts.after}`
      : `${parts.before}${parts.kept}\n${parts.after}`;

  const record = readRecord(options.stateFile);

  if (rest === "" && record.created.includes(file)) {
    rmSync(file);
  } else {
    writeFileSync(file, rest);
  }

  writeRecord(options.stateFile, {
    ...record,
    created: withCreated(record, file, false),
  });

  return {
    ...base,
    action: "removed",
    backup,
    lines,
    message: `removed what dft added${keptNote(parts.kept)}`,
  };
};

export const installTelemetry = (
  options: TelemetryOptions
): readonly TelemetryChange[] => [
  installClaudeTelemetry(options),
  installCodexTelemetry(options),
];

export const uninstallTelemetry = (
  options: TelemetryOptions
): readonly TelemetryChange[] => [
  uninstallClaudeTelemetry(options),
  uninstallCodexTelemetry(options),
];

export interface TelemetryState {
  readonly claudeCode: boolean;
  readonly codex: boolean;
}

const LOCAL_LOGS = /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/u;

export const telemetryState = (
  claudeDir: string,
  codexDir: string
): TelemetryState => {
  const claudeFile = claudeSettingsPath(claudeDir);
  const codexFile = codexConfigPath(codexDir);

  const settings = existsSync(claudeFile)
    ? parseSettings(readFileSync(claudeFile, "utf-8"))
    : null;

  const env = settings?.env ?? {};

  return {
    claudeCode:
      stringValue(env.OTEL_LOGS_EXPORTER) === "otlp" &&
      LOCAL_LOGS.test(stringValue(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) ?? ""),
    codex:
      existsSync(codexFile) &&
      codexParts(readFileSync(codexFile, "utf-8")).found,
  };
};
