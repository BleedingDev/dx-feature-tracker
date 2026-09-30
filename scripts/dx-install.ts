// @effect-diagnostics nodeBuiltinImport:off -- This Node CLI edits project-level Cursor config files in one explicitly selected target directory.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { DateTime, Option, Schema } from "effect";

export const INSTALL_SCHEMA = "dx-install/v1" as const;

export const MCP_SERVER_NAME = "rat-stack" as const;

export const MANIFEST_FILE = "dx-feature-tracker.install.json" as const;

export const LEGACY_MANIFEST_FILE = "dx-flight-recorder.install.json" as const;

export const SPOOL_IGNORE_LINE = ".dx-flight-recorder/" as const;

export const SKILL_NAMES = ["dx-analyze", "dx-explain"] as const;

export const HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "stop",
  "postToolUse",
  "postToolUseFailure",
  "afterFileEdit",
  "afterTabFileEdit",
  "afterShellExecution",
  "afterMCPExecution",
  "afterAgentResponse",
] as const;

export interface InstallOptions {
  readonly target: string;
  readonly configRoot: string | null;
  readonly cliPath: string;
  readonly nodePath: string;
  readonly skillsSource: string;
  readonly hooks: boolean;
  readonly store: string | null;
  readonly now: DateTime.Utc;
}

export interface UninstallOptions {
  readonly target: string;
  readonly configRoot: string | null;
  readonly now: DateTime.Utc;
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

type JsonObject = typeof JsonObjectSchema.Type;

const McpEntrySchema = Schema.Struct({
  args: Schema.Array(Schema.String),
  command: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
});

type McpEntry = typeof McpEntrySchema.Type;

const InstallManifestSchema = Schema.Struct({
  backups: Schema.Array(Schema.String),
  createdFiles: Schema.Array(Schema.String),
  gitExclude: Schema.NullOr(Schema.String),
  hookCommand: Schema.NullOr(Schema.String),
  hookEvents: Schema.Array(Schema.String),
  installedAt: Schema.String,
  mcpServer: Schema.Struct({ entry: McpEntrySchema, name: Schema.String }),
  schema: Schema.Literal(INSTALL_SCHEMA),
  skills: Schema.Array(Schema.String),
  target: Schema.String,
});

export type InstallManifest = typeof InstallManifestSchema.Type;

const HookEntrySchema = Schema.Struct({ command: Schema.String });

const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObjectSchema)
);

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(InstallManifestSchema)
);

const asObject = Schema.decodeUnknownOption(JsonObjectSchema);

const asArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));

const isHookEntry = Schema.is(HookEntrySchema);

export interface ActionResult {
  readonly changed: readonly string[];
  readonly backups: readonly string[];
  readonly notes: readonly string[];
}

export class InstallError extends Error {
  override readonly name = "InstallError";
}

interface Journal {
  readonly changed: string[];
  readonly backups: string[];
  readonly notes: string[];
  readonly createdFiles: Set<string>;
  readonly now: DateTime.Utc;
}

const readJsonObject = (file: string): JsonObject | null => {
  if (!existsSync(file)) {
    return null;
  }

  const decoded = decodeJsonObject(readFileSync(file, "utf-8"));

  if (Option.isNone(decoded)) {
    throw new InstallError(
      `${file} is not a valid JSON object; refusing to modify it (fix or move it first)`
    );
  }

  return decoded.value;
};

const writeJson = (file: string, value: Schema.Json): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const stamp = (now: DateTime.Utc): string =>
  DateTime.formatIso(now).replaceAll(/[:.]/gu, "-");

const backup = (file: string, journal: Journal): void => {
  if (!existsSync(file)) {
    return;
  }

  const copy = `${file}.dx-backup-${stamp(journal.now)}`;

  copyFileSync(file, copy);
  journal.backups.push(copy);
};

const sameJson = (a: Schema.Json | undefined, b: Schema.Json): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

export const configRootFor = (options: {
  readonly target: string;
  readonly configRoot: string | null;
}): string =>
  options.configRoot === null
    ? path.join(path.resolve(options.target), ".cursor")
    : path.resolve(options.configRoot);

