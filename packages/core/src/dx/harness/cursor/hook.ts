import { kindForHookEvent } from "../../collectors/cursor-hooks/decode.js";
import {
  handleCursorHook,
  hookResponseFor,
} from "../../collectors/cursor-hooks/handler.js";
import { cursorSpoolDirFor } from "../../collectors/cursor-hooks/spool-dirs.js";
import type {
  HookDecoder,
  HookRunReply,
  HookRunRequest,
} from "../hook-observation.js";
import { standardHookFields } from "../hook-observation.js";

export const runCursorHookRequest = (request: HookRunRequest): HookRunReply =>
  handleCursorHook(request.stdinText, {
    cwd: request.cwd,
    listWorktrees: request.listWorktrees,
    now: request.now,
    resolveGit: request.resolveGit,
    spoolDirFor: (worktreePath) =>
      cursorSpoolDirFor(worktreePath, request.dftHome),
  });

export const cursorHookDecoder: HookDecoder = {
  decode: (stdinText) => standardHookFields(stdinText),
  kind: kindForHookEvent,
  respond: (event) => hookResponseFor(event),
  run: runCursorHookRequest,
};
