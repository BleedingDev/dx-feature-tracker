import { rulesForEvent } from "../harness/rules.js";
import type { ModelEffort, ModelEffortSource } from "../harness/rules.js";
import type { DxEventEnvelope } from "../model/event.js";

export type EffortSource = ModelEffortSource;

export type { ModelEffort } from "../harness/rules.js";

export const modelEffortOf = (
  event: DxEventEnvelope,
  rawModel: string,
  recorded: string | null
): ModelEffort => rulesForEvent(event).effort(rawModel, recorded);
