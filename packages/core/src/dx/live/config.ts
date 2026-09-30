// @effect-diagnostics nodeBuiltinImport:off -- The tracked-repo list is a small JSON file under DFT_HOME, read and replaced with a temp-file rename at the process boundary.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Effect, Option, Schema } from "effect";

import { contextForRepo } from "../registry/runtime.js";
import { configPath, LiveActionError } from "./home.js";
import type { LiveHome } from "./home.js";

export interface LiveConfig {
  readonly cursorUsageImport: boolean;
  readonly repos: readonly string[];
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  cursorUsageImport: true,
  repos: [],
};

const LiveConfigFileSchema = Schema.fromJsonString(
  Schema.Struct({
    cursorUsageImport: Schema.optionalKey(Schema.Boolean),
    repos: Schema.optionalKey(Schema.Array(Schema.String)),
  })
);

const decodeConfigFile = Schema.decodeUnknownOption(LiveConfigFileSchema);

export interface GitRepo {
  readonly commonDir: string;
  readonly name: string;
  readonly root: string;
}

export const resolveGitRepo = (target: string): GitRepo | null => {
  const context = contextForRepo(path.resolve(target));

  if (context.repoCommonDir === null || context.worktreePath === null) {
    return null;
  }

  const root =
    path.basename(context.repoCommonDir) === ".git"
      ? path.dirname(context.repoCommonDir)
      : context.worktreePath;

  return {
    commonDir: context.repoCommonDir,
    name: path.basename(root),
    root,
  };
};

const configError = (message: string) =>
  new LiveActionError({ message, reason: "bad-config" });

export const readLiveConfig = (
  home: LiveHome
): Effect.Effect<LiveConfig, LiveActionError> =>
  Effect.gen(function* readConfig() {
    const file = configPath(home);

    if (!existsSync(file)) {
      return DEFAULT_LIVE_CONFIG;
    }

    const text = yield* Effect.try({
      catch: () => configError(`Could not read ${file}.`),
      try: () => readFileSync(file, "utf-8"),
    });

    return yield* Option.match(decodeConfigFile(text), {
      onNone: () =>
        Effect.fail(
          configError(
            `${file} is not valid. Fix it or delete it to start with no tracked repos.`
          )
        ),
      onSome: (parsed) =>
        Effect.succeed<LiveConfig>({
          cursorUsageImport:
            parsed.cursorUsageImport ?? DEFAULT_LIVE_CONFIG.cursorUsageImport,
          repos: parsed.repos === undefined ? [] : [...new Set(parsed.repos)],
        }),
    });
  });

export const writeLiveConfig = (
  home: LiveHome,
  config: LiveConfig
): Effect.Effect<LiveConfig, LiveActionError> =>
  Effect.try({
    catch: () => configError(`Could not save ${configPath(home)}.`),
    try: () => {
      const file = configPath(home);
      const temp = `${file}.${process.pid}.tmp`;

      mkdirSync(home.dftHome, { recursive: true });
      writeFileSync(
        temp,
        `${JSON.stringify({ cursorUsageImport: config.cursorUsageImport, repos: config.repos }, null, 2)}\n`
      );
      renameSync(temp, file);

      return config;
    },
  });

export interface TrackResult {
  readonly added: boolean;
  readonly config: LiveConfig;
  readonly repo: GitRepo;
}

export interface UntrackResult {
  readonly config: LiveConfig;
  readonly removed: readonly string[];
}

const sameRepo = (entry: string, repo: GitRepo): boolean =>
  path.resolve(entry) === repo.root ||
  resolveGitRepo(entry)?.commonDir === repo.commonDir;

export const listRepos = (
  home: LiveHome
): Effect.Effect<readonly string[], LiveActionError> =>
  Effect.map(readLiveConfig(home), (config) => config.repos);

export const addRepo = (
  home: LiveHome,
  target: string
): Effect.Effect<TrackResult, LiveActionError> =>
  Effect.gen(function* track() {
    const repo = resolveGitRepo(target);

    if (repo === null) {
      return yield* new LiveActionError({
        message: `${path.resolve(target)} is not a git repo.`,
        reason: "not-a-repo",
      });
    }

    const config = yield* readLiveConfig(home);

    if (config.repos.some((entry) => sameRepo(entry, repo))) {
      return { added: false, config, repo };
    }

    const saved = yield* writeLiveConfig(home, {
      ...config,
      repos: [...config.repos, repo.root],
    });

    return { added: true, config: saved, repo };
  });

export const removeRepo = (
  home: LiveHome,
  target: string
): Effect.Effect<UntrackResult, LiveActionError> =>
  Effect.gen(function* untrack() {
    const config = yield* readLiveConfig(home);
    const repo = resolveGitRepo(target);

    const matches = (entry: string): boolean =>
      path.resolve(entry) === path.resolve(target) ||
      (repo !== null && sameRepo(entry, repo));

    const removed = config.repos.filter(matches);

    if (removed.length === 0) {
      return { config, removed };
    }

    const saved = yield* writeLiveConfig(home, {
      ...config,
      repos: config.repos.filter((entry) => !matches(entry)),
    });

    return { config: saved, removed };
  });

export const setCursorUsageImport = (
  home: LiveHome,
  enabled: boolean
): Effect.Effect<LiveConfig, LiveActionError> =>
  Effect.flatMap(readLiveConfig(home), (config) =>
    writeLiveConfig(home, { ...config, cursorUsageImport: enabled })
  );
