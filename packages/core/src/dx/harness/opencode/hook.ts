import { Option, Schema } from "effect";

import type { EventKind } from "../../model/event.js";
import type { HookDecoder, HookFields } from "../hook-observation.js";
import { boundedField, standardHookFields } from "../hook-observation.js";
import { effortOf, modelRawOf } from "./attribution.js";

const Text = Schema.optional(Schema.NullOr(Schema.String));

const ModelSchema = Schema.Struct({
  id: Text,
  modelID: Text,
  providerID: Text,
  variant: Text,
});

const InfoSchema = Schema.Struct({
  agent: Text,
  directory: Text,
  id: Text,
  modelID: Text,
  parentID: Text,
  providerID: Text,
  role: Text,
  sessionID: Text,
  variant: Text,
});

const PropertiesSchema = Schema.Struct({
  agent: Text,
  assistantMessageID: Text,
  directory: Text,
  info: Schema.optional(Schema.NullOr(InfoSchema)),
  location: Schema.optional(Schema.NullOr(Schema.Struct({ directory: Text }))),
  messageID: Text,
  model: Schema.optional(Schema.NullOr(ModelSchema)),
  parentID: Text,
  sessionID: Text,
});

const OpencodeEventSchema = Schema.Struct({
  data: Schema.optional(Schema.NullOr(PropertiesSchema)),
  properties: Schema.optional(Schema.NullOr(PropertiesSchema)),
  type: Schema.String,
});

const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(OpencodeEventSchema)
);

const first = (...values: (string | null | undefined)[]): string | null => {
  for (const value of values) {
    const bounded = boundedField(value);

    if (bounded !== null) {
      return bounded;
    }
  }

  return null;
};

interface HookModel {
  readonly effort: string | null;
  readonly model: string | null;
}

const modelOf = (props: typeof PropertiesSchema.Type): HookModel => {
  const id = first(props.model?.id, props.model?.modelID, props.info?.modelID);

  if (id === null) {
    return { effort: null, model: null };
  }

  const model = {
    id,
    providerId: first(props.model?.providerID, props.info?.providerID),
    variant: first(props.model?.variant, props.info?.variant),
  };

  return { effort: effortOf(model), model: modelRawOf(model) };
};

const isSessionInfo = (event: string): boolean => event.startsWith("session.");

const nativeFields = (stdinText: string): HookFields | null =>
  Option.match(decodeEvent(stdinText), {
    onNone: () => null,
    onSome: (decoded) => {
      const props = decoded.data ?? decoded.properties ?? {};
      const { info } = props;

      const sessionInfo =
        isSessionInfo(decoded.type) &&
        (info?.sessionID === null || info?.sessionID === undefined);

      const { effort, model } = modelOf(props);

      return {
        agentId: null,
        agentType: first(props.agent, info?.agent),
        cwd: first(props.location?.directory, props.directory, info?.directory),
        effort,
        model,
        parentSessionId: first(
          props.parentID,
          sessionInfo ? info?.parentID : null
        ),
        sessionId: first(
          props.sessionID,
          info?.sessionID,
          sessionInfo ? info?.id : null
        ),
        transcriptPath: null,
        turnId: first(
          props.assistantMessageID,
          props.messageID,
          sessionInfo ? null : info?.id
        ),
      };
    },
  });

const merge = (
  a: HookFields | null,
  b: HookFields | null
): HookFields | null => {
  if (a === null || b === null) {
    return a ?? b;
  }

  return {
    agentId: a.agentId ?? b.agentId,
    agentType: a.agentType ?? b.agentType,
    cwd: a.cwd ?? b.cwd,
    effort: a.effort ?? b.effort,
    model: a.model ?? b.model,
    parentSessionId: a.parentSessionId ?? b.parentSessionId,
    sessionId: a.sessionId ?? b.sessionId,
    transcriptPath: a.transcriptPath ?? b.transcriptPath,
    turnId: a.turnId ?? b.turnId,
  };
};

const SESSION_EVENTS: ReadonlySet<string> = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.forked",
  "session.moved",
]);

const TURN_EVENTS: ReadonlySet<string> = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.status",
  "session.model.selected",
  "session.agent.selected",
  "session.compaction.started",
  "session.compaction.ended",
  "chat.message",
]);

const REQUEST_EVENTS: ReadonlySet<string> = new Set([
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "message.updated",
  "chat.params",
]);

export const opencodeHookKind = (event: string): EventKind => {
  if (SESSION_EVENTS.has(event)) {
    return "ai.session";
  }

  if (TURN_EVENTS.has(event)) {
    return "ai.turn";
  }

  return REQUEST_EVENTS.has(event) ? "ai.request" : "other";
};

export const opencodeHookDecoder: HookDecoder = {
  decode: (stdinText) =>
    merge(standardHookFields(stdinText), nativeFields(stdinText)),
  kind: opencodeHookKind,
  respond: () => "",
};
