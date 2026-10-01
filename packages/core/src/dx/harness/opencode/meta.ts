import type { ModuleReadiness } from "../../model/descriptor.js";
import type { Channel } from "../ids.js";

export const OPENCODE_CHANNELS = [
  "local-db",
  "extension",
  "session-file",
] as const satisfies readonly Channel[];

export const OPENCODE_READINESS: ModuleReadiness = "ready";