const shellQuote = (value: string): string =>
  /^[\w./:@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export const hookCommandFor = (nodePath: string, cliPath: string): string =>
  `${shellQuote(nodePath)} ${shellQuote(cliPath)} dx hook`;

export const mcpEntryFor = (options: InstallOptions): McpEntry => {
  const repo = path.resolve(options.target);

  const env =
    options.store === null
      ? { DX_REPO: repo }
      : { DX_REPO: repo, DX_STORE: path.resolve(options.store) };

  return { args: [options.cliPath, "mcp"], command: options.nodePath, env };
};

const gitExcludeFor = (target: string): string | null => {
  const dotGit = path.join(target, ".git");

  return existsSync(path.join(dotGit, "HEAD"))
    ? path.join(dotGit, "info", "exclude")
    : null;
};

const manifestPath = (configRoot: string): string =>
  path.join(configRoot, MANIFEST_FILE);

const legacyManifestPath = (configRoot: string): string =>
  path.join(configRoot, LEGACY_MANIFEST_FILE);

const existingManifestPath = (configRoot: string): string | null =>
  [manifestPath(configRoot), legacyManifestPath(configRoot)].find((file) =>
    existsSync(file)
  ) ?? null;

export const readManifest = (configRoot: string): InstallManifest | null => {
  const file = existingManifestPath(configRoot);

  if (file === null) {
    return null;
  }

  const decoded = decodeManifest(readFileSync(file, "utf-8"));

  if (Option.isNone(decoded)) {
    throw new InstallError(`unreadable install manifest at ${file}`);
  }

  return decoded.value;
};

const objectField = (doc: JsonObject, key: string): JsonObject =>
  Option.getOrElse(asObject(doc[key]), () => ({}));

const installMcp = (
  configRoot: string,
  entry: McpEntry,
  previous: InstallManifest | null,
  journal: Journal
): void => {
  const mcpFile = path.join(configRoot, "mcp.json");
  const existingDoc = readJsonObject(mcpFile);

  if (existingDoc === null) {
    journal.createdFiles.add("mcp.json");
  }

  const mcp = existingDoc ?? {};
  const servers = objectField(mcp, "mcpServers");
  const existing = servers[MCP_SERVER_NAME];

  const owned =
    previous !== null && sameJson(existing, previous.mcpServer.entry);

  if (sameJson(existing, entry)) {
    return;
  }

  if (existing !== undefined && !owned) {
    throw new InstallError(
      `${mcpFile} already has a different "${MCP_SERVER_NAME}" server that this installer does not own; refusing to overwrite it`
    );
  }

  backup(mcpFile, journal);
  writeJson(mcpFile, {
    ...mcp,
    mcpServers: { ...servers, [MCP_SERVER_NAME]: entry },
  });
  journal.changed.push(mcpFile);
};

const installSkill = (
  skill: string,
  options: InstallOptions,
  configRoot: string,
  previous: InstallManifest | null,
  journal: Journal
): boolean => {
  const source = path.join(options.skillsSource, skill);
  const dest = path.join(configRoot, "skills", skill);

  if (!existsSync(path.join(source, "SKILL.md"))) {
    journal.notes.push(`skill ${skill} missing at ${source}; skipped`);

    return false;
  }

  if (path.resolve(source) === path.resolve(dest)) {
    journal.notes.push(
      `skill ${skill} already lives in the target; left as is`
    );

    return false;
  }

  const destSkill = path.join(dest, "SKILL.md");
  const owned = previous?.skills.includes(skill) === true;

  const foreign =
    existsSync(destSkill) &&
    !owned &&
    readFileSync(destSkill, "utf-8") !==
      readFileSync(path.join(source, "SKILL.md"), "utf-8");

  if (foreign) {
    throw new InstallError(
      `${dest} exists and was not installed by dx-feature-tracker; refusing to overwrite it`
    );
  }

  cpSync(source, dest, { force: true, recursive: true });
  journal.changed.push(dest);

  return true;
};

const mergeHookList = (
  list: readonly Schema.Json[],
  command: string,
  stale: string | null
): readonly Schema.Json[] => {
  const kept = list.filter(
    (item) =>
      !(
        isHookEntry(item) &&
        stale !== null &&
        stale !== command &&
        item.command === stale
      )
  );

  const present = kept.some(
    (item) => isHookEntry(item) && item.command === command
  );

  return present ? kept : [...kept, { command }];
};

const installHooks = (
  configRoot: string,
  command: string,
  previous: InstallManifest | null,
  journal: Journal
): void => {
  const hooksFile = path.join(configRoot, "hooks.json");
  const existingDoc = readJsonObject(hooksFile);

  if (existingDoc === null) {
    journal.createdFiles.add("hooks.json");
  }

  const doc = existingDoc ?? { version: 1 };
  const current = objectField(doc, "hooks");
  const stale = previous?.hookCommand ?? null;

  const merged = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      mergeHookList(
        Option.getOrElse(asArray(current[event]), () => []),
        command,
        stale
      ),
    ])
  );

  const hooks = { ...current, ...merged };

  const next = { ...doc, hooks, version: doc.version ?? 1 };

  if (existingDoc !== null && sameJson(existingDoc, next)) {
    return;
  }

  backup(hooksFile, journal);
  writeJson(hooksFile, next);
  journal.changed.push(hooksFile);
};

