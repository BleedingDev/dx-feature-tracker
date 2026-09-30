import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { captureCommand } from "../../src/dx/collectors/shell-command/capture.js";
import {
  SHELL_COMMAND_ADAPTER_ID,
  shellCommandCollector,
  shellCommandDescriptor,
} from "../../src/dx/collectors/shell-command/collector.js";
import {
  isTestCommand,
  redactArgv,
  shellExitStatus,
} from "../../src/dx/collectors/shell-command/record.js";
import type { CollectInput } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import {
  EventBatchSchema,
  emptyFlightContext,
} from "../../src/dx/model/event.js";

const CANARY = "DXFR_SYNTHETIC_SECRET_CANARY_7f3a9c";

const fixture = (name: string) =>
  Path.Path.pipe(
    Effect.map((path) =>
      path.join(import.meta.dirname, "fixtures", "b20", name)
    )
  );

const inputFor = (
  selectedInput: string,
  cursor: string | null = null
): CollectInput => ({
  adapterId: SHELL_COMMAND_ADAPTER_ID,
  context: {
    ...emptyFlightContext,
    branch: "feature/input-branch",
    worktreePath: "/redacted/repos/sample-app",
  },
  cursor:
    cursor === null
      ? null
      : { adapterId: SHELL_COMMAND_ADAPTER_ID, value: cursor },
  origin: "fixture",
  scratchDir: null,
  selectedInput,
});

