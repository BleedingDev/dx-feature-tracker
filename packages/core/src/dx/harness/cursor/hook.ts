import { hookResponseFor } from "../../collectors/cursor-hooks/handler.js";
import type { HookDecoder } from "../hook-observation.js";
import { standardHookFields } from "../hook-observation.js";

export const cursorHookDecoder: HookDecoder = {
  decode: (stdinText) => standardHookFields(stdinText),
  respond: (event) => hookResponseFor(event),
};
