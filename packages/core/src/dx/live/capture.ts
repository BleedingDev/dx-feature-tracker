// @effect-diagnostics nodeBuiltinImport:off -- Live capture lists hook spool folders and reads the newest observation synchronously while the engine scans for changes.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Option, Schema } from "effect";

import { CURSOR_CAPTURE } from "../harness/cursor/capture.js";
import { HookObservationSchema } from "../harness/hook-observation.js";
import { hookSpoolDir } from "../harness/hook-spool.js";
import { HARNESS_IDS } from "../harness/ids.js";
import type { HarnessId } from "../harness/ids.js";
import type { LiveConfig } from "./config.js";

export interface SpoolWatch {
  readonly commonDirOf: (key: string) => string | null;
  readonly id: string;
  readonly keyForWorktree: ((worktree: string) => string) | null;
  readonly keyOf: (relative: string) => string | null;
  readonly keys: () => readonly string[];
  readonly pathOf: (key: string) => string;
  readonly root: string;
}

export interface AccountPoll {
  readonly enabled: (config: LiveConfig) => boolean;
  readonly input: string;
  readonly source: string;
}

export interface HarnessCapture {
  readonly accountPoll: AccountPoll | null;
  readonly harness: HarnessId;
  readonly watches: (dftHome: string) => readonly SpoolWatch[];
}

const JSONL = ".jsonl";

const decodeObservation = Schema.decodeUnknownOption(
  Schema.fromJsonString(HookObservationSchema)
);

const lastCommonDir = (file: string): string | null => {
  try {
    const lines = readFileSync(file, "utf-8").trimEnd().split("\n");

    for (const line of lines.toReversed()) {
      const observation = Option.getOrNull(decodeObservation(line));

      if (observation !== null) {
        return observation.git.repoCommonDir;
      }
    }

    return null;
  } catch {
    return null;
  }
};

const spoolDays = (root: string): readonly string[] => {
  try {
    return readdirSync(root)
      .filter((name) => name.endsWith(JSONL))
      .toSorted();
  } catch {
    return [];
  }
};

export const hookSpoolWatch = (
  dftHome: string,
  tool: HarnessId
): SpoolWatch => {
  const root = hookSpoolDir(dftHome, tool);

  return {
    commonDirOf: (key) => lastCommonDir(path.join(root, key)),
    id: `hooks:${tool}`,
    keyForWorktree: null,
    keyOf: (relative) => {
      const name = path.basename(relative);

      return name.endsWith(JSONL) ? name : null;
    },
    keys: () => spoolDays(root),
    pathOf: (key) => path.join(root, key),
    root,
  };
};

const hookCapture = (harness: HarnessId): HarnessCapture => ({
  accountPoll: null,
  harness,
  watches: (dftHome) => [hookSpoolWatch(dftHome, harness)],
});

const CAPTURES: Readonly<Partial<Record<HarnessId, HarnessCapture>>> = {
  cursor: CURSOR_CAPTURE,
};

export const LIVE_CAPTURES: readonly HarnessCapture[] = HARNESS_IDS.map(
  (id) => CAPTURES[id] ?? hookCapture(id)
);

export const ACCOUNT_POLLS: readonly AccountPoll[] = LIVE_CAPTURES.flatMap(
  (capture) => (capture.accountPoll === null ? [] : [capture.accountPoll])
);
