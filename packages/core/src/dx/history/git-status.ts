// @effect-diagnostics nodeBuiltinImport:off -- Branch status is read synchronously and read-only from the local git binary; a failed git call becomes status unknown or deleted with a reason.
import { execFileSync } from "node:child_process";

import { unknownStatus } from "./compute.js";
import type { BranchStatusResolver } from "./compute.js";
import type { FlightStatusReport } from "./contract.js";

const GIT_TIMEOUT_MS = 3000;

const git = (gitDir: string, args: readonly string[]): string | null => {
  try {
    return execFileSync("git", ["--no-pager", `--git-dir=${gitDir}`, ...args], {
      encoding: "utf-8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
};

const refExists = (gitDir: string, ref: string): boolean =>
  git(gitDir, ["rev-parse", "--verify", "--quiet", ref]) !== null;

const defaultBranchOf = (gitDir: string): string | null => {
  const remoteHead = git(gitDir, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);

  if (remoteHead !== null && remoteHead !== "") {
    return remoteHead.replace(/^origin\//u, "");
  }

  return (
    ["main", "master", "trunk", "develop"].find((name) =>
      refExists(gitDir, `refs/heads/${name}`)
    ) ?? null
  );
};

export const gitBranchStatus: BranchStatusResolver = (
  repoCommonDir,
  branch
): FlightStatusReport => {
  if (git(repoCommonDir, ["rev-parse", "--git-dir"]) === null) {
    return unknownStatus(`repository ${repoCommonDir} is not readable`);
  }

  if (!refExists(repoCommonDir, `refs/heads/${branch}`)) {
    return {
      reason: "no local branch ref; deleted, renamed or never created locally",
      value: "deleted",
    };
  }

  const base = defaultBranchOf(repoCommonDir);

  if (base === null) {
    return unknownStatus("no default branch (origin/HEAD, main, master) found");
  }

  if (base === branch) {
    return { reason: "default branch", value: "open" };
  }

  const baseRef = refExists(repoCommonDir, `refs/remotes/origin/${base}`)
    ? `refs/remotes/origin/${base}`
    : `refs/heads/${base}`;

  const tip = git(repoCommonDir, ["rev-parse", `refs/heads/${branch}`]);
  const baseTip = git(repoCommonDir, ["rev-parse", baseRef]);

  if (tip !== null && tip === baseTip) {
    return {
      reason: `branch tip equals ${base}; no own commits yet`,
      value: "open",
    };
  }

  const merged =
    git(repoCommonDir, [
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branch}`,
      baseRef,
    ]) !== null;

  return merged
    ? {
        reason: `branch tip is reachable from ${base}`,
        value: "merged",
      }
    : {
        reason: `branch tip not reachable from ${base}; squash or rebase merges also look open`,
        value: "open",
      };
};
