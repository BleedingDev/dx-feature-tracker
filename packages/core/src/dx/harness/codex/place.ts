import type { FlightContext } from "../../model/event.js";
import type { BranchSource } from "../ids.js";
import type { CodexHead } from "./head.js";

export interface Placement {
  readonly branchSource: BranchSource;
  readonly context: FlightContext;
}

const trimmed = (dir: string): string =>
  dir.length > 1 ? dir.replace(/\/+$/u, "") : dir;

export const samePath = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && trimmed(a) === trimmed(b);

export const within = (child: string | null, parent: string | null): boolean =>
  child !== null &&
  parent !== null &&
  (samePath(child, parent) || trimmed(child).startsWith(`${trimmed(parent)}/`));

const recordedFor = (
  head: CodexHead | null,
  cwd: string | null
): CodexHead | null =>
  head !== null && head.branch !== null && samePath(cwd, head.cwd)
    ? head
    : null;

export const placeTurn = (
  head: CodexHead,
  parent: CodexHead | null,
  turnCwd: string | null,
  selected: FlightContext
): Placement => {
  const cwd = turnCwd ?? head.cwd;
  const inside = within(cwd, selected.worktreePath);
  const recorded = recordedFor(head, cwd) ?? recordedFor(parent, cwd);

  const shared = {
    flightId: inside ? selected.flightId : null,
    repoCommonDir: inside ? selected.repoCommonDir : null,
    worktreePath: inside ? selected.worktreePath : cwd,
  };

  if (recorded !== null) {
    return {
      branchSource: "session-recorded",
      context: { ...shared, branch: recorded.branch, headSha: recorded.commit },
    };
  }

  if (inside && selected.branch !== null) {
    return {
      branchSource: "cwd-inferred",
      context: {
        ...shared,
        branch: selected.branch,
        headSha: selected.headSha,
      },
    };
  }

  return {
    branchSource: "unassigned",
    context: { ...shared, branch: null, headSha: null },
  };
};
