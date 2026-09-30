// @effect-diagnostics-next-line nodeBuiltinImport:off -- Event IDs need a synchronous deterministic sha256 inside the pure parser; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem, Option, Schema } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import { UnsupportedSource } from "../../contracts/error-unsupported-source.js";
import type { CollectInput, DxCollector } from "../../contracts/services.js";
import { CONTRACT_VERSION } from "../../contracts/version.js";
import { canonicalRequestKey, canonicalTurnKey } from "../../model/ai.js";
import type { CoverageState, SourceGap } from "../../model/coverage.js";
import type { ModuleDescriptor } from "../../model/descriptor.js";
import type {
  DxEventEnvelope,
  EventBatch,
  EventKind,
  FieldSemantics,
} from "../../model/event.js";
import { EVENT_SCHEMA_VERSION, emptyEventIdentity } from "../../model/event.js";
import { DescriptorIdSchema, EventIdSchema } from "../../model/ids.js";

export const OPENCODE_ADAPTER_ID = "opencode";

export const OPENCODE_ADAPTER_VERSION = "0.1.0";

export const OPENCODE_FIXTURE_IDS = [
  "b13-opencode-session-export",
  "b13-opencode-partial-export",
] as const;

const OptionalNumberSchema = Schema.optionalKey(Schema.NullOr(Schema.Finite));

const OptionalStringSchema = Schema.optionalKey(Schema.NullOr(Schema.String));

const OpencodeTokensSchema = Schema.Struct({
  cache: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        read: OptionalNumberSchema,
        write: OptionalNumberSchema,
      })
    )
  ),
  input: OptionalNumberSchema,
  output: OptionalNumberSchema,
  reasoning: OptionalNumberSchema,
});

const OpencodeTimeSchema = Schema.Struct({
  completed: OptionalNumberSchema,
  created: OptionalNumberSchema,
  updated: OptionalNumberSchema,
});

export const OpencodeMessageInfoSchema = Schema.Struct({
  cost: OptionalNumberSchema,
  id: Schema.String,
  modelID: OptionalStringSchema,
  providerID: OptionalStringSchema,
  role: Schema.String,
  sessionID: OptionalStringSchema,
  time: Schema.optionalKey(Schema.NullOr(OpencodeTimeSchema)),
  tokens: Schema.optionalKey(Schema.NullOr(OpencodeTokensSchema)),
});

export type OpencodeMessageInfo = typeof OpencodeMessageInfoSchema.Type;

const OpencodePartSchema = Schema.Struct({
  tool: OptionalStringSchema,
  type: Schema.String,
});

export const OpencodeExportSchema = Schema.Struct({
  info: Schema.Struct({
    directory: OptionalStringSchema,
    id: Schema.String,
    parentID: OptionalStringSchema,
    time: Schema.optionalKey(Schema.NullOr(OpencodeTimeSchema)),
    version: OptionalStringSchema,
  }),
  messages: Schema.Array(
    Schema.Struct({
      info: OpencodeMessageInfoSchema,
      parts: Schema.optionalKey(
        Schema.NullOr(Schema.Array(OpencodePartSchema))
      ),
    })
  ),
});

export type OpencodeExport = typeof OpencodeExportSchema.Type;

const decodeExport = Schema.decodeUnknownOption(OpencodeExportSchema);

const SOURCE_GAPS: readonly SourceGap[] = [
  {
    code: "cost-is-list-price-estimate",
    message:
      "OpenCode computes message cost from model list pricing; it is not a provider charge. A reported 0 can mean pricing unknown to OpenCode (e.g. subscription or unpriced models).",
  },
  {
    code: "no-git-branch-in-export",
    message:
      "OpenCode session exports carry a working directory but no Git branch or HEAD; branch attribution comes only from the collect context or correlation.",
  },
  {
    code: "total-tokens-not-summed",
    message:
      "Token categories are kept separate; overlap semantics between output and reasoning are not verified, so no total is derived.",
  },
  {
    code: "v2-export-shape-unverified",
    message:
      "Parser is fixture-tested against the OpenCode session export shape (info + messages[{info, parts}]); a real OpenCode 2.x export was not inspected on the build host (no private session data read).",
  },
  {
    code: "explicit-export-only",
    message:
      "Only a user-selected `opencode session export [--sanitize] <id>` JSON file is read; the OpenCode database is never opened.",
  },
];

