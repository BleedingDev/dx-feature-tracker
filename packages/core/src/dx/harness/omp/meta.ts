import type { ModuleReadiness } from "../../model/descriptor.js";
import type { Channel } from "../ids.js";

export const OMP_CHANNELS = [
  "session-file",
  "stats-db",
  "extension",
  "hooks",
] as const satisfies readonly Channel[];

export const OMP_READINESS: ModuleReadiness = "unsupported";
