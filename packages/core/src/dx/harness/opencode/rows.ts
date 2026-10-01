import { Option, Schema } from "effect";

import { titleText } from "../title.js";
import type { BodyRow } from "./sql.js";

const Text = Schema.optional(Schema.NullOr(Schema.String));

const Count = Schema.optional(Schema.NullOr(Schema.Finite));

const ModelSchema = Schema.Struct({
  id: Text,
  modelID: Text,
  providerID: Text,
  variant: Text,
});

const ModelField = Schema.optional(
  Schema.NullOr(Schema.Union([ModelSchema, Schema.fromJsonString(ModelSchema)]))
);

const SessionTokensSchema = Schema.Struct({
  cacheRead: Count,
  cacheWrite: Count,
  input: Count,
  output: Count,
  reasoning: Count,
});

const SessionBodySchema = Schema.Struct({
  agent: Text,
  archived: Count,
  cost: Count,
  created: Schema.Finite,
  directory: Schema.String,
  forkBoundary: Schema.optional(Schema.Unknown),
  forkOf: Text,
  id: Schema.String,
  model: ModelField,
  parentId: Text,
  table: Schema.String,
  title: Text,
  tokens: Schema.optional(Schema.NullOr(SessionTokensSchema)),
  updated: Count,
  version: Text,
});

const MessageTokensSchema = Schema.Struct({
  cache: Schema.optional(
    Schema.NullOr(Schema.Struct({ read: Count, write: Count }))
  ),
  input: Count,
  output: Count,
  reasoning: Count,
});

const MessageBodySchema = Schema.Struct({
  agent: Text,
  completed: Count,
  cost: Count,
  created: Schema.Finite,
  cwd: Text,
  directory: Text,
  error: Text,
  finish: Text,
  id: Schema.String,
  model: ModelField,
  parentId: Text,
  paths: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  previousDirectory: Text,
  seq: Count,
  sessionId: Schema.String,
  status: Text,
  summary: Schema.optional(Schema.Unknown),
  table: Schema.String,
  tokens: Schema.optional(Schema.NullOr(MessageTokensSchema)),
  type: Text,
  updated: Count,
});

const decodeSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionBodySchema)
);

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(MessageBodySchema)
);

export interface OcTokens {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
}

export interface OcModel {
  readonly id: string;
  readonly providerId: string | null;
  readonly variant: string | null;
}

export interface OcSession {
  readonly agent: string | null;
  readonly archived: boolean;
  readonly cost: number | null;
  readonly created: number;
  readonly directory: string;
  readonly forkOf: string | null;
  readonly id: string;
  readonly model: OcModel | null;
  readonly parentId: string | null;
  readonly table: string;
  readonly title: string | null;
  readonly tokens: OcTokens | null;
  readonly updated: number;
  readonly version: string | null;
}

export type OcMessageType =
  | "user"
  | "assistant"
  | "compaction"
  | "location-switched"
  | "model-switched"
  | "agent-switched";

export interface OcMessage {
  readonly agent: string | null;
  readonly completed: number | null;
  readonly cost: number | null;
  readonly created: number;
  readonly cwd: string | null;
  readonly directory: string | null;
  readonly error: string | null;
  readonly finish: string | null;
  readonly id: string;
  readonly model: OcModel | null;
  readonly parentId: string | null;
  readonly paths: readonly string[];
  readonly previousDirectory: string | null;
  readonly seq: number | null;
  readonly sessionId: string;
  readonly status: string | null;
  readonly table: string;
  readonly tokens: OcTokens | null;
  readonly type: OcMessageType;
  readonly updated: number;
}

export interface OcRows {
  readonly failures: number;
  readonly messages: readonly OcMessage[];
  readonly sessions: readonly OcSession[];
}

const TYPES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "compaction",
  "location-switched",
  "model-switched",
  "agent-switched",
]);

const isMessageType = (value: string): value is OcMessageType =>
  TYPES.has(value);

const nonEmpty = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

const count = (value: number | null | undefined): number =>
  value === null || value === undefined || value < 0 ? 0 : value;

const modelOf = (
  model: typeof ModelSchema.Type | null | undefined
): OcModel | null => {
  const id = nonEmpty(model?.id ?? model?.modelID);

  return id === null
    ? null
    : {
        id,
        providerId: nonEmpty(model?.providerID),
        variant: nonEmpty(model?.variant),
      };
};

const sessionOf = (body: typeof SessionBodySchema.Type): OcSession => ({
  agent: nonEmpty(body.agent),
  archived: body.archived !== null && body.archived !== undefined,
  cost: body.cost ?? null,
  created: body.created,
  directory: body.directory,
  forkOf: nonEmpty(body.forkOf),
  id: body.id,
  model: modelOf(body.model),
  parentId: nonEmpty(body.parentId),
  table: body.table,
  title: titleText(body.title),
  tokens:
    body.tokens === null || body.tokens === undefined
      ? null
      : {
          cacheRead: count(body.tokens.cacheRead),
          cacheWrite: count(body.tokens.cacheWrite),
          input: count(body.tokens.input),
          output: count(body.tokens.output),
          reasoning: count(body.tokens.reasoning),
        },
  updated: body.updated ?? body.created,
  version: nonEmpty(body.version),
});

const messageTokens = (
  tokens: typeof MessageTokensSchema.Type | null | undefined
): OcTokens | null =>
  tokens === null || tokens === undefined
    ? null
    : {
        cacheRead: count(tokens.cache?.read),
        cacheWrite: count(tokens.cache?.write),
        input: count(tokens.input),
        output: count(tokens.output),
        reasoning: count(tokens.reasoning),
      };

const messageOf = (body: typeof MessageBodySchema.Type): OcMessage | null => {
  const type = nonEmpty(body.type);

  if (type === null || !isMessageType(type)) {
    return null;
  }

  return {
    agent: nonEmpty(body.agent),
    completed: body.completed ?? null,
    cost: body.cost ?? null,
    created: body.created,
    cwd: nonEmpty(body.cwd),
    directory: nonEmpty(body.directory),
    error: nonEmpty(body.error),
    finish: nonEmpty(body.finish),
    id: body.id,
    model: modelOf(body.model),
    parentId: nonEmpty(body.parentId),
    paths: body.paths ?? [],
    previousDirectory: nonEmpty(body.previousDirectory),
    seq: body.seq ?? null,
    sessionId: body.sessionId,
    status: nonEmpty(body.status),
    table: body.table,
    tokens: messageTokens(body.tokens),
    type,
    updated: body.updated ?? body.created,
  };
};

export const decodeRows = (rows: readonly BodyRow[]): OcRows => {
  const sessionRows = rows.filter((row) => row.kind === "session");
  const messageRows = rows.filter((row) => row.kind !== "session");

  const sessions = sessionRows.flatMap((row) =>
    Option.toArray(Option.map(decodeSession(row.body), sessionOf))
  );

  const decodedMessages = messageRows.flatMap((row) =>
    Option.toArray(decodeMessage(row.body))
  );

  const messages = decodedMessages.flatMap((body) => {
    const message = messageOf(body);

    return message === null ? [] : [message];
  });

  const failures =
    sessionRows.length -
    sessions.length +
    (messageRows.length - decodedMessages.length);

  return { failures, messages, sessions };
};
