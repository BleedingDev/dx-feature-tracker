import type { ModuleReadiness } from "../../model/descriptor.js";
import type { Channel } from "../ids.js";

export const CURSOR_CHANNELS = [
  "usage-api",
  "cli-stream",
  "hooks",
  "local-db",
  "extension",
  "transcript",
] as const satisfies readonly Channel[];

export const CURSOR_READINESS: ModuleReadiness = "degraded";
