import { Option, Schema } from "effect";

import type { DxEventEnvelope } from "../../model/event.js";

export type TestOutcome = "failed" | "passed" | "unknown";

export interface TestRunSignal {
  readonly event: DxEventEnvelope;
  readonly failingTests: readonly string[];
  readonly outcome: TestOutcome;
}

export interface ToolCallSignal {
  readonly event: DxEventEnvelope;
  readonly failed: boolean;
  readonly toolName: string | null;
}

export interface CommandFailureSignal {
  readonly commandKey: string;
  readonly event: DxEventEnvelope;
}

export interface FileEditSignal {
  readonly event: DxEventEnvelope;
  readonly filePath: string;
}

export interface FrictionSignals {
  readonly commandFailures: readonly CommandFailureSignal[];
  readonly commandRuns: readonly DxEventEnvelope[];
  readonly fileEdits: readonly FileEditSignal[];
  readonly testRuns: readonly TestRunSignal[];
  readonly toolCalls: readonly ToolCallSignal[];
}

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

const OptionalCount = Schema.optional(Schema.NullOr(Schema.Finite));

const TestPayloadSchema = Schema.Struct({
  errors: OptionalCount,
  failed: OptionalCount,
  failingTests: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  outcome: OptionalText,
  status: OptionalText,
});

const CommandPayloadSchema = Schema.Struct({
  commandBin: OptionalText,
  commandHash: OptionalText,
  commandName: OptionalText,
  exitCode: OptionalCount,
  program: OptionalText,
  spawnError: OptionalText,
});

const HookPayloadSchema = Schema.Struct({
  filePath: OptionalText,
  hookEvent: OptionalText,
  status: OptionalText,
  toolCall: Schema.optional(Schema.NullOr(Schema.Boolean)),
  toolName: OptionalText,
});

type TestPayload = typeof TestPayloadSchema.Type;

type CommandPayload = typeof CommandPayloadSchema.Type;

type HookPayload = typeof HookPayloadSchema.Type;

const decodeTest = Schema.decodeUnknownOption(TestPayloadSchema);

const decodeCommand = Schema.decodeUnknownOption(CommandPayloadSchema);

const decodeHook = Schema.decodeUnknownOption(HookPayloadSchema);

const FAILED_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "errored",
  "fail",
  "failed",
  "failure",
]);

const PASSED_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "pass",
  "passed",
  "success",
]);

const nonEmpty = (text: string | null | undefined): string | null =>
  text === undefined || text === null || text === "" ? null : text;

const statusOutcome = (text: string | null | undefined): TestOutcome => {
  const normalized = nonEmpty(text)?.toLowerCase() ?? null;

  if (normalized !== null && FAILED_STATUSES.has(normalized)) {
    return "failed";
  }

  if (normalized !== null && PASSED_STATUSES.has(normalized)) {
    return "passed";
  }

  return "unknown";
};

const testOutcome = (payload: TestPayload): TestOutcome => {
  const failed = payload.failed ?? null;
  const errors = payload.errors ?? null;

  if ((failed ?? 0) + (errors ?? 0) > 0) {
    return "failed";
  }

  const byStatus = statusOutcome(payload.status);

  if (byStatus !== "unknown") {
    return byStatus;
  }

  const byOutcome = statusOutcome(payload.outcome);

  if (byOutcome !== "unknown") {
    return byOutcome;
  }

  return failed === 0 && errors === 0 ? "passed" : "unknown";
};

const commandKeyOf = (payload: CommandPayload): string =>
  nonEmpty(payload.commandName) ??
  nonEmpty(payload.program) ??
  nonEmpty(payload.commandBin) ??
  nonEmpty(payload.commandHash) ??
  "unknown-command";

const commandFailed = (payload: CommandPayload): boolean => {
  const exitCode = payload.exitCode ?? null;

  if (exitCode !== null) {
    return exitCode !== 0;
  }

  return nonEmpty(payload.spawnError) !== null;
};

const toolFailed = (payload: HookPayload): boolean =>
  payload.hookEvent === "postToolUseFailure" ||
  statusOutcome(payload.status) === "failed";

const compareIds = (a: DxEventEnvelope, b: DxEventEnvelope): number => {
  if (a.eventId === b.eventId) {
    return 0;
  }

  return a.eventId < b.eventId ? -1 : 1;
};

const uniqueEvents = (
  events: readonly DxEventEnvelope[]
): DxEventEnvelope[] => {
  const byId = new Map<string, DxEventEnvelope>();

  for (const event of events) {
    if (!byId.has(event.eventId)) {
      byId.set(event.eventId, event);
    }
  }

  return [...byId.values()].toSorted(compareIds);
};

const testSignal = (event: DxEventEnvelope): TestRunSignal => {
  const decoded = decodeTest(event.payload);

  if (Option.isNone(decoded)) {
    return { event, failingTests: [], outcome: "unknown" };
  }

  return {
    event,
    failingTests: (decoded.value.failingTests ?? []).filter(
      (name) => name !== ""
    ),
    outcome: testOutcome(decoded.value),
  };
};

export const extractFrictionSignals = (
  events: readonly DxEventEnvelope[]
): FrictionSignals => {
  const testRuns: TestRunSignal[] = [];
  const toolCalls: ToolCallSignal[] = [];
  const commandFailures: CommandFailureSignal[] = [];
  const commandRuns: DxEventEnvelope[] = [];
  const fileEdits: FileEditSignal[] = [];

  for (const event of uniqueEvents(events)) {
    if (event.kind === "test.result") {
      testRuns.push(testSignal(event));
    }

    if (event.kind === "command.run") {
      commandRuns.push(event);

      const decoded = decodeCommand(event.payload);

      if (Option.isSome(decoded) && commandFailed(decoded.value)) {
        commandFailures.push({
          commandKey: commandKeyOf(decoded.value),
          event,
        });
      }
    }

    const hook = decodeHook(event.payload);

    if (Option.isSome(hook) && hook.value.toolCall === true) {
      toolCalls.push({
        event,
        failed: toolFailed(hook.value),
        toolName: nonEmpty(hook.value.toolName),
      });
    }

    const filePath = Option.isSome(hook) ? nonEmpty(hook.value.filePath) : null;

    if (event.kind === "ai.tool-edit" && filePath !== null) {
      fileEdits.push({ event, filePath });
    }
  }

  return { commandFailures, commandRuns, fileEdits, testRuns, toolCalls };
};
