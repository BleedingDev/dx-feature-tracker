// @effect-diagnostics nodeBuiltinImport:off -- Spool folder names are derived from the canonical worktree path inside the hook process, which must answer in milliseconds.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { HOOK_SPOOL_FOLDER, LEGACY_SPOOL_RELATIVE } from "./spool.js";

export const CURSOR_SPOOL_ROOT = "spool" as const;

const canonical = (target: string): string => {
  const absolute = path.resolve(target);

  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

export const worktreeSpoolId = (worktreePath: string): string => {
  const real = canonical(worktreePath);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  const name = path.basename(real).replaceAll(/[^A-Za-z0-9._-]+/gu, "-");

  return name === "" || name === "-" ? hash : `${name}-${hash}`;
};

export const cursorSpoolRoot = (dftHome: string): string =>
  path.join(dftHome, CURSOR_SPOOL_ROOT);

export const cursorSpoolDirFor = (
  worktreePath: string,
  dftHome: string
): string =>
  path.join(
    cursorSpoolRoot(dftHome),
    worktreeSpoolId(worktreePath),
    HOOK_SPOOL_FOLDER
  );

export const legacyHookSpoolDirFor = (worktreePath: string): string =>
  path.join(worktreePath, LEGACY_SPOOL_RELATIVE);
