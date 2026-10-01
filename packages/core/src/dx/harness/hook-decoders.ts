import { claudeCodeHookDecoder } from "./claude-code/hook.js";
import { codexHookDecoder } from "./codex/hook.js";
import { cursorHookDecoder } from "./cursor/hook.js";
import { deepseekHookDecoder } from "./deepseek/hook.js";
import type { HookDecoder } from "./hook-observation.js";
import type { HarnessId } from "./ids.js";
import { ompHookDecoder } from "./omp/hook.js";
import { opencodeHookDecoder } from "./opencode/hook.js";
import { piHookDecoder } from "./pi/hook.js";

export const HOOK_DECODERS: Readonly<Record<HarnessId, HookDecoder>> = {
  "claude-code": claudeCodeHookDecoder,
  codex: codexHookDecoder,
  cursor: cursorHookDecoder,
  deepseek: deepseekHookDecoder,
  omp: ompHookDecoder,
  opencode: opencodeHookDecoder,
  pi: piHookDecoder,
};
