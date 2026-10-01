import { Config, Context, Effect, Layer, Option, Path } from "effect";

import type { HarnessId } from "./ids.js";

export interface HarnessHomeOverrides {
  readonly CLAUDE_CONFIG_DIR?: string | undefined;
  readonly CODEX_HOME?: string | undefined;
  readonly DSH_HOME?: string | undefined;
  readonly PI_CODING_AGENT_DIR?: string | undefined;
  readonly PI_CONFIG_DIR?: string | undefined;
  readonly PI_PROFILE?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly XDG_DATA_HOME?: string | undefined;
}

export interface HarnessDirs {
  readonly claudeCode: string;
  readonly codex: string;
  readonly cursor: string;
  readonly deepseek: string;
  readonly omp: string;
  readonly ompConfig: string;
  readonly ompXdgData: string | null;
  readonly opencodeConfig: string;
  readonly opencodeData: string;
  readonly pi: string;
}

export interface HarnessLocations {
  readonly dirs: HarnessDirs;
  readonly home: string;
  readonly rootOf: (harness: HarnessId) => string;
}

export const HARNESS_HOME_ENV_VARS = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "DSH_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
] as const;

const present = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

const OMP_CONFIG_NAME = ".omp";

interface OmpDirs {
  readonly omp: string;
  readonly ompConfig: string;
  readonly ompXdgData: string | null;
}

const ompDirs = (
  home: string,
  overrides: HarnessHomeOverrides,
  path: Path.Path
): OmpDirs => {
  const profile = present(overrides.PI_PROFILE);
  const profileParts = profile === null ? [] : ["profiles", profile];

  const ompConfig = path.join(
    home,
    present(overrides.PI_CONFIG_DIR) ?? OMP_CONFIG_NAME,
    ...profileParts
  );

  const agentOverride =
    profile === null ? present(overrides.PI_CODING_AGENT_DIR) : null;

  const xdgData = present(overrides.XDG_DATA_HOME);

  return {
    omp:
      agentOverride === null
        ? path.join(ompConfig, "agent")
        : path.resolve(agentOverride),
    ompConfig,
    ompXdgData:
      xdgData === null || agentOverride !== null
        ? null
        : path.join(path.resolve(xdgData), "omp", ...profileParts),
  };
};

export const harnessDirs = (
  home: string,
  overrides: HarnessHomeOverrides,
  path: Path.Path
): HarnessDirs => {
  const under = (value: string | null, ...fallback: string[]) =>
    value === null ? path.join(home, ...fallback) : path.resolve(value);

  const configHome = under(present(overrides.XDG_CONFIG_HOME), ".config");

  const dataHome = under(present(overrides.XDG_DATA_HOME), ".local", "share");

  return {
    claudeCode: under(present(overrides.CLAUDE_CONFIG_DIR), ".claude"),
    codex: under(present(overrides.CODEX_HOME), ".codex"),
    cursor: path.join(home, ".cursor"),
    deepseek: under(present(overrides.DSH_HOME), ".dsh"),
    ...ompDirs(home, overrides, path),
    opencodeConfig: path.join(configHome, "opencode"),
    opencodeData: path.join(dataHome, "opencode"),
    pi: under(present(overrides.PI_CODING_AGENT_DIR), ".pi", "agent"),
  };
};

const rootFor =
  (dirs: HarnessDirs) =>
  (harness: HarnessId): string => {
    switch (harness) {
      case "claude-code": {
        return dirs.claudeCode;
      }

      case "codex": {
        return dirs.codex;
      }

      case "cursor": {
        return dirs.cursor;
      }

      case "deepseek": {
        return dirs.deepseek;
      }

      case "omp": {
        return dirs.omp;
      }

      case "opencode": {
        return dirs.opencodeData;
      }

      case "pi": {
        return dirs.pi;
      }

      default: {
        return dirs.cursor;
      }
    }
  };

const locationsFor = (
  home: string,
  overrides: HarnessHomeOverrides,
  path: Path.Path
): HarnessLocations => {
  const dirs = harnessDirs(home, overrides, path);

  return { dirs, home, rootOf: rootFor(dirs) };
};

const optional = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) => Option.getOrUndefined(value))
  );

const environmentOverrides = Effect.gen(function* readOverrides() {
  const overrides: HarnessHomeOverrides = {
    CLAUDE_CONFIG_DIR: yield* optional("CLAUDE_CONFIG_DIR"),
    CODEX_HOME: yield* optional("CODEX_HOME"),
    DSH_HOME: yield* optional("DSH_HOME"),
    PI_CODING_AGENT_DIR: yield* optional("PI_CODING_AGENT_DIR"),
    PI_CONFIG_DIR: yield* optional("PI_CONFIG_DIR"),
    PI_PROFILE: yield* optional("PI_PROFILE"),
    XDG_CONFIG_HOME: yield* optional("XDG_CONFIG_HOME"),
    XDG_DATA_HOME: yield* optional("XDG_DATA_HOME"),
  };

  return overrides;
});

export class HarnessHome extends Context.Service<
  HarnessHome,
  HarnessLocations
>()("dx/harness/HarnessHome", {
  make: Effect.gen(function* makeHarnessHome() {
    const path = yield* Path.Path;
    const home = yield* Config.String("HOME");

    return locationsFor(home, yield* environmentOverrides, path);
  }).pipe(Effect.orDie),
}) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly forHome = (home: string): Layer.Layer<HarnessHome> =>
    Layer.effect(
      this,
      Effect.gen(function* forHome() {
        const path = yield* Path.Path;
        const userHome = yield* optional("HOME");

        const isUserHome =
          userHome !== undefined &&
          path.resolve(userHome) === path.resolve(home);

        const overrides = isUserHome ? yield* environmentOverrides : {};

        return locationsFor(home, overrides, path);
      }).pipe(Effect.orDie)
    ).pipe(Layer.provide(Path.layer));

  static readonly at = (
    home: string,
    overrides: HarnessHomeOverrides = {}
  ): Layer.Layer<HarnessHome> =>
    Layer.effect(
      this,
      Effect.gen(function* atHome() {
        return locationsFor(home, overrides, yield* Path.Path);
      })
    ).pipe(Layer.provide(Path.layer));
}
