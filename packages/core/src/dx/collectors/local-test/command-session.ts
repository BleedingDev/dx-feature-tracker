import { DateTime, Option, Schema } from "effect";

export const COMMAND_SESSION_SCHEMA = "dx.local-test.command.v1" as const;

export interface CommandSession {
  readonly branch: string | null;
  readonly commandDisplay: string;
  readonly commandName: string;
  readonly cwd: string | null;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly headSha: string | null;
  readonly isTestCommand: boolean;
  readonly reports: readonly string[];
  readonly sessionId: string;
  readonly startedAt: string | null;
}

export interface CommandSessionParse {
  readonly rejected: number;
  readonly sessions: readonly CommandSession[];
}

const MAX_DISPLAY_LENGTH = 200;

const SECRET_PATTERN =
  /(?<key>(?:token|secret|password|passwd|api[_-]?key|auth)[\w-]*[=:])\S+/giu;

const TEST_COMMAND_PATTERN =
  /\b(?:vitest|jest|mocha|pytest|test|spec|cargo test|go test|playwright)\b/u;

const CommandRecordSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  endedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  headSha: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reports: Schema.optionalKey(Schema.Array(Schema.String)),
  schema: Schema.Literal(COMMAND_SESSION_SCHEMA),
  sessionId: Schema.NonEmptyString,
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

type CommandRecord = typeof CommandRecordSchema.Type;

const decodeRecordLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(CommandRecordSchema)
);

const nonEmpty = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.length === 0 ? null : value;

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = DateTime.make(value);

  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null;
};

export const redactCommand = (argv: readonly string[]): string => {
  const joined = argv.join(" ").replaceAll(SECRET_PATTERN, "$<key>[redacted]");

  return joined.length > MAX_DISPLAY_LENGTH
    ? joined.slice(0, MAX_DISPLAY_LENGTH)
    : joined;
};

const baseName = (value: string): string => value.split(/[\\/]/u).at(-1) ?? "";

const toSession = (record: CommandRecord): CommandSession | null => {
  const [program] = record.argv;

  if (program === undefined) {
    return null;
  }

  return {
    branch: nonEmpty(record.branch),
    commandDisplay: redactCommand(record.argv),
    commandName: baseName(program),
    cwd: nonEmpty(record.cwd),
    endedAt: isoOrNull(record.endedAt),
    exitCode: record.exitCode ?? null,
    headSha: nonEmpty(record.headSha),
    isTestCommand: TEST_COMMAND_PATTERN.test(record.argv.join(" ")),
    reports: (record.reports ?? []).map(baseName),
    sessionId: record.sessionId,
    startedAt: isoOrNull(record.startedAt),
  };
};

export const parseCommandSessions = (content: string): CommandSessionParse => {
  const sessions: CommandSession[] = [];
  let rejected = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.length > 0) {
      const decoded = decodeRecordLine(trimmed);
      const session = Option.isSome(decoded) ? toSession(decoded.value) : null;

      if (session === null) {
        rejected += 1;
      } else {
        sessions.push(session);
      }
    }
  }

  return { rejected, sessions };
};

export type JoinAttribution = "strong" | "provisional" | "unassigned";

export interface SessionJoin {
  readonly attribution: JoinAttribution;
  readonly method: "declared-report" | "time-window" | "none";
  readonly session: CommandSession | null;
}

export const JOIN_SLACK_MS = 5000;

const epochMs = (iso: string): number =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const containsTime = (session: CommandSession, at: number): boolean => {
  if (session.startedAt === null || session.endedAt === null) {
    return false;
  }

  return (
    at >= epochMs(session.startedAt) &&
    at <= epochMs(session.endedAt) + JOIN_SLACK_MS
  );
};

export const joinReport = (
  reportName: string,
  reportStartedAt: string | null,
  sessions: readonly CommandSession[]
): SessionJoin => {
  const declared = sessions.filter((session) =>
    session.reports.includes(reportName)
  );

  if (declared.length > 1) {
    return { attribution: "unassigned", method: "none", session: null };
  }

  if (declared.length === 1) {
    return {
      attribution: "strong",
      method: "declared-report",
      session: declared[0] ?? null,
    };
  }

  if (reportStartedAt === null) {
    return { attribution: "unassigned", method: "none", session: null };
  }

  const at = epochMs(reportStartedAt);
  const windowed = sessions.filter((session) => containsTime(session, at));

  if (windowed.length === 1) {
    return {
      attribution: "provisional",
      method: "time-window",
      session: windowed[0] ?? null,
    };
  }

  return { attribution: "unassigned", method: "none", session: null };
};