const installExclude = (exclude: string | null, journal: Journal): void => {
  if (exclude === null) {
    journal.notes.push(
      `no .git dir in the target; add the old folder ${SPOOL_IGNORE_LINE} to your ignore rules if it exists, so it is never committed`
    );

    return;
  }

  const text = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";

  if (text.split("\n").includes(SPOOL_IGNORE_LINE)) {
    return;
  }

  const separator = text === "" || text.endsWith("\n") ? "" : "\n";

  mkdirSync(path.dirname(exclude), { recursive: true });
  writeFileSync(exclude, `${text}${separator}${SPOOL_IGNORE_LINE}\n`);
  journal.changed.push(exclude);
};

export const install = (options: InstallOptions): ActionResult => {
  const target = path.resolve(options.target);

  if (!existsSync(target)) {
    throw new InstallError(`target ${target} does not exist`);
  }

  const configRoot = configRootFor(options);
  const previous = readManifest(configRoot);

  const journal: Journal = {
    backups: [],
    changed: [],
    createdFiles: new Set(previous?.createdFiles),
    notes: [],
    now: options.now,
  };

  const entry = mcpEntryFor(options);

  installMcp(configRoot, entry, previous, journal);

  const skills = SKILL_NAMES.filter((skill) =>
    installSkill(skill, options, configRoot, previous, journal)
  );

  const command = hookCommandFor(options.nodePath, options.cliPath);
  const exclude = gitExcludeFor(target);

  if (options.hooks) {
    installHooks(configRoot, command, previous, journal);
    installExclude(exclude, journal);
  } else {
    journal.notes.push(
      "hooks not installed (--no-hooks); MCP and skills only (v0)"
    );
  }

  const manifest: InstallManifest = {
    backups: [...(previous?.backups ?? []), ...journal.backups],
    createdFiles: [...journal.createdFiles],
    gitExclude: options.hooks ? exclude : null,
    hookCommand: options.hooks ? command : null,
    hookEvents: options.hooks ? [...HOOK_EVENTS] : [],
    installedAt: DateTime.formatIso(options.now),
    mcpServer: { entry, name: MCP_SERVER_NAME },
    schema: INSTALL_SCHEMA,
    skills,
    target,
  };

  writeJson(manifestPath(configRoot), manifest);
  rmSync(legacyManifestPath(configRoot), { force: true });

  return {
    backups: journal.backups,
    changed: journal.changed,
    notes: journal.notes,
  };
};

const uninstallMcp = (
  configRoot: string,
  manifest: InstallManifest,
  journal: Journal
): void => {
  const mcpFile = path.join(configRoot, "mcp.json");
  const mcp = readJsonObject(mcpFile);

  if (mcp === null) {
    return;
  }

  const servers = objectField(mcp, "mcpServers");
  const current = servers[manifest.mcpServer.name];

  if (current === undefined) {
    return;
  }

  if (!sameJson(current, manifest.mcpServer.entry)) {
    journal.notes.push(
      `"${manifest.mcpServer.name}" in ${mcpFile} was edited after install; left in place`
    );

    return;
  }

  const rest = Object.fromEntries(
    Object.entries(servers).filter(([name]) => name !== manifest.mcpServer.name)
  );

  const removeFile =
    manifest.createdFiles.includes("mcp.json") &&
    Object.keys(rest).length === 0 &&
    Object.keys(mcp).length === 1;

  backup(mcpFile, journal);

  if (removeFile) {
    rmSync(mcpFile);
  } else {
    writeJson(mcpFile, { ...mcp, mcpServers: rest });
  }

  journal.changed.push(mcpFile);
};

const uninstallHooks = (
  configRoot: string,
  command: string,
  manifest: InstallManifest,
  journal: Journal
): void => {
  const hooksFile = path.join(configRoot, "hooks.json");
  const doc = readJsonObject(hooksFile);

  if (doc === null) {
    return;
  }

  const hooks: Record<string, Schema.Json> = {};
  let removed = false;

  for (const [event, value] of Object.entries(objectField(doc, "hooks"))) {
    const list = asArray(value);

    if (Option.isNone(list)) {
      hooks[event] = value;
      continue;
    }

    const kept = list.value.filter(
      (item) => !(isHookEntry(item) && item.command === command)
    );

    removed ||= kept.length !== list.value.length;

    if (kept.length > 0 || !manifest.hookEvents.includes(event)) {
      hooks[event] = kept;
    }
  }

  if (!removed) {
    return;
  }

  backup(hooksFile, journal);

  if (
    manifest.createdFiles.includes("hooks.json") &&
    Object.keys(hooks).length === 0
  ) {
    rmSync(hooksFile);
  } else {
    writeJson(hooksFile, { ...doc, hooks });
  }

  journal.changed.push(hooksFile);
};

