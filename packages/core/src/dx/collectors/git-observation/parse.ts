import { DateTime, Option } from "effect";

export interface WorkingTreeState {
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly branch: string | null;
  readonly conflictedFiles: number;
  readonly headSha: string | null;
  readonly stagedFiles: number;
  readonly trackedChangedFiles: number;
  readonly untrackedFiles: number;
  readonly upstream: string | null;
}

export interface DiffTotals {
  readonly binaryFiles: number;
  readonly files: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
}

export interface ReflogEntry {
  readonly action: string;
  readonly createdFrom: string | null;
  readonly newSha: string;
  readonly occurredAt: string | null;
}

const UNBORN_OID = "(initial)";

const DETACHED_HEAD = "(detached)";

const ACTION_PATTERN = /^(?<action>[a-z-]+(?: \([a-z -]+\))?)/u;

const CREATED_FROM_PATTERN = /^branch: Created from (?<ref>\S+)$/u;

const SELECTOR_DATE_PATTERN = /@\{(?<date>.+)\}$/u;

const parseCount = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Math.trunc(Number(value.replace(/^[+-]/u, "")));

  return Number.isFinite(parsed) ? parsed : null;
};

const applyHeader = (
  state: WorkingTreeState,
  header: string
): WorkingTreeState => {
  const [key, ...rest] = header.split(" ");
  const value = rest.join(" ");

  if (key === "branch.oid") {
    return { ...state, headSha: value === UNBORN_OID ? null : value };
  }

  if (key === "branch.head") {
    return { ...state, branch: value === DETACHED_HEAD ? null : value };
  }

  if (key === "branch.upstream") {
    return { ...state, upstream: value };
  }

  if (key === "branch.ab") {
    return {
      ...state,
      ahead: parseCount(rest[0]),
      behind: parseCount(rest[1]),
    };
  }

  return state;
};

const applyEntry = (
  state: WorkingTreeState,
  entry: string
): WorkingTreeState => {
  const kind = entry.slice(0, 1);

  if (kind === "?") {
    return { ...state, untrackedFiles: state.untrackedFiles + 1 };
  }

  if (kind === "u") {
    return { ...state, conflictedFiles: state.conflictedFiles + 1 };
  }

  if (kind === "1" || kind === "2") {
    const staged = entry.slice(2, 3) !== ".";

    return {
      ...state,
      stagedFiles: state.stagedFiles + (staged ? 1 : 0),
      trackedChangedFiles: state.trackedChangedFiles + 1,
    };
  }

  return state;
};

export const parseStatusPorcelainV2 = (output: string): WorkingTreeState => {
  const records = output.split("\0");

  let state: WorkingTreeState = {
    ahead: null,
    behind: null,
    branch: null,
    conflictedFiles: 0,
    headSha: null,
    stagedFiles: 0,
    trackedChangedFiles: 0,
    untrackedFiles: 0,
    upstream: null,
  };

  let index = 0;

  while (index < records.length) {
    const record = records[index] ?? "";

    if (record.startsWith("# ")) {
      state = applyHeader(state, record.slice(2));
    } else if (record.length > 0) {
      state = applyEntry(state, record);

      if (record.startsWith("2 ")) {
        index += 1;
      }
    }

    index += 1;
  }

  return state;
};

export const parseNumstat = (output: string): DiffTotals => {
  const records = output.split("\0");

  let totals: DiffTotals = {
    binaryFiles: 0,
    files: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };

  let index = 0;

  while (index < records.length) {
    const record = records[index] ?? "";
    const fields = record.split("\t");

    if (fields.length >= 3) {
      const [added = "", deleted = "", path = ""] = fields;
      const binary = added === "-" || deleted === "-";
      totals = {
        binaryFiles: totals.binaryFiles + (binary ? 1 : 0),
        files: totals.files + 1,
        linesAdded: totals.linesAdded + (binary ? 0 : Number(added)),
        linesDeleted: totals.linesDeleted + (binary ? 0 : Number(deleted)),
      };

      if (path.length === 0) {
        index += 2;
      }
    }

    index += 1;
  }

  return totals;
};

const toIso = (value: string): string | null =>
  Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });

const parseReflogLine = (line: string): ReflogEntry | null => {
  const [sha = "", selector = "", subject = ""] = line.split("\u001F");

  if (!/^[0-9a-f]{7,64}$/u.test(sha)) {
    return null;
  }

  const dateMatch = SELECTOR_DATE_PATTERN.exec(selector);
  const actionMatch = ACTION_PATTERN.exec(subject);
  const createdMatch = CREATED_FROM_PATTERN.exec(subject);

  return {
    action: actionMatch?.groups?.action ?? "unknown",
    createdFrom: createdMatch?.groups?.ref ?? null,
    newSha: sha,
    occurredAt:
      dateMatch?.groups?.date === undefined
        ? null
        : toIso(dateMatch.groups.date),
  };
};

export const parseReflog = (output: string): readonly ReflogEntry[] =>
  output.split("\n").flatMap((line) => {
    const entry = parseReflogLine(line.trim());

    return entry === null ? [] : [entry];
  });

const PATH_FIELD_OFFSET = new Map([
  ["1", 8],
  ["2", 9],
  ["?", 1],
  ["u", 10],
]);

const isWorktreeDeletion = (entry: string): boolean => {
  const worktreeCode = entry.slice(3, 4);
  const indexCode = entry.slice(2, 3);

  return worktreeCode === "D" || (indexCode === "D" && worktreeCode === ".");
};

export const parseStatusPaths = (output: string): readonly string[] => {
  const records = output.split("\0");
  const paths: string[] = [];
  let index = 0;

  while (index < records.length) {
    const record = records[index] ?? "";
    const offset = PATH_FIELD_OFFSET.get(record.slice(0, 1));

    if (offset !== undefined && !record.startsWith("# ")) {
      const path = record.split(" ").slice(offset).join(" ");

      if (path.length > 0 && !isWorktreeDeletion(record)) {
        paths.push(path);
      }
    }

    index += record.startsWith("2 ") ? 2 : 1;
  }

  return paths.toSorted();
};
