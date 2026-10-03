// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture starts and kills only its own helper process against an owned SQLite file.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";

import type { OperationInput } from "../../../../src/dx/model/agent-operation.js";
import type { EventBatch } from "../../../../src/dx/model/event.js";

class ProcessProbeError extends Schema.TaggedError<ProcessProbeError>()(
  "S06ProcessProbeError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
  }
) {}

export const startOperationProcess = (
  storePath: string,
  apply: OperationInput,
  firstBatch: EventBatch,
  secondBatch: EventBatch
) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("operation-process.mjs", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  child.stdin.end(
    JSON.stringify({ apply, firstBatch, secondBatch, storePath })
  );

  return child;
};

export const operationProcessReady = (
  child: ReturnType<typeof startOperationProcess>
) =>
  Effect.callback<string, ProcessProbeError>((resume) => {
    let output = "";
    let diagnostics = "";

    // @effect-diagnostics-next-line globalTimersInEffect:off -- The owned subprocess watchdog must expire in live wall time even when the parent test clock is paused.
    const timer = setTimeout(() => {
      resume(
        Effect.fail(
          new ProcessProbeError({
            cause: null,
            message:
              "Fixture operation process did not become ready within 20 seconds",
          })
        )
      );
    }, 20_000);

    const onExit = () => {
      resume(
        Effect.fail(
          new ProcessProbeError({
            cause: null,
            message: `Fixture operation process exited before readiness: ${diagnostics}`,
          })
        )
      );
    };

    const onError = (cause: Error) => {
      resume(
        Effect.fail(
          new ProcessProbeError({
            cause,
            message: "The owned fixture process failed before readiness",
          })
        )
      );
    };

    const onDiagnostics = (chunk: string) => {
      diagnostics += chunk;
    };

    const onOutput = (chunk: string) => {
      output += chunk;
      const end = output.indexOf("\n");

      if (end !== -1) {
        resume(Effect.succeed(output.slice(0, end)));
      }
    };

    child.once("exit", onExit);
    child.once("error", onError);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", onDiagnostics);
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", onOutput);

    return Effect.sync(() => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stderr.off("data", onDiagnostics);
      child.stdout.off("data", onOutput);
    });
  });

export const killOperationProcess = (
  child: ReturnType<typeof startOperationProcess>
) =>
  Effect.callback<null, ProcessProbeError>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(null));

      return Effect.void;
    }

    // @effect-diagnostics-next-line globalTimersInEffect:off -- SIGKILL and process exit are external events whose watchdog must use live wall time rather than a paused test clock.
    const timer = setTimeout(() => {
      resume(
        Effect.fail(
          new ProcessProbeError({
            cause: null,
            message: "Owned fixture process did not exit after SIGKILL",
          })
        )
      );
    }, 20_000);

    const onExit = () => {
      resume(Effect.succeed(null));
    };

    const onError = (cause: Error) => {
      resume(
        Effect.fail(
          new ProcessProbeError({
            cause,
            message: "The owned fixture process failed while awaiting exit",
          })
        )
      );
    };

    child.once("exit", onExit);
    child.once("error", onError);
    child.kill("SIGKILL");

    return Effect.sync(() => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    });
  });
