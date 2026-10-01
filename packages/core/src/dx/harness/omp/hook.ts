import type { EventKind } from "../../model/event.js";
import type { HookDecoder } from "../hook-observation.js";
import { standardHookFields } from "../hook-observation.js";

export const OMP_HOOK_EVENTS = [
  "session_start",
  "before_agent_start",
  "turn_start",
  "agent_end",
  "session_shutdown",
] as const;

export type OmpHookEvent = (typeof OMP_HOOK_EVENTS)[number];

export const ompHookKind = (event: string): EventKind => {
  switch (event) {
    case "session_start":
    case "session_switch":
    case "session_shutdown": {
      return "ai.session";
    }

    case "before_agent_start":
    case "input": {
      return "ai.request";
    }

    case "agent_end": {
      return "ai.turn";
    }

    default: {
      return "other";
    }
  }
};

export const ompHookDecoder: HookDecoder = {
  decode: (stdinText) => standardHookFields(stdinText),
  kind: ompHookKind,
  respond: () => "",
};
