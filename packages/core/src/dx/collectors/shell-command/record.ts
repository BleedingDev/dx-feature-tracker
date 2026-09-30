import { Schema } from "effect";

export const LIFECYCLE_RECORD_VERSION = "dx.shell-command.v1" as const;

export const CommandLifecycleRecordSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  branch: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  headSha: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["start", "end"]),
  runId: Schema.String,
  signal: Schema.NullOr(Schema.String),
  spawnError: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  version: Schema.Literal(LIFECYCLE_RECORD_VERSION),
});

export type CommandLifecycleRecord = typeof CommandLifecycleRecordSchema.Type;

export const MAX_ARGS = 32;

export const MAX_ARG_LENGTH = 200;

const SECRET_NAME = /token|secret|passw|api[-_]?key|auth|credential|bearer/iu;

const SECRET_VALUE = /^[A-Za-z0-9+/=_-]{32,}$/u;

const ENV_ASSIGNMENT = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u;

const REDACTED = "[redacted]";

const redactOne = (arg: string, previous: string | null): string => {
  if (
    previous !== null &&
    previous.startsWith("-") &&
    SECRET_NAME.test(previous)
  ) {
    return REDACTED;
  }

  const flagValue = /^(?<flag>--?[^=]+)=(?<value>.*)$/u.exec(arg);

  if (flagValue !== null && SECRET_NAME.test(flagValue.groups?.flag ?? "")) {
    return `${flagValue.groups?.flag}=${REDACTED}`;
  }

  const env = ENV_ASSIGNMENT.exec(arg);

  if (env !== null && SECRET_NAME.test(env.groups?.name ?? "")) {
    return `${env.groups?.name}=${REDACTED}`;
  }

  if (SECRET_VALUE.test(arg)) {
    return REDACTED;
  }

  if (/:\/\/[^/\s:@]+:[^/\s@]+@/u.test(arg)) {
    return arg.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/u, `://${REDACTED}@`);
  }

  return arg.length > MAX_ARG_LENGTH ? `${arg.slice(0, MAX_ARG_LENGTH)}…` : arg;
};

export interface RedactedArgv {
  readonly args: readonly string[];
  readonly redactedCount: number;
  readonly truncated: boolean;
}

export const redactArgv = (argv: readonly string[]): RedactedArgv => {
  const args: string[] = [];
  let redactedCount = 0;

  for (const [index, arg] of argv.slice(0, MAX_ARGS).entries()) {
    const out = redactOne(arg, index > 0 ? (argv[index - 1] ?? null) : null);

    if (out !== arg && out.includes(REDACTED)) {
      redactedCount += 1;
    }

    args.push(out);
  }

  return { args, redactedCount, truncated: argv.length > MAX_ARGS };
};

const TEST_RUNNERS = new Set([
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "ava",
  "playwright",
  "rspec",
]);

const PACKAGE_MANAGERS = new Set([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "turbo",
  "npx",
]);

const baseName = (value: string): string => value.split("/").at(-1) ?? value;

export const programOf = (argv: readonly string[]): string | null => {
  const envSkipped = argv.find((arg) => !ENV_ASSIGNMENT.test(arg));

  return envSkipped === undefined ? null : baseName(envSkipped);
};

export const isTestCommand = (argv: readonly string[]): boolean => {
  const words = argv.flatMap((arg) =>
    ENV_ASSIGNMENT.test(arg) ? [] : [baseName(arg)]
  );

  const [program, ...rest] = words;

  if (program === undefined) {
    return false;
  }

  if (TEST_RUNNERS.has(program)) {
    return true;
  }

  if (program === "cargo" || program === "go" || program === "dotnet") {
    return rest[0] === "test";
  }

  if (PACKAGE_MANAGERS.has(program)) {
    return rest.some(
      (word) =>
        word === "test" || word.startsWith("test:") || TEST_RUNNERS.has(word)
    );
  }

  return false;
};

const SIGNAL_MESSAGE = /signal: '(?<signal>[A-Z0-9]+)'/u;

export const signalFromMessage = (message: string): string | null =>
  SIGNAL_MESSAGE.exec(message)?.groups?.signal ?? null;

const SIGNAL_NUMBERS = new Map<string, number>([
  ["SIGABRT", 6],
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGKILL", 9],
  ["SIGPIPE", 13],
  ["SIGQUIT", 3],
  ["SIGSEGV", 11],
  ["SIGTERM", 15],
]);

export const shellExitStatus = (
  record: Pick<CommandLifecycleRecord, "exitCode" | "signal" | "spawnError">
): number => {
  if (record.exitCode !== null) {
    return record.exitCode;
  }

  if (record.signal !== null) {
    return 128 + (SIGNAL_NUMBERS.get(record.signal) ?? 0);
  }

  return record.spawnError === null ? 1 : 127;
};
