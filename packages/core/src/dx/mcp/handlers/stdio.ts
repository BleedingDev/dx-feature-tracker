import { Console, Effect } from "effect";

const toStderr = (...args: readonly unknown[]): void => {
  // @effect-diagnostics-next-line globalConsole:off -- This is the stderr sink that keeps MCP stdio stdout reserved for protocol frames.
  globalThis.console.error(...args);
};

const ignore = (): void => undefined;

export const stderrConsole: Console.Console = {
  assert: (condition: boolean, ...args: readonly string[]) => {
    if (!condition) {
      toStderr("Assertion failed", ...args);
    }
  },
  clear: ignore,
  count: toStderr,
  countReset: ignore,
  debug: toStderr,
  dir: toStderr,
  dirxml: toStderr,
  error: toStderr,
  group: toStderr,
  groupCollapsed: toStderr,
  groupEnd: ignore,
  info: toStderr,
  log: toStderr,
  table: toStderr,
  time: ignore,
  timeEnd: toStderr,
  timeLog: toStderr,
  trace: toStderr,
  warn: toStderr,
};

export const isolateStdout = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Console.Console, stderrConsole);
