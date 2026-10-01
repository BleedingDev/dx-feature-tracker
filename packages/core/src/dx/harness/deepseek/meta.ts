import type { ModuleReadiness } from "../../model/descriptor.js";
import type { Channel } from "../ids.js";

export const DEEPSEEK_CHANNELS = [
  "session-file",
  "extension",
] as const satisfies readonly Channel[];

export const DEEPSEEK_READINESS: ModuleReadiness = "ready";
