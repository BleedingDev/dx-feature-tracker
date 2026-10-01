import type { EventKind } from "../../model/event.js";
import type { HookDecoder } from "../hook-observation.js";
import { standardHookFields } from "../hook-observation.js";

const SESSION_EVENTS: ReadonlySet<string> = new Set([
  "sessionstart",
  "subagentstart",
  "subagentstop",
  "session/start",
  "session/created",
  "subagent/start",
  "subagent/end",
]);

const TURN_EVENTS: ReadonlySet<string> = new Set([
  "userpromptsubmit",
  "stop",
  "turn/start",
  "turn/end",
  "agent/pre-step",
  "agent/turn-stopping",
]);

const REQUEST_EVENTS: ReadonlySet<string> = new Set([
  "assistant/message",
  "assistant/attempt",
]);

export const deepseekHookKind = (event: string): EventKind => {
  const name = event.trim().toLowerCase();

  if (SESSION_EVENTS.has(name)) {
    return "ai.session";
  }

  if (TURN_EVENTS.has(name)) {
    return "ai.turn";
  }

  return REQUEST_EVENTS.has(name) ? "ai.request" : "other";
};

export const deepseekHookDecoder: HookDecoder = {
  decode: (stdinText) => standardHookFields(stdinText),
  kind: deepseekHookKind,
  respond: () => "",
};
