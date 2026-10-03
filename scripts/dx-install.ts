// @effect-diagnostics nodeBuiltinImport:off -- This Node CLI edits project-level Cursor config files in one explicitly selected target directory.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { DateTime, Option, Schema } from "effect";

import {
  isReleasedSkillBody,
  skillDigest,
} from "../apps/cli/src/dft-skills.js";

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

const HookEntrySchema = Schema.Struct({ command: Schema.String });

const OwnedHookSchema = Schema.Struct({
  createdEvent: Schema.optionalKey(Schema.Boolean),
  entry: HookEntrySchema,
  event: Schema.String,
});

const InstallOwnershipSchema = Schema.Struct({
  gitExclude: Schema.Boolean,
  hooks: Schema.Array(OwnedHookSchema),
  mcpServer: Schema.Boolean,
  skillFiles: Schema.Record(Schema.String, Schema.String),
});

const InstallManifestSchema = Schema.Struct({
  backups: Schema.Array(Schema.String),
  createdFiles: Schema.Array(Schema.String),
  gitExclude: Schema.NullOr(Schema.String),
  hookCommand: Schema.NullOr(Schema.String),
  hookEvents: Schema.Array(Schema.String),
  installedAt: Schema.String,
  mcpServer: Schema.Struct({ entry: McpEntrySchema, name: Schema.String }),
  ownership: Schema.optionalKey(InstallOwnershipSchema),
  schema: Schema.Literal(INSTALL_SCHEMA),
  skills: Schema.Array(Schema.String),
  target: Schema.String,
});

export type InstallManifest = typeof InstallManifestSchema.Type;

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
  readonly ownership: {
    gitExclude: boolean;
    hooks: (typeof OwnedHookSchema.Type)[];
    mcpServer: boolean;
    skillFiles: Record<string, string>;
  };
}

const readJsonObject = (file: string): JsonObject | null => {
  const stat = lstatSync(file, { throwIfNoEntry: false });

  if (stat === undefined) {
    return null;
  }

  if (!stat.isFile()) {
    throw new InstallError(`${file} is not a regular file; left in place`);
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

const backup = (
  file: string,
  journal: Journal,
  backupBase: string = file
): void => {
  if (!existsSync(file)) {
    return;
  }

  const base = `${backupBase}.dx-backup-${stamp(journal.now)}`;
  let copy = base;
  let suffix = 0;

  while (lstatSync(copy, { throwIfNoEntry: false }) !== undefined) {
    suffix += 1;
    copy = `${base}-${suffix}`;
  }

  copyFileSync(file, copy);
  journal.backups.push(copy);
};

const sameJson = (a: Schema.Json | undefined, b: Schema.Json): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

const ownershipFor = (
  manifest: InstallManifest | null
): Journal["ownership"] => ({
  gitExclude: manifest?.ownership?.gitExclude ?? false,
  hooks: [...(manifest?.ownership?.hooks ?? [])],
  mcpServer: manifest?.ownership?.mcpServer ?? false,
  skillFiles: { ...manifest?.ownership?.skillFiles },
});

const regularLocation = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }

  const parts = relative === "" ? [] : relative.split(path.sep);

  const locations = [
    root,
    ...parts.map((_, index) => path.join(root, ...parts.slice(0, index + 1))),
  ];

  return locations.every((location, index) => {
    const stat = lstatSync(location, { throwIfNoEntry: false });

    return (
      stat === undefined ||
      (index === locations.length - 1 && parts.length > 0
        ? stat.isFile()
        : stat.isDirectory())
    );
  });
};

const skillFileFor = (configRoot: string, relative: string): string | null => {
  const parts = relative.split("/");

  if (
    parts.length < 2 ||
    !SKILL_NAMES.some((name) => name === parts[0]) ||
    parts.some(
      (part) =>
        part === "" || part === "." || part === ".." || part.includes("\\")
    )
  ) {
    return null;
  }

  const file = path.join(configRoot, "skills", ...parts);

  return regularLocation(configRoot, file) ? file : null;
};

const requireRegularLocation = (root: string, file: string): void => {
  if (!regularLocation(root, file)) {
    throw new InstallError(
      `${file} is not a regular location; refusing to modify it`
    );
  }
};

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
  [manifestPath(configRoot), legacyManifestPath(configRoot)].find(
    (file) => lstatSync(file, { throwIfNoEntry: false }) !== undefined
  ) ?? null;

