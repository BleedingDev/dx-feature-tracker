// @effect-diagnostics nodeBuiltinImport:off -- The live engine keeps its config, backups and spool under DFT_HOME and checks every path against it at the process boundary.
import path from "node:path";

import { Data } from "effect";

import { DFT_DB_FILE } from "../registry/runtime.js";

export type LiveActionReason =
  | "backup-incompatible"
  | "bad-config"
  | "confirmation"
  | "not-a-repo"
  | "outside-home"
  | "store"
  | "unknown-backup";

export class LiveActionError extends Data.TaggedError("LiveActionError")<{
  readonly message: string;
  readonly reason: LiveActionReason;
}> {}

export interface LiveHome {
  readonly dftHome: string;
  readonly storePath: string;
}

export const liveHome = (
  dftHome: string,
  storePath: string | null = null
): LiveHome => ({
  dftHome: path.resolve(dftHome),
  storePath: path.resolve(storePath ?? path.join(dftHome, DFT_DB_FILE)),
});

export const CONFIG_FILE = "config.json" as const;

export const BACKUPS_FOLDER = "backups" as const;

export const SPOOL_FOLDER = "spool" as const;

export const COMMIT_SNAPSHOTS_FILE = "snapshots.jsonl" as const;

export const USAGE_STATE_FOLDER = "cursor-usage-api" as const;

export const configPath = (home: LiveHome): string =>
  path.join(home.dftHome, CONFIG_FILE);

export const backupsDir = (home: LiveHome): string =>
  path.join(home.dftHome, BACKUPS_FOLDER);

export const spoolRoot = (home: LiveHome): string =>
  path.join(home.dftHome, SPOOL_FOLDER);

export const commitSnapshotsPath = (home: LiveHome): string =>
  path.join(path.dirname(home.storePath), COMMIT_SNAPSHOTS_FILE);

export const usageStateDir = (home: LiveHome): string =>
  path.join(home.dftHome, USAGE_STATE_FOLDER);

export const isInsideHome = (home: LiveHome, target: string): boolean => {
  const relative = path.relative(home.dftHome, path.resolve(target));

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

export const confined = (
  home: LiveHome,
  target: string
): LiveActionError | null =>
  isInsideHome(home, target)
    ? null
    : new LiveActionError({
        message: `${target} is outside ${home.dftHome}, so dft will not change it.`,
        reason: "outside-home",
      });
