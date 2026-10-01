import type { ModuleReadiness } from "../../model/descriptor.js";
import type { Channel } from "../ids.js";

export const PI_CHANNELS = [
  "session-file",
  "extension",
] as const satisfies readonly Channel[];

export const PI_READINESS: ModuleReadiness = "ready";