export const readManifest = (configRoot: string): InstallManifest | null => {
  const file = existingManifestPath(configRoot);

  if (file === null) {
    return null;
  }

  requireRegularLocation(configRoot, file);

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
    previous?.ownership?.mcpServer === true &&
    sameJson(existing, previous.mcpServer.entry);

  if (sameJson(existing, entry)) {
    journal.ownership.mcpServer = owned;

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
  journal.ownership.mcpServer = true;
};

const sourceSkillFiles = (
  source: string,
  journal: Journal
): readonly string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const file = path.join(source, entry.name);

    if (entry.isDirectory()) {
      files.push(...sourceSkillFiles(file, journal));
    } else if (entry.isFile()) {
      files.push(file);
    } else {
      journal.notes.push(`skill source ${file} is not a regular file; skipped`);
    }
  }

  return files;
};

const migrateSkillOwnership = (
  skill: string,
  configRoot: string,
  manifest: InstallManifest | null,
  journal: Journal
): void => {
  if (
    manifest?.ownership !== undefined ||
    manifest?.skills.includes(skill) !== true
  ) {
    return;
  }

  const key = `${skill}/SKILL.md`;
  const file = skillFileFor(configRoot, key);

  if (file === null || !existsSync(file)) {
    return;
  }

  const body = readFileSync(file, "utf-8");

  if (isReleasedSkillBody(skill, body)) {
    journal.ownership.skillFiles[key] = skillDigest(body);
  } else {
    journal.notes.push(
      `legacy skill ${skill} has no verified file ownership; kept`
    );
  }
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

  migrateSkillOwnership(skill, configRoot, previous, journal);

  if (
    !regularLocation(options.skillsSource, path.join(source, "SKILL.md")) ||
    !existsSync(path.join(source, "SKILL.md"))
  ) {
    journal.notes.push(`skill ${skill} missing at ${source}; skipped`);

    return false;
  }

  if (path.resolve(source) === path.resolve(dest)) {
    journal.notes.push(
      `skill ${skill} already lives in the target; left as is`
    );

    return false;
  }

  for (const file of sourceSkillFiles(source, journal)) {
    const key = `${skill}/${path.relative(source, file).split(path.sep).join("/")}`;
    const destination = skillFileFor(configRoot, key);

    if (destination === null) {
      journal.notes.push(`skill ${key} has a conflicting destination; kept`);
      continue;
    }

    const digest = skillDigest(readFileSync(file));

    const current = existsSync(destination)
      ? skillDigest(readFileSync(destination))
      : null;

    const owned = journal.ownership.skillFiles[key];

    if (current !== null && current !== owned) {
      if (current !== digest) {
        journal.notes.push(`skill ${key} is unowned or edited; kept`);
      }

      continue;
    }

    if (current !== digest) {
      backup(destination, journal);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(file, destination);
      journal.changed.push(destination);
    }

    journal.ownership.skillFiles[key] = digest;
  }

  return true;
};

const installHooks = (
  configRoot: string,
  command: string,
  journal: Journal
): void => {
  const hooksFile = path.join(configRoot, "hooks.json");
  const existingDoc = readJsonObject(hooksFile);

  if (existingDoc === null) {
    journal.createdFiles.add("hooks.json");
  }

  const doc = existingDoc ?? { version: 1 };
  const current = objectField(doc, "hooks");
  const hooks = { ...current };
  const owned: (typeof OwnedHookSchema.Type)[] = [];
  const entry = { command };

  for (const event of HOOK_EVENTS) {
    let list = [...Option.getOrElse(asArray(current[event]), () => [])];

    const previousOwned = journal.ownership.hooks.filter(
      (hook) => hook.event === event
    );

    for (const hook of previousOwned) {
      const index = list.findIndex((item) => sameJson(item, hook.entry));

      if (index === -1) {
        continue;
      }

      if (sameJson(hook.entry, entry)) {
        owned.push(hook);
      } else {
        list = [...list.slice(0, index), ...list.slice(index + 1)];
      }
    }

    if (!list.some((item) => isHookEntry(item) && item.command === command)) {
      list.push(entry);
      owned.push({
        createdEvent:
          current[event] === undefined ||
          previousOwned.some((hook) => hook.createdEvent === true),
        entry,
        event,
      });
    }

    hooks[event] = list;
  }

  journal.ownership.hooks = owned;

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

  if (
    text
      .split("\n")
      .some((line) => line.replace(/\r$/u, "") === SPOOL_IGNORE_LINE)
  ) {
    return;
  }

  const separator = text === "" || text.endsWith("\n") ? "" : "\n";

  mkdirSync(path.dirname(exclude), { recursive: true });
  backup(exclude, journal);
  writeFileSync(exclude, `${text}${separator}${SPOOL_IGNORE_LINE}\n`);
  journal.changed.push(exclude);
  journal.ownership.gitExclude = true;
};

