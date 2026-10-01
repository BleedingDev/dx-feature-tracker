// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs need a synchronous deterministic sha256 inside the pure parser; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem, Option, Schema } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import { withCollectorBlocks } from "../../harness/collector-blocks.js";
import type { SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  FieldSemantics,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";

export const CURSOR_EXTENSION_ADAPTER_ID = "cursor-extension";

export const CURSOR_EXTENSION_ADAPTER_VERSION = "0.1.0";

export const CURSOR_EXTENSION_RECORD_SCHEMA = "dx.cursor-extension.activity.v1";

export const CURSOR_EXTENSION_FIXTURE_ID = "b09-cursor-extension-activity";

export const CursorExtensionActivityTypeSchema = Schema.Literals([
  "window-focus",
  "window-blur",
  "document-save",
  "active-editor-change",
  "branch-change",
]);

export type CursorExtensionActivityType =
  typeof CursorExtensionActivityTypeSchema.Type;

export const CursorExtensionActivityRecordSchema = Schema.Struct({
  at: Schema.String,
  branch: Schema.NullOr(Schema.String),
  extensionVersion: Schema.String,
  fileHash: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  hostApp: Schema.String,
  hostVersion: Schema.NullOr(Schema.String),
  schema: Schema.Literal(CURSOR_EXTENSION_RECORD_SCHEMA),
  seq: Schema.Int,
  sessionId: Schema.String,
  type: CursorExtensionActivityTypeSchema,
  workspace: Schema.NullOr(Schema.String),
});

export type CursorExtensionActivityRecord =
  typeof CursorExtensionActivityRecordSchema.Type;

const decodeRecordLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(CursorExtensionActivityRecordSchema)
);

const SOURCE_GAPS: readonly SourceGap[] = [
  {
    code: "producer-not-installed",
    message:
      "No dft VS Code/Cursor extension is shipped or installed on this host; only user-selected activity JSONL exports are read.",
  },
  {
    code: "no-ai-usage-via-extension-api",
    message:
      "The public VS Code extension API exposes editor/window/save/git activity only; Cursor AI tokens, cost, requests and tool calls are unavailable from this route.",
  },
  {
    code: "no-ai-ownership",
    message:
      "Editor activity is not evidence of AI or human authorship; attribution stays not-applicable.",
  },
];

export const cursorExtensionDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [CURSOR_EXTENSION_FIXTURE_ID],
  gaps: SOURCE_GAPS,
  id: DescriptorIdSchema.make("collector/cursor-extension"),
  kind: "collector",
  owner: "B09",
  readiness: "disabled",
  requiredInputs: [
    `user-selected JSONL export with records of schema ${CURSOR_EXTENSION_RECORD_SCHEMA}`,
  ],
  supportedFields: [
    "occurredAt",
    "context.branch",
    "context.headSha",
    "context.worktreePath",
    "identity.sessionId",
    "payload.activity",
    "payload.hostApp",
    "payload.hostVersion",
    "payload.extensionVersion",
    "payload.fileHash",
  ],
  version: CURSOR_EXTENSION_ADAPTER_VERSION,
};

const FIELD_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "payload.activity",
    method: "observed",
    note: "VS Code extension API event observed by the producer extension",
    rawName: "type",
    unit: null,
  },
  {
    field: "occurredAt",
    method: "source-reported",
    note: null,
    rawName: "at",
    unit: "iso8601",
  },
];

const eventIdOf = (upstreamKey: string): string =>
  `sha256:${createHash("sha256")
    .update(`${CURSOR_EXTENSION_ADAPTER_ID}\u0000${upstreamKey}\u0000other`)
    .digest("hex")}`;

