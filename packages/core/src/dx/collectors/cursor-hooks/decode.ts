import type { Origin } from "../../model/common.js";
import type {
  DxEventEnvelope,
  EventKind,
  FieldSemantics,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION } from "../../model/event.js";
import { EventIdSchema } from "../../model/ids.js";
import { sha256Hex } from "./sanitize.js";
import type { SanitizedHook, SpoolRecord } from "./spool-record.js";

export const CURSOR_HOOKS_ADAPTER_ID = "cursor-hooks" as const;

export const CURSOR_HOOKS_ADAPTER_VERSION = "0.1.0" as const;

export const SUPPORTED_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "subagentStart",
  "subagentStop",
  "preCompact",
] as const;

export type SupportedHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number];

const TOOL_CALL_EVENTS: ReadonlySet<string> = new Set([
  "postToolUse",
  "postToolUseFailure",
]);

const isSupported = (hookEvent: string): boolean =>
  SUPPORTED_HOOK_EVENTS.some((name) => name === hookEvent);

export const kindForHookEvent = (hookEvent: string): EventKind => {
  switch (hookEvent) {
    case "beforeSubmitPrompt": {
      return "ai.request";
    }

    case "stop": {
      return "ai.turn";
    }

    case "sessionStart":
    case "sessionEnd": {
      return "ai.session";
    }

    case "afterFileEdit":
    case "afterTabFileEdit": {
      return "ai.tool-edit";
    }

    default: {
      return "other";
    }
  }
};

const surfaceFor = (hookEvent: string): "agent" | "tab" =>
  hookEvent.includes("Tab") ? "tab" : "agent";

const hookDiscriminator = (record: SpoolRecord): string => {
  const { hook } = record;

  if (hook.hookEvent === "stop" || hook.hookEvent === "beforeSubmitPrompt") {
    return hook.hookEvent;
  }

  return hook.toolUseId ?? record.recordHash;
};

export const upstreamKeyFor = (record: SpoolRecord): string => {
  const { hook } = record;
  const session = hook.conversationId ?? hook.sessionId ?? "-";
  const generation = hook.generationId ?? "-";

  return `${hook.hookEvent}:${session}:${generation}:${hookDiscriminator(record)}`;
};

export const eventIdFor = (upstreamKey: string, kind: EventKind) =>
  EventIdSchema.make(
    `sha256:${sha256Hex(`${CURSOR_HOOKS_ADAPTER_ID}\n${upstreamKey}\n${kind}`)}`
  );

const semantics = (
  field: string,
  rawName: string,
  unit: string | null,
  note: string | null
): FieldSemantics => ({
  field,
  method: "source-reported",
  note,
  rawName,
  unit,
});

const baseSemantics = (hook: SanitizedHook): FieldSemantics[] => {
  const out: FieldSemantics[] = [
    semantics(
      "occurredAt",
      "capturedAt",
      null,
      "hook handler capture time, not a source timestamp"
    ),
  ];

  if (hook.durationMs !== null) {
    out.push(
      semantics("payload.durationMs", "duration_ms|duration", "ms", null)
    );
  }

  if (hook.linesAdded !== null) {
    out.push({
      field: "payload.linesAdded",
      method: "derived",
      note: "newline count of edit new_string values, not a git diff",
      rawName: "edits[].new_string",
      unit: "lines",
    });
  }

  return out;
};

const payloadFor = (hook: SanitizedHook, surface: "agent" | "tab") => ({
  attachmentCount: hook.attachmentCount,
  commandBin: hook.commandBin,
  commandHash: hook.commandHash,
  composerMode: hook.composerMode,
  cursorVersion: hook.cursorVersion,
  durationMs: hook.durationMs,
  editCount: hook.editCount,
  filePath: hook.filePath,
  finalStatus: hook.finalStatus,
  hookEvent: hook.hookEvent,
  isBackgroundAgent: hook.isBackgroundAgent,
  linesAdded: hook.linesAdded,
  linesRemoved: hook.linesRemoved,
  loopCount: hook.loopCount,
  model: hook.model,
  presentKeys: hook.presentKeys,
  promptChars: hook.promptChars,
  rawUsagePresent: hook.rawUsage.length > 0,
  reason: hook.reason,
  status: hook.status,
  supportedHookEvent: isSupported(hook.hookEvent),
  surface,
  toolCall: TOOL_CALL_EVENTS.has(hook.hookEvent),
  toolName: hook.toolName,
});

interface EnvelopeInput {
  readonly kind: EventKind;
  readonly upstreamKey: string;
  readonly payload: DxEventEnvelope["payload"];
  readonly fieldSemantics: readonly FieldSemantics[];
}

const envelope = (
  record: SpoolRecord,
  origin: Origin,
  input: EnvelopeInput
): DxEventEnvelope => {
  const { hook, git } = record;

  const turnId =
    hook.conversationId !== null && hook.generationId !== null
      ? `${hook.conversationId}:${hook.generationId}`
      : null;

  return {
    acquisition: "hook",
    adapterId: CURSOR_HOOKS_ADAPTER_ID,
    adapterVersion: CURSOR_HOOKS_ADAPTER_VERSION,
    context: {
      branch: git.branch,
      flightId: null,
      headSha: git.headSha,
      repoCommonDir: git.repoCommonDir,
      worktreePath: git.worktreePath,
    },
    eventId: eventIdFor(input.upstreamKey, input.kind),
    evidence: {
      bounded: true,
      hash: `sha256:${record.recordHash}`,
      ref: `cursor-hooks-spool:${record.recordHash}`,
    },
    fieldSemantics: input.fieldSemantics,
    identity: {
      commitSha: null,
      generationId: hook.generationId,
      githubAttempt: null,
      githubRunId: null,
      prNumber: null,
      requestId: null,
      sessionId: hook.conversationId ?? hook.sessionId,
      turnId,
    },
    kind: input.kind,
    observedAt: record.capturedAt,
    occurredAt: record.capturedAt,
    occurredAtPrecision: "exact",
    origin,
    payload: input.payload,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: hook.cursorVersion,
    upstreamKey: input.upstreamKey,
  };
};

const usageEnvelope = (
  record: SpoolRecord,
  origin: Origin,
  turnKey: string
): DxEventEnvelope => {
  const { hook } = record;
  const upstreamKey = `usage:${turnKey}`;

  return envelope(record, origin, {
    fieldSemantics: hook.rawUsage.map((entry) =>
      semantics(
        `payload.rawUsage.${entry.path}`,
        entry.path,
        null,
        "raw Cursor stop-hook field; semantics unverified, do not sum until probe passes"
      )
    ),
    kind: "ai.usage",
    payload: {
      hookEvent: hook.hookEvent,
      model: hook.model,
      normalizedCategories: null,
      rawUsage: Object.fromEntries(
        hook.rawUsage.map((entry) => [entry.path, entry.value])
      ),
      semanticsVerified: false,
      sourceKind: "hooks-stop",
    },
    upstreamKey,
  });
};

export const decodeSpoolRecord = (
  record: SpoolRecord,
  origin: Origin
): DxEventEnvelope[] => {
  const { hook } = record;
  const kind = kindForHookEvent(hook.hookEvent);
  const upstreamKey = upstreamKeyFor(record);

  const main = envelope(record, origin, {
    fieldSemantics: baseSemantics(hook),
    kind,
    payload: payloadFor(hook, surfaceFor(hook.hookEvent)),
    upstreamKey,
  });

  if (hook.hookEvent === "stop" && hook.rawUsage.length > 0) {
    return [main, usageEnvelope(record, origin, upstreamKey)];
  }

  return [main];
};