export const opencodeDescriptor: ModuleDescriptor = {
  contractVersion: CONTRACT_VERSION,
  fixtureIds: [...OPENCODE_FIXTURE_IDS],
  gaps: SOURCE_GAPS,
  id: DescriptorIdSchema.make("collector/opencode"),
  kind: "collector",
  owner: "B13",
  readiness: "degraded",
  requiredInputs: [
    "user-selected JSON file from `opencode session export --sanitize <sessionId>`",
  ],
  supportedFields: [
    "occurredAt",
    "identity.sessionId",
    "identity.generationId",
    "identity.turnId",
    "payload.requestKey",
    "payload.turnKey",
    "payload.modelId",
    "payload.providerId",
    "payload.tokens.input",
    "payload.tokens.output",
    "payload.tokens.reasoning",
    "payload.tokens.cacheRead",
    "payload.tokens.cacheWrite",
    "payload.cost",
    "payload.toolCalls",
    "payload.toolNames",
    "payload.durationMs",
  ],
  version: OPENCODE_ADAPTER_VERSION,
};

const USAGE_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "payload.tokens.input",
    method: "source-reported",
    note: null,
    rawName: "tokens.input",
    unit: "tokens",
  },
  {
    field: "payload.tokens.output",
    method: "source-reported",
    note: null,
    rawName: "tokens.output",
    unit: "tokens",
  },
  {
    field: "payload.tokens.reasoning",
    method: "source-reported",
    note: null,
    rawName: "tokens.reasoning",
    unit: "tokens",
  },
  {
    field: "payload.tokens.cacheRead",
    method: "source-reported",
    note: null,
    rawName: "tokens.cache.read",
    unit: "tokens",
  },
  {
    field: "payload.tokens.cacheWrite",
    method: "source-reported",
    note: null,
    rawName: "tokens.cache.write",
    unit: "tokens",
  },
  {
    field: "payload.cost.value",
    method: "estimated",
    note: "OpenCode list-price estimate, not a provider charge",
    rawName: "cost",
    unit: "USD",
  },
  {
    field: "payload.toolCalls",
    method: "observed",
    note: "count of tool parts in the exported message",
    rawName: "parts[type=tool]",
    unit: "calls",
  },
  {
    field: "payload.durationMs",
    method: "derived",
    note: "time.completed - time.created",
    rawName: "time",
    unit: "ms",
  },
  {
    field: "occurredAt",
    method: "source-reported",
    note: null,
    rawName: "time.created",
    unit: "epoch-ms",
  },
];

const SESSION_SEMANTICS: readonly FieldSemantics[] = [
  {
    field: "payload.messageCount",
    method: "observed",
    note: "messages present in the export",
    rawName: "messages",
    unit: "messages",
  },
  {
    field: "occurredAt",
    method: "source-reported",
    note: null,
    rawName: "info.time.created",
    unit: "epoch-ms",
  },
];

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const eventIdOf = (upstreamKey: string, kind: EventKind): string =>
  sha256(`${OPENCODE_ADAPTER_ID}\u0000${upstreamKey}\u0000${kind}`);

const isoOf = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined
    ? null
    : Option.getOrNull(Option.map(DateTime.make(ms), DateTime.formatIso));

const countOf = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : value;

const unavailableTokens = (info: OpencodeMessageInfo): readonly string[] => {
  const tokens = info.tokens ?? null;
  const fields: string[] = [];

  if (countOf(tokens?.input) === null) {
    fields.push("tokens.input");
  }

  if (countOf(tokens?.output) === null) {
    fields.push("tokens.output");
  }

  if (countOf(tokens?.reasoning) === null) {
    fields.push("tokens.reasoning");
  }

  if (countOf(tokens?.cache?.read) === null) {
    fields.push("tokens.cacheRead");
  }

  if (countOf(tokens?.cache?.write) === null) {
    fields.push("tokens.cacheWrite");
  }

  if (countOf(info.cost) === null) {
    fields.push("cost");
  }

  return fields;
};

const toolSummary = (
  parts: readonly { readonly type: string; readonly tool?: string | null }[]
) => {
  const names: Record<string, number> = {};
  let count = 0;

  for (const part of parts) {
    if (part.type === "tool") {
      count += 1;
      const name = part.tool ?? "unknown";
      names[name] = (names[name] ?? 0) + 1;
    }
  }

  return { count, names };
};

