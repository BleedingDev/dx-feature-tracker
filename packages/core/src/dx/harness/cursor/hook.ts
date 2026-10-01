import { kindForHookEvent } from "../../collectors/cursor-hooks/decode.js";
import { hookResponseFor } from "../../collectors/cursor-hooks/handler.js";
import type { HookDecoder } from "../hook-observation.js";
import { standardHookFields } from "../hook-observation.js";

export const cursorHookDecoder: HookDecoder = {
  decode: (stdinText) => standardHookFields(stdinText),
  kind: kindForHookEvent,
  respond: (event) => hookResponseFor(event),
};
