import { Clock, Crypto, DateTime, Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { FlightContext } from "../../model/event.js";
import {
  CommandLifecycleRecordSchema,
  LIFECYCLE_RECORD_VERSION,
  signalFromMessage,
} from "./record.js";
import type { CommandLifecycleRecord } from "./record.js";

const isoNow = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms)))
);

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const encodeRecord = Schema.encodeEffect(
  Schema.fromJsonString(CommandLifecycleRecordSchema)
);

export const appendLifecycleRecord = Effect.fn("appendLifecycleRecord")(
  function* appendLifecycleRecord(
    logPath: string,
    record: CommandLifecycleRecord
  ) {
    const fs = yield* FileSystem.FileSystem;
    const line = yield* encodeRecord(record);
    yield* fs.writeFileString(logPath, `${line}\n`, { flag: "a" });
  }
);

export interface CaptureOptions {
  readonly argv: readonly string[];
  readonly context: FlightContext;
  readonly cwd: string | null;
  readonly logPath: string;
}

export const captureCommand = Effect.fn("captureCommand")(
  function* captureCommand(options: CaptureOptions) {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [program, ...args] = options.argv;
    const runId = toHex(yield* crypto.randomBytes(12));
    const startedAt = yield* isoNow;

    const start: CommandLifecycleRecord = {
      argv: options.argv,
      branch: options.context.branch,
      cwd: options.cwd,
      endedAt: null,
      exitCode: null,
      headSha: options.context.headSha,
      phase: "start",
      runId,
      signal: null,
      spawnError: null,
      startedAt,
      version: LIFECYCLE_RECORD_VERSION,
    };

    yield* appendLifecycleRecord(options.logPath, start);

    const outcome =
      program === undefined
        ? { exitCode: null, signal: null, spawnError: "empty argv" }
        : yield* spawner
            .exitCode(
              ChildProcess.make(program, args, {
                cwd: options.cwd ?? undefined,
                stderr: "inherit",
                stdin: "inherit",
                stdout: "inherit",
              })
            )
            .pipe(
              Effect.map((code) => ({
                exitCode: Number(code),
                signal: null,
                spawnError: null,
              })),
              Effect.catch((error) => {
                const detail = `${error.message} ${String(error.cause)}`;
                const signal = signalFromMessage(detail);

                return Effect.succeed({
                  exitCode: null,
                  signal,
                  spawnError: signal === null ? detail.slice(0, 200) : null,
                });
              })
            );

    const endedAt = yield* isoNow;

    const end: CommandLifecycleRecord = {
      ...start,
      ...outcome,
      endedAt,
      phase: "end",
    };

    yield* appendLifecycleRecord(options.logPath, end);

    return end;
  }
);