it.layer(NodeServices.layer)("B20 shell-command collector", (test) => {
  test.effect(
    "lifecycle log yields runs with exit, signal, tests and no secrets",
    () =>
      Effect.gen(function* lifecycle() {
        const file = yield* fixture("lifecycle.jsonl");
        const batch = yield* shellCommandCollector.collect(inputFor(file));
        yield* Schema.decodeEffect(EventBatchSchema)(batch);

        const runs = batch.events.filter(
          (event) => event.kind === "command.run"
        );

        const tests = batch.events.filter(
          (event) => event.kind === "test.result"
        );

        expect(runs.map((event) => event.upstreamKey).toSorted()).toEqual([
          "run:r1",
          "run:r2",
          "run:r3",
        ]);
        const failing = runs.find((event) => event.upstreamKey === "run:r1");
        expect(failing?.payload).toMatchObject({
          durationMs: 42_500,
          exitCode: 1,
          status: "failed",
          testCommand: true,
        });
        expect(failing?.context.branch).toBe("feature/fixture-flight");
        expect(tests).toHaveLength(1);
        expect(tests[0]?.payload).toMatchObject({
          failedTests: null,
          outcome: "failed",
        });
        const signaled = runs.find((event) => event.upstreamKey === "run:r3");
        expect(signaled?.payload).toMatchObject({
          exitCode: null,
          signal: "SIGINT",
          status: "signaled",
        });
        expect(
          runs.find((event) => event.upstreamKey === "run:r2")?.payload
        ).toMatchObject({
          cwdRelative: "apps/web",
          redactedCount: 2,
        });
        expect(JSON.stringify(batch)).not.toContain(CANARY);
        expect(batch.coverage.state).toBe("partial");
        expect(batch.coverage.gaps.map((gap) => gap.code).toSorted()).toEqual([
          "incomplete-runs",
          "invalid-records",
        ]);
        expect(batch.cursor?.value).toBe("5");
        expect(runs[0]?.eventId).toMatch(/^sha256:[0-9a-f]{64}$/u);
      })
  );

  test.effect("cursor re-read is idempotent and holds incomplete runs", () =>
    Effect.gen(function* resume() {
      const file = yield* fixture("lifecycle.jsonl");
      const first = yield* shellCommandCollector.collect(inputFor(file));

      const again = yield* shellCommandCollector.collect(
        inputFor(file, first.cursor?.value ?? null)
      );

      expect(again.events).toHaveLength(0);
      expect(again.cursor?.value).toBe("5");
      const rerun = yield* shellCommandCollector.collect(inputFor(file));
      expect(rerun.events.map((event) => event.eventId)).toEqual(
        first.events.map((event) => event.eventId)
      );
    })
  );

  test.effect(
    "zsh and bash history are reconstructed with unavailable exit status",
    () =>
      Effect.gen(function* history() {
        const zsh = yield* fixture("history-zsh.txt");
        const bash = yield* fixture("history-bash.txt");

        const zshBatch = yield* shellCommandCollector.collect(
          inputFor(`history:${zsh}`)
        );

        const bashBatch = yield* shellCommandCollector.collect(
          inputFor(`history:${bash}`)
        );

        expect(zshBatch.events).toHaveLength(3);
        expect(zshBatch.events[0]).toMatchObject({
          acquisition: "file-import",
          occurredAt: "2026-09-30T09:00:00.000Z",
          occurredAtPrecision: "second",
        });
        expect(zshBatch.events[0]?.payload).toMatchObject({
          durationMs: 3000,
          exitCode: null,
          reconstructed: true,
          status: "unknown",
          testCommand: true,
        });
        expect(JSON.stringify(zshBatch)).not.toContain("SECRETVALUE");
        expect(
          bashBatch.events.map((event) => event.occurredAtPrecision)
        ).toEqual(["second", "unknown"]);
        expect(bashBatch.coverage.gaps.map((gap) => gap.code)).toContain(
          "history-untimed"
        );
        expect(bashBatch.cursor).toBeNull();
      })
  );

  test.effect(
    "missing selection or unreadable file fail with typed errors",
    () =>
      Effect.gen(function* failures() {
        const none = yield* Effect.flip(
          shellCommandCollector.collect({
            ...inputFor(""),
            selectedInput: null,
          })
        );

        expect(none._tag).toBe("InvalidInput");

        const missing = yield* Effect.flip(
          shellCommandCollector.collect(inputFor("/nonexistent/dxfr-b20.jsonl"))
        );

        expect(missing._tag).toBe("SourceUnavailable");
      })
  );

  test.effect(
    "captureCommand records a real child exit code and a signal",
    () =>
      Effect.gen(function* capture() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const logPath = path.join(directory, "commands.jsonl");
        const context = { ...emptyFlightContext, branch: "feature/capture" };

        const failed = yield* captureCommand({
          argv: ["node", "-e", "process.exit(3)"],
          context,
          cwd: directory,
          logPath,
        });

        expect(failed.exitCode).toBe(3);
        expect(shellExitStatus(failed)).toBe(3);

        const killed = yield* captureCommand({
          argv: ["node", "-e", "process.kill(process.pid, 'SIGTERM')"],
          context,
          cwd: directory,
          logPath,
        });

        expect(killed.signal).toBe("SIGTERM");
        expect(shellExitStatus(killed)).toBe(143);

        const missing = yield* captureCommand({
          argv: ["dxfr-b20-no-such-binary"],
          context,
          cwd: directory,
          logPath,
        });

        expect(missing.spawnError).not.toBeNull();
        expect(shellExitStatus(missing)).toBe(127);

        const batch = yield* shellCommandCollector.collect({
          ...inputFor(logPath),
          context: { ...emptyFlightContext, worktreePath: directory },
        });

        expect(batch.events.map((event) => event.payload.status)).toEqual([
          "failed",
          "signaled",
          "spawn-error",
        ]);
        expect(batch.events[0]?.context.branch).toBe("feature/capture");
        expect(batch.events[0]?.payload.cwdRelative).toBe(".");
      })
  );

  test.effect("descriptor decodes and classification helpers behave", () =>
    Effect.gen(function* descriptor() {
      yield* Schema.decodeEffect(ModuleDescriptorSchema)(
        shellCommandDescriptor
      );
      expect(isTestCommand(["CI=1", "pnpm", "--filter", "core", "test"])).toBe(
        true
      );
      expect(isTestCommand(["cargo", "build"])).toBe(false);
      expect(redactArgv(["curl", "-H", "--password", "hunter2"]).args).toEqual([
        "curl",
        "-H",
        "--password",
        "[redacted]",
      ]);
    })
  );
});
