import type { ModuleReadiness } from "../../model/descriptor.js";
import type { Channel } from "../ids.js";

export const CLAUDE_CODE_CHANNELS = [
  "session-file",
  "otel",
  "hooks",
  "transcript",
] as const satisfies readonly Channel[];

export const CLAUDE_CODE_READINESS: ModuleReadiness = "unsupported";