const baseEnvelope = (
  input: CollectInput,
  observedAt: string,
  sourceVersion: string | null
) => ({
  acquisition: "file-import" as const,
  adapterId: OPENCODE_ADAPTER_ID,
  adapterVersion: OPENCODE_ADAPTER_VERSION,
  context: input.context,
  observedAt,
  origin: input.origin,
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion,
});

const tokenPayload = (info: OpencodeMessageInfo) => {
  const tokens = info.tokens ?? null;

  return {
    cacheRead: countOf(tokens?.cache?.read),
    cacheWrite: countOf(tokens?.cache?.write),
    input: countOf(tokens?.input),
    output: countOf(tokens?.output),
    reasoning: countOf(tokens?.reasoning),
    total: null,
  };
};

const costPayload = (info: OpencodeMessageInfo) => {
  const cost = countOf(info.cost);

  return {
    currency: cost === null ? null : "USD",
    ledger: "list-price-estimate",
    method: "estimated",
    value: cost,
  };
};

const durationOf = (
  created: number | null,
  completed: number | null
): number | null =>
  created !== null && completed !== null && completed >= created
    ? completed - created
    : null;

const unavailableOf = (info: OpencodeMessageInfo, hasParts: boolean) => {
  const unavailable = unavailableTokens(info).map((field) => ({
    field,
    reason: "not present in OpenCode export",
  }));

  if (!hasParts) {
    unavailable.push({
      field: "toolCalls",
      reason: "message parts not present in export",
    });
  }

  return unavailable;
};

const usageEnvelope = (
  exported: OpencodeExport,
  messageIndex: number,
  input: CollectInput,
  observedAt: string
): DxEventEnvelope | null => {
  const message = exported.messages[messageIndex];

  if (message === undefined || message.info.role !== "assistant") {
    return null;
  }

  const { info } = message;
  const sessionId = info.sessionID ?? exported.info.id;
  const upstreamKey = `opencode:session:${sessionId}:message:${info.id}`;
  const parts = message.parts ?? null;
  const tools = parts === null ? null : toolSummary(parts);
  const created = countOf(info.time?.created);
  const completed = countOf(info.time?.completed);
  const occurredAt = isoOf(created);

  return {
    ...baseEnvelope(input, observedAt, exported.info.version ?? null),
    eventId: EventIdSchema.make(eventIdOf(upstreamKey, "ai.usage")),
    evidence: {
      bounded: true,
      hash: sha256(JSON.stringify(info)),
      ref: `${input.selectedInput ?? "unknown"}#messages[${messageIndex}].info`,
    },
    fieldSemantics: USAGE_SEMANTICS,
    identity: {
      ...emptyEventIdentity,
      generationId: info.id,
      sessionId,
      turnId: info.id,
    },
    kind: "ai.usage",
    occurredAt,
    occurredAtPrecision: occurredAt === null ? "unknown" : "exact",
    payload: {
      completed: completed !== null,
      cost: costPayload(info),
      durationMs: durationOf(created, completed),
      modelId: info.modelID ?? null,
      providerId: info.providerID ?? null,
      requestKey: canonicalRequestKey({
        generationId: info.id,
        requestId: null,
        sessionId,
        sourceKind: "opencode",
        turnIndex: messageIndex,
      }),
      sourceKind: "opencode",
      tokens: tokenPayload(info),
      toolCalls: tools?.count ?? null,
      toolNames: tools?.names ?? {},
      turnIndex: messageIndex,
      turnKey: canonicalTurnKey(sessionId, info.id),
      unavailable: unavailableOf(info, parts !== null),
    },
    upstreamKey,
  };
};

