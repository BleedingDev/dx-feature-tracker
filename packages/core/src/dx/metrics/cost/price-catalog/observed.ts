import type { DxEventEnvelope } from "../../../model/event.js";
import type { CostOptions } from "../metric.js";
import { extractReadings } from "../readings.js";
import { expandForModels } from "./catalog.js";

export const observedModelSlugs = (
  events: readonly DxEventEnvelope[]
): readonly string[] => [
  ...new Set(
    extractReadings(events).tokens.flatMap((t) =>
      t.model === null ? [] : [t.model]
    )
  ),
];

export const withObservedModels = (
  options: CostOptions,
  events: readonly DxEventEnvelope[]
): CostOptions =>
  options.priceTable === null
    ? options
    : {
        ...options,
        priceTable: expandForModels(
          options.priceTable,
          observedModelSlugs(events)
        ),
      };