const preflightHooks = (configRoot: string): void => {
  const hooksFile = path.join(configRoot, "hooks.json");
  const hooks = readJsonObject(hooksFile);

  if (hooks?.hooks !== undefined && Option.isNone(asObject(hooks.hooks))) {
    throw new InstallError(
      `${hooksFile} has invalid hooks; refusing to modify it`
    );
  }

  for (const event of HOOK_EVENTS) {
    const value =
      hooks === null ? undefined : objectField(hooks, "hooks")[event];

    if (value !== undefined && Option.isNone(asArray(value))) {
      throw new InstallError(
        `${hooksFile} has an invalid ${event} list; refusing to modify it`
      );
    }
  }
};

const preflightInstall = (
  configRoot: string,
  options: InstallOptions,
  previous: InstallManifest | null,
  entry: McpEntry
): void => {
  if (
    previous !== null &&
    path.resolve(previous.target) !== path.resolve(options.target)
  ) {
    throw new InstallError(
      `manifest belongs to ${previous.target}; uninstall it before selecting a different target`
    );
  }

  for (const file of [
    manifestPath(configRoot),
    legacyManifestPath(configRoot),
    path.join(configRoot, "mcp.json"),
    ...(options.hooks ? [path.join(configRoot, "hooks.json")] : []),
  ]) {
    requireRegularLocation(configRoot, file);
  }

  const mcpFile = path.join(configRoot, "mcp.json");
  const mcp = readJsonObject(mcpFile);

  if (
    mcp?.mcpServers !== undefined &&
    Option.isNone(asObject(mcp.mcpServers))
  ) {
    throw new InstallError(
      `${mcpFile} has invalid mcpServers; refusing to modify it`
    );
  }

  const existing =
    mcp === null ? undefined : objectField(mcp, "mcpServers")[MCP_SERVER_NAME];

  const owned =
    previous?.ownership?.mcpServer === true &&
    sameJson(existing, previous.mcpServer.entry);

  if (existing !== undefined && !sameJson(existing, entry) && !owned) {
    throw new InstallError(
      `${mcpFile} has an unowned "${MCP_SERVER_NAME}" server; refusing to overwrite it`
    );
  }

  if (!options.hooks) {
    return;
  }

  preflightHooks(configRoot);

  const exclude = gitExcludeFor(path.resolve(options.target));

  if (exclude !== null) {
    requireRegularLocation(path.resolve(options.target), exclude);
  }
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
    ownership: ownershipFor(previous),
  };

  const entry = mcpEntryFor(options);

  preflightInstall(configRoot, options, previous, entry);

  installMcp(configRoot, entry, previous, journal);

  const skills = [
    ...new Set([
      ...(previous?.skills ?? []),
      ...SKILL_NAMES.filter((skill) =>
        installSkill(skill, options, configRoot, previous, journal)
      ),
    ]),
  ];

  const command = hookCommandFor(options.nodePath, options.cliPath);
  const exclude = gitExcludeFor(target);

  if (options.hooks) {
    installHooks(configRoot, command, journal);
    journal.ownership.gitExclude &&= previous?.gitExclude === exclude;
    installExclude(exclude, journal);
  } else {
    journal.notes.push(
      "hooks not installed (--no-hooks); MCP and skills only (v0)"
    );
  }

  const manifest: InstallManifest = {
    backups: [...(previous?.backups ?? []), ...journal.backups],
    createdFiles: [...journal.createdFiles],
    gitExclude: options.hooks ? exclude : (previous?.gitExclude ?? null),
    hookCommand: options.hooks ? command : (previous?.hookCommand ?? null),
    hookEvents: options.hooks ? [...HOOK_EVENTS] : (previous?.hookEvents ?? []),
    installedAt: DateTime.formatIso(options.now),
    mcpServer: { entry, name: MCP_SERVER_NAME },
    ownership: journal.ownership,
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
  if (manifest.ownership?.mcpServer !== true) {
    journal.notes.push("MCP ownership was not recorded; existing entry kept");

    return;
  }

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
  manifest: InstallManifest,
  journal: Journal
): void => {
  const owned = manifest.ownership?.hooks ?? [];

  if (owned.length === 0) {
    return;
  }

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

    let kept = [...list.value];

    for (const hook of owned.filter((entry) => entry.event === event)) {
      const index = kept.findIndex((item) => sameJson(item, hook.entry));

      if (index !== -1) {
        kept = [...kept.slice(0, index), ...kept.slice(index + 1)];
      }
    }

    removed ||= kept.length !== list.value.length;

    if (
      kept.length > 0 ||
      !owned.some((hook) => hook.event === event && hook.createdEvent === true)
    ) {
      hooks[event] = kept;
    }
  }

  if (!removed) {
    return;
  }

  backup(hooksFile, journal);

  if (
    manifest.createdFiles.includes("hooks.json") &&
    Object.keys(hooks).length === 0 &&
    doc.version === 1 &&
    Object.keys(doc).every((key) => key === "hooks" || key === "version")
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

  const index = lines.findIndex(
    (line) => line.replace(/\r$/u, "") === SPOOL_IGNORE_LINE
  );

  if (index === -1) {
    return;
  }

  backup(exclude, journal);
  writeFileSync(
    exclude,
    [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n")
  );
  journal.changed.push(exclude);
};

const uninstallSkillFiles = (
  configRoot: string,
  manifest: InstallManifest,
  journal: Journal
): void => {
  for (const skill of manifest.skills) {
    migrateSkillOwnership(skill, configRoot, manifest, journal);
  }

  for (const [relative, digest] of Object.entries(
    journal.ownership.skillFiles
  )) {
    const file = skillFileFor(configRoot, relative);

    if (file === null) {
      journal.notes.push(
        `skill ${relative} has a conflicting destination; kept`
      );
      continue;
    }

    if (!existsSync(file)) {
      continue;
    }

    if (skillDigest(readFileSync(file)) !== digest) {
      journal.notes.push(`skill ${relative} was edited after install; kept`);
      continue;
    }

    backup(
      file,
      journal,
      path.join(configRoot, `skill-${skillDigest(relative).slice(0, 16)}`)
    );
    rmSync(file);
    journal.changed.push(file);

    const skillsRoot = path.join(configRoot, "skills");
    let directory = path.dirname(file);

    while (directory !== skillsRoot && readdirSync(directory).length === 0) {
      rmdirSync(directory);
      directory = path.dirname(directory);
    }

    if (readdirSync(skillsRoot).length === 0) {
      rmdirSync(skillsRoot);
    }
  }
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
    ownership: ownershipFor(manifest),
  };

  if (manifest.ownership?.mcpServer === true) {
    const file = path.join(configRoot, "mcp.json");
    requireRegularLocation(configRoot, file);
    readJsonObject(file);
  }

  if ((manifest.ownership?.hooks.length ?? 0) > 0) {
    const file = path.join(configRoot, "hooks.json");
    requireRegularLocation(configRoot, file);
    readJsonObject(file);
  }

  if (manifest.ownership?.gitExclude === true && manifest.gitExclude !== null) {
    requireRegularLocation(path.resolve(options.target), manifest.gitExclude);
  }

  uninstallMcp(configRoot, manifest, journal);

  if ((manifest.ownership?.hooks.length ?? 0) > 0) {
    uninstallHooks(configRoot, manifest, journal);
  }

  uninstallSkillFiles(configRoot, manifest, journal);

  if (manifest.ownership?.gitExclude === true && manifest.gitExclude !== null) {
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

Never edits ~/.cursor. Existing MCP, hook, ignore and skill files are backed up before changes.`;

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
