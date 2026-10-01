import type { EventKind } from "../../model/event.js";
import type { HookDecoder } from "../hook-observation.js";
import { standardHookFields } from "../hook-observation.js";

export const PI_HOOK_EVENTS: ReadonlyMap<string, EventKind> = new Map([
  ["session_start", "ai.session"],
  ["turn_end", "ai.turn"],
  ["message_end", "ai.request"],
]);

export const piHookDecoder: HookDecoder = {
  decode: (stdinText) => standardHookFields(stdinText),
  kind: (event) => PI_HOOK_EVENTS.get(event) ?? "other",
  respond: () => "",
};
