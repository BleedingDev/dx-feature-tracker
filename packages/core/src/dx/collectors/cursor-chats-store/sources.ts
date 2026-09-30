// @effect-diagnostics nodeBuiltinImport:off -- Auto-sync finds the cursor-agent chat folder of a worktree with a synchronous md5 of its path and an existence check.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const CURSOR_CLI_SOURCE = "collector/cursor-cli";

const realOrSelf = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
};

export const chatsDirFor = (home: string, cwd: string): string =>
  path.join(
    home,
    ".cursor",
    "chats",
    createHash("md5").update(cwd).digest("hex")
  );

export const chatStoreSources = (
  home: string,
  worktree: string
): readonly { readonly input: string; readonly source: string }[] =>
  [...new Set([path.resolve(worktree), realOrSelf(worktree)])].flatMap(
    (cwd) => {
      const input = chatsDirFor(home, cwd);

      return existsSync(input) ? [{ input, source: CURSOR_CLI_SOURCE }] : [];
    }
  );
