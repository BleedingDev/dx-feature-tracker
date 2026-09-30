import { DateTime, Option } from "effect";

export const RECORD_SEPARATOR = "\u001E";

export const FIELD_SEPARATOR = "\u001F";

export const LOG_FORMAT = "%x1e%H%x1f%P%x1f%aI%x1f%cI";

export const MAX_PATHS_PER_EVENT = 200;

export interface NumstatEntry {
  readonly added: number | null;
  readonly binary: boolean;
  readonly deleted: number | null;
  readonly path: string;
}

export interface NumstatSummary {
  readonly binaryFiles: number;
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly paths: readonly string[];
  readonly pathsTruncated: boolean;
}

export interface ParsedCommit {
  readonly authoredAt: string | null;
  readonly committedAt: string | null;
  readonly files: readonly NumstatEntry[];
  readonly parents: readonly string[];
  readonly sha: string;
}

export interface ReflogEntry {
  readonly at: string | null;
  readonly sha: string;
  readonly subject: string;
}

const DIGITS_PATTERN = /^\d+$/u;

const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

const parseCount = (raw: string): number | null => {
  if (raw === "-") {
    return null;
  }

  return DIGITS_PATTERN.test(raw) ? Number(raw) : null;
};

const normalizeTimestamp = (raw: string | undefined): string | null => {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  return Option.match(DateTime.make(raw.trim()), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
};

export const parseNumstatLine = (line: string): NumstatEntry | null => {
  const parts = line.split("\t");

  if (parts.length < 3) {
    return null;
  }

  const [addedRaw = "", deletedRaw = "", ...rest] = parts;
  const path = rest.join("\t");

  if (path === "") {
    return null;
  }

  const binary = addedRaw === "-" && deletedRaw === "-";

  return {
    added: parseCount(addedRaw),
    binary,
    deleted: parseCount(deletedRaw),
    path,
  };
};

export const parseNumstat = (text: string): readonly NumstatEntry[] =>
  text
    .split("\n")
    .map((line) => parseNumstatLine(line.trimEnd()))
    .filter((entry): entry is NumstatEntry => entry !== null);

export const summarizeNumstat = (
  files: readonly NumstatEntry[]
): NumstatSummary => {
  const paths = files.map((file) => file.path);

  return {
    binaryFiles: files.filter((file) => file.binary).length,
    filesChanged: files.length,
    linesAdded: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    linesDeleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
    paths: paths.slice(0, MAX_PATHS_PER_EVENT),
    pathsTruncated: paths.length > MAX_PATHS_PER_EVENT,
  };
};

export const parseLog = (text: string): readonly ParsedCommit[] =>
  text
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+/u, ""))
    .filter((record) => record.trim() !== "")
    .flatMap((record) => {
      const [header = "", ...body] = record.split("\n");

      const [sha = "", parents = "", authored, committed] =
        header.split(FIELD_SEPARATOR);

      if (!SHA_PATTERN.test(sha)) {
        return [];
      }

      return [
        {
          authoredAt: normalizeTimestamp(authored),
          committedAt: normalizeTimestamp(committed),
          files: parseNumstat(body.join("\n")),
          parents: parents.split(" ").filter((parent) => parent !== ""),
          sha,
        },
      ];
    });

const REFLOG_DATE_PATTERN = /@\{(?<date>[^}]+)\}$/u;

export const parseReflog = (text: string): readonly ReflogEntry[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const [sha = "", selector = "", subject = ""] =
        line.split(FIELD_SEPARATOR);

      if (!SHA_PATTERN.test(sha)) {
        return [];
      }

      const match = REFLOG_DATE_PATTERN.exec(selector);

      return [{ at: normalizeTimestamp(match?.groups?.date), sha, subject }];
    });

const CREATED_PATTERN = /^branch: Created from (?<from>\S+)/u;

export const branchCreatedFrom = (subject: string): string | null =>
  CREATED_PATTERN.exec(subject)?.groups?.from ?? null;