const sessionEnvelope = (
  exported: OpencodeExport,
  input: CollectInput,
  observedAt: string
): DxEventEnvelope => {
  const { info } = exported;
  const upstreamKey = `opencode:session:${info.id}`;
  const occurredAt = isoOf(info.time?.created);
  const roles = exported.messages.map((message) => message.info.role);

  return {
    ...baseEnvelope(input, observedAt, info.version ?? null),
    eventId: EventIdSchema.make(eventIdOf(upstreamKey, "ai.session")),
    evidence: {
      bounded: true,
      hash: sha256(JSON.stringify(info)),
      ref: `${input.selectedInput ?? "unknown"}#info`,
    },
    fieldSemantics: SESSION_SEMANTICS,
    identity: { ...emptyEventIdentity, sessionId: info.id },
    kind: "ai.session",
    occurredAt,
    occurredAtPrecision: occurredAt === null ? "unknown" : "exact",
    payload: {
      assistantMessageCount: roles.filter((role) => role === "assistant")
        .length,
      directory: info.directory ?? null,
      messageCount: roles.length,
      parentSessionId: info.parentID ?? null,
      sourceKind: "opencode",
      updatedAt: isoOf(info.time?.updated),
      userMessageCount: roles.filter((role) => role === "user").length,
    },
    upstreamKey,
  };
};

const coverageStateOf = (
  assistantMessages: number,
  incomplete: number
): CoverageState => {
  if (assistantMessages === 0) {
    return "none";
  }

  return incomplete > 0 ? "partial" : "complete";
};

export const importOpencodeExport = (
  exported: OpencodeExport,
  input: CollectInput,
  observedAt: string
): EventBatch => {
  const usage: DxEventEnvelope[] = [];
  let assistantMessages = 0;
  let incomplete = 0;

  for (let index = 0; index < exported.messages.length; index += 1) {
    const envelope = usageEnvelope(exported, index, input, observedAt);

    if (envelope !== null) {
      assistantMessages += 1;
      const info = exported.messages[index]?.info;

      if (info !== undefined && unavailableTokens(info).length > 0) {
        incomplete += 1;
      }

      usage.push(envelope);
    }
  }

  const events = [sessionEnvelope(exported, input, observedAt), ...usage];

  const times = events
    .flatMap((event) => (event.occurredAt === null ? [] : [event.occurredAt]))
    .toSorted();

  const gaps: SourceGap[] = [...SOURCE_GAPS];

  if (incomplete > 0) {
    gaps.push({
      code: "missing-usage-fields",
      message: `${incomplete} of ${assistantMessages} assistant message(s) lack one or more token/cost fields; those fields are null (unavailable)`,
    });
  }

  const state = coverageStateOf(assistantMessages, incomplete);

  return {
    coverage: {
      adapterId: OPENCODE_ADAPTER_ID,
      expectedItems: assistantMessages,
      gaps,
      observedItems: assistantMessages - incomplete,
      state,
      watermark: times.at(-1) ?? null,
      windowFrom: times.at(0) ?? null,
      windowTo: times.at(-1) ?? null,
    },
    cursor: {
      adapterId: OPENCODE_ADAPTER_ID,
      value: `${exported.info.id}:${exported.messages.length}`,
    },
    events,
  };
};

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
);

export const parseOpencodeExport = (
  text: string,
  input: CollectInput,
  observedAt: string
): Effect.Effect<EventBatch, InvalidInput | UnsupportedSource> =>
  Effect.gen(function* parseOpencode() {
    const json = decodeJson(text);

    if (Option.isNone(json)) {
      return yield* new InvalidInput({
        field: "input",
        message: "selected OpenCode export is not valid JSON",
      });
    }

    const decoded = decodeExport(json.value);

    if (Option.isNone(decoded)) {
      return yield* new UnsupportedSource({
        adapterId: OPENCODE_ADAPTER_ID,
        message:
          "selected file does not match the OpenCode session export shape (info + messages[{info, parts}])",
        sourceVersion: null,
      });
    }

    return importOpencodeExport(decoded.value, input, observedAt);
  });

export const opencodeCollector: DxCollector<FileSystem.FileSystem> = {
  collect: (input) =>
    Effect.gen(function* collectOpencode() {
      const path = input.selectedInput;

      if (path === null || path.length === 0) {
        return yield* new InvalidInput({
          field: "input",
          message:
            "opencode reads only an explicitly selected `opencode session export` JSON file (--input)",
        });
      }

      const fileSystem = yield* FileSystem.FileSystem;

      const text = yield* fileSystem.readFileString(path).pipe(
        Effect.mapError(
          () =>
            new SourceUnavailable({
              adapterId: OPENCODE_ADAPTER_ID,
              message: "selected OpenCode export is not readable",
            })
        )
      );

      const now = yield* DateTime.now;

      return yield* parseOpencodeExport(text, input, DateTime.formatIso(now));
    }),
  descriptor: opencodeDescriptor,
};