const toEnvelope = (
  record: CursorExtensionActivityRecord,
  lineIndex: number,
  input: CollectInput,
  observedAt: string
): DxEventEnvelope => {
  const upstreamKey = `${record.sessionId}:${record.seq}`;

  return withCollectorBlocks({
    acquisition: "file-import",
    adapterId: CURSOR_EXTENSION_ADAPTER_ID,
    adapterVersion: CURSOR_EXTENSION_ADAPTER_VERSION,
    context: {
      ...input.context,
      branch: record.branch ?? input.context.branch,
      headSha: record.headSha ?? input.context.headSha,
      worktreePath: record.workspace ?? input.context.worktreePath,
    },
    eventId: EventIdSchema.make(eventIdOf(upstreamKey)),
    evidence: {
      bounded: true,
      hash: null,
      ref: `${input.selectedInput ?? "unknown"}#L${lineIndex + 1}`,
    },
    fieldSemantics: FIELD_SEMANTICS,
    identity: { ...emptyEventIdentity, sessionId: record.sessionId },
    kind: "other",
    observedAt,
    occurredAt: record.at,
    occurredAtPrecision: "exact",
    origin: input.origin,
    payload: {
      activity: record.type,
      category: "ide.activity",
      extensionVersion: record.extensionVersion,
      fileHash: record.fileHash,
      hostApp: record.hostApp,
      hostVersion: record.hostVersion,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceVersion: record.hostVersion,
    upstreamKey,
  });
};

const startLine = (input: CollectInput): number => {
  const value = input.cursor?.value;
  const parsed = value === undefined ? 0 : Math.trunc(Number(value));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const parseCursorExtensionActivity = (
  text: string,
  input: CollectInput,
  observedAt: string
): EventBatch => {
  const lines = text.split("\n");
  const from = startLine(input);
  const events = new Map<string, DxEventEnvelope>();
  let rejected = 0;
  let considered = 0;

  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";

    if (line.length > 0) {
      considered += 1;
      const decoded = decodeRecordLine(line);

      if (Option.isSome(decoded)) {
        const envelope = toEnvelope(decoded.value, index, input, observedAt);

        events.set(envelope.eventId, envelope);
      } else {
        rejected += 1;
      }
    }
  }

  const ordered = [...events.values()];

  const times = ordered
    .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
    .toSorted();

  const gaps: SourceGap[] = [...SOURCE_GAPS];

  if (rejected > 0) {
    gaps.push({
      code: "rejected-records",
      message: `${rejected} line(s) were not valid ${CURSOR_EXTENSION_RECORD_SCHEMA} records and were skipped`,
    });
  }

  return {
    coverage: {
      adapterId: CURSOR_EXTENSION_ADAPTER_ID,
      expectedItems: considered,
      gaps,
      observedItems: ordered.length,
      state: ordered.length === 0 ? "none" : "partial",
      watermark: times.at(-1) ?? null,
      windowFrom: times.at(0) ?? null,
      windowTo: times.at(-1) ?? null,
    },
    cursor: {
      adapterId: CURSOR_EXTENSION_ADAPTER_ID,
      value: String(lines.length),
    },
    events: ordered,
  };
};

export const cursorExtensionCollector: DxCollector<FileSystem.FileSystem> = {
  collect: (input) =>
    Effect.gen(function* collectCursorExtension() {
      const path = input.selectedInput;

      if (path === null || path.length === 0) {
        return yield* new InvalidInput({
          field: "input",
          message:
            "cursor-extension reads only an explicitly selected activity JSONL export (--input)",
        });
      }

      const fileSystem = yield* FileSystem.FileSystem;

      const text = yield* fileSystem.readFileString(path).pipe(
        Effect.mapError(
          () =>
            new SourceUnavailable({
              adapterId: CURSOR_EXTENSION_ADAPTER_ID,
              message:
                "selected cursor-extension activity export is not readable",
            })
        )
      );

      const now = yield* DateTime.now;

      return parseCursorExtensionActivity(text, input, DateTime.formatIso(now));
    }),
  descriptor: cursorExtensionDescriptor,
};
