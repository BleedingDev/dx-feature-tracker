// @effect-diagnostics nodeBuiltinImport:off -- The live engine lists Cursor spool folders synchronously while it scans for changes.
import { readdirSync } from "node:fs";
import path from "node:path";

import {
  cursorSpoolRoot,
  worktreeSpoolId,
} from "../../collectors/cursor-hooks/spool-dirs.js";
import {
  HOOK_SPOOL_FOLDER,
  latestSpoolRecord,
} from "../../collectors/cursor-hooks/spool.js";
import type { HarnessCapture, SpoolWatch } from "../../live/capture.js";

export const CURSOR_USAGE_SOURCE = "collector.cursor-usage-api" as const;

export const CURSOR_USAGE_INPUT =
  "https://cursor.com/api/dashboard/get-filtered-usage-events" as const;

const spoolFolders = (root: string): readonly string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const cursorSpoolWatch = (dftHome: string): SpoolWatch => {
  const root = cursorSpoolRoot(dftHome);

  return {
    commonDirOf: (key) =>
      latestSpoolRecord(path.join(root, key, HOOK_SPOOL_FOLDER))?.git
        .repoCommonDir ?? null,
    id: "cursor-spool",
    keyForWorktree: worktreeSpoolId,
    keyOf: (relative) => {
      const [key, ...rest] = relative.split(path.sep);

      return rest.length === 0 || key === undefined ? null : key;
    },
    keys: () => spoolFolders(root),
    pathOf: (key) => path.join(root, key),
    root,
  };
};

export const CURSOR_CAPTURE: HarnessCapture = {
  accountPoll: {
    enabled: (config) => config.cursorUsageImport,
    input: CURSOR_USAGE_INPUT,
    source: CURSOR_USAGE_SOURCE,
  },
  harness: "cursor",
  watches: (dftHome) => [cursorSpoolWatch(dftHome)],
};
