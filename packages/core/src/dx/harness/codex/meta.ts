import type { ModuleReadiness } from "../../model/descriptor.js";
import type { Channel } from "../ids.js";

export const CODEX_CHANNELS = [
  "session-file",
  "otel",
  "hooks",
] as const satisfies readonly Channel[];

export const CODEX_READINESS: ModuleReadiness = "unsupported";