const uninstallExclude = (exclude: string, journal: Journal): void => {
  if (!existsSync(exclude)) {
    return;
  }

  const lines = readFileSync(exclude, "utf-8").split("\n");
  const kept = lines.filter((line) => line !== SPOOL_IGNORE_LINE);

  if (kept.length === lines.length) {
    return;
  }

  writeFileSync(exclude, kept.join("\n"));
  journal.changed.push(exclude);
};

export const uninstall = (options: UninstallOptions): ActionResult => {
  const configRoot = configRootFor(options);
  const manifest = readManifest(configRoot);

  if (manifest === null) {
    return { backups: [], changed: [], notes: ["nothing installed"] };
  }

  const journal: Journal = {
    backups: [],
    changed: [],
    createdFiles: new Set(),
    notes: [],
    now: options.now,
  };

  uninstallMcp(configRoot, manifest, journal);

  if (manifest.hookCommand !== null) {
    uninstallHooks(configRoot, manifest.hookCommand, manifest, journal);
  }

  for (const skill of manifest.skills) {
    const dest = path.join(configRoot, "skills", skill);

    if (existsSync(dest)) {
      rmSync(dest, { force: true, recursive: true });
      journal.changed.push(dest);
    }
  }

  if (manifest.gitExclude !== null) {
    uninstallExclude(manifest.gitExclude, journal);
  }

  rmSync(manifestPath(configRoot), { force: true });
  rmSync(legacyManifestPath(configRoot), { force: true });
  journal.notes.push(
    "hook spool and the event store are user data and were kept"
  );

  return {
    backups: journal.backups,
    changed: journal.changed,
    notes: journal.notes,
  };
};

const HELP = `Usage: node scripts/dx-install.ts <install|uninstall|status> --target <project> [options]

  --target <dir>       Project to wire (required). Only <target>/.cursor is touched.
  --config-root <dir>  Override the Cursor config dir (default <target>/.cursor).
  --no-hooks           Install MCP + skills only (v0); skip project hooks.
  --store <file>       Pass DX_STORE to the MCP server.
  --cli <file>         Built dft CLI (default <repo>/apps/cli/dist/cli.js).
  --node <file>        Node binary for commands (default: this node).

Never edits ~/.cursor. Every modified file is backed up next to itself.`;

const print = (value: ActionResult | InstallManifest | null): void => {
  process.stdout.write(
    `${JSON.stringify(value ?? { installed: false }, null, 2)}\n`
  );
};

const runInstall = (
  target: string,
  configRoot: string | null,
  values: {
    readonly cli?: string | undefined;
    readonly node?: string | undefined;
    readonly store?: string | undefined;
    readonly "no-hooks"?: boolean | undefined;
  }
): ActionResult => {
  const recorderRoot = path.resolve(import.meta.dirname, "..");

  const cliPath = path.resolve(
    values.cli ?? path.join(recorderRoot, "apps/cli/dist/cli.js")
  );

  if (!existsSync(cliPath)) {
    throw new InstallError(
      `dft CLI not built at ${cliPath}; run \`pnpm exec turbo run build\` first`
    );
  }

  return install({
    cliPath,
    configRoot,
    hooks: values["no-hooks"] !== true,
    nodePath: values.node ?? process.execPath,
    now: DateTime.nowUnsafe(),
    skillsSource: path.join(recorderRoot, ".cursor", "skills"),
    store: values.store ?? null,
    target,
  });
};

export const main = (argv: readonly string[]): number => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      cli: { type: "string" },
      "config-root": { type: "string" },
      help: { type: "boolean" },
      "no-hooks": { type: "boolean" },
      node: { type: "string" },
      store: { type: "string" },
      target: { type: "string" },
    },
  });

  const [action] = positionals;
  const { target } = values;

  if (values.help === true || action === undefined || target === undefined) {
    process.stdout.write(`${HELP}\n`);

    return values.help === true ? 0 : 2;
  }

  const configRoot = values["config-root"] ?? null;

  try {
    if (action === "status") {
      print(readManifest(configRootFor({ configRoot, target })));

      return 0;
    }

    if (action === "uninstall") {
      print(uninstall({ configRoot, now: DateTime.nowUnsafe(), target }));

      return 0;
    }

    if (action === "install") {
      print(runInstall(target, configRoot, values));

      return 0;
    }

    process.stderr.write(`unknown action ${action}\n${HELP}\n`);

    return 2;
  } catch (error) {
    if (error instanceof InstallError) {
      process.stderr.write(`dx-install: ${error.message}\n`);

      return 1;
    }

    throw error;
  }
};

const [, invoked] = process.argv;

if (
  invoked !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invoked)).href
) {
  process.exitCode = main(process.argv.slice(2));
}
